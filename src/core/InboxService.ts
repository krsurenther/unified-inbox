import type { AppConfig } from './config/Config';
import { channelConfig } from './config/Config';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './channels/ChannelAdapter';
import type { LlmRouter } from './llm/LlmRouter';
import type { InboxStore } from './store/InboxStore';
import type { Draft, Message, ThreadView } from './types';

export interface InboxServiceDeps {
  store: InboxStore;
  router: LlmRouter;
  config: AppConfig;
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
  private readonly channels = new Map<string, ChannelAdapter>();

  constructor(deps: InboxServiceDeps) {
    this.store = deps.store;
    this.router = deps.router;
    this.config = deps.config;
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

  /** Ingest one inbound message: persist (idempotent), then auto-draft a reply. Never sends. */
  async ingest(msg: InboundMessage): Promise<void> {
    const customer = this.store.upsertCustomer(msg.channelId, msg.from.externalId, msg.from.name, msg.from.phone);
    const thread = this.store.findOrCreateThread(msg.channelId, customer.id, msg.threadKey);
    const { inserted } = this.store.recordInbound({
      threadId: thread.id,
      body: msg.body,
      channelMessageId: msg.channelMessageId,
      authorName: msg.from.name,
      createdAt: msg.timestamp,
    });
    if (!inserted) return; // duplicate delivery — nothing new to draft
    try {
      await this.generateDraft(thread.id);
    } catch {
      /* best-effort — a down/slow LLM must not drop the inbound message */
    }
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

    return this.store.saveDraft({
      threadId,
      body: result.text,
      status: 'suggested',
      providerId: result.providerId,
      model: result.model,
    });
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

      for (const m of await adapter.getHistory(d.threadKey)) {
        const { inserted } = this.store.recordMessage({
          threadId: thread.id,
          direction: m.direction,
          body: m.body,
          channelMessageId: m.channelMessageId,
          authorName: m.authorName,
          createdAt: m.timestamp,
        });
        if (inserted) messages++;
      }
      this.store.setThreadSummary(thread.id, { unread: d.unread, lastMessageAt: d.lastMessageAt });

      // Draft when the latest message is an unanswered buyer message (and we don't
      // already have a live draft) — never auto-sends.
      const history = this.store.getHistory(thread.id);
      const last = history[history.length - 1];
      const draft = this.store.getLatestDraft(thread.id);
      if (last?.direction === 'inbound' && (!draft || draft.status === 'sent' || draft.status === 'discarded')) {
        try {
          await this.generateDraft(thread.id);
        } catch {
          /* drafting is best-effort — a down/slow LLM must not break the sync */
        }
      }
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

    const out: OutboundMessage = { threadKey: view.thread.threadKey, body: opts.body };
    const res = await adapter.send(out);

    this.store.recordOutbound({
      threadId,
      body: opts.body,
      channelMessageId: res.channelMessageId,
      createdAt: res.sentAt,
    });

    const draft = this.store.getLatestDraft(threadId);
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

  // --- reads for UI / MCP --------------------------------------------------

  listThreads(): ThreadView[] {
    return this.store.listThreads();
  }

  getHistory(threadId: string): Message[] {
    return this.store.getHistory(threadId);
  }

  getDraft(threadId: string): Draft | undefined {
    return this.store.getLatestDraft(threadId);
  }
}
