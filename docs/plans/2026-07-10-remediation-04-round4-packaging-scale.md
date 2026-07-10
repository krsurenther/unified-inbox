# Round 4 — Packaging & Scale Implementation Plan

> **For agentic workers:** superpowers:subagent-driven-development or
> superpowers:executing-plans. **Freshness rule (master) applies** — expand to bite-sized
> steps against the post-Round-3 code before executing. Scope/interfaces/tests/acceptance
> below are LOCKED.

**Goal:** A real installable daily driver: double-clickable .app, event-driven UI, safe
schema evolution, keyboard-speed triage, and tests guarding the surfaces that had none.

## Global Constraints
Master's constraints apply. Decision gates consumed here: ⛔ G7 (electron-builder
devDependency). Task 7's `jsdom` devDependency is a **new gate — ask the owner alongside
G7** (both are dev-only, no runtime deps).

---

### Task 1: Kill the cwd-dependent paths (packaging blockers, review #31a)
**Files:** `main/index.ts` (`.wwebjs_auth` → `join(app.getPath('userData'),
'wa-sessions')`, with a one-time migration: if the old repo-local dir exists and the new
one doesn't, `fs.renameSync` it and log), `InboxStore.ts` + new
`src/core/store/schema.ts` (schema embedded as a string via electron-vite/vite
`import schemaSql from '../../../db/schema.sql?raw'` re-exported; store uses the embedded
string by default, `opts.schemaPath` remains a test-only override), `scripts/build-mcp.mjs`
(esbuild `loader: { '.sql': 'text' }` so the MCP bundle embeds it too).
**Interfaces:** `InboxStoreOptions.schemaPath` semantics: explicit path wins; otherwise
embedded schema; `readOnly` still skips DDL.
**Tests:** store constructed with no cwd access to `db/schema.sql` (chdir a temp dir in
the test) still creates tables; readOnly still skips.
**Acceptance:** app boots with tables and re-links WhatsApp when launched from a cwd that
isn't the repo (`cd / && npm run dev --prefix <repo>`).

### Task 2: Single instance + identity + renderer sandbox
**Files:** `main/index.ts` (`app.requestSingleInstanceLock()` — second instance focuses
the first and exits; guards the SQLite file against double-open), `package.json`
(`productName: "Unified Inbox"`), window/app icon placeholder (`build/icon.icns` — a
simple generated glyph is fine this round), **sandbox re-enable**: `electron.vite.config.ts`
preload `build.rollupOptions.output.format: 'cjs'` (sandboxed preloads can't load ESM —
the only reason `sandbox: false` exists), update the preload path in `createWindow`
(`index.mjs` → `index.cjs`), then set `sandbox: true` in `webPreferences`.
**Tests:** none unit-reachable — manual: launching twice focuses instead of duplicating;
app boots with sandbox on and the `window.inbox` bridge still works (open a thread, send).
**Acceptance:** menu bar says "Unified Inbox", not "Electron"; two launches = one app;
`webPreferences` carries `sandbox: true`.

### Task 3: electron-builder packaging (⛔ G7)
**Files:** `package.json` (devDep `electron-builder`, `build` config: `appId
com.kronoshop.unified-inbox`, mac `dmg`+`zip`, `asarUnpack` for whatsapp-web.js if its
runtime spawn needs it — verify), `scripts` (`dist: electron-vite build && electron-builder`),
`README.md` (install/run section), optional login item toggle deferred until asked (YAGNI).
**Tests:** manual: built .app launches, links WhatsApp, quits clean (Round 1 checklist 5
re-run against the packaged app).
**Acceptance:** a teammate can install from the dmg and run without Node/npm on PATH
(Ollama + Duoke remain separate installs, documented in README).

### Task 4: Push-driven UI + listThreads JOIN (review #33)
**Files:** `InboxService` (+`onChanged?: () => void` in deps, debounced fire from
ingest/sync/approve/markRead/status paths), `main/index.ts` (forward as
`win.webContents.send('inbox:changed')`), `preload` + `shared/inbox-api.ts`
(`onChanged(cb)`), `App.tsx` (refresh on event; poll interval demoted 3s → 30s fallback),
`InboxStore.listThreads` (single SQL: threads JOIN channels JOIN customers + correlated
subqueries for last-message body/direction and latest draft — replaces the 4-per-thread
N+1; `toThreadView` kept only for `getThreadView`).
**Interfaces:** `InboxApi.onChanged(cb): () => void`; `ThreadView` shape unchanged.
**Tests:** store: JOIN version returns byte-identical ThreadViews to a seeded fixture
(write the expectation from the OLD implementation's output before swapping — regression
lock); service: onChanged fires once per mutation batch (debounce test with injected timer).
**Acceptance:** a new inbound renders in the list within ~100ms without waiting for a
poll; CPU stays flat with the window open-idle.

### Task 5: Schema versioning (review #34)
**Files:** `src/core/store/schema.ts` (embedded base schema = version 1),
`InboxStore` constructor (read `PRAGMA user_version`; if 0 on a fresh DB → apply base,
set 1; if <current on an existing DB → run ordered `MIGRATIONS: Array<{to: number;
sql: string}>` inside a transaction, set version; readOnly skips all), `db/schema.sql`
stays the human-readable source that `schema.ts` imports.
**Interfaces:** `MIGRATIONS` exported for tests; current version constant.
**Tests:** fresh DB lands at current version with tables; a v1 fixture DB + a test
migration (add a column) upgrades and preserves rows; readOnly never migrates.
**Acceptance:** future column adds ship as a migration entry, not a silent no-op.

### Task 6: Keyboard-speed triage + in-app confirm (review #29)
**Files:** `App.tsx` (Cmd+Enter sends from the textarea; `j/k`+arrow list navigation with
selection follow; `e` = Done/reopen; autofocus textarea on selection; Esc closes the WA
panel), new `src/renderer/Confirm.tsx` (small themed modal replacing both
`window.confirm` call sites — kill switch + unlink — with the same copy), `styles.css`.
**Interfaces:** none new.
**Tests:** covered by Task 7's jsdom harness (keyboard dispatch → handler effects).
**Acceptance:** a full reply cycle (navigate → read → edit → send → done) works
mouse-free; confirms match the app's theme and can be Esc-dismissed.

### Task 7: The missing test surfaces + repo hygiene (⛔ jsdom devDep)
**Files:**
- `tests/renderer-app.test.tsx` (vitest `environment: 'jsdom'`, mocked `window.inbox`):
  locks (a) draft edit survives thread switch, (b) regenerate never clobbers dirty text,
  (c) markRead fires on open, (d) Simulate button absent when `appInfo.demo` false,
  (e) Cmd+Enter sends.
- `tests/whatsapp-manager.test.ts`: extract manager's client-factory into an injected seam
  (`WhatsAppManagerOptions.createClient?: (id) => WaClient` defaulting to the real
  factory) so the existing scripted fake `WaClient` drives qr→ready→disconnected→
  auto-reconnect→connect-works-again; assert the Round 2 reconnect contract.
- `tests/mcp-server.test.ts`: refactor `src/mcp/server.ts` into `buildServer(store,
  router): McpServer` + a thin stdio `main`; test via
  `InMemoryTransport.createLinkedPair()` from the MCP SDK against a temp seeded DB:
  `list_threads` filters by channel, `get_thread` errors on unknown id, `draft_reply`
  returns text and never writes (row counts unchanged).
- Hygiene: move the 15 one-shot probes into `scripts/diagnostics/` with a 5-line README;
  keep `build-mcp.mjs` + `mcp-test.mjs` at `scripts/`; add `"typecheck"` to the README dev
  loop. (eslint/prettier remain out — separate gate if the owner wants them.)
**Interfaces:** `buildServer` export; manager `createClient` seam.
**Tests:** are the deliverable.
**Acceptance:** `npx vitest run` covers renderer/manager/MCP; suite stays under ~10s;
`scripts/` reads intentional.

---

## Round 4 exit checklist
1. Full gate green (now including jsdom + manager + MCP suites); no new tsc errors.
2. Packaged .app passes the Round 1 manual checklist end-to-end.
3. README: status table shows Rounds 1–4 done; install section reflects the dmg.
4. STOP — report. (Next up per master: Phase 2c webstore adapter.)
