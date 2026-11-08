# driftboard design

driftboard is a local-first collaborative sticky-note board. Every client holds a full replica of the
board, edits it without waiting for the network, and converges with other replicas through
conflict-free replicated data types (CRDTs) synchronised over WebSockets.

This document describes the target design. Status markers: **[scaffolded]** exists in the
repository today, **[planned]** is designed here but not yet implemented.

## Packages

| Path                | Role                                                                     | Status      |
| ------------------- | ------------------------------------------------------------------------ | ----------- |
| `packages/crdt`     | Pure CRDT library. Zero runtime dependencies, no I/O, injected clocks.   | implemented |
| `packages/protocol` | Sync messages (zod) and the sync logic as pure functions.                | implemented |
| `apps/server`       | Node 22 sync server: `ws` WebSockets, `better-sqlite3` in `./.data/`.    | implemented |
| `apps/web`          | React 18 + Vite client.                                                  | scaffolded  |

Dependency direction: `web` and `server` depend on `protocol` and `crdt`; `protocol` depends on
`crdt`; `crdt` depends on nothing.

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

## Sync protocol **[implemented as pure logic; the server uses it, the client wiring is planned]**

Source: `packages/protocol/src`. `messages.ts` (zod schemas, parse/encode), `ops.ts` and `store.ts`
(stamped operations and the operation store), `sync.ts` (one connection's state machine), `room.ts`
(the server side for one board). Nothing there sends, stores or times anything: every function takes
state and returns the next state, the messages to send and the operations that are new.

**Transport.** One WebSocket per client per board, JSON text frames of at most 1 MiB. Every frame is
parsed with zod (`parseMessage`, which never throws); an invalid frame gets an `error` and never
reaches application code.

**Operation identity.** The author of an operation stamps it with `(origin, seq)`: its own replica id
and a number counting that replica's operations 1, 2, 3, ... without gaps (`authorOps`). A
version vector `origin -> count` therefore says exactly which operations a replica holds, and "the
operations a peer is missing" is "everything beyond its vector". The stamp is separate from the
board's own ids, so the sync layer does not look inside operations; the payload is the board
operation's JSON form (`board-json.ts`). Operations of one origin travel in order; operations of
different origins may arrive in any order because `Board.applyRemote` tolerates that.

| Message | Fields | Purpose |
| --- | --- | --- |
| `hello` | `version`, `replicaId`, `boardId`, `versionVector` | Opens a connection: who I am and exactly what I hold. Sent by the client, answered by the server with its own. |
| `ops` | `ops: [{ origin, seq, op }]`, 1 to 500 | A batch of operations the receiver is missing. |
| `ack` | `versionVector` | "I hold everything this covers." Sent after receiving operations that were new. |
| `presence` | `replicaId`, `state: { cursor, selection, name? } \| null` | Ephemeral cursor and selection, relayed, never stored. `null` means the replica left. |
| `error` | `code`, `message` | A protocol violation; the sender then closes the connection. |

Error codes: `invalid_message`, `unsupported_version`, `wrong_board`, `unexpected_message`
(for example `ops` before `hello`), `out_of_order` (an operation skips ahead of its origin's stream)
and `conflicting_op` (a different operation under an origin and number already stored).

**Connecting.** Each side sends its version vector and the other answers with exactly the
operations beyond it:

1. The client opens with `hello` carrying its vector.
2. The server replies with its own `hello` and one or more `ops` messages with exactly the
   operations the client lacks. A repeated `hello` on the same connection is ignored.
3. The client, on the server's `hello`, sends `ops` with exactly the operations the server lacks.
4. Each side applies what it received (`applied` in the result of `receive`) to its board and acks.

**Staying in sync.** A session keeps `sent`, the operations the peer is known to hold: it starts as the
vector in the peer's `hello`, and grows with every operation sent to the peer, every operation
received from it (it holds what it sent) and every `ack`. `flush(session, store)` sends the
operations beyond `sent` and moves `sent` forward. Anything that may have added operations to the
store (an edit, a received batch) is followed by `flush` on each session, so each operation is sent
to a peer once per connection and never back to the peer it came from. The server's `Room` does this
for every other session when a client's operations arrive, which is also how it relays.

**After a disconnect.** Whatever was in flight is lost, and neither side can know how much arrived.
The next connection starts with `hello`, whose vector is the authoritative record of what each side
holds, so exactly what was lost is sent again and nothing else. There is no separate outbox or
resend timer: a client's unsent operations are simply the ones its server vector does not cover.
A client that lost its own store gets its operations back from the server and numbers on from them.

**No operation is sent twice.** Within one connection `sent` only grows and `flush` only sends what is
beyond it, so a repeated send is impossible; across connections the peer's `hello` replaces the
guess with the truth. Duplicated messages are harmless: a repeated `hello` is ignored, repeated
operations are recognised by `(origin, seq)`, stored once, not acked and not relayed. The server
treats a second connection of the same replica id as the old one coming back and drops the old
session.

**Validation.** `receive` checks every operation payload in depth (`BoardFormatError` rules from the
board JSON), stores it in canonical form, and rejects the whole batch, leaving the store unchanged,
for a bad payload, a gap or a conflict. A client may only send presence for itself.

**Presence.** Relayed to the other ready sessions, not stored. When a client's connection ends the
server relays `state: null` for it.

**Tested** (`packages/protocol/src/*.test.ts`): schemas and malformed input; the store (gaps,
conflicts, duplicates, versions that share storage) against a plain model; the handshake, live
sync, violations and presence of `sync.ts`; `Room` with several clients, reconnects, replaced
sessions and bad clients; and `simulation.test.ts`, a simulated network of 3 clients and a server
with random edits, disconnects, reconnects, the server noticing a dead connection late, and
duplicated messages in flight. Messages travel as JSON text through the real encoder and parser.
Every run must converge (same operations, same board snapshot as a reference replay, nothing left
to send, every session synced) and, while it runs, no operation may be sent twice on a connection,
no original message may carry an operation its receiver already holds, and nobody may send an
error. Without faults every operation crosses exactly one link up and one link down per other
client; a reconnect sends exactly the missing operations.

**Not yet:** there is no client-side wiring, operations are never compacted away, and replica ids
must be unique per device and tab (two live tabs sharing one id would write conflicting streams;
`conflicting_op` catches that only when the operations differ).

## Server **[implemented]**

Source: `apps/server/src`. `server.ts` (HTTP and WebSocket), `hub.ts` (rooms and validation),
`storage.ts`, `snapshot.ts` and `db.ts` (SQLite), `board-id.ts`, `config.ts`, `main.ts`.

**Endpoints.** `GET /healthz` returns `200 {"status":"ok"}` after a `SELECT 1` on the database, or
`503 {"status":"unavailable"}` if that fails (other methods get 405, `HEAD` works). WebSocket
clients connect to `ws://host:port/ws`; an upgrade on any other path gets 404. Everything else is 404.
The server binds to `127.0.0.1:22100` by default.

**Access.** There are no accounts. A board is reached by its id alone, so the id is a capability: the
server accepts only ids of 22 to 128 URL-safe characters (`generateBoardId()` makes 22 random
base64url characters, 128 bits), never lists boards, and `/healthz` reveals nothing about them. A
`hello` with any other id is rejected. Whoever knows the id can read and write the board; there is
no per-user access control, rate limiting or expiry yet.

**Rooms.** `SyncHub` keeps one `Room` (from `@driftboard/protocol`) per board id that has a
connection. The first `hello` for an id loads the board from SQLite; when the last connection
leaves, the room is dropped. The hub is the glue and does no I/O of its own: it receives frames,
runs the pure sync logic, **writes the new operations to storage before anything is sent about
them** (so an `ack` means the operations are on disk; if storing fails the step is discarded, the
connection is closed with 1011 and the room still matches the disk), then sends the messages.

**Validation.** Every frame is checked before it reaches the sync logic, and a connection that
fails a check gets one `error` message and is closed:

| Problem | Close code |
| --- | --- |
| binary frame | 1003 |
| larger than the limit (`maxMessageBytes`, default 1 MiB; also enforced by the WebSocket layer, which cuts the connection off with no reply) | 1009 |
| not JSON, or not valid against the zod schemas | 1008 |
| first message is not `hello`, or its board id is not acceptable | 1008 |
| no valid `hello` within `helloTimeoutMs` (default 10 s) | 1008 |
| protocol violation (bad version, gap, conflict, invalid operation payload, presence for another replica) | 1008 |
| storage failure | 1011 |
| the same replica connected again (the older connection is closed) | 4001 |

Other connections, and the board, are unaffected. Compression is off, so a small frame cannot expand
past the limit.

**Storage** (SQLite under `./.data/`, schema version 2, WAL, `synchronous = FULL`, migrations in
`db.ts`). A board's operation log is kept in two places:

- `ops(board_id, origin, seq, payload)`: the **tail**, one row per operation since the last
  compaction, primary key `(board_id, origin, seq)`.
- `snapshots(board_id, op_count, payload, updated_at)`: the **snapshot**, every operation up to the
  last compaction in one row: gzipped JSON `{ "v": 1, "origins": [[origin, [op, ...]], ...] }`
  without the repeated origin and sequence numbers.

New operations go to the tail (one transaction per message). `compact` folds the tail into the
snapshot in one transaction (decode the snapshot, add the tail, write a new snapshot, delete the tail
rows), so a crash leaves the old or the new state. Compaction runs when a board's tail reaches
`compactAfterOps` (default 1000; after a failed attempt it waits for the tail to grow by that much
again), and every `compactIntervalMs` (default 5 minutes) for every board with a tail, which also
covers boards nobody has open. A failure is reported through `onError` and never closes a
connection. Loading a board reads the snapshot row, decodes it, adds the tail and rebuilds the
operation store, checking the stored operation count and that each origin's numbering is gapless
(`StorageError` otherwise).

The snapshot holds every operation, not a summary of the board's state, because any peer, however
old, is caught up from the log by version vector. Compaction therefore shrinks and speeds up
storage and loading but does not discard history.

**Measured** on this machine (Node 26 `node:sqlite` standing in for better-sqlite3, synthetic
operations that all have the same shape, one run each, no tuning): for 100,000 operations, loading
from tail rows took 208 ms and from the snapshot 136 ms; compaction took 417 ms; the snapshot was
294 KB against about 34 MB of database for the rows (the synthetic operations are far more
repetitive than real ones, so the size ratio is optimistic). For 20,000 operations: 37 ms, 21 ms and
67 ms. Real better-sqlite3 timings were not measured.

**Tested** (`apps/server/src/*.test.ts`): storage, snapshots, schema migration and configuration;
the hub with fake sockets (relaying, persistence order, room lifecycle, compaction and its failure,
every kind of invalid input, storage failures); and `server.test.ts`, which starts the server on
loopback ports 22110-22139 and connects real WebSocket clients (each with a `Board` and the real
sync logic): three clients converge, one of them after editing offline, with every operation received
exactly once; boards are isolated by id; presence is relayed; a restart keeps every board, with
and without a snapshot; compaction by threshold and by timer; malformed text, schema violations,
binary frames, oversized messages, a missing or bad `hello`, invalid operations and a silent
connection are rejected and close the connection while other clients keep syncing; `/healthz`.

**Not yet:** no heartbeat (a dead TCP connection is noticed only when the OS gives up on it), no limit
on connections or rooms, compaction does not `VACUUM` (freed pages are reused but the file does not
shrink), loading and compacting a board are synchronous and block the event loop for their duration,
and the server holds a board's whole log in memory while it is open.

## Offline-first approach

- **The local replica is the source of truth.** The UI reads and writes the local CRDT state
  only. Edits apply immediately and never wait on the network or on acknowledgements.
- **Durable local storage.** The replica (state plus outbox) is persisted in the browser
  (IndexedDB) so a reload or crash while offline loses nothing. **[planned]**
- **Outbox.** There is no separate queue: every local operation is stamped and kept in the
  replica's store, and the ones the server lacks are exactly the ones its `hello` vector does not
  cover. After a disconnect nothing is resent blindly (see "Sync protocol"). **[logic implemented]**
- **Reconnect.** The client reconnects with capped exponential backoff and jitter and opens with
  `hello`; the vectors decide what is sent. Going offline is a normal state, not an error.
  **[planned: the client wiring]**
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
