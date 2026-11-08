# Roadmap

Twenty steps, in the order to take them, from a review of the whole repository on 2026-11-08: the
code, `DESIGN.md`, `CRDT-REVIEW.md`, `PERFORMANCE.md`, the commit history, and a run of every check
that can run here (`pnpm check:all`, `pnpm build`, `pnpm bench`, `pnpm start:prod` in a browser,
`pnpm audit`). `README.md` ("Status") says what is implemented, verified, partial and unverified
today; this file says what to do about the gaps.

## How the steps are ordered

1. **Things that were asked for and never ran** (steps 1 and 2), then **correctness and security
   gaps** that can hurt a user (3 to 8), then **verification and deployment depth** (9 to 13), then
   **quality and operations** (14 to 16), and only then **new capability** (17 to 20).
2. Inside a tier, a step comes earlier if a later step needs it or if it removes an `unverified`
   from the docs.
3. "Original requirements": the prompts of the first eleven pieces of work were not available when
   this was written, so this means the features `DESIGN.md` and the commit history describe. All of
   them are implemented. The ones that lack a real check are the container and CI (step 1) and
   Firefox, the service worker and presence in the end-to-end suite (step 11).
   `DESIGN.md` marks four things as planned: compaction of the version vector, freeing the text of
   deleted notes, truncating the log, and Fugue's non-interleaving variant. They are steps 17 and 14.

Fixed during the reviews, so not on the list: `ws` was 8.18.0, which has a high-severity memory
exhaustion advisory and a moderate one; it is 8.22.2 now. `pnpm bench` failed on its first run (the
sync scenario ran out of prepared worlds); it passes now. The end-to-end suite can run on other engines
and ports (`E2E_BROWSERS`, `E2E_SYNC_PORT`, `E2E_WEB_PORT`), and all 15 specs pass on WebKit as well
as on Chromium.

| #   | Step                                                         | Tier                 |   Hours |
| --- | ------------------------------------------------------------ | -------------------- | ------: |
| 1   | Build and run the container and the CI workflow for real     | never ran            |       5 |
| 2   | Clear the dependency advisories                              | never ran / security |      10 |
| 3   | A replica past the note limit while offline can never sync   | correctness          |      10 |
| 4   | Send operations in causal order                              | correctness          |      12 |
| 5   | Version the limits; retry quarantined operations             | correctness          |       7 |
| 6   | Protect the streams of replicas that are not connected       | security             |      12 |
| 7   | Bound clocks, detect dead connections, limit connections     | security             |       8 |
| 8   | Server memory and event loop at scale                        | correctness / scale  |      16 |
| 9   | Measure coverage; make the mutation tests reproducible       | verification         |      10 |
| 10  | Deeper verification of the CRDTs                             | verification         |      16 |
| 11  | Firefox, touch, the service worker and presence              | verification         |      12 |
| 12  | Real-network and load tests                                  | verification         |      12 |
| 13  | Run the server from compiled JavaScript; third-party notices | deployment           |       8 |
| 14  | Maximally non-interleaving text                              | quality              |      14 |
| 15  | Accessibility and keyboard operation                         | quality              |      14 |
| 16  | Backups, logs and metrics                                    | operations           |       8 |
| 17  | Compact history: runs of characters, then safe collection    | capability           |      56 |
| 18  | Presence in depth                                            | capability           |      10 |
| 19  | Board management: list, export, import, delete               | capability           |      12 |
| 20  | Access control                                               | capability           |      24 |
|     | **Total**                                                    |                      | **276** |

## 1. Build and run the container and the CI workflow for real

- **Scope.** On a machine with Docker, run `docker compose up --build` from a clean clone and fix what
  fails: the syntax of the `Dockerfile`, the base image, the `apt-get` step, the cache mount, the
  health check, and the compose options (`read_only`, `cap_drop`, `user`, the bind mount). Run
  `.github/workflows/check.yml` (both jobs, `check` and `image`) on GitHub for the first time.
- **Why.** The container and the workflow are deliverables that have never executed: Docker could not
  be operated here and the repository has not been published. A scratch reproduction of the stages
  covered the dependency set and the layout of the runtime image, and a static check on 2026-11-08
  (the Dockerfile parses with `dockerfile-utils` and the compose file validates against the
  compose-spec schema) covered the syntax of the files. None of it built an image.
- **Depends on.** A Docker host and a GitHub repository with Actions.
- **Done when.**
  - `docker build` and `docker compose up --build` succeed from a clean clone;
  - `/healthz` answers, and `docker inspect` says the container is healthy;
  - a board created through the container survives `docker compose down` and `up`, and the database
    files in `./.data/` belong to the person who ran compose, not to root;
  - both CI jobs are green on a pushed branch, including the `grep` checks on the served page;
  - the "unverified" notes in `README.md` and `AGENTS.md` about the container and CI are removed.
- **Effort.** 5 hours (more if the base image or the cache mount need rework).

## 2. Clear the dependency advisories

- **Scope.** `pnpm audit` on 2026-11-08, after `ws` was updated, reports 5 low, 21 moderate, 3 high and
  4 critical advisories; production dependencies alone: 1 moderate and 1 high. Upgrade what has a patched
  version and decide about the rest:
  - production: `zod` 3.24.1 (high: memory exhaustion validating oversized constrained collections;
    patched only in 4.x, so migrate the schemas of `packages/protocol`, or show that the 1 MiB frame
    limit makes it moot and record that); `esbuild` 0.23.1 through `tsx` 4.19.2 (moderate: only its
    development server, which `tsx` does not start);
  - development tools: `vitest` 2.1.8 and `tinypool` (critical: remote code execution when
    Vitest's API or UI server is listening, and a prototype-pollution gadget), `vite` 5.4.11 (high,
    17 advisories in all, about its development server), `playwright` 1.49.1 (high: it downloads
    browsers without verifying the TLS certificate), `@eslint/plugin-kit`, `glob`, `minimatch`,
    `deepmerge`.
  - Add `pnpm audit --prod --audit-level=high` to CI, with a short allowlist file for anything accepted
    on purpose.
- **Why.** A server that is hardened against peers should not ship a vulnerable parser. The
  development-tool advisories are about servers that this repository does not run exposed (that is
  reasoning, not a test), but they sit on every machine and runner that builds it.
- **Depends on.** Step 1 for the CI part. The major upgrades (Vitest 3, Vite 6, Zod 4, newer Playwright
  and its browser) need the whole suite and `pnpm e2e` run again; changing Vite or Vitest also means
  re-running `pnpm bench`.
- **Done when.**
  - `pnpm audit --prod` reports no high or critical advisory, and `pnpm audit` no critical one;
  - CI fails on a new high or critical advisory in production dependencies;
  - `pnpm check:all` and `pnpm bench` are green on the new versions;
  - the text in `README.md` and `AGENTS.md` about advisories is removed or updated to what remains.
- **Effort.** 10 hours.

## 3. A replica past the note limit while offline can never sync (O3)

- **Scope.** Decide and implement what happens to a batch that the server refuses because a note would
  pass its character limit. Give the refusal its own error code instead of closing the connection;
  have the client keep the refused text by moving it into a note of its own (through ordinary
  operations) and drop the refused operations, so that the next connection does not send the same
  batch again. Show the person what happened.
- **Why.** `CRDT-REVIEW.md` O3: reachable by an honest user with about 100,000 characters in one note
  (deleted ones count). The server refuses the batch and closes the connection on every retry, so that
  replica's part never reaches anyone, and the rest of the board syncs around it. It is the one open
  case that is a liveness failure rather than a stray input.
- **Depends on.** Nothing. A new error code is compatible on the wire; see step 5 for versioning.
- **Done when.**
  - a regression test with two offline replicas whose added text together passes the limit ends with
    both converged, no reconnect loop (one refusal per batch at most), and the overflow text present
    in a second note;
  - an end-to-end spec does the same in two browsers with a lowered `DRIFTBOARD_MAX_NOTE_NODES`;
  - the fuzz tests still pass, and `CRDT-REVIEW.md` moves O3 to "fixed" naming the tests.
- **Effort.** 10 hours.

## 4. Send operations in causal order (O2)

- **Scope.** Keep the order in which the server received operations (an arrival column in the `ops`
  table, kept by snapshots, with a new snapshot version), and send a joining client the log in that
  order, which is a causal order, instead of sorted by replica id. Databases written before the
  change keep their old order for the old rows.
- **Why.** `CRDT-REVIEW.md` O2: a client loading a board from scratch is sent operations sorted by
  replica id, so the operations of an author who built on another's wait for those. On a very large
  board written by several people the waiting operations can pass the 250,000 budget; the client then
  refuses real operations, and a reload gives the same result. Nothing here is that large and
  multi-author (the 842,485-operation benchmark board has one author), but it is a limit, not an
  impossibility.
- **Depends on.** Nothing; best done before step 5, which touches the same code.
- **Done when.**
  - a generated board of at least 300,000 operations by at least five authors, with operations that
    depend on each other's, loads into a fresh client with no quarantined operation and an identical
    snapshot;
  - old and new snapshot versions both load, and a test migrates a database fixture written by the
    current version;
  - the loading scenario of `pnpm bench` is not more than 10% slower.
- **Effort.** 12 hours.

## 5. Version the limits; retry quarantined operations (O5, O6)

- **Scope.** Put the limits that decide which operations are valid or kept (`MAX_NOTE_NODES`,
  `MAX_PENDING_OPS`, `MAX_OP_REFS`) into the `hello` exchange, so that a client and a server built
  with different values refuse each other with a clear error instead of silently disagreeing. Make
  that protocol version 4. And apply again, after each batch, the operations that were set aside only
  because a budget was full.
- **Why.** `CRDT-REVIEW.md` O5: the limits are part of the protocol but only the wire format is
  versioned. O6: a refused operation is not tried again until the page is reloaded, so the board
  differs meanwhile.
- **Depends on.** Steps 3 and 4 (same code, so do them first).
- **Done when.**
  - a server and a client with different limits refuse each other with `limits_mismatch`, and the web
    app says that an update is needed;
  - an operation set aside for budget reasons is applied once the budget frees, without a reload;
  - version 3 clients get a clear refusal; the protocol table in `DESIGN.md` is updated; the fuzz tests
    pass.
- **Effort.** 7 hours.

## 6. Protect the streams of replicas that are not connected (O1)

- **Scope.** The secret sent in `hello` stops a connection from replacing a replica that is connected.
  It does not stop a connection from appending operations to the stream of a replica that is not,
  and devices do upload the operations of their earlier page loads under those replicas' ids. Bind
  each replica id to a secret the first time the server sees it (store a hash with the log), keep the
  secret in IndexedDB with that replica's unsent operations, and require it for later uploads of that
  replica's operations. Rows from before the change are trusted on first use.
- **Why.** The "known limitations" in `README.md` and `DESIGN.md`: a participant can write into the
  stream of a replica that is not connected, and `CRDT-REVIEW.md` O1 shows how that makes replicas
  disagree about what an id means. There are no accounts here, but the link holder should not be able
  to forge another device's history.
- **Depends on.** A migration of the web app's IndexedDB schema.
- **Done when.**
  - a connection that does not know replica R's secret cannot extend R's stream (refused, nobody
    else affected), in a protocol test and in the server fuzz test;
  - a device that uploads old replicas' pending operations after a reload still syncs (the
    offline-first test on three devices and the reload specs of the end-to-end suite pass);
  - a mutation check of the new rule is caught, and the limitation is removed from the docs.
- **Effort.** 12 hours.

## 7. Bound clocks, detect dead connections, limit connections

- **Scope.** Three server rules with configuration and tests: (a) refuse a note write whose timestamp
  is more than a day ahead of the server's clock; (b) a WebSocket ping every interval, terminating a
  connection that does not answer, and removing its presence; (c) a maximum number of connections
  (total and per address, with the forwarded address trusted only when configured) and of open boards.
- **Why.** `CRDT-REVIEW.md`: a far-future timestamp makes a note's fields win over every later write
  until real time reaches it, so a note can be made unmovable for good (everyone still agrees; it is
  not divergence). `README.md`: "no heartbeat for dead connections, no limit on connections or
  boards, rate limits only per connection".
- **Depends on.** Nothing.
- **Done when.**
  - a timestamp in the year 9999 is refused with its own error and honest replicas are unaffected;
  - a connection that stops answering pings is closed within two intervals (a test with virtual
    time) and the others are told it left;
  - the connection and board limits are enforced and appear in the configuration table of
    `README.md`; the fuzz tests pass.
- **Effort.** 8 hours.

## 8. Server memory and event loop at scale

- **Scope.** Measure first (a server benchmark: open N boards of M operations, record the heap and the
  event-loop delay with `monitorEventLoopDelay`). Then: load a board incrementally or in a worker
  thread, evict idle boards from memory and reload them on demand, compact in a worker, and refuse
  growth past a configurable size per board with its own error.
- **Why.** `README.md`: the server keeps each open board's whole log in memory, loads and compacts a
  board synchronously, and runs one process. One large board therefore stalls every other board on the
  server while it loads. `PERFORMANCE.md` measured about 485 bytes a node in memory.
- **Depends on.** Nothing; step 12 uses the numbers.
- **Done when.**
  - while a board of about 800,000 operations is opened and compacted, the 99th percentile of event-loop
    delay for other boards stays under a target set after the first measurement (write it down);
  - an idle board is evicted after a configurable time and comes back on demand (test), and the
    memory of a hundred idle boards does not grow;
  - `PERFORMANCE.md` has the server numbers; the restart specs of the end-to-end suite pass.
- **Effort.** 16 hours.

## 9. Measure coverage; make the mutation tests reproducible

- **Scope.** Add line and branch coverage per package (`@vitest/coverage-v8`) with thresholds in CI that
  can only go up, starting at today's numbers. Commit a mutation-testing setup (StrykerJS with its
  Vitest runner) for `packages/crdt` and `packages/protocol`, scoped so that it finishes in under 30
  minutes, and triage the surviving mutants.
- **Why.** Coverage has never been measured. The docs quote mutation results (21 of 21 for the order
  tree and sequence, 20 of 20 for the binary codec, 23 of 23 for the peer protections), but they come
  from scripts that were deleted, so nobody can repeat them.
- **Depends on.** Step 2 if Vitest is upgraded first (do it after, to avoid doing it twice).
- **Done when.**
  - `pnpm coverage` prints per package numbers and CI enforces them;
  - `pnpm mutate` produces a report, CI keeps it as an artifact, and a table in the docs lists each
    survivor as killed by a new test or as an equivalent mutant;
  - the docs refer to the committed setup and not to scripts that no longer exist.
- **Effort.** 10 hours.

## 10. Deeper verification of the CRDTs

- **Scope.** (a) An independent, small and slow implementation of the published Fugue algorithm, and a
  test that compares it with `TextSequence` on random histories, including the alternating-typing
  cases. (b) A long fuzz with 5 to 10 replicas, 10,000 to 100,000 operations and random partitions,
  run nightly. (c) Models for `order-tree.ts` and `history.ts` beyond the property tests. (d) Decide
  whether a formal model (TLA+ or Quint) of the ledger and the delivery rules is worth the cost.
- **Why.** `CRDT-REVIEW.md` is explicit that it is not a proof: the text sequence was not compared with
  the published algorithm line by line, the order tree and the history were checked by tests and
  mutation, not reasoned to the end, and the generators are small (a few operations per scenario).
- **Depends on.** Step 9, to see what the existing tests miss.
- **Done when.**
  - the reference comparison runs 10,000 histories in `pnpm check` and a million nightly, and every
    difference is either a fixed bug or a documented difference of design;
  - the nightly fuzz job exists and has run; `CRDT-REVIEW.md` is updated with what was found and
    what is still not covered.
- **Effort.** 16 hours.

## 11. Firefox, touch, the service worker and presence

- **Scope.** Run the suite on Firefox on a machine where it starts, and fix what it shows. (It does not
  start under the macOS sandbox used for development here: `sandbox_init() failed with error
"Operation not permitted"`, and switching off its own sandboxes did not help.) Add a mobile-emulated
  project with touch events for dragging notes, panning and pinching; add a spec project with service
  workers allowed for the offline page load and the update banner; assert presence (cursors, the
  people list, who is editing); run the monkey test with several seeds in CI (`E2E_MONKEY_RUNS`); and
  put Chromium and WebKit (`E2E_BROWSERS=chromium,webkit`) in the CI matrix.
- **Why.** The 15 specs pass on Chromium and on Playwright's WebKit build (30 passed with
  `E2E_BROWSERS=chromium,webkit pnpm e2e` on 2026-11-08), but Firefox has never run, WebKit is not
  Safari, the suite blocks the service worker (so that "offline" means the network alone) and it does
  not assert presence. The offline page load was checked by hand with a throwaway script that is not
  in the repository, and nothing has run on a touch device.
- **Depends on.** A machine where Firefox can start; step 1 for the CI matrix.
- **Done when.**
  - the specs pass on Firefox as well, or each failure is a recorded finding that is fixed;
  - the touch, service worker and presence specs exist and pass;
  - the by-hand PWA check is replaced by a spec, and the "unverified" notes shrink to match.
- **Effort.** 12 hours.

## 12. Real-network and load tests

- **Scope.** A proxy in the repository (loopback ports 22100 to 22199) that adds latency, jitter, loss,
  limited bandwidth and dropped connections; a load generator that speaks the protocol without a
  browser, for 100 to 1,000 connections on 1 to 50 boards; an hour-long soak recording memory and CPU.
  Record the results in `PERFORMANCE.md`.
- **Why.** Nothing has run over a non-ideal network or with many connections. The sync benchmark runs in
  one process and measures work, not latency.
- **Depends on.** Steps 7 and 8, so that the numbers mean something.
- **Done when.**
  - convergence checks pass with 200 ms plus or minus 100 ms of jitter and 5% loss;
  - 500 connections on 10 boards run for 30 minutes with a steady resident size (no leak) and a
    reported 99th percentile of broadcast latency; anything that fails is a filed finding.
- **Effort.** 12 hours.

## 13. Run the server from compiled JavaScript, and ship third-party notices

- **Scope.** Build the server and the workspace packages it uses (`tsc` or an esbuild bundle), and have
  `start:prod`, the `Dockerfile` and the end-to-end fixture run `node dist/main.js`. Keep `tsx` for
  development only. In the same pass, make the web build emit a third-party notices file for the
  packages it bundles (React and its scheduler, `idb`, `zod`, `workbox-window`) and copy it into the
  image.
- **Why.** `tsx` is a production dependency only because the workspace packages are TypeScript read from
  source. It costs start-up time, needs a writable cache (the reason compose mounts `/tmp` as a
  tmpfs), and brings `esbuild` and its advisory into the image. And the minified web bundle keeps
  React's license comments but not the notices of `idb` (ISC), `zod` and `workbox-window` (MIT), which
  those licenses ask to be kept in copies. The source repository is unaffected; a published bundle or
  image is not.
- **Depends on.** Step 1 (to verify the image) and step 2.
- **Done when.**
  - `pnpm build` emits the server; the image has no `tsx` or `esbuild`;
  - the server tests, a smoke run of the built output, and `pnpm e2e` pass against the build;
  - image size and cold start time are reported before and after; compose no longer needs the tmpfs;
  - the built web app contains a notices file with the license text of every bundled package, and a
    test fails when a new bundled dependency is missing from it.
- **Effort.** 8 hours.

## 14. Maximally non-interleaving text

- **Scope.** Implement Fugue's maximally non-interleaving variant, which also orders siblings by their
  right origin, or write down why not. It may need the insert operation to carry its right origin,
  which would change the wire and log formats (a protocol version and a migration of stored logs).
- **Why.** `DESIGN.md`: only the base Fugue tree is implemented, and nothing is promised for edit
  patterns other than contiguous typing runs, for example two people typing alternately while moving
  their cursors. Their words can interleave, which reads oddly.
- **Depends on.** Step 10(a), to have a reference to compare with; step 5 for the version.
- **Done when.**
  - a test with two people alternately typing in the same place does not interleave their words;
  - the convergence harness passes at 50,000 runs, and existing logs and snapshots still load;
  - `pnpm bench:report` shows no regression greater than 10%.
- **Effort.** 14 hours.

## 15. Accessibility and keyboard operation

- **Scope.** Make the board usable without a pointer: focusable notes, keyboard commands to create,
  move (arrows, with a modifier for larger steps), recolour, delete and raise a note, and to pan and
  zoom; polite live announcements of remote changes and arrivals; a visible focus; checks with axe in
  the component tests and the end-to-end suite; contrast of the six note colours and eight presence
  colours; reduced motion for the gliding cursors; touch targets of a usable size.
- **Why.** Today a note is created only by double-clicking the canvas and moved only by dragging
  (checked in the code); the keyboard handles undo, redo and the name field. The buttons and groups
  have labels, but no audit has ever been done.
- **Depends on.** Nothing; shares work with step 18.
- **Done when.**
  - axe reports no serious or critical violation on the front page and a board page;
  - an end-to-end spec creates, edits, moves, recolours and deletes a note with the keyboard only;
  - a screen-reader pass (VoiceOver or NVDA) is recorded in the docs with its findings.
- **Effort.** 14 hours.

## 16. Backups, logs and metrics

- **Scope.** Structured logs (connections, boards opened and closed, refusals and quarantines by
  reason); a metrics endpoint in Prometheus text format, off by default and on loopback or behind a
  token; counters for refused, quarantined and rate-limited messages, open boards and connections, and
  the size of the database; scheduled online backups with SQLite's backup API and a restore procedure;
  a check that shutdown on a signal leaves the database consistent.
- **Why.** Observability today is `/healthz` and a few `console` lines (checked in the source), and the
  `./.data/` folder is the only copy of every board.
- **Depends on.** Nothing.
- **Done when.**
  - a test writes boards, backs up, wipes the data and restores, and the boards are equal;
  - the log fields and the metrics are documented with an example scrape;
  - `README.md` has a short operations section.
- **Effort.** 8 hours.

## 17. Compact history: runs of characters, then safe collection

- **Scope.** In three parts. (a) Store a run of consecutive characters as one block in `TextSequence`
  instead of one node per character; ids and operations stay the same, so no protocol change. (b)
  Measure nodes and tombstones per note on a real server. (c) Only if (b) says it matters, the design in
  `PERFORMANCE.md` ("When it is safe to garbage-collect one"): per-note epochs once deletes are
  causally stable, a lease after which an absent replica reloads, a snapshot with a base version
  vector, and a new protocol version. With it, the items `DESIGN.md` marks as planned: compaction of
  the version vector, freeing the text of deleted notes, and truncating the log.
- **Why.** A board only grows: deleted characters stay as tombstones, a note is capped at 100,000
  characters counting deleted ones, and every operation stays in the log. Replica ids are new on every
  page load, so version vectors grow with the number of page loads that wrote. About 485 bytes a node
  is the cost of that.
- **Depends on.** Steps 10 and 14 (the sequence is changed under them), and step 4 (the log's order).
- **Done when.**
  - (a): memory per character on the tombstone benchmark falls from about 485 bytes to 50 or less
    with every existing CRDT test unchanged;
  - (c): the convergence harness, extended with random epochs and replicas offline across them, passes
    at 50,000 runs; a replica absent past the lease reloads cleanly and its unsent edits survive as a
    diff; the log size after compaction is measured;
  - `DESIGN.md` and `PERFORMANCE.md` are updated.
- **Effort.** 56 hours: 16 for (a), 40 for (c); (c) may turn out to be unnecessary, and (a) alone is a
  complete step.

## 18. Presence in depth

- **Scope.** Show other people's caret and selection inside a note, mapped through concurrent edits
  using stable ids; make cursors follow a person who scrolls the page instead of the canvas; add
  keyboard shortcuts for notes (with step 15) and a touch design (larger targets, a long press for the
  note menu).
- **Why.** `DESIGN.md` ("Not yet"): presence shows the focused note, not the caret or selection inside
  it, and does not follow page scrolling; there is no touch-specific design beyond pointer events.
- **Depends on.** Steps 11 (presence specs) and 15.
- **Done when.**
  - two browsers in an end-to-end spec see each other's caret in one note, and it stays in place
    while the other person types before it;
  - the presence rate stays at or below 20 messages a second, and the presence fuzz covers the new
    payload.
- **Effort.** 10 hours.

## 19. Board management: list, export, import, delete

- **Scope.** A front page that lists the boards opened on this device (from IndexedDB) with a name
  and the time last opened; renaming (a title as a register on the board); export to JSON (the
  existing `serializeBoardOps`) and to Markdown or an image; import; deleting a board on the device
  and, with a delete secret in its link, on the server; a configurable retention rule for idle boards.
- **Why.** The front page offers only "Create a board". `serializeBoardOps` exists in `packages/crdt`
  but no part of the web app uses it (checked), so people cannot get their data out, and boards cannot
  be deleted.
- **Depends on.** Step 6 if the delete secret reuses its mechanism.
- **Done when.**
  - export then import into a new board shows the same notes, texts and colours;
  - an end-to-end spec creates three boards, sees them listed, and deletes one, after which its rows
    and snapshot are gone from the database;
  - a retention test with a fake clock removes only idle boards.
- **Effort.** 12 hours.

## 20. Access control

- **Scope.** First a design note that settles the scope, then read-only links and edit links
  (capability tokens in the URL fragment, so that they are not sent in a `Referer` header), rotating
  a link, and an optional passphrase. Consider end-to-end encryption, which conflicts with the
  server's checks of ids and sizes; it needs a design in which the server validates metadata only.
- **Why.** The link is the only access control, and the server can read everything (`README.md`, "no
  accounts, no encryption").
- **Depends on.** Step 6; step 19 for deletion.
- **Done when.**
  - the design note is accepted;
  - a read-only link can view and appears in presence, and every operation it sends is refused
    (covered by the fuzz tests);
  - rotating a link disconnects the old holders within a stated time, and the limitations in the docs
    are rewritten.
- **Effort.** 24 hours, depending on how far the design note goes (encryption alone could double it).

## Total

**276 hours.** By tier: never ran (1, 2) 15; correctness and security (3 to 8) 65; verification and
deployment (9 to 13) 58; quality and operations (14 to 16) 36; new capability (17 to 20) 102.
Steps 1 to 13, which take the product to "everything claimed has been run, and the known ways for
replicas to disagree or for a peer to hurt a server are closed", come to 138 hours.

Suggested order of work for two people: one takes 1, 2, 13, 9, 10 and 11 (checks and build), the other
takes 3, 4, 5, 6, 7 and 8 (protocol and server). Steps 3 to 5 touch the same code and should not run in
parallel.

## Assumptions

- The figures are focused hours for one engineer who has read `DESIGN.md`, `CRDT-REVIEW.md` and
  `PERFORMANCE.md`, and they include tests and documentation. Add about 30% for someone who has not.
  They are not calendar time.
- Estimates of 12 hours or more, and steps 8, 12 and 17, are within plus or minus 40% until the
  measurement they start with is done. Steps 17(c) and 20 depend on decisions that could make them
  smaller or much larger.
- Network access for installs and a machine with Docker exist for steps 1 and 13, and a GitHub
  repository with Actions for steps 1, 2 and 11. None of them could be tried in the environment this
  was written in.
- Node 22.12 and pnpm 9.15.9 stay the baseline; step 2 may move the tooling to newer majors, and its
  effort is for the upgrades listed there.
- Nothing here changes the product's premises: boards stay capability links, one server process owns
  a board, and the CRDT library stays pure (`AGENTS.md`).
- Effort is for the work as described; a finding in a "verify" step (1, 9, 10, 11, 12) turns into
  further work that is not counted.
