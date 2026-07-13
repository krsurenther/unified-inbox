# Spec — Unified Inbox redesign (find/read/reply friction)

**Status:** approved (owner reviewed mockup rev 2, 2026-07-11)
**Companion:** `docs/REVIEW-UI-2026-07-11.md` (friction inventory + rationale), `docs/plans/2026-07-11-inbox-redesign-plan.md` (execution)
**Mockup:** rev 2 — collapsible channel rail, search, customer panel, on-demand AI, staff assignment.

---

## 1. Goal & non-goals

**Goal:** cut the friction in the operator's core loop — *pick a channel → find the customer → read → reply → next* — without touching the sync/draft/approve/send pipeline or the safety gate.

**Non-goals (explicitly out of scope for this work):**
- No rebrand. Dark theme, current palette + system font stay.
- No auth / user accounts. Staff assignment is a routing label, not a login system.
- No change to WhatsApp/Duoke adapters, anti-ban pacing, MCP, or the approve-to-send gate.
- Webstore remains a placeholder channel that only appears once connected.

---

## 2. Locked decisions

| # | Decision | Notes |
|---|----------|-------|
| D1 | **Four zones**: nav rail · thread list · conversation · context panel | grid `216px 296px 1fr 300px`; context panel collapsible |
| D2 | **Nav rail = triage + per-account channels** | Triage (Needs reply / Assigned to me / All / Done) on top; one row per connected account below, grouped WhatsApp / Marketplace; each with status dot + count |
| D3 | **Rail collapses to a 56px icon strip** | chevron at rail foot; collapsed state persisted; unread badge on the inbox icon |
| D4 | **Search** matches name, phone/externalId, and message body | `⌘K` / `/` focuses; store-side SQL |
| D5 | **Orders + customer info move to the right context panel** | conversation reclaims full height; panel toggles with `⌘I` |
| D6 | **AI generation is on-demand only** ⚠ | composer empty until "Generate with AI" (`⌘G`) pressed. `config.autoDraft` (default **false**) gates the old auto-draft. Saves tokens. |
| D7 | **Staff assignment** | assignee chip in header + row-hover assign; "Assigned to me" queue; staff list in settings; `threads.assignee` column |
| D8 | **Auto-advance** after Send/Done in Needs-reply queue | optional, **OFF by default** (`config.autoAdvance`) |
| D9 | **No emoji in UI chrome** | one inline-SVG line-icon set; emoji only inside chat content |
| D10 | **Keyboard**: `↑↓` threads · `⌘⏎` send · `⌘G` generate · `⌘R` regenerate · `E` done · `/` quick replies · `Esc` back | shown in tooltips/kbd hints |

---

## 3. Data model changes

### 3.1 Migration — `threads.assignee`
```sql
ALTER TABLE threads ADD COLUMN assignee TEXT;   -- nullable; staff name string, NULL = unassigned
```
Idempotent boot migration (guard: `PRAGMA table_info(threads)` lacks `assignee`). Mirrors the existing boot-repair pattern in `src/main/index.ts`.

### 3.2 Types (`src/core/types.ts`)
- `Thread` gains `assignee?: string`.
- `ThreadView` gains `assignee?: string` (already carries `channel`, so channel filtering needs no new field).

### 3.3 Config (`src/core/config/Config.ts`, Zod)
```ts
autoDraft: z.boolean().default(false),        // D6 — auto-generate a draft on every inbound
autoAdvance: z.boolean().default(false),      // D8 — jump to next unanswered after send/done
staff: z.array(z.string()).default([]),       // D7 — assignable people
currentStaff: z.string().default(''),         // D7 — who is "me" on this machine ("Assigned to me")
ui: z.object({ railCollapsed: z.boolean().default(false), contextOpen: z.boolean().default(true) }).default({}),
```
All persisted via the existing `persistConfig()`.

---

## 4. Store API additions (`InboxStore`)

| Method | Signature | Behaviour |
|--------|-----------|-----------|
| `searchThreads` | `(q: string, limit=50) => ThreadView[]` | LIKE over `customers.name`, `customers.external_id`, `customers.phone`, and `messages.body`; DISTINCT thread; ordered by `last_message_at DESC`. Empty `q` → `[]`. |
| `channelSummaries` | `() => Array<{ channelId; kind; label; needs; total }>` | one row per channel; `needs` = threads where last message is inbound and status≠closed and not muted; `total` = non-closed threads. Drives the rail. |
| `assignThread` | `(threadId, assignee: string \| null) => void` | sets `threads.assignee`. |
| `getThreadView` / `listThreads` | — | include `assignee` in the mapped view. |
| `countsByTriage` | `() => { needs; mine; all; done }` | server-side counts for the rail triage rows (replaces the renderer-side `counts` memo; `mine` uses `config.currentStaff` passed in). |

"Needs reply" definition stays exactly as the current `needsReply(t)` predicate (last message inbound, not muted, status≠closed) — just moved server-side for correctness at scale.

## 5. IPC contract additions (`InboxApi` + preload + main handlers)

```ts
searchThreads(q: string): Promise<ThreadView[]>;
listChannels(): Promise<ChannelSummary[]>;          // rail rows + counts
assignThread(threadId: string, assignee: string | null): Promise<void>;
listStaff(): Promise<{ staff: string[]; me: string }>;
setStaff(staff: string[], me: string): Promise<{ staff: string[]; me: string }>;
getUiPrefs(): Promise<{ railCollapsed: boolean; contextOpen: boolean; autoDraft: boolean; autoAdvance: boolean }>;
setUiPrefs(p: Partial<UiPrefs>): Promise<UiPrefs>;
```
`regenerateDraft(threadId)` is reused verbatim for the Generate button (no new draft IPC).

## 6. Behavioral change — on-demand AI (D6, the one risk)

Today `InboxService.maybeDraft` auto-generates a draft on every new inbound, from **both** paths:
- push: `ingest()` → `maybeDraft(id, { newInbound: true })` (line ~110)
- pull: `syncChannel()` → `maybeDraft(id, { newInbound })` (line ~235)

Change: `maybeDraft` gains an early return `if (!this.config.autoDraft) return;`. Nothing else in the pipeline changes:
- Inbound is still persisted; **notifications still fire** (they're independent of drafting).
- The composer opens empty; **"Generate with AI"** calls the existing `generateDraft`/`regenerateDraft`.
- The row "draft ready" chip only appears when a draft exists — so with `autoDraft` off it appears only after a human generates one. Correct.
- The durable-edit contract (never overwrite an `edited`/`approved` draft) is unaffected.

Owners who want the old behavior flip `autoDraft` on in settings.

## 7. Renderer structure

`App.tsx` splits into the 4 zones (D1). New components (all in `src/renderer/`, no router — plain conditional render):
- `NavRail` — triage rows + channel groups + collapse toggle; reads `listChannels` + `countsByTriage`.
- `ThreadList` — search box + sort menu + rows (avatar initials, channel color, humanized media chips, hover quick-actions, assignee bubble).
- `Conversation` — header (name/sub + assignee dropdown + Done) + history (day separators, short times, media chips) + composer (Generate button, quick replies, Send).
- `ContextPanel` — customer card (stats, buyer id, assignee, other channels), order cards, notes.

Filter model: `filter` state is either a triage key (`'needs'|'mine'|'all'|'done'`) or `{ channelId: string }`. `filteredThreads` branches on it; sort unchanged.

Media humanizer: `mediaLabel(body, media)` maps `[10007]`-style codes + `[image]`/`[interactive]` placeholders → `{ icon, label }` (Sticker / Photo / Card / File …). Used in list previews and history bubbles.

## 8. Acceptance criteria

- **Find:** typing a name / phone fragment / message word in search narrows the list to matches within ~100ms; clearing restores. Clicking a channel row shows only that account's threads with a live count.
- **Rail:** collapse persists across restart; collapsed rail shows icons + dots + unread badge; nothing clips.
- **Read:** order + customer info render in the right panel, never in the conversation column; conversation uses full height; panel toggles and remembers state.
- **Reply (on-demand):** a fresh inbound produces **no** draft (with `autoDraft` off); pressing Generate fills the composer from the AI; Send goes through the existing gate + pacing.
- **Assign:** assigning a thread sets the assignee, shows the chip in header + row, and moves it into "Assigned to me" when `me` matches; persists.
- **Keyboard:** the loop `↑↓ → ⌘G → ⌘⏎` works without the mouse; `E` marks done; `/` opens quick replies.
- **Chrome:** no emoji in any control/label; emoji still render inside chat messages.
- **Gate:** `tsc` at baseline (4) and all vitest suites green after each phase.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| On-demand AI silently drops a workflow owners rely on | `autoDraft` flag preserves old behavior; call it out in-app the first time the composer is empty |
| `searchThreads` slow at 10k+ messages | LIMIT + index on `messages(thread_id)`; body search is LIKE — fine at current scale, FTS later if needed |
| Assignment without accounts = ambiguous "me" | `currentStaff` set per machine in settings; assignment is advisory routing, not access control |
| Rail filter model churn (union → triage|channel) | keep the existing `needsReply`/`isActive` predicates; only the selector shape changes |
| Scope creep across 3 phases | each phase ships independently behind the gate; R4 (quick replies content, bulk, notes sync) explicitly deferred |
