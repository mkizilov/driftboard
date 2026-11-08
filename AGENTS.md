# driftboard: working agreement

## Boundaries

- Work only inside this repository. Do not read, modify, clean up, or run commands in other
  repositories or in the user's configuration.
- Work autonomously: choose sensible defaults and document assumptions instead of stopping to ask.
- Never install anything globally or use sudo, Homebrew, launchd, host credentials, or host Docker
  sockets.
- Dependencies, toolchains, caches, browser binaries, SDKs, temporary files and test data stay in this
  repository. Use the project-local environment (`.agent-local/env.sh`, see Commands) and keep it
  intact. Python packages, if ever needed, go in `.venv`.
- `.agent-local/` is git-ignored, project-local build and runtime state. `.opencode/` and
  `.cortexkit/` are tool-managed local state: do not change or remove them, and do not bypass the
  sandbox.
- Use existing system tools read-only, or install pinned tools under this repository. Do not change
  shell profiles, user settings, Keychain, or global Git settings.
- Bind test servers to loopback and use ports 22100–22199 only. Limit build and test workers to two
  unless a benchmark explicitly needs more.
- Do not operate host Docker. Docker-dependent checks must stay reproducible and be reported as
  unverified where they cannot run.
- Do not touch attached hardware, enroll services, flash firmware, install agents, or alter OS
  settings. Supply manual checklists for such steps.
- Report genuine limitations. Never fabricate test or benchmark results, and never weaken a test to
  make it pass.
- Before finishing any piece of work: stop its servers and watchers, remove scratch outputs, update
  the relevant documentation, and make a local conventional-commit Git commit. Do not push.
- End with a short summary of changes, checks actually run, remaining limitations, and the commit
  hash.

## Project architecture

pnpm-workspace TypeScript monorepo (see `DESIGN.md` for the data model, CRDTs and sync protocol).

| Path                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/crdt`     | Pure CRDT library. Implemented: replica ids, op ids, Lamport/hybrid logical clocks, version vectors, LWW register, add-wins map, text sequence (Fugue tree, `TextSequence`, whose index lookups run on an order-statistic B+ tree, `order-tree.ts`) with a causal delivery buffer, the `Board` document model (add-wins map of notes with LWW fields, per-note text, op log, JSON, change subscription), `BoardHistory` (undo and redo of the local user's own changes by inverse operations), plus a generic convergence harness (`convergence*.ts`, test-only). No runtime deps.                                                                                                                                                                                                                                                                                   |
| `packages/protocol` | Sync messages validated with zod (`hello`, `ops`, `ack`, `presence`, `error`; protocol version 3: `ops` travel as binary frames, `encodeFrame`/`parseFrame`, the compact encoding of operations in `binary.ts` and `bytes.ts`) and the sync logic as pure functions: operation store, per-connection session, server `Room` (which also remembers each present replica's latest presence in memory, to tell newcomers). Depends on `@driftboard/crdt`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/server`       | Node 22 sync server: `ws` WebSockets (one room per unguessable board id, using the protocol's `Room`), `GET /healthz`, `better-sqlite3` in `./.data/` with each board's log as a compacted snapshot (gzipped binary batch; version 1 gzipped JSON is still read) plus a tail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web`          | React 18 + Vite client: `/` creates a board, `/b/:boardId` is the canvas. Framework-free logic in `src/lib` (text diff, caret, text binding, board store, sync connection, offline storage in IndexedDB through `idb`, write-behind persistence, sync indicator, ephemeral presence: identity, throttled sender, timing-out store; undo/redo keys; viewport, route); thin React in `src/components` and `src/hooks`. Installable offline PWA through `vite-plugin-pwa` (`vite.config.ts`, `src/pwa-manifest.ts`, icons from `scripts/make-icons.mjs`). Component tests use jsdom through `src/test-render.ts`.                                                                                                                                                                                                                                                       |
| `bench`             | Benchmarks (`@driftboard/bench`): the scenarios (`src/*-scenarios.ts`: 100,000 text operations, a board of 1,000 notes with long texts, a sync after a long offline period, tombstone growth, wire sizes), their `vitest bench` files (`*.bench.ts`), the tests that keep the scenarios honest (`scenarios.test.ts`, run by `pnpm test`) and `report.ts`, which prints the tables of `PERFORMANCE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `e2e`               | Playwright end-to-end suite (`@driftboard/e2e`). `tests/*.spec.ts` start the real sync server (fixture `syncServer`, `support/sync-server.ts`, port 22150, own database in `.data/`) and the production web build (`vite preview`, port 22151), and drive 2-3 browser contexts on one board (Chromium; `E2E_BROWSERS=chromium,webkit` adds WebKit) through `support/person.ts`; every test ends with `expectConverged` (identical boards in all contexts). Specs: concurrent typing, simultaneous moves, `context.setOffline`, server restart/kill, page reload, and a seeded monkey test (200 random actions; `E2E_SEED`, `E2E_MONKEY_RUNS`). The pure helpers in `support/` (seeded rng, monkey plan and runner, board parsing and comparison, geometry, polling, `SyncServer`) have Vitest unit tests that `pnpm test` runs; the specs run only under `pnpm e2e`. |

The server limits what one connection may send and what a board may hold, and everything that
comes from another replica (or from the disk) is checked, set aside rather than thrown on, and
counted: see "Security and robustness" in `DESIGN.md` before changing `store.ts`, `room.ts`,
`ledger.ts`, `hub.ts`, `rate-limit.ts`, `Board.applyUntrusted` or `CausalBuffer`.

Workspace packages are consumed from source (`exports` points at `src/index.ts`); there is no
separate library build step. The server runs through `tsx`.

## Commands

Run from the repository root. Node is pinned by `.nvmrc` / `engines` (22.12) and pnpm by
`packageManager` (9.15.9, through corepack on an ordinary machine). Here the host has neither in that
version, so both are installed under `.agent-local/tools`: run `source .agent-local/env.sh` first, which
puts them on `PATH` and points HOME and every cache at `.agent-local`. Any Node 22.12 with pnpm 9 does
as well.

| Command             | What it does                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies (store in `./.pnpm-store`).                                                                                                        |
| `pnpm build`        | Build every package that defines a `build` script (currently the web app).                                                                              |
| `pnpm test`         | Vitest in every package (at most two workers).                                                                                                          |
| `pnpm lint`         | ESLint (flat config, `eslint.config.js`).                                                                                                               |
| `pnpm typecheck`    | `tsc --noEmit` in every package.                                                                                                                        |
| `pnpm format`       | Prettier write; `pnpm format:check` verifies without writing.                                                                                           |
| `pnpm check`        | `pnpm lint && pnpm typecheck && pnpm test`: the local gate.                                                                                             |
| `pnpm bench`        | `vitest bench` over `bench/src/*.bench.ts` (about 45 s, up to 2.5 GB of memory; few samples of the heavy scenarios, so a wide spread).                  |
| `pnpm bench:report` | `bench/src/report.ts`: each scenario once, as Markdown tables, with heap numbers (`--expose-gc`). About 10 s and 2 GB resident on the author's machine. |
| `pnpm e2e:install`  | Install Playwright's Chromium into the project (`PLAYWRIGHT_BROWSERS_PATH=0`). Once.                                                                    |
| `pnpm e2e`          | Playwright E2E suite: builds the web app, starts both servers, runs the specs (one worker, a few minutes).                                              |
| `pnpm check:all`    | `pnpm check && pnpm e2e`: the full local gate.                                                                                                          |
| `pnpm start:prod`   | Build the web app for production and serve it, the WebSocket and `/healthz` from the Node server on one port (22100).                                   |

Dev servers: `pnpm --filter @driftboard/server dev` (ws://127.0.0.1:22100/ws, `GET /healthz`) and
`pnpm --filter @driftboard/web dev` (http://127.0.0.1:22101). Use only loopback ports 22100–22199.

Production: `pnpm start:prod`, or `mkdir -p .data && docker compose up --build` (published on
http://127.0.0.1:22160, databases in `./.data/`). The server's settings are the `DRIFTBOARD_*`
variables listed in `README.md`; the web app is built for production with `VITE_SYNC_URL=/ws` (the
page connects back to its own origin).

Playwright's browser lives in the project: `pnpm e2e:install` and `pnpm e2e` both set
`PLAYWRIGHT_BROWSERS_PATH=0`. The suite uses ports 22150 (sync server) and 22151 (web preview), so it
can run next to the dev servers (`E2E_SYNC_PORT` and `E2E_WEB_PORT` move them, within 22100-22199,
if a process of an earlier run still holds one; `E2E_BROWSERS=chromium,webkit` picks the engines, and
WebKit and Firefox are installed with `playwright install`); failed tests keep a trace per person in `e2e/test-results/`
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

1. `pnpm check` passes (and `pnpm check:all`, which includes the end-to-end suite).
2. New code has tests.
3. Docs are updated (`DESIGN.md`, this file, README) when behaviour or commands change.
4. Give a short summary: what changed, checks actually run, remaining limitations.
5. Make a conventional-commit git commit (`feat:`, `fix:`, `chore:`, `docs:`, ...). Do not push.

## Verification status

`README.md` ("Status") says, area by area, what is implemented, verified, partial or unverified, and
`ROADMAP.md` ranks what is left. Keep both true: write that something passes only if you ran it, and
say what a check does not cover.

Run for real on Node 22.12 and pnpm 9.15.9 with the real packages (Vitest, fast-check, zod, `ws`,
better-sqlite3, React, jsdom, fake-indexeddb, Playwright with Chromium): `pnpm check` (ESLint,
`tsc --noEmit` in every package, Prettier, all unit, component, property, simulation and fuzz tests),
`pnpm build`, `pnpm e2e` on Chromium and, with `E2E_BROWSERS`, WebKit (so `pnpm check:all`),
`pnpm bench` and `pnpm bench:report`, and
`pnpm start:prod` driven by hand in headless Chromium (create a board, edit from two contexts, reload;
with the service worker allowed, a reload and a cold second tab with the network cut still show the
board). Those hand checks were throwaway scripts and are not in the repository.

Not verified:

- **The `Dockerfile` and `docker-compose.yml` were never built or run**: Docker was not available.
  Their stages were reproduced as plain commands from the lockfile (`DESIGN.md`, "Production build and
  container"), the Dockerfile was parsed with `dockerfile-utils` 0.16.3 (no diagnostics) and the
  compose file validated against the compose-spec JSON schema, with deliberately broken copies
  rejected by both (scratch checks, not in the repository). That covers the dependency set, the layout
  and the syntax of the files, not the base image, `apt-get`, the cache mount, the health check or
  what the compose options do at runtime.
- **`.github/workflows/check.yml` has never run** on GitHub (the repository has not been published
  from here), including its container job.
- Firefox (it cannot start in the development sandbox: its own sandbox is refused), Safari itself
  (the suite has passed on Playwright's WebKit build), touch devices, a real network (latency,
  proxies, dropped connections), many connections at once, and accessibility beyond the labels the
  component tests look for.
- The end-to-end suite does not exercise the service worker (it blocks workers so that "offline"
  means the network alone) and does not assert presence.
- `pnpm audit` reports known advisories, mostly in development tools and one in `zod` 3 (see
  `ROADMAP.md`, step 2). The mutation checks quoted in the docs were run with scripts that are not
  in the repository.

Test ports (all loopback): the server's WebSocket tests 22110-22139, its fuzz test 22140, its
static-file tests 22141-22149, the end-to-end suite 22150 and 22151, `docker compose` 22160, and the
unit test of `SyncServer` 22195. The CRDT review (`CRDT-REVIEW.md`) and the README's CRDT examples are
tests too (`packages/crdt/src/review.test.ts`, `readme-examples.test.ts`): change one with the other.
