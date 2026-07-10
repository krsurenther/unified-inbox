# Round 2 — Triage Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. **Freshness rule (master):** Round 1 changes these same
> files — at round start, expand each task below to bite-sized RED→GREEN steps against the
> then-current code before executing. Scope, interfaces, tests, and acceptance below are
> LOCKED; only line-level detail is deferred.

**Goal:** Turn the viewer into a workflow: staff can see what needs a reply, clear it,
trust their edits, and always know why something isn't sending.

**Architecture:** `thread.status` + unread finally get wired end-to-end (store → IPC →
UI); drafting gets one shared decision rule (`maybeDraft`); sends move to a per-number
queue in main with pushed status events; channel health becomes an IPC surface.

**Tech stack:** unchanged. Zero new dependencies.

## Global Constraints
Master's constraints apply. Additionally: ⛔ G8 (default filter = "Needs reply") consumed
by Task 3. Mark-read is LOCAL ONLY — never send WhatsApp read receipts.

---

### Task 1: Mark-read on open
**Files:** `InboxStore` (+`markRead`), `InboxService` (proxy), `main/index.ts` (IPC
`inbox:markRead`), `shared/inbox-api.ts`, `preload`, `App.tsx` (call on selection).
**Interfaces:** `InboxStore.markRead(threadId): void` → `UPDATE threads SET unread = 0
WHERE id = ?`; `InboxApi.markRead(threadId): Promise<void>`.
**Tests (write first):** store: unread 2 → markRead → 0, other threads untouched;
pipeline: ingest → unread 1 → markRead → `totalUnread()` 0 (dock badge source).
**Acceptance:** opening a thread clears its badge within one poll; badge total drops.

### Task 2: Thread status — one-click Done / reopen
**Files:** `InboxStore` (+`setThreadStatus`), `InboxService` (proxy), IPC
`inbox:setThreadStatus`, `App.tsx` (Done/Reopen button in detail head + list `Open|Done`
toggle), `styles.css`.
**Interfaces:** `setThreadStatus(threadId, status: 'open'|'closed'|'snoozed')`; `ThreadView`
already carries `thread.status`. List shows `status === 'open'` by default; a small
`Done` segment shows `closed`. (Snoozed: accepted value, no UI this round — YAGNI.)
**Tests:** store: status transitions persist + invalid status throws; pipeline: closed
thread excluded from default list filter helper.
**Acceptance:** click Done → thread leaves the default list; Reopen brings it back; a new
inbound on a closed thread REOPENS it (`recordInbound` sets `status='open'` — test this).

### Task 3: "Needs reply" view (⛔ G8: it is the default)
**Files:** `InboxStore.listThreads` (add `lastMessageDirection` to `ThreadView` via the
existing last-message lookup), `core/types.ts`, `App.tsx` (filter chips: **Needs reply** /
All / Marketplace / WhatsApp / Done + counts).
**Interfaces:** `ThreadView.lastMessageDirection?: 'inbound'|'outbound'`.
**Tests:** store: view exposes direction of latest message; renderer-logic helper
`needsReply(view)` = open && lastMessageDirection === 'inbound' (pure function, unit-test it).
**Acceptance:** default view lists exactly the open threads whose last message is from the
customer; counts on every chip are correct against a seeded store.

### Task 4: Durable draft edits + one drafting rule (`maybeDraft`)
**Files:** `InboxStore` (+`updateDraftBody(draftId, body)` → status `'edited'`,
`updated_at` bump), `InboxService` (extract `private async maybeDraft(threadId, opts:
{ newInbound: boolean })` used by BOTH `ingest` and `syncChannel`; rule: regenerate when
`newInbound` and latest draft is absent/`suggested`/`sent`/`discarded` — NEVER when
`edited`), IPC `inbox:updateDraft`, `App.tsx` (debounced 800ms save; `dirtySinceRegen`
flag so a resolving regenerate never overwrites typed text; composer tag shows
"✍️ Edited by you" vs "✨ AI suggestion · <provider>").
**Interfaces:** `InboxApi.updateDraft(draftId, body): Promise<Draft>`.
**Tests:** store: updateDraftBody sets body+status+updated_at; service: (a) sync with new
inbound regenerates a `suggested` draft (kills review #15's stale-draft hole), (b) sync
does NOT touch an `edited` draft, (c) ingest keeps regenerating suggested drafts as today;
renderer logic: reducer-level test for dirty-flag behavior (full component test lands
Round 4 with jsdom).
**Acceptance:** edit → switch thread → return: text intact (and intact after app restart);
new customer message on an edited thread notifies but does not clobber; a stale marketplace
question gets a fresh draft on next sync.

### Task 5: Conversation scroll behavior
**Files:** `App.tsx` (history container ref), `styles.css` (bottom padding).
**Interfaces:** none new.
**Tests:** none unit-testable pre-jsdom — acceptance is manual + Round 4 component test.
**Acceptance:** opening a thread lands at the NEWEST message; while open, new messages
auto-stick only if already near bottom (≤80px), otherwise position holds; last bubble is
fully visible above the composer.

### Task 6: Thread-list information scent + timestamp correctness
**Files:** `App.tsx` (row layout), `styles.css` (kind chips), new `src/renderer/time.ts`
(`formatRelative(iso): string` — "now", "5m", "3h", "2d", then "12 Jun"), `InboxStore`
(`setThreadSummary`/`recordInbound` make `last_message_at` monotonic via
`MAX(last_message_at, ?)`), `duoke/normalize.ts` (skip `lastMessageAt` when source
timestamp missing — kills the 1970 sink), `App.tsx` detail header (hide raw `@lid`
externalId when it isn't a phone; day-group message timestamps, drop seconds).
**Interfaces:** none new beyond `formatRelative`.
**Tests:** `formatRelative` unit matrix; store: monotonic update ignores older timestamps;
duoke normalize: missing ts → undefined lastMessageAt.
**Acceptance:** every row shows relative time + colored channel chip (WA green /
marketplace orange / other neutral) + `You:` prefix when last message is outbound
(consumes Task 3's direction); no thread ever sorts to 1970.

### Task 7: Per-number send queue — pacing gets a face, busy gets a scope
**Files:** new `src/main/SendQueue.ts` (pure-logic class, fully unit-tested: per-channel
FIFO, one in-flight per channel; calls `service.approveAndSend`), `main/index.ts`
(IPC `inbox:approveAndSend` → validate → enqueue → immediate `{queued: true, etaMs}`;
emit `send:update` events `{threadId, state: 'pacing'|'sent'|'failed', etaMs?, error?}`),
`SendPolicy` (+`delayFor` already public — expose eta via `WhatsAppAdapter` or compute in
queue for WA channels; non-WA channels eta 0), `shared/inbox-api.ts` + `preload`
(`onSendUpdate(cb)`), `App.tsx` (per-thread busy map keyed by threadId; Send button label
"Sending… ~Ns (human pacing)" countdown on `pacing`; inline composer error strip on
`failed` showing the FULL error — replaces the truncated toast; toasts only for success).
**Interfaces:** `InboxApi.approveAndSend` return type becomes
`Promise<{queued: true, etaMs: number}>`; `InboxApi.onSendUpdate(cb): () => void`.
**Tests:** SendQueue: serializes per channel (two enqueues → second starts after first
settles), parallel across channels, failure rejects that item only and emits `failed`,
events fire in order queued→pacing→sent; service layer untouched (approveAndSend still the
only sender — the queue CALLS it).
**Acceptance:** approving a WhatsApp reply returns instantly; the button counts down; other
threads' Send buttons stay live; a cap/kill rejection shows its full reason inline and
persists until dismissed.
**Note:** queue serialization also closes the review's check()/pace() race — two rapid
approvals can no longer both pass the cap check.

### Task 8: Channel health surface — nobody silently disconnects again
**Files:** `InboxService` (+`channelsHealth(): Promise<Array<{channelId, label, kind,
health: ChannelHealth}>>` — calls every registered adapter's existing `health()`),
IPC `channels:health` (renderer polls 15s alongside the guard poll), `App.tsx` banners:
Marketplace tab shows "Duoke not connected / session expired — open Duoke and log in"
when duoke channels are absent or unhealthy; composer shows "Drafting unavailable —
<provider> unreachable" when the last draft attempt for the open thread failed,
`InboxService` records `lastDraftError` per thread (in-memory Map, exposed on
`ThreadView` via service layer — NOT stored).
**Interfaces:** `InboxApi.channelsHealth()`; `ThreadView.lastDraftError?: string`
(service-composed, store untouched).
**Tests:** service: health aggregation returns one row per registered channel; draft
failure populates lastDraftError and a later success clears it.
**Acceptance:** stop Ollama → open a needs-reply thread → banner explains drafting is
down (not "No draft yet"); with Duoke closed/logged-out, the Marketplace tab says so.

### Task 9: WhatsApp resilience — reconnect, un-dead Connect, liveness
**Files:** `WhatsAppManager` (on `onDisconnected`: clear `e.adapter`, `unregisterChannel`,
`void adapter.stop()`, schedule capped-backoff reconnect (3 tries: 5s/30s/2m) unless the
disconnect was user-initiated; surface `auth_failure` via a new adapter `onAuthFailure`
callback → state `error` + detail), `WhatsAppAdapter` (+`onAuthFailure` option),
`main/index.ts` (piggyback the 60s tick: for each `ready` number call `client.getState()`
— add `getState` to `WaClient` type + mock — and if not `CONNECTED`, drive the same
disconnected path).
**Interfaces:** `WhatsAppAdapterOptions.onAuthFailure?: (msg: string) => void`;
`WaClient.getState(): Promise<string>`.
**Tests:** adapter: auth_failure fires callback + `connected` false; manager-level logic
extracted into a pure `nextReconnectDelay(attempt): number | undefined` helper (unit-test:
5s, 30s, 2m, then undefined). Full manager state-machine test is Round 4's harness.
**Acceptance:** kill WhatsApp Web session from the phone → app shows `disconnected`,
auto-retries, and the Connect button works on the first click (no silent no-op); a
zombie session (page dead, no event) is detected within ~60s.

### Task 10: Mute non-customer threads (review #24 — suppliers/status must stop drafting)
**Files:** `InboxService` (+`setThreadMuted(threadId, on)` / `isThreadMuted(threadId)`
backed by Round 1's settings k/v — key `mute.<threadId>`, value `'1'` — NO schema change
so existing DBs work pre-migrations; promote to a real `threads.muted` column in Round
4's first migration), `maybeDraft` (return early when muted), `needsReply` helper
(muted ⇒ false), IPC `inbox:setThreadMuted`, `App.tsx` (a "Not a customer" toggle in the
detail head next to Done; muted rows show a small 🔇 and never count as needs-reply).
**Interfaces:** `InboxApi.setThreadMuted(threadId, on): Promise<void>`;
`ThreadView.muted?: boolean` (service-composed from settings).
**Tests:** service: muted thread — new inbound records + notifies onInbound? NO —
decision: muted also suppresses `onInbound` (a supplier ping must not badge the team);
test both: no draft, no onInbound, message still stored; unmute restores both.
**Acceptance:** mute the supplier thread from the live review ("Ada supply tv ni") → no
more Ollama drafts or badge noise from it; it still opens and sends normally if needed.

---

## Round 2 exit checklist
1. Full gate green; no new tsc errors.
2. Manual: the five-chip filter behaves (G8 default = Needs reply); Done/reopen cycle;
   edit-survives-restart; WhatsApp send countdown; pull the Ollama plug and see the banner;
   phone-side unlink triggers visible reconnect attempts.
3. README status table updated; STOP and report.
