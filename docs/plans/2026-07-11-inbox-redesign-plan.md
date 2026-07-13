# Plan — Unified Inbox redesign

**Spec:** `docs/plans/2026-07-11-inbox-redesign-spec.md` · **Review:** `docs/REVIEW-UI-2026-07-11.md`

**Method:** TDD per task (RED → GREEN → commit). Every phase ends green on `npx tsc --noEmit` (baseline 4 known errors) + `npx vitest run`, and is verified live in the running app before the next phase starts. Commits are conventional; CSS-only tasks note that in the body.

**Sequencing:** R0 foundations → R1 Find → R2 Read → R3 Reply. R0 is shared plumbing so R1–R3 don't each re-open the store/IPC. Within a phase, store → IPC → renderer.

---

## R0 — Foundations (shared plumbing) · ~½ day

| Task | Files | Test |
|------|-------|------|
| 0.1 `threads.assignee` migration + `Thread.assignee`/`ThreadView.assignee` | `InboxStore.ts` (boot migration + mapThread/toThreadView), `types.ts` | store test: assignee round-trips through `getThreadView`; migration idempotent |
| 0.2 Config fields (`autoDraft`, `autoAdvance`, `staff`, `currentStaff`, `ui`) | `config/Config.ts` | schema test: defaults parse; `autoDraft` defaults false |
| 0.3 Icon set — inline SVG `<Icon name=…>` component (no emoji) | `renderer/Icon.tsx` (new) | render test optional; visual in later phases |

**Gate + commit** `feat(inbox): assignee column + redesign config flags + icon set`

---

## R1 — Find (channel rail + search + scannable rows) · ~1 day

| Task | Files | Test (RED first) |
|------|-------|------------------|
| 1.1 `channelSummaries()` + `countsByTriage(me)` in store | `InboxStore.ts` | counts match the `needsReply`/`isActive` predicates across a seeded multi-channel fixture; muted/closed excluded |
| 1.2 `searchThreads(q, limit)` in store | `InboxStore.ts` | matches name / external_id / phone / message body; DISTINCT thread; empty q → [] |
| 1.3 IPC: `listChannels`, `searchThreads`, `getUiPrefs`/`setUiPrefs` | `shared/inbox-api.ts`, `preload/index.ts`, `main/index.ts` | tsc contract; handler smoke |
| 1.4 `NavRail` component — triage rows + channel groups + counts + status dots + collapse toggle (persist via ui prefs) | `renderer/NavRail.tsx`, `App.tsx`, `styles.css` | — (live verify) |
| 1.5 Filter model → triage-key `|` `{channelId}`; wire `filteredThreads` | `App.tsx` | memo test: channel filter returns only that channel's active threads |
| 1.6 Search box + `⌘K`/`/` focus; results replace list while query non-empty | `App.tsx`, `ThreadList` | — |
| 1.7 Row identity — avatar initials + channel color, media-label chips, hover quick-actions (Done/Assign/Mute) | `renderer/ThreadList.tsx`, `mediaLabel.ts` (new), `styles.css` | unit: `mediaLabel('[10007]')` → Sticker; `[image]` → Photo |

**Live verify:** search finds a customer by phone; clicking Temerloh Shop shows only that number; rail collapses and survives restart.
**Gate + commit** per task or tight group; phase commit `feat(inbox): channel rail + search + scannable rows (R1)`

---

## R2 — Read (context panel + cleaner history) · ~1 day

| Task | Files | Test |
|------|-------|------|
| 2.1 `ContextPanel` — move order cards out of `.detail`; add customer card (stats: orders/spend/returns from Duoke orders + store, buyer id, assignee, other channels) | `renderer/ContextPanel.tsx`, `App.tsx`, `styles.css` | — |
| 2.2 Panel collapsible (`⌘I`) + responsive overlay <1100px; persist `ui.contextOpen` | `App.tsx`, `styles.css` | — |
| 2.3 "Other channels" — same customer on other channels | `InboxStore.ts` `relatedThreads(customerKey)`, IPC | store test: matches by phone/external id across channels |
| 2.4 History polish — day separators, short bubble times, media-label chips in bubbles | `renderer/Conversation.tsx`, `styles.css` | unit: day-grouping helper buckets by local date |
| 2.5 Notes card — per-customer shared note (`customers.note` column + migration) | `InboxStore.ts`, IPC, `ContextPanel` | store test: note round-trips |

**Live verify:** order card sits in the right panel, conversation full-height; customer stats populate; note saves; history shows "Yesterday/Today" + short times.
**Gate + commit** `feat(inbox): customer context panel + history polish (R2)`

---

## R3 — Reply (on-demand AI + assignment + keyboard) · ~1 day

| Task | Files | Test (RED first) |
|------|-------|------------------|
| 3.1 ⚠ Gate auto-draft behind `config.autoDraft` (default off) | `InboxService.ts` `maybeDraft` | test: inbound with autoDraft=false produces NO draft; =true still drafts; notifications fire either way |
| 3.2 Composer "Generate with AI" (`⌘G`) → `regenerateDraft`; empty by default; keep Edited/Send states | `App.tsx`, `renderer/Composer.tsx` | — |
| 3.3 `assignThread` IPC + assignee dropdown (header) + row hover assign; `listStaff`/`setStaff` + settings staff editor | `InboxStore`(done R0), IPC, `App.tsx`, settings modal | store test (R0) covers persistence; handler smoke |
| 3.4 "Assigned to me" triage filter (uses `currentStaff`) | `App.tsx`, `countsByTriage` | memo/store test: only threads where assignee==me |
| 3.5 Keyboard map — `↑↓` select, `⌘⏎` send, `⌘G` generate, `⌘R` regen, `E` done, `Esc` back | `App.tsx` (key handler hook) | unit: reducer maps key → intent |
| 3.6 Auto-advance (opt-in) — after send/done in Needs queue, select next unanswered | `App.tsx` | unit: `nextUnanswered(list, currentId)` picks the following needs-reply thread |
| 3.7 Safety note → footer line; remove permanent banner prominence | `App.tsx`, `styles.css` | — |

**Live verify:** fresh inbound leaves composer empty; Generate fills it; Send paces + goes out; assign a thread → chip + "Assigned to me" count; full keyboard loop works mouse-free.
**Gate + commit** `feat(inbox): on-demand AI + staff assignment + keyboard flow (R3)`

---

## R4 — Deferred (not in this build)

Quick-reply snippet library (content + management UI), bulk select/triage, notification→filter alignment, notes real-time sync across machines, FTS search. Tracked, not scheduled.

---

## Definition of done (whole redesign)

1. Every acceptance criterion in spec §8 demonstrated live in the running app.
2. `tsc` baseline (4) unchanged; all vitest suites green; new logic (search, counts, mediaLabel, on-demand gate, next-unanswered, day-grouping) unit-covered.
3. No emoji in UI chrome (grep the renderer for emoji in JSX outside message rendering).
4. `autoDraft` off by default and documented in-app; old behavior recoverable via settings.
5. Memory updated: redesign shipped, on-demand-AI pipeline change, assignee column, filter model.
