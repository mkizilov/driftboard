# driftboard design

driftboard is a local-first collaborative sticky-note board. Every client holds a full replica of the
board, edits it without waiting for the network, and converges with other replicas through
conflict-free replicated data types (CRDTs) synchronised over WebSockets.

This document describes the target design. Status markers: **[scaffolded]** exists in the
repository today, **[planned]** is designed here but not yet implemented.

## Packages

| Path                | Role                                                                     | Status      |
| ------------------- | ------------------------------------------------------------------------ | ----------- |
| `packages/crdt`     | Pure CRDT library. Zero runtime dependencies, no I/O, injected clocks.   | scaffolded  |
| `packages/protocol` | Sync message types and zod validation (`hello`, `welcome`, `error`).     | scaffolded  |
| `apps/server`       | Node 22 sync server: `ws` WebSockets, `better-sqlite3` in `./.data/`.    | scaffolded  |
| `apps/web`          | React 18 + Vite client.                                                  | scaffolded  |

Dependency direction: `web` and `server` depend on `protocol` and `crdt`; `protocol` may depend on
`crdt` types later; `crdt` depends on nothing.

## Data model

A **board** is a map from `NoteId` to `Note`. A **note** has:

- `x`, `y` — position in board coordinates.
- `z` — stacking order; a larger `z` is drawn above a smaller one.
- `color` — one value from a fixed palette (`yellow`, `pink`, `green`, `blue`, `purple`, `orange`).
- `text` — an ordered sequence of characters (Unicode code points) edited collaboratively.

Mapping to CRDTs (implemented as the `Board` class, see "Board document" below):

```
Board  = AwMap<NoteId, NoteFields>          // add-wins presence; one small value per note
NoteFields = {                              // the map's value, joined field by field
  x, y, z: LwwRegister<number>,
  color:   LwwRegister<NoteColor>
}
Texts  = Map<NoteId, TextSequence>          // one sequence per note, kept beside the map
```

`NoteId` is the creating replica's first map write for the note (`counter@replica`, e.g. `3@ab12`),
so concurrent creations never collide.

Semantics worth stating up front:

- Concurrent moves of the same note: last writer (by HLC) wins. A move writes `x` and `y` with one
  timestamp, so the winning move supplies both and the note never lands at a mixed `x`/`y`.
- Concurrent text edits merge character by character; neither edit is lost.
- Delete vs. edit: the map is **add-wins**. Any edit to a note re-asserts its presence (an edit is
  a `put` that replaces the dots its author saw), so an edit concurrent with a delete resurrects
  the note, and no work is silently discarded. A delete only removes the note state that the
  deleting replica had observed.

## CRDTs

All types live in `packages/crdt` and are pure: time comes from an injected `Clock`, randomness and
replica ids are passed in, and there is no I/O. Each type supports merge/apply that is
commutative, associative and idempotent, which is verified with fast-check property tests.
Identifiers, clocks, version vectors, the LWW register, the add-wins map and the text sequence are
implemented.

### Identifiers and clocks **[implemented]**

Source: `packages/crdt/src/{replica-id,op-id,lamport,hlc,version-vector}.ts`.

**Replica id.** A branded string matching `[A-Za-z0-9_-]{1,64}`, unique per replica (device/tab) and
never reused. `generateReplicaId(randomBytes)` builds a 16-hex-char id from caller-supplied random
bytes; the library never reads an entropy source. Ids compare by UTF-16 code unit (not locale).

**Operation id / Lamport timestamp.** `OpId = (counter, replicaId)` with `counter >= 1`. The total
order is counter first, then replica id. A replica issues each counter once, so an id names one
operation. `LamportClock.tick()` issues the next id; `observe(remote)` raises the counter to at
least the remote one, so if `a` happened before `b` then `id(a) < id(b)`.

**Version vector.** Immutable map `replicaId -> highest counter seen` (absent = 0, zero entries are
dropped so equal vectors have one representation).

- `merge` is the pointwise maximum: commutative, associative, idempotent, identity = empty vector.
- `compare` returns `before | after | equal | concurrent`.
- `includes(opId)` is `opId.counter <= vv[opId.replicaId]`. This is only sound if each replica's
  operations are applied in counter order (causal delivery), which the sync layer must guarantee.
- `advance(opId)` records one operation.

**Hybrid logical clock (HLC).** A timestamp is `(wallMs, logical, replicaId)`, totally ordered
lexicographically. Because `replicaId` is unique per replica, two distinct events never compare
equal. The physical clock is injected (`Clock.now()`, integer ms).

- `tick()` (local event / send): if `now > wall` then `(wall, logical) = (now, 0)`, else
  `logical += 1`.
- `receive(remote)`: `wall' = max(wall, remote.wall, now)`; the logical counter becomes
  `max(local, remote) + 1` if both ties, `local + 1` or `remote + 1` if only one ties, else `0`.
  The result is strictly greater than `remote` and than everything issued before.
- **Physical clock jumps backwards:** the held wall time does not move; `logical` keeps counting up,
  so issued timestamps stay strictly increasing. Once the physical clock passes the held wall time
  again, the clock follows it and `logical` resets to 0.
- **Drift bound:** `receive` throws `HlcDriftError` if `remote.wallMs - now > maxDriftMs` (default
  60 s), leaving the clock unchanged, so one misconfigured client cannot drag every other clock
  forward.
- **Limits:** wall time is 48 bits, `logical` is 16 bits (`MAX_LOGICAL`); overflow throws
  `RangeError` without changing state. Persist `latest` and pass it back as `initial` on restart so
  a restarted replica never reissues or regresses.
- **String form:** `formatHlc` gives `<wall:12 hex>-<logical:4 hex>-<replicaId>`, fixed-width so
  that plain string comparison (including SQLite `ORDER BY`) equals `compareHlc`. `parseHlc` is
  its inverse.

### LWW register **[implemented]**

Source: `packages/crdt/src/lww-register.ts`. Immutable `LwwRegister<T>` holding `(value, timestamp)`.

- Operation: `{ type: 'set', value, timestamp }`, built by `prepareSet(value, timestamp)` and
  applied with `apply(op)`. The write with the greater HLC timestamp wins, so any order and any
  number of deliveries give the same result. `apply` is idempotent and commutative.
- State merge: `merge(other)` keeps the entry with the greater timestamp (commutative,
  associative, idempotent; an empty register is the identity).
- A write should win over everything its replica has seen. The caller must therefore feed every
  received timestamp to the replica's clock (`HybridLogicalClock.receive`) before calling `tick()`
  for the new write. This holds even if the physical clock is behind or jumps backwards.
- Timestamps must be unique per write (guaranteed by the HLC's replica id). Two different values
  with an identical timestamp are a caller bug; the first one applied is kept.
- Used for `position` and `color`.

### Add-wins map **[implemented]**

Source: `packages/crdt/src/aw-map.ts`. Immutable observed-remove map `AwMap<V>` from string keys to
values `V`; the constructor takes a `join(a, b)` for `V` (commutative, associative, idempotent), for
example `LwwRegister.merge`.

- **Dots.** Every write creates a *dot*: an `OpId` `(n, replica)` where `n` is that replica's next
  *map* counter (contiguous, taken from the map's version vector). A dot stores the value written
  with it. A key is present while at least one of its dots survives.
- **`put`** `{ key, dot, value, supersedes }`: `supersedes` lists the dots of that key the issuer had
  observed; they are replaced by the new dot. Concurrent writes of one key from different replicas
  both survive and the visible value is the `join` of all surviving dots' values (applied in dot
  order, so it is deterministic).
- **`remove`** `{ key, dots }`: deletes only the dots the issuer had observed. A concurrent write has
  a dot the remover never saw, so it survives: **add wins**.
- **Causal context, no tombstones.** The map's `VersionVector` records every write seen. A dot that
  the vector covers but the map no longer holds was removed or replaced. This keeps duplicates
  harmless (a write already covered is ignored, even if it was later removed) and makes state
  merge possible without tombstones.
- **Delivery requirements.** Each replica's writes must be applied in order, and an operation only
  after the writes it refers to (causal delivery). `apply` throws `CausalOrderError` for a gap or
  an unseen reference; the sync layer is responsible for buffering until the predecessors arrive.
  Re-applying an operation is a no-op.
- **State merge** `merge(other)` is the standard dot-store join: a dot present on one side only
  survives if the other side's version vector has not seen it; version vectors merge pointwise. It
  is commutative, associative, idempotent, and equals replaying the union of both sides' operations
  (checked by the convergence harness below).
- **Value size.** Every write carries its whole value, so values should be small join-able states
  (for example a record of LWW registers for `x`, `y`, `z` and `color`). The text sequence is a
  large mutable structure and does not fit that shape, so the board keeps one `TextSequence` per
  note beside the map, and a note's text is visible while the note is present.
- Nothing is ever compacted yet: the version vector grows with the number of replicas that wrote.
  **[planned]**

### Convergence harness

Source: `packages/crdt/src/convergence.ts` (fast-check wrapper) and `convergence-scenario.ts` (the
runner, which has no test-framework imports). Test-only; not exported from the package.

A CRDT plugs in through a `ConvergenceSpec`: `create`, `prepare` (turn a random intent into a list
of operations using the replica's state and clock), `apply`, `snapshot` (canonical JSON of the
*entire* state), and optionally `merge`, `observe` (feed the HLC) and `idempotentApply`. States may
be mutated in place by `apply` (the text sequence does this); such a spec must have an idempotent
`apply`, and cannot use `merge`. `checkConvergence(spec, { numRuns = 1000, replicas })` then
generates random scenarios on 3 replicas, or on 3 to 5 with `replicas: { min: 3, max: 5 }`:

- local operations, with the replicas' physical clocks randomly advanced or moved backwards;
- deliveries of single operations to a replica, chosen at random among those that are *causally
  ready* (everything the origin had applied when it created the operation is already applied);
- redeliveries of already-applied operations (only if `idempotentApply`);
- a final drain of the remaining operations in a random causally valid order.

It fails unless all replicas end with the snapshot of a reference replica that applied the
operations in creation order; redelivery never changes a snapshot; and, if `merge` is given, merging
recorded intermediate states is commutative, associative, idempotent and equal to replaying the
union of their operations. `checkConvergence` returns totals (operations, concurrent pairs,
redeliveries, merge checks) so tests can assert that runs were not vacuous. `convergence.test.ts`
checks the harness itself against deliberately broken CRDTs.

### Text sequence: RGA-style, using the Fugue tree **[implemented]**

Source: `packages/crdt/src/text-sequence.ts` (`TextSequence`) and `causal-buffer.ts`.

The sequence starts from the RGA idea (every character has a unique id and names the character it
was inserted next to; deletes leave tombstones) but uses the Fugue tree, because plain RGA
interleaves concurrent words in one common case (see "Interleaving" below).

- **Model.** A tree of nodes, one per Unicode code point, plus a virtual start node. A node has an
  `OpId` (the creating replica's next insert counter, so ids are unique and per-replica contiguous),
  a `parent` and a `side` (`left` or `right`), a value, and a tombstone flag. The document is the
  in-order walk of the tree: a node's left children, the node itself, its right children. Children
  on the same side are ordered by ascending `OpId`. The start node only has right children.
- **Operations** are immutable data: `insert { id, parent | null, side, value }` and
  `delete { target }`. Where a character ends up is fixed by its operation alone, so any delivery
  order that respects the dependencies below gives the same tree. Applying an insert twice is a
  no-op; reusing an id for a different character throws `RangeError`.
- **Local insert** at index `i` (Fugue's rule). Let `origin` be the visible character before the
  insertion point (or the start). If `origin` has no right children (tombstones count), the new
  character becomes its first right child. Otherwise the next node in document order, which is the
  leftmost node of origin's right subtree and so has no left children, gets the new character as
  its first left child. Either way the character lands directly after `origin`. The remaining
  characters of an `insert(index, text)` call each become the right child of the previous one, so a
  run of typing is a chain.
- **Local delete** only sets tombstones; the tree does not change, so later inserts can still refer
  to deleted characters. Tombstones are kept forever for now; dropping them once causally stable is
  **[planned]**.
- **API.** `insert(index, text)` and `delete(index, length)` apply locally and return the
  operations to send; `apply(op)` takes remote (or echoed) operations; `toString()`, `length`,
  `nodes()` (the whole tree in document order, for snapshots and tests) and `pendingCount`. Indices
  count code points (not UTF-16 units, not grapheme clusters). The replica is a mutable object while
  its operations are immutable. The document order is rebuilt lazily with an explicit stack, so an
  edit after a change costs O(n) and very long runs cannot overflow the call stack.
- **Causal delivery buffer.** `CausalBuffer` is a small generic class: `apply` sends every operation
  through it. An insert requires its parent, a delete requires its target. An operation whose
  requirement has not arrived is parked under that one missing id and applied, together with
  whatever it unblocks and parents before children, as soon as the missing operation is applied.
  Duplicates are harmless. The buffer has no size limit or timeout; `pendingCount` lets the sync
  layer notice a stuck stream and ask for the missing operations again.

#### Interleaving

Question checked: two replicas concurrently type a word at the same position. Each character must
not be mixed in with the other word's characters.

- **Plain RGA** (insert after a predecessor, siblings by descending id) keeps *forward* typing
  together: each character is inserted after the one typed before it, so a word is a chain and a
  chain is one subtree. It fails for *backward* typing (a word typed right to left, or any run where
  the cursor stays put): every character is inserted after the same predecessor, so the characters
  of both words are siblings and the id order mixes them. Typing `c b a` and `z y x` at the start
  gives ids `A1 c, A2 b, A3 a` and `B1 z, B2 y, B3 x`; descending order gives `xaybzc`. The
  "why the sequence is not plain RGA" tests reproduce this with a 15-line RGA model.
- **Fugue** puts backward-typed characters on the *left* side: after the first character, each new
  one lands directly before the previous one, which makes it the previous one's left child (the
  insert rule above, with `origin` = the character before the cursor, whose right subtree now
  starts with the previous character). So a backward run is a chain of left children and a forward
  run a chain of right children. Either way the only siblings are the *first* characters of the
  concurrent runs, ordered by id, and each run is a whole subtree that stays contiguous:
  `[alphaOMEGA]` or `[OMEGAalpha]`, never a mix. The word whose first character has the smaller id
  comes first.
- **Tested** (`text-sequence.test.ts`): forward and backward in all four combinations, at the start,
  in the middle, at the end and in empty text; words inserted with one `insert` call; three
  simultaneous words; words typed next to tombstones; a fast-check property over random bases,
  positions, word lengths and directions for 2 and 3 replicas; and the convergence harness (below).
  The harness also checks that every local edit has exactly the intended effect on the text and that
  a remote operation never reorders existing characters.
- **Not claimed.** This is the base Fugue tree with siblings ordered by id. Fugue's
  "maximally non-interleaving" guarantee (the `FugueMax` variant, which also orders siblings by their
  right origin) is not implemented, and nothing here is promised for edit patterns other than
  contiguous typing runs, for example two users alternately typing and moving their cursors.

### Board document **[implemented]**

Source: `packages/crdt/src/board.ts` (`Board`), `board-ops.ts` (types, palette, validation, errors)
and `board-json.ts` (JSON).

- **Operations.** A `BoardOp` is either `{ type: 'notes', op }` with `op` an `AwMapOp<NoteFields>`
  (create, change or delete a note), or `{ type: 'text', noteId, op }` with `op` a `TextOp` for that
  note's sequence. Operations are immutable data.
- **Local API.** Each call applies the change and returns the operations to send:

  | Call | Operations returned |
  | --- | --- |
  | `createNote({ x, y, color, text })` -> `{ id, ops }` | a map write with all four fields (one timestamp, `z` = top + 1), then the text inserts |
  | `moveNote(id, x, y)` | one map write; `x` and `y` share a timestamp |
  | `setColor(id, color)` | one map write |
  | `bringToFront(id)` | one map write; `z` = top + 1 (the only way to write `z` after creation) |
  | `editText(id, index, deleteCount, insert)` | text deletes, text inserts, then a map write that re-asserts the note |
  | `deleteNote(id)` | one map remove of the dots this replica has seen |

  `editText` is `splice` on code points and returns `[]` if nothing changes. Calls on a note that is
  not present throw `UnknownNoteError`; invalid arguments throw `RangeError` before anything changes.
  Reads: `getNote(id)`, `notes()` (bottom to top: by `z`, then id), `size`.
- **Add wins for everything.** Every write to a note is a map write that replaces the dots its author
  saw, so any change made concurrently with a delete keeps the note. In particular **an edit of a
  note's text concurrent with another replica deleting that note keeps the note, with the edit**
  (tested in both delivery orders, for edits that insert and for edits that delete, and with a third
  replica). A delete made after seeing the edit removes the note for good. A deleted note's text is
  kept, so a surviving concurrent write finds it intact; this also means the sequences of deleted
  notes are never freed **[planned]**.
- **Fields.** Concurrent writes to a note leave several dots; the visible value is their join, which
  takes each field from the write with the greater timestamp. So a concurrent move and recolour both
  show, and two concurrent moves leave exactly one of them.
- **Delivery.** `applyRemote(ops)` accepts operations in any order and repeatedly. Text operations
  wait in their sequence's causal buffer. Map operations wait in a `CausalBuffer` of their own: a
  write requires the previous write of its replica and the dots it replaces, a remove requires the
  dots it removes. Everything is validated first, so a bad operation cannot leave a batch half
  applied.
- **Clock.** The board owns a hybrid logical clock over the injected physical clock, and feeds it the
  newest timestamp of every remote write it applies, so a local write made after seeing a remote one
  always wins. It never rejects an operation for clock drift: a replica that dropped an operation
  others applied would diverge. Bounding drift is the server's job, before operations are shared.
- **Op log.** `board.log` holds every operation that changed the board, once, in the order it took
  effect: duplicates and no-ops are not logged, and an operation that was held back is logged when
  it is released, so the log replays cleanly in order. Restoring a replica is
  `applyRemote(deserializeBoardOps(json))`; it continues its own numbering and its clock moves past
  the log. The log is never truncated yet **[planned]**.
- **JSON** (`board-json.ts`, format version 1): `{ "format": "driftboard-ops", "version": 1, "ops": [...] }`.
  Operation ids are `counter@replica` strings and timestamps use the fixed-width HLC string. Four
  operation types: `note-put`, `note-remove`, `text-insert`, `text-delete`. `deserializeBoardOps`
  and `boardOpFromJson` check every field (ids, timestamps, finite coordinates, palette colour, one
  code point per insert, note id length) and throw `BoardFormatError`; unknown extra keys are
  ignored. A colour outside the palette is rejected, so adding colours needs a format version bump.
- **Subscription.** `subscribe(listener)` returns the unsubscribe function. The listener gets a
  `BoardChange` `{ source: 'local' | 'remote', noteIds, ops }` once per local call and once per
  `applyRemote` that changed something, after the state is updated; duplicates and no-ops are silent.
  If listeners throw, all of them still run and the error (an `AggregateError` for several) reaches
  the caller afterwards. The change stays applied and in the op log, but a local call that throws
  does not return its operations, so a sync layer should send from `board.log` or use listeners that
  do not throw.
- **`snapshot()`** returns the whole state (including deleted notes' text and the causal context) as
  plain JSON; two replicas have converged iff their snapshots serialise equally.
- **Tested** (`board.test.ts`, `board-json.test.ts`): every call and its errors; replication and
  every concurrency case above, plus later-writer-wins for each field in both directions; held back
  and repeated operations, with a property test that shuffles a random history; the op log and JSON
  round trip, restoring a replica, malformed input; subscriptions; and the convergence harness for
  whole-board operations (create, move, recolour, bring to front, edit, delete) on 3 to 5 replicas.
  The harness also checks that every local call has exactly the intended effect on what the board
  shows.

## Sync protocol (outline)

Transport: one WebSocket per client per board, JSON text frames. Every frame is validated with zod
on receipt; invalid frames get an `error` reply and never reach application code. Every message
has a `type` discriminator, and the handshake carries a protocol `version`.

| Message   | Direction       | Purpose                                                              | Status     |
| --------- | --------------- | -------------------------------------------------------------------- | ---------- |
| `hello`   | client → server | Open a session: `version`, `boardId`, `clientId`.                    | scaffolded |
| `welcome` | server → client | Accept the session and confirm protocol `version`.                   | scaffolded |
| `error`   | server → client | Reject a frame: `code` (`invalid_message`) and `message`.            | scaffolded |
| `hello` + `since` | client → server | Resume point: highest server sequence number the client has seen. | planned |
| `push`    | client → server | A batch of CRDT operations from the client's outbox.                 | planned    |
| `ack`     | server → client | Operation ids durably stored by the server.                          | planned    |
| `ops`     | server → client | Operations the client has not seen, with the new `cursor`.           | planned    |
| `presence`| both            | Ephemeral cursors/selection; never persisted.                        | planned    |

Planned behaviour:

1. The server keeps an append-only **operation log** per board in SQLite
   (`ops(board_id, seq, op_id UNIQUE, payload)`), under `./.data/`. `seq` is assigned by the server
   and only orders delivery; it plays no part in conflict resolution.
2. On connect the client sends `hello` with its `since` cursor. The server replies with `welcome`
   followed by every operation after that cursor.
3. The client sends local operations in `push` batches. The server de-duplicates by `op_id`,
   appends new operations, `ack`s them, and relays them to the board's other connections.
4. Operations are idempotent and commute, so duplicates, reordering and re-delivery after a
   reconnect are harmless. Correctness never depends on server ordering.
5. Periodic snapshots bound log replay time and catch-up cost for new clients. **[planned]**

Authentication, authorisation and multi-board access control are out of scope for now; the server
binds to loopback by default.

## Offline-first approach

- **The local replica is the source of truth.** The UI reads and writes the local CRDT state
  only. Edits apply immediately and never wait on the network or on acknowledgements.
- **Durable local storage.** The replica (state plus outbox) is persisted in the browser
  (IndexedDB) so a reload or crash while offline loses nothing. **[planned]**
- **Outbox.** Every local operation is queued until the server `ack`s its id. After a
  disconnect the unacked outbox is resent in full; idempotence makes that safe.
- **Reconnect.** The client reconnects with capped exponential backoff and jitter, then resumes
  from its `since` cursor. Going offline is a normal state, not an error.
- **Merge on reconnect.** Remote operations are applied to the local replica with the same
  functions used for local edits, so offline edits made by several people converge without a manual
  merge step.
- **Deterministic core.** Because `packages/crdt` takes its clock and ids as inputs, offline,
  reordering and partition scenarios can be simulated deterministically in unit and property tests,
  and later in Playwright end-to-end tests.

## Local-only environment

Everything runs inside the repository folder: Node is pinned in `.nvmrc` and `engines`, pnpm is
pinned by the `packageManager` field and run through corepack, the pnpm store is `./.pnpm-store`,
SQLite databases live in `./.data/`, and Playwright browsers will be installed into the project
with `PLAYWRIGHT_BROWSERS_PATH=0`. Dev servers use loopback ports 22100–22199 (sync server 22100,
Vite dev server 22101, Vite preview 22102).
