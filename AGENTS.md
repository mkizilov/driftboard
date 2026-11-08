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

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `packages/crdt`     | Pure CRDT library. Implemented: replica ids, op ids, Lamport/hybrid logical clocks, version vectors, LWW register, add-wins map, text sequence (Fugue tree, `TextSequence`) with a causal delivery buffer, the `Board` document model (add-wins map of notes with LWW fields, per-note text, op log, JSON, change subscription), plus a generic convergence harness (`convergence*.ts`, test-only). No runtime deps. |
| `packages/protocol` | Sync messages validated with zod (`hello`, `ops`, `ack`, `presence`, `error`) and the sync logic as pure functions: operation store, per-connection session, server `Room`. Depends on `@driftboard/crdt`. |
| `apps/server`       | Node 22 sync server: `ws` WebSockets (one room per unguessable board id, using the protocol's `Room`), `GET /healthz`, `better-sqlite3` in `./.data/` with each board's log as a compacted snapshot plus a tail. |
| `apps/web`          | React 18 + Vite client: `/` creates a board, `/b/:boardId` is the canvas. Framework-free logic in `src/lib` (text diff, caret, text binding, board store, sync connection, viewport, route); thin React in `src/components` and `src/hooks`. Component tests use jsdom through `src/test-render.ts`. |

Workspace packages are consumed from source (`exports` points at `src/index.ts`); there is no
separate library build step. The server runs through `tsx`.

## Commands

Run from the repository root. Use pnpm through corepack (`corepack enable`); the version is pinned by
`packageManager`, Node by `.nvmrc` / `engines`.

| Command            | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `pnpm install`     | Install dependencies (store in `./.pnpm-store`).                           |
| `pnpm build`       | Build every package that defines a `build` script (currently the web app). |
| `pnpm test`        | Vitest in every package (at most two workers).                             |
| `pnpm lint`        | ESLint (flat config, `eslint.config.js`).                                  |
| `pnpm typecheck`   | `tsc --noEmit` in every package.                                           |
| `pnpm format`      | Prettier write; `pnpm format:check` verifies without writing.              |
| `pnpm check`       | `pnpm lint && pnpm typecheck && pnpm test`: the local gate.                |
| `pnpm e2e`         | Playwright E2E suite. Placeholder until the suite exists (later task).     |
| `pnpm check:all`   | `pnpm check && pnpm e2e`.                                                  |

Dev servers: `pnpm --filter @driftboard/server dev` (ws://127.0.0.1:22100/ws, `GET /healthz`) and
`pnpm --filter @driftboard/web dev` (http://127.0.0.1:22101). Use only loopback ports 22100–22199.

When Playwright is added, install its browsers into the project with `PLAYWRIGHT_BROWSERS_PATH=0`.

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

The scaffold, `packages/crdt`, `packages/protocol`, `apps/server` and `apps/web` (turns 1-8) were
written in an environment with no network access, so no `pnpm install` has run: there is no
`pnpm-lock.yaml` yet and `pnpm check` has not been executed. The tests were only run under throwaway
minimal stand-ins for Vitest, fast-check and zod (which cover only the features used), plus, for the
server, an adapter over Node's built-in `node:sqlite` in place of better-sqlite3 and a hand-written
RFC 6455 server in place of `ws` (its clients were Node's own WebSocket), on Node's built-in type
stripping. Nothing has run against the real packages or `tsc`/ESLint, so type or lint errors and
failures that only the real packages would show are still possible; the real `ws` and better-sqlite3
integration in `apps/server` is the least verified part.

In `apps/web` the framework-free tests (`src/lib/*.test.ts`) ran under those stand-ins. React, Vite
and jsdom have never been installed, so the `.tsx` files, the hooks, `Canvas` pointer and wheel
handling, the styles and the five component tests (`NoteTextArea`, `NoteCard`, `BoardPage`,
`HomePage`, `App`) have never been compiled or executed, and nothing has been seen in a browser. The
component tests are the first thing to run: if they fail, check them against the real DOM before
changing `lib/text-binding.ts`, whose behaviour the `lib` tests pin down. Dependency versions added
for the web app (`jsdom`, `fast-check`) are from memory, like the others. On the first machine with
network access (Node 22.12 + corepack), run `pnpm install`, then `pnpm format`, fix anything
`pnpm check` reports, commit the generated `pnpm-lock.yaml`, and switch the CI install step to
`--frozen-lockfile`. Delete this section once that is done.
