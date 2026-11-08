# driftboard: project boundaries and working agreement

- Work only in `/Users/mk-rune/test_projects/12-driftboard`. This is one of fourteen independent repositories.
- Do not read, modify, clean up, or run commands in sibling repositories or the user's configuration.
- Work autonomously: choose sensible defaults and document assumptions; do not ask questions or delegate.
- Never install anything globally or use sudo, Homebrew, launchd, host credentials, or host Docker sockets.
- Dependencies, toolchains, caches, browser binaries, SDKs, temporary files and test data stay in this repository. Preserve the supplied project-local environment. Python packages go in `.venv`.
- `.agent-local/` is ignored, project-local build/runtime state. `.opencode/` is managed orchestration configuration; do not change or remove it or bypass the sandbox.
- Use existing system tools read-only, or install pinned tools under this repository. Do not change shell profiles, user settings, Keychain, or global Git settings.
- Bind test servers to loopback; use ports 22100–22199. Limit build/test workers to two unless a required benchmark explicitly needs more.
- Docker-dependent integration tests must remain reproducible but be reported as unverified here if they require access outside this repository. Do not bypass this boundary.
- Do not touch attached hardware, enroll services, flash firmware, install agents, or alter OS settings. Supply manual checklists for such steps.
- Implement only the current numbered prompt, preserving prior behavior. Run appropriate checks, fix failures, and report genuine limitations without fabricating test or benchmark results.
- Before finishing every numbered turn: stop its servers/watchers, remove scratch outputs, update relevant documentation, and make a local conventional-commit Git commit. Do not push.
- End each turn with a short summary of changes, checks actually run, remaining limitations, and commit hash. The orchestrator will provide the next prompt only after this turn ends.

Extend this file with the project's language-specific architecture and verification commands while retaining these boundaries.

## Project architecture

pnpm-workspace TypeScript monorepo (see `DESIGN.md` for the data model, CRDTs and sync protocol).

| Path                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/crdt`     | Pure CRDT library. Implemented: replica ids, op ids, Lamport/hybrid logical clocks, version vectors, LWW register, add-wins map, text sequence (Fugue tree, `TextSequence`, whose index lookups run on an order-statistic B+ tree, `order-tree.ts`) with a causal delivery buffer, the `Board` document model (add-wins map of notes with LWW fields, per-note text, op log, JSON, change subscription), `BoardHistory` (undo and redo of the local user's own changes by inverse operations), plus a generic convergence harness (`convergence*.ts`, test-only). No runtime deps.                                                                                                                                                                                                                             |
| `packages/protocol` | Sync messages validated with zod (`hello`, `ops`, `ack`, `presence`, `error`; protocol version 3: `ops` travel as binary frames, `encodeFrame`/`parseFrame`, the compact encoding of operations in `binary.ts` and `bytes.ts`) and the sync logic as pure functions: operation store, per-connection session, server `Room` (which also remembers each present replica's latest presence in memory, to tell newcomers). Depends on `@driftboard/crdt`.                                                                                                                                                                                                                                                                                                                                                         |
| `apps/server`       | Node 22 sync server: `ws` WebSockets (one room per unguessable board id, using the protocol's `Room`), `GET /healthz`, `better-sqlite3` in `./.data/` with each board's log as a compacted snapshot (gzipped binary batch; version 1 gzipped JSON is still read) plus a tail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/web`          | React 18 + Vite client: `/` creates a board, `/b/:boardId` is the canvas. Framework-free logic in `src/lib` (text diff, caret, text binding, board store, sync connection, offline storage in IndexedDB through `idb`, write-behind persistence, sync indicator, ephemeral presence: identity, throttled sender, timing-out store; undo/redo keys; viewport, route); thin React in `src/components` and `src/hooks`. Installable offline PWA through `vite-plugin-pwa` (`vite.config.ts`, `src/pwa-manifest.ts`, icons from `scripts/make-icons.mjs`). Component tests use jsdom through `src/test-render.ts`.                                                                                                                                                                                                 |
| `bench`             | Benchmarks (`@driftboard/bench`): the scenarios (`src/*-scenarios.ts`: 100,000 text operations, a board of 1,000 notes with long texts, a sync after a long offline period, tombstone growth, wire sizes), their `vitest bench` files (`*.bench.ts`), the tests that keep the scenarios honest (`scenarios.test.ts`, run by `pnpm test`) and `report.ts`, which prints the tables of `PERFORMANCE.md`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `e2e`               | Playwright end-to-end suite (`@driftboard/e2e`). `tests/*.spec.ts` start the real sync server (fixture `syncServer`, `support/sync-server.ts`, port 22150, own database in `.data/`) and the production web build (`vite preview`, port 22151), and drive 2-3 Chromium contexts on one board through `support/person.ts`; every test ends with `expectConverged` (identical boards in all contexts). Specs: concurrent typing, simultaneous moves, `context.setOffline`, server restart/kill, page reload, and a seeded monkey test (200 random actions; `E2E_SEED`, `E2E_MONKEY_RUNS`). The pure helpers in `support/` (seeded rng, monkey plan and runner, board parsing and comparison, geometry, polling, `SyncServer`) have Vitest unit tests that `pnpm test` runs; the specs run only under `pnpm e2e`. |

The server limits what one connection may send and what a board may hold, and everything that
comes from another replica (or from the disk) is checked, set aside rather than thrown on, and
counted: see "Security and robustness" in `DESIGN.md` before changing `store.ts`, `room.ts`,
`ledger.ts`, `hub.ts`, `rate-limit.ts`, `Board.applyUntrusted` or `CausalBuffer`.

Workspace packages are consumed from source (`exports` points at `src/index.ts`); there is no
separate library build step. The server runs through `tsx`.

## Commands

Run from the repository root. Use pnpm through corepack (`corepack enable`); the version is pinned by
`packageManager`, Node by `.nvmrc` / `engines`.

| Command             | What it does                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies (store in `./.pnpm-store`).                                                                                                        |
| `pnpm build`        | Build every package that defines a `build` script (currently the web app).                                                                              |
| `pnpm test`         | Vitest in every package (at most two workers).                                                                                                          |
| `pnpm lint`         | ESLint (flat config, `eslint.config.js`).                                                                                                               |
| `pnpm typecheck`    | `tsc --noEmit` in every package.                                                                                                                        |
| `pnpm format`       | Prettier write; `pnpm format:check` verifies without writing.                                                                                           |
| `pnpm check`        | `pnpm lint && pnpm typecheck && pnpm test`: the local gate.                                                                                             |
| `pnpm bench`        | `vitest bench` over `bench/src/*.bench.ts` (heavy; never run here).                                                                                     |
| `pnpm bench:report` | `bench/src/report.ts`: each scenario once, as Markdown tables, with heap numbers (`--expose-gc`). About 10 s and 2 GB resident on the author's machine. |
| `pnpm e2e:install`  | Install Playwright's Chromium into the project (`PLAYWRIGHT_BROWSERS_PATH=0`). Once.                                                                    |
| `pnpm e2e`          | Playwright E2E suite: builds the web app, starts both servers, runs the specs (one worker, a few minutes).                                              |
| `pnpm check:all`    | `pnpm check && pnpm e2e`: the full local gate.                                                                                                          |

Dev servers: `pnpm --filter @driftboard/server dev` (ws://127.0.0.1:22100/ws, `GET /healthz`) and
`pnpm --filter @driftboard/web dev` (http://127.0.0.1:22101). Use only loopback ports 22100–22199.

Playwright's browser lives in the project: `pnpm e2e:install` and `pnpm e2e` both set
`PLAYWRIGHT_BROWSERS_PATH=0`. The suite uses ports 22150 (sync server) and 22151 (web preview), so it
can run next to the dev servers; failed tests keep a trace per person in `e2e/test-results/`
(`pnpm --filter @driftboard/e2e exec playwright show-trace <file>`).

## Conventions

- Strict TypeScript everywhere (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and more). Do not loosen it.
- Prettier formatting (`.prettierrc.json`); ESLint flat config; tests with Vitest and fast-check
  (use property tests for CRDT laws).
- Tests are colocated as `*.test.ts(x)` next to the source.
- Every new CRDT gets a `ConvergenceSpec` and a `checkConvergence(spec)` test (1000 runs by default,
  3 replicas, or `replicas: { min: 3, max: 5 }`); see `packages/crdt/src/lww-register.test.ts` for
  the pattern, `text-sequence.test.ts` for an in-place (mutable) state, and `DESIGN.md`
  (Convergence harness).
- Server SQLite files live under `./.data/` (git-ignored). Never write databases elsewhere.

## Rule: `packages/crdt` stays pure

`packages/crdt` must contain no DOM, no Node APIs, no I/O, no `Date.now()` (or any `Date`), no
`Math.random()`, no timers, and no runtime dependencies. Clocks, replica ids and randomness are
injected by the caller (see the `Clock` interface). Enforced by `tsconfig` (`types: []`, no DOM lib)
and by ESLint (`no-restricted-globals`, `no-restricted-imports`, `no-restricted-properties`). Do not
disable those rules.

## Definition of done (every task)

1. `pnpm check` passes (and `pnpm check:all` once E2E exists).
2. New code has tests.
3. Docs are updated (`DESIGN.md`, this file, README) when behaviour or commands change.
4. Give a short summary: what changed, checks actually run, remaining limitations.
5. Make a conventional-commit git commit (`feat:`, `fix:`, `chore:`, `docs:`, ...). Do not push.

## Known state

Turns 1-13 were written with no network access, on throwaway stand-ins for Vitest, fast-check, zod,
better-sqlite3 and `ws`. Turn 14 had network access: the project's tools were installed into the
repository (pnpm 9.15.9 and Node 22.12.0 under `.agent-local/tools`, because the host has Node 26 and
no pnpm; `.agent-local/env.sh` puts them first on `PATH` and points HOME and the caches at
`.agent-local`; both are git-ignored, and any Node 22.12 with pnpm 9 does as well),
`pnpm-lock.yaml` was generated and committed, CI now installs with `--frozen-lockfile`, and
everything ran on the real packages for the first time.

What now runs for real and passes: `pnpm test` in every package (CRDT 349 tests, protocol 176, server
107 including `server.test.ts` over real `ws` and better-sqlite3 and the fuzz test, web 518 including
the component tests on React 18 with jsdom and `storage.test.ts` on fake-indexeddb, bench scenarios
15, e2e helpers 96), `tsc --noEmit` in every package, ESLint and Prettier. That first run found and
fixed real defects of the earlier turns (commit `c005fec`): `IdbBoardStorage.write` left half a
batch behind when a value could not be stored, `NoteCard` kept saying its person was editing a note
that was deleted under it, the bench package's Vitest `benchmark` option was in the wrong place (so
`vitest bench` would have ignored it), and some tests that had only ever agreed with the stand-ins.
In the turn-14 commit the first real `pnpm build` of the web app failed (and so would `pnpm e2e`):
`virtual:pwa-register` imports `workbox-window`, which the app did not declare; it does now.

Still unverified:

- **The `e2e` package (turn 12): no spec has ever run.** Its Chromium is not installed (`pnpm e2e:install`
  has not been run here) and the sandbox has no browser, so not one browser context was
  opened, and neither the production web build under `vite preview`, nor the real server started by
  the `syncServer` fixture, nor `context.setOffline` against the real page has been seen working
  together. What ran: the Vitest unit tests of the pure helpers in `e2e/support/` and the TypeScript
  check of the whole package. The pinned `@playwright/test` 1.49.1 installs. Things most likely to
  need a fix on the first real run, in this order: the selectors and geometry in `support/person.ts`
  (the header grab point `HEADER_GRAB_X`, `elementFromPoint` checks, forced double-click), the
  `webServer` command in `playwright.config.ts` (`vite build/preview --outDir ../../e2e/dist/web`),
  `node --import tsx` starting `apps/server/src/main.ts`, timing in the restart tests (reconnect
  backoff is up to 15 s; `SYNC_TIMEOUT_MS` is 30 s), and the exact-text assertions in
  `concurrent-typing.spec.ts` and `offline.spec.ts`, which rely on `lib/caret.ts` keeping a caret in
  place when text is inserted before it (a failure there is a finding about the app, not the test).
  The suite goes over binary frames and, since turn 14, sends a connection secret in `hello`. Run
  `pnpm e2e:install` once, then `pnpm e2e`; the monkey test prints its seed in its title and attaches
  its plan and per-action report.
- **Nothing has been seen in a browser**: the `.tsx` files are covered by the component tests only.
  Whether the app installs and opens offline has to be checked by hand: build the web app, serve it
  with `preview` (port 22102), then DevTools > Application; and presence by opening one board in two
  browsers.
- `pnpm bench` (`vitest bench`) has not been run. `pnpm bench:report` has, on Node 22.12.
- The numbers in `PERFORMANCE.md` were measured on Node 26.13; a re-run on Node 22.12 after turn 14
  was within about 15% of them on every scenario (not a controlled comparison).

Turn 14 (security and robustness) is described in `DESIGN.md`, "Security and robustness". Its tests
run on the real tools, and so do the fuzz tests (`packages/protocol/src/fuzz.test.ts` against a
`Room`; `apps/server/src/fuzz.test.ts` over real sockets on port 22140), which found two real
problems while they were written. The e2e ports 22150 and 22151 and the server tests' 22110-22139
do not overlap with the fuzz test's 22140.
