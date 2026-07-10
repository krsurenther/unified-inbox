import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ChannelRef,
  Customer,
  Draft,
  DraftStatus,
  Message,
  MessageDirection,
  Thread,
  ThreadView,
} from '../types';

export interface SendAuditRow {
  id: string;
  threadId: string;
  channelId: string;
  draftId?: string;
  body: string;
  channelMessageId?: string;
  approvedBy?: string;
  auto: number; // 0 | 1
  sentAt: string;
}

const nowIso = (): string => new Date().toISOString();

/**
 * The local message store. The ONLY module that touches the database engine, so
 * the engine (currently Node's built-in node:sqlite) is swappable without
 * touching business logic. Synchronous on purpose — node:sqlite is sync and the
 * store is tiny + local.
 */
export interface InboxStoreOptions {
  schemaPath?: string;
  /** Open without write access and skip schema DDL — for the MCP server. */
  readOnly?: boolean;
}

export class InboxStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ':memory:', opts: InboxStoreOptions = {}) {
    this.db = new DatabaseSync(dbPath, { readOnly: opts.readOnly ?? false });
    // Cross-process safety: the desktop app and the MCP server share this file.
    // Without a busy timeout, overlapping locks fail instantly (SQLITE_BUSY).
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Apply the schema (idempotent) when available and writable. A pre-existing DB
    // opened standalone (e.g. by the MCP server, cwd unknown) runs without it.
    if (!opts.readOnly) {
      const schemaPath = opts.schemaPath ?? resolve(process.cwd(), 'db/schema.sql');
      if (existsSync(schemaPath)) this.db.exec(readFileSync(schemaPath, 'utf8'));
    }
  }

  /** The connection's busy timeout (ms) — exposed for tests/diagnostics. */
  busyTimeoutMs(): number {
    return Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);
  }

  close(): void {
    this.db.close();
  }

  // --- channels / customers / threads -------------------------------------

  upsertChannel(ch: ChannelRef): void {
    this.db
      .prepare(
        `INSERT INTO channels (id, kind, label, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label`,
      )
      .run(ch.id, ch.kind, ch.label, nowIso());
  }

  upsertCustomer(channelId: string, externalId: string, name?: string, phone?: string): Customer {
    const existing = this.db
      .prepare(`SELECT * FROM customers WHERE channel_id = ? AND external_id = ?`)
      .get(channelId, externalId) as Record<string, unknown> | undefined;

    if (existing) {
      if ((name && name !== existing.name) || (phone && phone !== existing.phone)) {
        this.db
          .prepare(`UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?`)
          .run(name ?? null, phone ?? null, existing.id as string);
      }
      return this.customerById(existing.id as string)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO customers (id, channel_id, external_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, channelId, externalId, name ?? null, phone ?? null, nowIso());
    return this.customerById(id)!;
  }

  findOrCreateThread(channelId: string, customerId: string, threadKey: string): Thread {
    const existing = this.db
      .prepare(`SELECT * FROM threads WHERE channel_id = ? AND thread_key = ?`)
      .get(channelId, threadKey) as Record<string, unknown> | undefined;
    if (existing) return this.mapThread(existing);

    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO threads (id, channel_id, customer_id, thread_key, status, unread, last_message_at, created_at)
         VALUES (?, ?, ?, ?, 'open', 0, ?, ?)`,
      )
      .run(id, channelId, customerId, threadKey, now, now);
    return this.mapThread(this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as Record<string, unknown>);
  }

  // --- messages ------------------------------------------------------------

  /** Insert an inbound message. Idempotent on (thread_id, channel_message_id). */
  recordInbound(p: {
    threadId: string;
    body: string;
    channelMessageId?: string;
    authorName?: string;
    meta?: Record<string, unknown>;
    createdAt?: string;
  }): { inserted: boolean } {
    const createdAt = p.createdAt ?? nowIso();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, thread_id, direction, body, channel_message_id, author_name, meta, created_at)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), p.threadId, p.body, p.channelMessageId ?? null, p.authorName ?? null, p.meta ? JSON.stringify(p.meta) : null, createdAt);

    const inserted = Number(res.changes) > 0;
    if (inserted) {
      // A new customer message reopens a done thread and bumps unread. last_message_at
      // is monotonic (MAX) so a late/out-of-order delivery can't sink the thread.
      this.db
        .prepare(`UPDATE threads SET last_message_at = MAX(last_message_at, ?), unread = unread + 1, status = 'open' WHERE id = ?`)
        .run(createdAt, p.threadId);
    }
    return { inserted };
  }

  recordOutbound(p: {
    threadId: string;
    body: string;
    channelMessageId?: string;
    createdAt?: string;
  }): Message {
    const id = randomUUID();
    const createdAt = p.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, direction, body, channel_message_id, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?)`,
      )
      .run(id, p.threadId, p.body, p.channelMessageId ?? null, createdAt);
    this.db.prepare(`UPDATE threads SET last_message_at = ?, unread = 0 WHERE id = ?`).run(createdAt, p.threadId);
    return this.mapMessage(this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Record<string, unknown>);
  }

  getHistory(threadId: string): Message[] {
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(threadId) as Record<string, unknown>[]
    ).map((r) => this.mapMessage(r));
  }

  /**
   * Idempotent insert of a historical message (either direction), keyed on
   * (thread_id, channel_message_id). Used to backfill pull-style channels without
   * duplicating on re-sync. Does not touch unread (the channel's count is authoritative).
   */
  recordMessage(p: {
    threadId: string;
    direction: MessageDirection;
    body: string;
    channelMessageId?: string;
    authorName?: string;
    meta?: Record<string, unknown>;
    createdAt?: string;
  }): { inserted: boolean } {
    const createdAt = p.createdAt ?? nowIso();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, thread_id, direction, body, channel_message_id, author_name, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), p.threadId, p.direction, p.body, p.channelMessageId ?? null, p.authorName ?? null, p.meta ? JSON.stringify(p.meta) : null, createdAt);
    return { inserted: Number(res.changes) > 0 };
  }

  /** Set a thread's authoritative unread / last-activity from the channel. */
  setThreadSummary(threadId: string, p: { unread?: number; lastMessageAt?: string }): void {
    if (p.unread != null) this.db.prepare(`UPDATE threads SET unread = ? WHERE id = ?`).run(p.unread, threadId);
    if (p.lastMessageAt)
      this.db.prepare(`UPDATE threads SET last_message_at = MAX(last_message_at, ?) WHERE id = ?`).run(p.lastMessageAt, threadId);
  }

  // --- drafts --------------------------------------------------------------

  saveDraft(p: {
    threadId: string;
    body: string;
    status?: DraftStatus;
    providerId?: string;
    model?: string;
  }): Draft {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO drafts (id, thread_id, body, status, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, p.threadId, p.body, p.status ?? 'suggested', p.providerId ?? null, p.model ?? null, now, now);
    return this.mapDraft(this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as Record<string, unknown>);
  }

  getLatestDraft(threadId: string): Draft | undefined {
    const row = this.db
      .prepare(`SELECT * FROM drafts WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? this.mapDraft(row) : undefined;
  }

  setDraftStatus(draftId: string, status: DraftStatus): void {
    this.db.prepare(`UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), draftId);
  }

  /** Persist a human-edited draft body — marks it 'edited' so drafting never overwrites it. */
  updateDraftBody(draftId: string, body: string): Draft {
    this.db.prepare(`UPDATE drafts SET body = ?, status = 'edited', updated_at = ? WHERE id = ?`).run(body, nowIso(), draftId);
    return this.mapDraft(this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as Record<string, unknown>);
  }

  // --- audit ---------------------------------------------------------------

  recordSendAudit(p: {
    threadId: string;
    channelId: string;
    draftId?: string;
    body: string;
    channelMessageId?: string;
    approvedBy?: string;
    auto?: boolean;
    sentAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO send_audit (id, thread_id, channel_id, draft_id, body, channel_message_id, approved_by, auto, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        p.threadId,
        p.channelId,
        p.draftId ?? null,
        p.body,
        p.channelMessageId ?? null,
        p.approvedBy ?? null,
        p.auto ? 1 : 0,
        p.sentAt ?? nowIso(),
      );
  }

  /** How many sends a channel has made at/after `sinceIso` (rolling-window cap source). */
  countSendsSince(channelId: string, sinceIso: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM send_audit WHERE channel_id = ? AND sent_at >= ?`)
      .get(channelId, sinceIso) as { n: number };
    return Number(row.n);
  }

  listSendAudit(threadId: string): SendAuditRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM send_audit WHERE thread_id = ? ORDER BY sent_at ASC, rowid ASC`)
        .all(threadId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      channelId: r.channel_id as string,
      draftId: (r.draft_id as string) ?? undefined,
      body: r.body as string,
      channelMessageId: (r.channel_message_id as string) ?? undefined,
      approvedBy: (r.approved_by as string) ?? undefined,
      auto: Number(r.auto),
      sentAt: r.sent_at as string,
    }));
  }

  // --- deletion ------------------------------------------------------------

  /** Delete drafts + messages + the thread rows themselves (FK-safe order). Returns messages deleted. */
  private deleteThreadRows(threadIds: string[]): number {
    let messages = 0;
    for (const id of threadIds) {
      this.db.prepare(`DELETE FROM drafts WHERE thread_id = ?`).run(id);
      messages += Number(this.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(id).changes);
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(`mute:${id}`); // no orphan mute flags
    }
    return messages;
  }

  /**
   * Owner-requested (2026-07-10): unlinking a channel deletes its inbox data —
   * threads, messages, drafts, and customers for the channel. Deliberately KEEPS
   * the channels row and every send_audit row: the audit is the anti-ban ledger,
   * and purging it would let disconnect→reconnect reset the daily cap.
   */
  purgeChannelData(channelId: string): { threads: number; messages: number } {
    const ids = (this.db.prepare(`SELECT id FROM threads WHERE channel_id = ?`).all(channelId) as { id: string }[]).map(
      (r) => r.id,
    );
    const messages = this.deleteThreadRows(ids);
    this.db.prepare(`DELETE FROM customers WHERE channel_id = ?`).run(channelId);
    return { threads: ids.length, messages };
  }

  /** Remove every thread with this thread_key (any channel) + its messages/drafts. */
  deleteThreadsByKey(threadKey: string): { threads: number; messages: number } {
    const ids = (this.db.prepare(`SELECT id FROM threads WHERE thread_key = ?`).all(threadKey) as { id: string }[]).map(
      (r) => r.id,
    );
    return { threads: ids.length, messages: this.deleteThreadRows(ids) };
  }

  // --- views ---------------------------------------------------------------

  listThreads(): ThreadView[] {
    const rows = this.db
      .prepare(`SELECT * FROM threads ORDER BY last_message_at DESC, rowid DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toThreadView(this.mapThread(r)));
  }

  // --- settings k/v (restart-durable app state) ---------------------------

  getSetting(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  /** Mute a thread ("not a customer"): suppresses AI drafting + notifications. Settings-backed. */
  setThreadMuted(threadId: string, muted: boolean): void {
    this.setSetting(`mute:${threadId}`, muted ? '1' : '0');
  }

  isThreadMuted(threadId: string): boolean {
    return this.getSetting(`mute:${threadId}`) === '1';
  }

  /** Clear a thread's unread (local read state; never sends a channel read receipt). */
  markRead(threadId: string): void {
    this.db.prepare(`UPDATE threads SET unread = 0 WHERE id = ?`).run(threadId);
  }

  /** Set a thread's workflow status (open | snoozed | closed). */
  setThreadStatus(threadId: string, status: Thread['status']): void {
    if (status !== 'open' && status !== 'snoozed' && status !== 'closed') {
      throw new Error(`invalid thread status: ${status}`);
    }
    this.db.prepare(`UPDATE threads SET status = ? WHERE id = ?`).run(status, threadId);
  }

  /** Total unread across all threads — the dock-badge source. */
  totalUnread(): number {
    return Number((this.db.prepare(`SELECT COALESCE(SUM(unread), 0) AS n FROM threads`).get() as { n: number }).n);
  }

  getThreadView(threadId: string): ThreadView | undefined {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toThreadView(this.mapThread(row)) : undefined;
  }

  private toThreadView(thread: Thread): ThreadView {
    const last = this.db
      .prepare(`SELECT body, direction FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    return {
      thread,
      channel: this.channelById(thread.channelId)!,
      customer: this.customerById(thread.customerId)!,
      lastMessagePreview: (last?.body as string) ?? undefined,
      lastMessageDirection: (last?.direction as MessageDirection) ?? undefined,
      muted: this.isThreadMuted(thread.id),
      draft: this.getLatestDraft(thread.id),
    };
  }

  // --- helpers / mappers ---------------------------------------------------

  private channelById(id: string): ChannelRef | undefined {
    const r = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? { id: r.id as string, kind: r.kind as ChannelRef['kind'], label: r.label as string } : undefined;
  }

  private customerById(id: string): Customer | undefined {
    const r = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapCustomer(r) : undefined;
  }

  private mapThread(r: Record<string, unknown>): Thread {
    return {
      id: r.id as string,
      channelId: r.channel_id as string,
      customerId: r.customer_id as string,
      threadKey: r.thread_key as string,
      subject: (r.subject as string) ?? undefined,
      status: r.status as Thread['status'],
      unread: Number(r.unread),
      lastMessageAt: r.last_message_at as string,
      createdAt: r.created_at as string,
    };
  }

  private mapCustomer(r: Record<string, unknown>): Customer {
    return {
      id: r.id as string,
      channelId: r.channel_id as string,
      externalId: r.external_id as string,
      name: (r.name as string) ?? undefined,
      phone: (r.phone as string) ?? undefined,
      meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : undefined,
      createdAt: r.created_at as string,
    };
  }

  private mapMessage(r: Record<string, unknown>): Message {
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      direction: r.direction as MessageDirection,
      body: r.body as string,
      channelMessageId: (r.channel_message_id as string) ?? undefined,
      authorName: (r.author_name as string) ?? undefined,
      meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : undefined,
      createdAt: r.created_at as string,
    };
  }

  private mapDraft(r: Record<string, unknown>): Draft {
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      body: r.body as string,
      status: r.status as DraftStatus,
      providerId: (r.provider_id as string) ?? undefined,
      model: (r.model as string) ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }
}
