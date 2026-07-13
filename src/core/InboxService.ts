import type { AppConfig } from './config/Config';
import { channelConfig } from './config/Config';
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutboundMessage } from './channels/ChannelAdapter';
import type { LlmRouter } from './llm/LlmRouter';
import type { InboxStore } from './store/InboxStore';
import type { Draft, Message, ThreadView } from './types';

/** One channel's live health, for the renderer's status banners. */
export interface ChannelHealthRow {
  channelId: string;
  label: string;
  kind: string;
  health: ChannelHealth;
}

/** Emitted once per newly-inserted inbound message (push or sync path) — drives notifications. */
export interface InboundEvent {
  threadId: string;
  channelId: string;
  channelLabel: string;
  customerName: string;
  body: string;
  at: string;
}

export interface InboxServiceDeps {
  store: InboxStore;
  router: LlmRouter;
  config: AppConfig;
  /** Fired once per NEW inbound message. Best-effort side channel (notifications/badge). */
  onInbound?: (e: InboundEvent) => void;
}

/**
 * The pipeline. Wires channels → store → LLM and exposes the operations the UI
 * (and later the MCP server) call. Knows nothing about any specific vendor.
 *
 * Human-in-the-loop is enforced here: inbound messages are persisted and an AI
 * draft is produced, but a reply only goes out through `approveAndSend`. Auto-send
 * remains a per-channel config flag that nothing in Phase 1 acts on.
 */
export class InboxService {
  private readonly store: InboxStore;
  private readonly router: LlmRouter;
  private readonly config: AppConfig;
  private readonly onInbound?: (e: InboundEvent) => void;
  private lastDraftError?: string;
  private readonly channels = new Map<string, ChannelAdapter>();

  constructor(deps: InboxServiceDeps) {
    this.store = deps.store;
    this.router = deps.router;
    this.config = deps.config;
    this.onInbound = deps.onInbound;
  }

  /** Register a channel adapter and start routing its inbound messages into the pipeline. */
  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.channel.id, adapter);
    this.store.upsertChannel(adapter.channel);
    adapter.onMessage((m) => this.ingest(m));
  }

  /** Remove a channel from the live registry (its stored history is kept). */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  isChannelRegistered(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  async start(): Promise<void> {
    for (const a of this.channels.values()) await a.start();
  }

  async stop(): Promise<void> {
    for (const a of this.channels.values()) await a.stop();
  }

  /** Stop every adapter (kills WA puppeteer Chromes) and close the DB. Call once on app quit. */
  async dispose(): Promise<void> {
    await this.stop();
    this.store.close();
  }

  /** Ingest one inbound message: persist (idempotent), then auto-draft a reply. Never sends. */
  async ingest(msg: InboundMessage): Promise<void> {
    const customer = this.store.upsertCustomer(msg.channelId, msg.from.externalId, msg.from.name, msg.from.phone);
    const thread = this.store.findOrCreateThread(msg.channelId, customer.id, msg.threadKey);
    const { inserted } = this.store.recordInbound({
      threadId: thread.id,
      body: msg.body,
      channelMessageId: msg.channelMessageId,
      authorName: msg.from.name,
      meta: msg.media ? { media: msg.media } : undefined,
      createdAt: msg.timestamp,
    });
    if (!inserted) return; // duplicate delivery — nothing new to draft or notify
    if (!this.store.isThreadMuted(thread.id)) {
      this.onInbound?.({
        threadId: thread.id,
        channelId: msg.channelId,
        channelLabel: this.channels.get(msg.channelId)?.channel.label ?? msg.channelId,
        customerName: msg.from.name ?? msg.from.externalId,
        body: msg.body,
        at: msg.timestamp ?? new Date().toISOString(),
      });
    }
    await this.maybeDraft(thread.id, { newInbound: true });
  }

  /**
   * One drafting rule for both the push (ingest) and pull (sync) paths: draft only
   * when a new customer message arrived AND it's the latest AND the current draft is
   * machine-owned. Never touches a human-'edited'/'approved' draft — that's the
   * durable-edit contract and it kills the push/pull asymmetry (stale pull drafts).
   */
  private async maybeDraft(threadId: string, opts: { newInbound: boolean }): Promise<void> {
    if (!this.config.autoDraft) return; // on-demand only: the operator presses Generate (saves tokens)
    if (!opts.newInbound) return;
    if (this.store.isThreadMuted(threadId)) return; // muted threads ("not a customer") don't draft
    const view = this.store.getThreadView(threadId);
    if (view?.lastMessageDirection !== 'inbound') return; // already answered on the channel
    const draft = view.draft;
    if (draft && (draft.status === 'edited' || draft.status === 'approved')) return;
    try {
      await this.generateDraft(threadId);
    } catch {
      /* best-effort — a down/slow LLM must not break ingest/sync */
    }
  }

  /** Persist a human-edited draft (status 'edited'); later drafting won't overwrite it. */
  updateDraft(draftId: string, body: string): Draft {
    return this.store.updateDraftBody(draftId, body);
  }

  /** (Re)generate an AI draft for a thread from its history + channel context. */
  async generateDraft(threadId: string): Promise<Draft> {
    const view = this.store.getThreadView(threadId);
    if (!view) throw new Error(`thread not found: ${threadId}`);

    const history = this.store.getHistory(threadId).map((m) => ({
      role: m.direction === 'inbound' ? ('customer' as const) : ('agent' as const),
      text: m.body,
      at: m.createdAt,
    }));

    try {
      const result = await this.router.draft(view.channel.id, {
        thread: {
          id: threadId,
          channelId: view.channel.id,
          channelKind: view.channel.kind,
          customerName: view.customer.name,
        },
        history,
        systemPrompt: this.config.systemPrompt,
      });
      const draft = this.store.saveDraft({
        threadId,
        body: result.text,
        status: 'suggested',
        providerId: result.providerId,
        model: result.model,
      });
      this.lastDraftError = undefined; // drafting is healthy
      return draft;
    } catch (e) {
      this.lastDraftError = (e as Error).message; // surfaced via draftHealth()
      throw e;
    }
  }

  /** Whether the last drafting attempt succeeded (for a "drafting unavailable" banner). */
  draftHealth(): { ok: boolean; error?: string } {
    return { ok: !this.lastDraftError, error: this.lastDraftError };
  }

  /** Live health of every registered channel (connection + ban risk) — for status banners. */
  async channelsHealth(): Promise<ChannelHealthRow[]> {
    const rows: ChannelHealthRow[] = [];
    for (const a of this.channels.values()) {
      rows.push({ channelId: a.channel.id, label: a.channel.label, kind: a.channel.kind, health: await a.health() });
    }
    return rows;
  }

  /**
   * Pull all threads from a channel and backfill their two-way history
   * (idempotent). Drafts a reply for any thread whose latest message is an
   * unanswered inbound. Used by pull-style channels (Duoke, WhatsApp) on a poll.
   */
  async syncChannel(channelId: string): Promise<{ threads: number; messages: number }> {
    const adapter = this.channels.get(channelId);
    if (!adapter) throw new Error(`no adapter registered for channel '${channelId}'`);

    const descriptors = await adapter.listThreads();
    let messages = 0;
    for (const d of descriptors) {
      const customer = this.store.upsertCustomer(channelId, d.participant.externalId, d.participant.name, d.participant.phone);
      const thread = this.store.findOrCreateThread(channelId, customer.id, d.threadKey);

      let newInbound = false;
      for (const m of await adapter.getHistory(d.threadKey)) {
        const { inserted } = this.store.recordMessage({
          threadId: thread.id,
          direction: m.direction,
          body: m.body,
          channelMessageId: m.channelMessageId,
          authorName: m.authorName,
          meta: m.media ? { media: m.media } : undefined,
          createdAt: m.timestamp,
        });
        if (inserted) {
          messages++;
          if (m.direction === 'inbound') {
            newInbound = true;
            if (!this.store.isThreadMuted(thread.id)) {
              this.onInbound?.({
                threadId: thread.id,
                channelId,
                channelLabel: adapter.channel.label,
                customerName: d.participant.name ?? d.participant.externalId,
                body: m.body,
                at: m.timestamp ?? new Date().toISOString(),
              });
            }
          }
        }
      }
      this.store.setThreadSummary(thread.id, { unread: d.unread }); // last_message_at tracks stored messages, not channel last-activity

      // Same rule as the push path: refresh the draft on a new buyer message, unless a human owns it.
      await this.maybeDraft(thread.id, { newInbound });
    }
    return { threads: descriptors.length, messages };
  }

  /**
   * Approve a (possibly human-edited) reply and send it through the channel.
   * This is the human-in-the-loop gate — the only path that emits an outbound
   * message in Phase 1.
   */
  async approveAndSend(
    threadId: string,
    opts: { body: string; approvedBy?: string },
  ): Promise<{ sent: boolean; channelMessageId?: string }> {
    const view = this.store.getThreadView(threadId);
    if (!view) throw new Error(`thread not found: ${threadId}`);
    const adapter = this.channels.get(view.channel.id);
    if (!adapter) throw new Error(`no adapter registered for channel '${view.channel.id}'`);

    // Capture the draft being approved BEFORE the (slow, paced) send — an inbound
    // arriving mid-send would otherwise create a fresh draft that we'd wrongly
    // flag 'sent' and mis-attribute in the audit.
    const draft = this.store.getLatestDraft(threadId);

    const out: OutboundMessage = { threadKey: view.thread.threadKey, body: opts.body };
    const res = await adapter.send(out);

    this.store.recordOutbound({
      threadId,
      body: opts.body,
      channelMessageId: res.channelMessageId,
      createdAt: res.sentAt,
    });

    if (draft) this.store.setDraftStatus(draft.id, 'sent');

    this.store.recordSendAudit({
      threadId,
      channelId: view.channel.id,
      draftId: draft?.id,
      body: opts.body,
      channelMessageId: res.channelMessageId,
      approvedBy: opts.approvedBy ?? 'human:ui',
      auto: false, // Phase 1 only ever sends via explicit human approval
      sentAt: res.sentAt,
    });

    return { sent: true, channelMessageId: res.channelMessageId };
  }

  /** Whether a channel currently has auto-send enabled (config-driven; OFF by default). */
  autoSendEnabled(channelId: string): boolean {
    return channelConfig(this.config, channelId).autoSend === true;
  }

  /** Sends a channel has made at/after `sinceIso` — feeds the WhatsApp anti-ban rolling cap. */
  sendCountSince(channelId: string, sinceIso: string): number {
    return this.store.countSendsSince(channelId, sinceIso);
  }

  /** Remove a channel's stored conversations (threads/messages/drafts/customers). Audit is kept. */
  purgeChannel(channelId: string): { threads: number; messages: number } {
    return this.store.purgeChannelData(channelId);
  }

  /** Mark a thread read locally (clears its unread badge). No channel read receipt. */
  markRead(threadId: string): void {
    this.store.markRead(threadId);
  }

  /** Rename a channel (e.g. relabel a WhatsApp number) — updates its chip on every thread. */
  renameChannel(channelId: string, label: string): void {
    this.store.renameChannel(channelId, label);
  }

  /** Set a thread's workflow status (open | snoozed | closed). */
  setThreadStatus(threadId: string, status: 'open' | 'snoozed' | 'closed'): void {
    this.store.setThreadStatus(threadId, status);
  }

  /** Mute/unmute a thread ("not a customer") — suppresses drafting + notifications. */
  setThreadMuted(threadId: string, muted: boolean): void {
    this.store.setThreadMuted(threadId, muted);
  }

  // --- reads for UI / MCP --------------------------------------------------

  listThreads(): ThreadView[] {
    return this.store.listThreads();
  }

  getThreadView(threadId: string): ThreadView | undefined {
    return this.store.getThreadView(threadId);
  }

  getHistory(threadId: string): Message[] {
    return this.store.getHistory(threadId);
  }

  getDraft(threadId: string): Draft | undefined {
    return this.store.getLatestDraft(threadId);
  }

  searchThreads(q: string): ThreadView[] {
    return this.store.searchThreads(q);
  }

  channelSummaries() {
    return this.store.channelSummaries();
  }

  countsByTriage() {
    return this.store.countsByTriage(this.config.currentStaff || undefined);
  }

  relatedThreads(threadId: string): ThreadView[] {
    return this.store.relatedThreads(threadId);
  }

  /** Route a thread to a staff member (or null to unassign). */
  assignThread(threadId: string, assignee: string | null): void {
    this.store.assignThread(threadId, assignee);
  }
}
