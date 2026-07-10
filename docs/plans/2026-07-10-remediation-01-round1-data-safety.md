# Round 1 — Data Safety & Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. Read
> [00-master](2026-07-10-remediation-00-master.md) first — its Global Constraints and
> Decision Gates (G1, G2) apply to every task here.

**Goal:** No customer message can be silently lost, the team is notified when one arrives,
the app quits clean, the kill switch survives restarts, junk (status stories / empty
bodies) stays out, and unlinking a WhatsApp number purges its inbox data.

**Architecture:** All changes inside existing layers. `InboxStore` gains options +
settings k/v + purge/delete helpers; `InboxService` gains `onInbound` + `dispose()` +
`purgeChannel()`; adapters get input guards; Electron main gets lifecycle + notification
wiring. No new files except tests.

**Tech stack:** unchanged (node:sqlite, vitest, Electron 42). Zero new dependencies.

## Global Constraints

- TDD every core change: failing vitest first, watch it fail, minimal code, watch it pass.
- Gate per task: `npx vitest run` all green + `npx tsc --noEmit` shows only the 4 known
  pre-existing errors. Commit per task.
- `send_audit` rows are never deleted or modified.
- Main-process-only wiring (tasks 6, 7 wiring, 4 wiring, 12 wiring) is not vitest-reachable:
  it ships with typecheck + the Manual Verification checklist at the bottom.
- The dev app restarts cleanly with `OLLAMA_MODEL=gemma3:4b npm run dev`.

---

### Task 1: InboxStore — busy_timeout, options object, read-only mode, audit index

**Files:**
- Modify: `src/core/store/InboxStore.ts:39-44` (constructor)
- Modify: `db/schema.sql` (append one index)
- Test: `tests/store-options.test.ts` (new)

**Interfaces:**
- Produces: `new InboxStore(dbPath?, opts?: { schemaPath?: string; readOnly?: boolean })`
  — second param becomes an options object (old positional `schemaPath` had no external
  callers besides defaults; tests/main/MCP all pass one arg today).
- Produces: read-only stores skip schema exec and reject writes (used by Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/store-options.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore options', () => {
  it('opens read-only: reads work, writes throw, schema exec is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-ro-'));
    const dbPath = join(dir, 'inbox.sqlite');
    const writer = new InboxStore(dbPath); // applies schema
    writer.upsertChannel({ id: 'c1', kind: 'fake', label: 'C1' });
    writer.close();

    const ro = new InboxStore(dbPath, { readOnly: true });
    expect(ro.listThreads()).toEqual([]); // reads fine
    expect(() => ro.upsertChannel({ id: 'c2', kind: 'fake', label: 'C2' })).toThrow(/read.?only/i);
    ro.close();
  });

  it('sets a busy_timeout so cross-process locks wait instead of failing', () => {
    const store = new InboxStore(':memory:');
    expect(store.busyTimeoutMs()).toBe(5000);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run tests/store-options.test.ts`
Expected: FAIL — options object not supported / `busyTimeoutMs is not a function`.

- [ ] **Step 3: Implement**

```ts
// src/core/store/InboxStore.ts — replace the constructor block
export interface InboxStoreOptions {
  schemaPath?: string;
  /** Open without write access and skip schema DDL — for the MCP server. */
  readOnly?: boolean;
}

  constructor(dbPath = ':memory:', opts: InboxStoreOptions = {}) {
    this.db = new DatabaseSync(dbPath, { readOnly: opts.readOnly ?? false });
    // Cross-process safety: the desktop app and the MCP server share this file.
    // Without a busy timeout, overlapping locks fail instantly (SQLITE_BUSY).
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly) {
      const schemaPath = opts.schemaPath ?? resolve(process.cwd(), 'db/schema.sql');
      if (existsSync(schemaPath)) this.db.exec(readFileSync(schemaPath, 'utf8'));
    }
  }

  /** The connection's busy timeout (ms) — exposed for tests/diagnostics. */
  busyTimeoutMs(): number {
    return Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);
  }
```

Append to `db/schema.sql` (after the send_audit index):

```sql
-- countSendsSince filters (channel_id, sent_at) on every send-policy check.
CREATE INDEX IF NOT EXISTS idx_send_audit_channel_time ON send_audit(channel_id, sent_at);
```

Note: `PRAGMA busy_timeout` returns a column named `timeout`. If the assertion fails on
column name, log `store['db'].prepare('PRAGMA busy_timeout').get()` once and match it.
The review's `withBusyRetry` wrapper is deliberately NOT built (YAGNI): busy_timeout +
Task 3's ingest catch cover the real failure path; add retries only if `database is locked`
persists in logs after this round.

- [ ] **Step 4: Verify GREEN** — `npx vitest run` (full suite; pipeline/sync tests confirm
  the signature change broke nothing).

- [ ] **Step 5: Commit** — `fix(store): busy_timeout + read-only mode + send_audit index`

---

### Task 2: MCP server opens the DB read-only, fails friendly when missing

**Files:**
- Modify: `src/mcp/server.ts:25-27`

**Interfaces:**
- Consumes: `InboxStore` options from Task 1.

- [ ] **Step 1: Implement** (main-process/CLI wiring — no vitest harness; verified by smoke)

```ts
// src/mcp/server.ts — imports: add existsSync
import { existsSync } from 'node:fs';

const dbPath =
  process.env.UNIFIED_INBOX_DB ?? join(homedir(), 'Library', 'Application Support', 'unified-inbox', 'inbox.sqlite');
if (!existsSync(dbPath)) {
  console.error(`[unified-inbox mcp] no database at ${dbPath} — launch the desktop app once first.`);
  process.exit(1);
}
// Read-only: this process must never be able to write the shared inbox
// (draft_reply returns text only; approval/sending live in the desktop app).
const store = new InboxStore(dbPath, { readOnly: true });
```

- [ ] **Step 2: Rebuild + smoke**

Run: `npm run build:mcp && node scripts/mcp-test.mjs` (existing smoke script) — expect the
three tools to list and `list_threads` to return rows. Also:
`UNIFIED_INBOX_DB=/nonexistent/x.sqlite node out/mcp/server.mjs` → prints the friendly
error, exit code 1.

- [ ] **Step 3: Gate + commit** — `fix(mcp): open shared DB read-only; friendly missing-DB error`

---

### Task 3: WhatsApp ingest crash-safety — a store error must not drop the message silently

**Files:**
- Modify: `src/core/channels/whatsapp/WhatsAppAdapter.ts:109-123` (handleIncoming)
- Test: `tests/whatsapp-adapter.test.ts` (append)

**Interfaces:**
- Consumes: existing `onMessage` handler contract.

- [ ] **Step 1: Write the failing test**

```ts
// tests/whatsapp-adapter.test.ts — append inside the describe block
it('a throwing ingest handler does not crash the adapter or block later messages', async () => {
  const { client } = makeMock();
  const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
  const got: string[] = [];
  let first = true;
  a.onMessage((m) => {
    if (first) { first = false; throw new Error('db locked'); }
    got.push(m.channelMessageId!);
  });
  await a.start();
  client.emit('message', waMsg({ id: { _serialized: 'boom' }, body: 'x' }));
  client.emit('message', waMsg({ id: { _serialized: 'ok-2' }, body: 'y' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(got).toEqual(['ok-2']); // second message survived; no unhandled rejection
});
```

- [ ] **Step 2: Verify RED** — `npx vitest run tests/whatsapp-adapter.test.ts`
Expected: FAIL — vitest reports an unhandled rejection from the first emit.

- [ ] **Step 3: Implement** — wrap the handler call in `handleIncoming`:

```ts
    const n = normalizeWaMessage(msg);
    try {
      await this.handler?.({
        channelId: this.channel.id,
        from: { externalId: stripWaId(msg.from), phone: stripWaId(msg.from) },
        threadKey: msg.from,
        body: n.body,
        channelMessageId: n.channelMessageId,
        timestamp: n.timestamp,
        raw: msg,
      });
    } catch (e) {
      // Never let a store/pipeline error become an unhandled rejection that
      // silently drops the customer's message — log loud; backfill re-syncs it.
      console.error(`[wa:${this.number.id}] ingest failed for ${n.channelMessageId}:`, (e as Error).message);
    }
```

- [ ] **Step 4: Verify GREEN**, full suite. **Step 5: Commit** —
`fix(whatsapp): ingest errors are caught + logged, not silently dropped`

---

### Task 4: Notifications + dock badge (G2 defaults: all channels, inbound, ≤10 min old)

**Files:**
- Modify: `src/core/InboxService.ts` (deps + ingest + syncChannel)
- Modify: `src/core/store/InboxStore.ts` (totalUnread)
- Modify: `src/main/index.ts` (wiring), `src/preload/index.ts`, `src/shared/inbox-api.ts`,
  `src/renderer/App.tsx` (select-thread listener)
- Test: `tests/inbox-pipeline.test.ts`, `tests/inbox-sync.test.ts` (append)

**Interfaces:**
- Produces: `InboxServiceDeps.onInbound?: (e: InboundEvent) => void` with
  `InboundEvent = { threadId; channelId; channelLabel; customerName; body; at }` (all string).
- Produces: `InboxStore.totalUnread(): number`.
- Produces: IPC push `inbox:select` (main → renderer) + `InboxApi.onSelectThread(cb): () => void`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/inbox-pipeline.test.ts — append
it('fires onInbound exactly once per NEW inbound message (not on duplicates)', async () => {
  const events: Array<{ threadId: string; customerName: string; body: string }> = [];
  const config = AppConfigSchema.parse({ defaultProvider: 'echo' });
  const store = new InboxStore(':memory:');
  const router = new LlmRouter(config, { echo: new EchoProvider() });
  const service = new InboxService({ store, router, config, onInbound: (e) => events.push(e) });
  const fake = new FakeAdapter({ id: 'fake:demo', label: 'Demo channel' });
  service.registerChannel(fake);
  await service.start();

  const inbound = { channelId: 'fake:demo', from: { externalId: 'c1', name: 'Aisha' }, threadKey: 't1', body: 'hello?', channelMessageId: 'dup-1', timestamp: new Date().toISOString() };
  await service.ingest(inbound);
  await service.ingest(inbound); // duplicate delivery
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ customerName: 'Aisha', body: 'hello?' });
  expect(store.totalUnread()).toBe(1);
});
```

```ts
// tests/inbox-sync.test.ts — append (mirror that file's existing makeService/adapter pattern)
it('fires onInbound for new inbound arriving via syncChannel, but not on re-sync', async () => {
  // build service exactly as this file's other tests do, passing onInbound spy in deps;
  // seed the fake pull adapter with one inbound history message;
  // await service.syncChannel(id) twice; expect spy called exactly once.
});
```
(The sync test body follows the file's existing helper pattern — write it against the real
helpers in that file, asserting the once-only + shape contract shown above.)

- [ ] **Step 2: Verify RED** — `onInbound` unknown / `totalUnread is not a function`.

- [ ] **Step 3: Implement core**

```ts
// src/core/InboxService.ts
export interface InboundEvent {
  threadId: string; channelId: string; channelLabel: string;
  customerName: string; body: string; at: string;
}
export interface InboxServiceDeps {
  store: InboxStore; router: LlmRouter; config: AppConfig;
  /** Fired once per newly-inserted inbound message (push or sync path). */
  onInbound?: (e: InboundEvent) => void;
}
// constructor: this.onInbound = deps.onInbound;
// in ingest(), right after `if (!inserted) return;`:
    this.onInbound?.({
      threadId: thread.id, channelId: msg.channelId,
      channelLabel: this.channels.get(msg.channelId)?.channel.label ?? msg.channelId,
      customerName: msg.from.name ?? msg.from.externalId,
      body: msg.body, at: msg.timestamp ?? new Date().toISOString(),
    });
// in syncChannel(), inside the history loop, after `if (inserted) messages++;`:
    if (inserted && m.direction === 'inbound') {
      this.onInbound?.({
        threadId: thread.id, channelId,
        channelLabel: adapter.channel.label,
        customerName: d.participant.name ?? d.participant.externalId,
        body: m.body, at: m.timestamp ?? new Date().toISOString(),
      });
    }
```

```ts
// src/core/store/InboxStore.ts — with the other view helpers
  totalUnread(): number {
    return Number((this.db.prepare(`SELECT COALESCE(SUM(unread), 0) AS n FROM threads`).get() as { n: number }).n);
  }
```

- [ ] **Step 4: Verify GREEN** (core tests).

- [ ] **Step 5: Wire Electron main (typecheck-verified; manual check below)**

```ts
// src/main/index.ts — imports: add Notification to the electron import
let store: InboxStore; // hoist next to `service` (module scope)

function updateBadge(): void {
  if (process.platform !== 'darwin') return;
  const n = store.totalUnread();
  app.dock?.setBadge(n > 0 ? String(n) : '');
}

function notifyInbound(e: InboundEvent): void {
  updateBadge();
  // G2: only messages fresher than 10 min (suppresses backfill storms on link/sync)
  if (Date.now() - new Date(e.at).getTime() > 10 * 60_000) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `${e.customerName} · ${e.channelLabel}`, body: e.body.slice(0, 120) });
  n.on('click', () => { win?.show(); win?.focus(); win?.webContents.send('inbox:select', e.threadId); });
  n.show();
}

// bootCore: store = new InboxStore(dbPath);  (assign the hoisted var)
// service = new InboxService({ store, router, config, onInbound: notifyInbound });
// registerIpc approveAndSend handler: call updateBadge() after the send resolves.
```

```ts
// src/shared/inbox-api.ts — add to InboxApi:
  /** Subscribe to main-process "open this thread" pushes (notification clicks). */
  onSelectThread(cb: (threadId: string) => void): () => void;
// src/preload/index.ts — add:
  onSelectThread: (cb) => {
    const l = (_e: unknown, threadId: string) => cb(threadId);
    ipcRenderer.on('inbox:select', l);
    return () => ipcRenderer.removeListener('inbox:select', l);
  },
// src/renderer/App.tsx — add effect:
  useEffect(() => inbox.onSelectThread((id) => setSelectedId(id)), []);
```

- [ ] **Step 6: Full gate + commit** — `feat(inbox): macOS notifications + dock badge on new inbound`

---

### Task 5: approveAndSend — capture the approved draft BEFORE the (slow) send

**Files:**
- Modify: `src/core/InboxService.ts:157-191` (approveAndSend)
- Test: `tests/inbox-pipeline.test.ts` (append)

**Interfaces:** unchanged externally.

- [ ] **Step 1: Write the failing test**

```ts
// tests/inbox-pipeline.test.ts — append
it('a draft created DURING the send is not marked sent (audit points at the approved draft)', async () => {
  const { service, store } = makeService();
  await service.start();
  await service.ingest({ channelId: 'fake:demo', from: { externalId: 'c1', name: 'Aisha' }, threadKey: 't1', body: 'hi', channelMessageId: 'm1' });
  const threadId = service.listThreads()[0]!.thread.id;
  const approved = store.getLatestDraft(threadId)!;

  // Replace the 'fake:demo' adapter with one whose send() simulates a concurrent
  // inbound → new draft mid-send. (registerChannel under the same id replaces it.)
  service.registerChannel({
    channel: { id: 'fake:demo', kind: 'fake' as const, label: 'Racy' },
    async start() {}, async stop() {}, onMessage() {},
    async listThreads() { return []; }, async getHistory() { return []; },
    async health() { return { connected: true, banRisk: 'low' as const }; },
    send: async () => {
      store.saveDraft({ threadId, body: 'sneaky mid-send draft' });
      return { channelMessageId: 'x1', sentAt: new Date().toISOString() };
    },
  });

  await service.approveAndSend(threadId, { body: approved.body, approvedBy: 'human:ui' });

  expect(store.listSendAudit(threadId)[0]!.draftId).toBe(approved.id);
  const latest = store.getLatestDraft(threadId)!;
  expect(latest.body).toBe('sneaky mid-send draft');
  expect(latest.status).toBe('suggested'); // NOT flipped to sent
});
```

- [ ] **Step 2: Verify RED** — the sneaky draft currently ends `sent` and audit points at it.

- [ ] **Step 3: Implement** — in `approveAndSend`, move the lookup above the send:

```ts
    const draft = this.store.getLatestDraft(threadId); // capture BEFORE the slow send
    const out: OutboundMessage = { threadKey: view.thread.threadKey, body: opts.body };
    const res = await adapter.send(out);
    this.store.recordOutbound({ threadId, body: opts.body, channelMessageId: res.channelMessageId, createdAt: res.sentAt });
    if (draft) this.store.setDraftStatus(draft.id, 'sent');
    this.store.recordSendAudit({ threadId, channelId: view.channel.id, draftId: draft?.id, ... });
```

- [ ] **Step 4: GREEN + full suite. Step 5: Commit** —
`fix(inbox): capture approved draft before send — mid-send drafts no longer mis-marked`

---

### Task 6: OllamaProvider request timeout

**Files:**
- Modify: `src/core/llm/OllamaProvider.ts` (options + fetch)
- Test: `tests/ollama-provider.test.ts` (append)

**Interfaces:**
- Produces: `OllamaProviderOptions.timeoutMs?: number` (default 30_000).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ollama-provider.test.ts — append
it('aborts a hung request after timeoutMs', async () => {
  const hung: typeof fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
  const p = new OllamaProvider({ fetchFn: hung, timeoutMs: 25 });
  await expect(
    p.draftReply({ thread: { id: 't', channelId: 'c', channelKind: 'whatsapp' }, history: [{ role: 'customer', text: 'hi', at: 'now' }], systemPrompt: 's' }),
  ).rejects.toThrow(/abort|timed?\s?out/i);
});
```

- [ ] **Step 2: RED** (currently hangs → vitest 5s timeout fails the test — acceptable RED).

- [ ] **Step 3: Implement**

```ts
// options: timeoutMs?: number
// constructor: this.timeoutMs = opts.timeoutMs ?? 30_000;
// in draftReply fetch init:
      signal: AbortSignal.timeout(this.timeoutMs),
```

- [ ] **Step 4: GREEN + full suite. Step 5: Commit** —
`fix(llm): 30s abort timeout on Ollama requests — hung model can no longer stall syncs`

---

### Task 7: 60s interval single-flight + bootDuoke reentrancy latch (main only)

**Files:**
- Modify: `src/main/index.ts:93-99` (bootDuoke guard), `:198-205` (interval)

- [ ] **Step 1: Implement**

```ts
let duokeBooting = false;
async function bootDuoke(): Promise<void> {
  if (duokeBooting || duokeChannelIds.length) return;
  duokeBooting = true;
  try {
    /* existing body from `duokeClient = new DuokeClient()` down */
  } finally {
    duokeBooting = false;
  }
}

// replace the setInterval block:
let duokeTick = false;
syncTimer = setInterval(() => {
  if (duokeTick) return; // single-flight: a slow sync must not stack another
  duokeTick = true;
  void (duokeChannelIds.length ? syncDuoke().then(() => ensureDuokeSend()) : bootDuoke())
    .catch(() => {})
    .finally(() => { duokeTick = false; });
}, 60_000);
```

(`syncTimer` is declared in Task 8 — if executing this task first, declare
`let syncTimer: ReturnType<typeof setInterval> | undefined;` at module scope now.)

- [ ] **Step 2: Gate** — `npx tsc --noEmit` (no new errors) + full vitest.
- [ ] **Step 3: Manual check** — run dev; logs show one `[duoke] synced` group per minute,
  never interleaved duplicates. **Commit:** `fix(main): single-flight duoke sync + boot latch`

---

### Task 8: Shutdown path — clean quit kills Chromes, closes DB, clears interval

**Files:**
- Modify: `src/core/InboxService.ts` (dispose), `src/main/index.ts` (before-quit, win guard)
- Test: `tests/inbox-pipeline.test.ts` (append)

**Interfaces:**
- Produces: `InboxService.dispose(): Promise<void>` — stops all adapters then closes the store.

- [ ] **Step 1: Failing test**

```ts
it('dispose() stops adapters and closes the store', async () => {
  const { service, store } = makeService();
  let stopped = false;
  service.registerChannel({
    channel: { id: 'x:1', kind: 'fake' as const, label: 'X' },
    async start() {}, async stop() { stopped = true; }, onMessage() {},
    async listThreads() { return []; }, async getHistory() { return []; },
    async send() { return { channelMessageId: 'i', sentAt: 'now' }; },
    async health() { return { connected: true, banRisk: 'low' as const }; },
  });
  await service.dispose();
  expect(stopped).toBe(true);
  expect(() => store.upsertChannel({ id: 'y', kind: 'fake', label: 'Y' })).toThrow(); // db closed
});
```

- [ ] **Step 2: RED.** **Step 3: Implement**

```ts
// InboxService
  /** Stop every adapter (kills WA puppeteer Chromes) and close the DB. Idempotent-ish. */
  async dispose(): Promise<void> {
    await this.stop();
    this.store.close();
  }
```

```ts
// src/main/index.ts
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  if (syncTimer) clearInterval(syncTimer);
  duokeSendDriver?.close();
  void service.dispose().catch(() => {}).finally(() => app.exit(0));
});

// createWindow(): after win.on('ready-to-show', ...):
  win.on('closed', () => { win = undefined; }); // macOS: stop sending to a destroyed window
```

- [ ] **Step 4: GREEN + typecheck.**
- [ ] **Step 5: Manual check** — link a WA number, quit the app (Cmd+Q), then
  `pgrep -fl "Chrome for Testing"` → **no output**; relaunch → number auto-relinks.
- [ ] **Step 6: Commit** — `fix(main): clean shutdown — stop adapters, close DB, clear timers`

---

### Task 9: Kill switch persists across restarts

**Files:**
- Modify: `db/schema.sql` (settings table), `src/core/store/InboxStore.ts` (get/setSetting),
  `src/core/channels/whatsapp/WhatsAppGuard.ts` (seams),
  `src/main/WhatsAppManager.ts` (forward opts), `src/main/index.ts` (wire to store)
- Test: `tests/send-audit-count.test.ts` → rename-scope stays; add `tests/store-settings.test.ts`;
  `tests/whatsapp-guard.test.ts` (append)

**Interfaces:**
- Produces: `InboxStore.getSetting(key): string | undefined`, `setSetting(key, value): void`.
- Produces: `WhatsAppGuardOptions.initialKilled?: boolean; onKillChange?: (on: boolean) => void`
  and the same two forwarded through `WhatsAppManagerOptions`.

- [ ] **Step 1: Failing tests**

```ts
// tests/store-settings.test.ts
import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore settings k/v', () => {
  it('roundtrips and overwrites', () => {
    const s = new InboxStore(':memory:');
    expect(s.getSetting('wa.kill')).toBeUndefined();
    s.setSetting('wa.kill', '1');
    expect(s.getSetting('wa.kill')).toBe('1');
    s.setSetting('wa.kill', '0');
    expect(s.getSetting('wa.kill')).toBe('0');
  });
});
```

```ts
// tests/whatsapp-guard.test.ts — append
it('starts killed from initialKilled and reports kill changes', async () => {
  const changes: boolean[] = [];
  const g = new WhatsAppGuard({
    numbers: [{ id: 'num-1', label: 'WA1' }],
    countRecentSends: () => 0,
    initialKilled: true,
    onKillChange: (on) => changes.push(on),
  });
  expect(g.isKilled()).toBe(true);
  expect((await g.policyFor('num-1')!.check()).allowed).toBe(false);
  g.setKill(false);
  expect(changes).toEqual([false]);
});
```

- [ ] **Step 2: RED.** **Step 3: Implement**

```sql
-- db/schema.sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

```ts
// InboxStore
  getSetting(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
```

```ts
// WhatsAppGuard: opts + constructor `this.killed = opts.initialKilled ?? false;`
// setKill: this.killed = on; this.onKillChange?.(on);
// WhatsAppManager: add both to WhatsAppManagerOptions, pass into new WhatsAppGuard({...}).
// main/index.ts manager construction:
    initialKilled: store.getSetting('wa.kill') === '1',
    onKillChange: (on) => store.setSetting('wa.kill', on ? '1' : '0'),
```

- [ ] **Step 4: GREEN + full suite. Step 5: Commit** —
`fix(whatsapp): kill switch persists across app restarts`

---

### Task 10: status@broadcast / newsletter filter (live path parity) + boot sweep

**Files:**
- Modify: `src/core/channels/whatsapp/normalize.ts` (isInboxWaChat),
  `src/core/channels/whatsapp/WhatsAppAdapter.ts` (handleIncoming + listThreads),
  `src/core/store/InboxStore.ts` (deleteThreadsByKey + private cascade helper),
  `src/main/index.ts` (one-line boot sweep)
- Test: `tests/whatsapp-normalize.test.ts`, `tests/whatsapp-adapter.test.ts`,
  `tests/store-purge.test.ts` (new — shared with Task 12)

**Interfaces:**
- Produces: `isInboxWaChat(chatId: string): boolean` (normalize.ts export).
- Produces: `InboxStore.deleteThreadsByKey(threadKey): { threads: number; messages: number }`
  and private `deleteThreadRows(threadIds: string[]): number` (reused by Task 12).

- [ ] **Step 1: Failing tests**

```ts
// tests/whatsapp-normalize.test.ts — append
it('isInboxWaChat rejects groups, broadcasts (incl. status), and newsletters', () => {
  expect(isInboxWaChat('60123@c.us')).toBe(true);
  expect(isInboxWaChat('96971972935865@lid')).toBe(true);
  expect(isInboxWaChat('123@g.us')).toBe(false);
  expect(isInboxWaChat('status@broadcast')).toBe(false);
  expect(isInboxWaChat('99@broadcast')).toBe(false);
  expect(isInboxWaChat('abc@newsletter')).toBe(false);
});

// tests/whatsapp-adapter.test.ts — append
it('does not ingest status@broadcast or newsletter messages', async () => {
  const { client } = makeMock();
  const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
  const got: unknown[] = [];
  a.onMessage((m) => { got.push(m); });
  await a.start();
  client.emit('message', waMsg({ from: 'status@broadcast', body: 'story' }));
  client.emit('message', waMsg({ from: 'x@newsletter', body: 'promo' }));
  client.emit('message', waMsg({ from: '60123@c.us', id: { _serialized: 'real' }, body: 'hi' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(got).toHaveLength(1);
});

// tests/store-purge.test.ts (new)
it('deleteThreadsByKey removes the thread + its messages + drafts, leaves others', () => {
  const s = new InboxStore(':memory:');
  s.upsertChannel({ id: 'whatsapp:num-1', kind: 'whatsapp', label: 'WA' });
  const c = s.upsertCustomer('whatsapp:num-1', 'status', 'status');
  const t1 = s.findOrCreateThread('whatsapp:num-1', c.id, 'status@broadcast');
  s.recordInbound({ threadId: t1.id, body: '[video]', channelMessageId: 's1' });
  s.saveDraft({ threadId: t1.id, body: 'junk draft' });
  const c2 = s.upsertCustomer('whatsapp:num-1', '60123', 'Real');
  const t2 = s.findOrCreateThread('whatsapp:num-1', c2.id, '60123@c.us');
  s.recordInbound({ threadId: t2.id, body: 'hi', channelMessageId: 'r1' });

  const r = s.deleteThreadsByKey('status@broadcast');
  expect(r.threads).toBe(1);
  expect(s.getThreadView(t1.id)).toBeUndefined();
  expect(s.getHistory(t2.id)).toHaveLength(1); // untouched
});
```

- [ ] **Step 2: RED.** **Step 3: Implement**

```ts
// normalize.ts
const NON_INBOX_CHAT = /(@g\.us|@broadcast|@newsletter)$/;
/** 1:1 customer chats only — no groups, status/broadcasts, or channels/newsletters. */
export function isInboxWaChat(chatId: string): boolean {
  return !NON_INBOX_CHAT.test(chatId);
}

// WhatsAppAdapter.handleIncoming: replace the group check
    if (!isInboxWaChat(msg.from)) return; // groups / status / newsletters are not inbox chats
// WhatsAppAdapter.listThreads filter:
      .filter((c) => !c.isGroup && isInboxWaChat(c.id._serialized))
```

```ts
// InboxStore — cascade helper + by-key delete (FK order: drafts → messages → thread)
  private deleteThreadRows(threadIds: string[]): number {
    let messages = 0;
    for (const id of threadIds) {
      this.db.prepare(`DELETE FROM drafts WHERE thread_id = ?`).run(id);
      messages += Number(this.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(id).changes);
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    }
    return messages;
  }

  /** Remove every thread with this thread_key (any channel) + its messages/drafts. */
  deleteThreadsByKey(threadKey: string): { threads: number; messages: number } {
    const ids = (this.db.prepare(`SELECT id FROM threads WHERE thread_key = ?`).all(threadKey) as { id: string }[]).map((r) => r.id);
    return { threads: ids.length, messages: this.deleteThreadRows(ids) };
  }
```

```ts
// main/index.ts bootCore, after the demo-seed block:
  const swept = store.deleteThreadsByKey('status@broadcast'); // junk from the pre-filter era
  if (swept.threads) console.log(`[inbox] swept ${swept.threads} status thread(s), ${swept.messages} messages`);
```

- [ ] **Step 4: GREEN + full suite. Step 5: Commit** —
`fix(whatsapp): status/newsletter chats filtered on live path; boot sweep removes old junk`

---

### Task 11: Empty-body handling — placeholders for non-media types, drop true empties

**Files:**
- Modify: `src/core/channels/whatsapp/normalize.ts:49`,
  `src/core/channels/whatsapp/WhatsAppAdapter.ts` (handleIncoming + getHistory)
- Test: `tests/whatsapp-normalize.test.ts`, `tests/whatsapp-adapter.test.ts`

**Interfaces:** unchanged externally.

- [ ] **Step 1: Failing tests**

```ts
// tests/whatsapp-normalize.test.ts — append
it('labels typed non-media messages and leaves true empties empty', () => {
  const base = { id: { _serialized: 'm' }, from: '1@c.us', to: 'me', fromMe: false, timestamp: 1700000000, hasMedia: false };
  expect(normalizeWaMessage({ ...base, body: '', type: 'location' }).body).toBe('[location]');
  expect(normalizeWaMessage({ ...base, body: '', type: 'order' }).body).toBe('[order]');
  expect(normalizeWaMessage({ ...base, body: '', type: 'chat' }).body).toBe('');
  expect(normalizeWaMessage({ ...base, body: 'real', type: 'chat' }).body).toBe('real');
});

// tests/whatsapp-adapter.test.ts — append
it('drops empty-bodied messages from ingest and history', async () => {
  const { client, histories } = makeMock();
  histories['60123@c.us'] = [
    waMsg({ id: { _serialized: 'h1' }, body: 'real', type: 'chat' }),
    waMsg({ id: { _serialized: 'h2' }, body: '', type: 'chat' }),
  ];
  const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
  expect((await a.getHistory('60123@c.us')).map((m) => m.channelMessageId)).toEqual(['h1']);

  const got: unknown[] = [];
  a.onMessage((m) => { got.push(m); });
  await a.start();
  client.emit('message', waMsg({ id: { _serialized: 'e1' }, body: '', type: 'chat' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(got).toHaveLength(0);
});
```

- [ ] **Step 2: RED.** **Step 3: Implement**

```ts
// normalize.ts:49
  const body =
    msg.body && msg.body.length > 0
      ? msg.body
      : (MEDIA_LABEL[msg.type] ?? (msg.type !== 'chat' ? `[${msg.type}]` : ''));
```

```ts
// WhatsAppAdapter.handleIncoming — after `const n = normalizeWaMessage(msg);`
    if (!n.body) return; // nothing displayable — don't store blank bubbles or draft on them
// WhatsAppAdapter.getHistory — chain after .map(...):
      .filter((m) => m.body !== '');
```

- [ ] **Step 4: GREEN + full suite. Step 5: Commit** —
`fix(whatsapp): typed placeholders for non-media messages; blank bubbles dropped`

---

### Task 12: Disconnect purges the number's inbox data (⛔ G1 copy)

**Files:**
- Modify: `src/core/store/InboxStore.ts` (purgeChannelData — reuses Task 10's helper),
  `src/core/InboxService.ts` (purgeChannel proxy),
  `src/main/WhatsAppManager.ts:97-119` (disconnect), `src/renderer/App.tsx:154-160` (copy)
- Test: `tests/store-purge.test.ts`, `tests/inbox-pipeline.test.ts`

**Interfaces:**
- Produces: `InboxStore.purgeChannelData(channelId): { threads: number; messages: number }`
  (keeps the `channels` row and ALL `send_audit` rows), `InboxService.purgeChannel(channelId)`.

- [ ] **Step 1: Failing tests**

```ts
// tests/store-purge.test.ts — append
it('purgeChannelData removes threads/messages/drafts/customers for ONE channel, keeps audit + others', () => {
  const s = new InboxStore(':memory:');
  for (const ch of ['whatsapp:num-1', 'whatsapp:num-2']) {
    s.upsertChannel({ id: ch, kind: 'whatsapp', label: ch });
    const c = s.upsertCustomer(ch, `cust-${ch}`, 'C');
    const t = s.findOrCreateThread(ch, c.id, `${ch}-t1`);
    s.recordInbound({ threadId: t.id, body: 'hi', channelMessageId: `${ch}-m1` });
    s.saveDraft({ threadId: t.id, body: 'draft' });
    s.recordSendAudit({ threadId: t.id, channelId: ch, body: 'sent reply', sentAt: '2026-07-10T00:00:00.000Z' });
  }
  const before = s.countSendsSince('whatsapp:num-1', '1970-01-01T00:00:00.000Z');

  const r = s.purgeChannelData('whatsapp:num-1');
  expect(r.threads).toBe(1);
  expect(s.listThreads().map((t) => t.channel.id)).toEqual(['whatsapp:num-2']);
  // anti-ban ledger untouched — disconnect→reconnect cannot reset the cap
  expect(s.countSendsSince('whatsapp:num-1', '1970-01-01T00:00:00.000Z')).toBe(before);
});
```

- [ ] **Step 2: RED.** **Step 3: Implement**

```ts
// InboxStore
  /**
   * Owner-requested (2026-07-10): unlinking a channel deletes its inbox data.
   * Removes threads/messages/drafts/customers for the channel. Deliberately KEEPS
   * the channels row and every send_audit row — the audit is the anti-ban ledger;
   * purging it would let disconnect→reconnect reset the daily cap.
   */
  purgeChannelData(channelId: string): { threads: number; messages: number } {
    const ids = (this.db.prepare(`SELECT id FROM threads WHERE channel_id = ?`).all(channelId) as { id: string }[]).map((r) => r.id);
    const messages = this.deleteThreadRows(ids);
    this.db.prepare(`DELETE FROM customers WHERE channel_id = ?`).run(channelId);
    return { threads: ids.length, messages };
  }

// InboxService
  /** Remove a channel's stored conversations (send_audit is kept). */
  purgeChannel(channelId: string): { threads: number; messages: number } {
    return this.store.purgeChannelData(channelId);
  }
```

```ts
// WhatsAppManager.disconnect — at the end of the method (after the try/catch teardown):
    if (wasReady) {
      try {
        const purged = this.service.purgeChannel(adapter.channel.id);
        console.log(`[wa] ${id} unlinked — purged ${purged.threads} threads, ${purged.messages} messages`);
      } catch (err) {
        console.error(`[wa] purge ${id}:`, (err as Error).message);
      }
      this.onChange();
    }
```

```ts
// App.tsx disconnectWa — G1 copy (default approved wording):
    const msg = linked
      ? "Unlink this WhatsApp number? This removes it from your phone's Linked Devices and deletes all its conversations from this inbox. Chats still on the phone re-import if you re-link."
      : 'Stop connecting this number?';
```

- [ ] **Step 4: GREEN + full suite + typecheck.**
- [ ] **Step 5: Manual check** — disconnect a linked number in the panel → its threads
  vanish from the list; WhatsApp tab count drops; re-link → recent chats re-import.
- [ ] **Step 6: Commit** — `feat(whatsapp): unlinking a number purges its inbox data (audit kept)`

---

## Round 1 manual verification checklist (before reporting done)

1. `npx vitest run` — all green. `npx tsc --noEmit` — only the 4 known errors.
2. Fresh dev launch: no `database is locked` lines across 5 minutes with the MCP server
   running simultaneously (`npm run mcp` in another terminal).
3. Send yourself a WhatsApp message → macOS notification appears, dock badge increments,
   clicking the notification opens the thread.
4. Post a WhatsApp status from another phone → NO new thread appears.
5. Cmd+Q → `pgrep -fl "Chrome for Testing"` empty; relaunch → numbers auto-relink; kill
   switch state survived the restart (toggle it ON before quitting to verify).
6. Disconnect one number → its conversations disappear; `send_audit` row count unchanged
   (`sqlite3 ~/Library/Application\ Support/unified-inbox/inbox.sqlite 'SELECT COUNT(*) FROM send_audit'` before/after).
7. Update README status table (Round 1 line) and STOP — report to owner.
