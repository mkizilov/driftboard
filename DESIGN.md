# driftboard design

driftboard is a local-first collaborative sticky-note board. Every client holds a full replica of the
board, edits it without waiting for the network, and converges with other replicas through
conflict-free replicated data types (CRDTs) synchronised over WebSockets.

This document describes the target design. Status markers: **[scaffolded]** exists in the
repository today, **[planned]** is designed here but not yet implemented.

## Packages

| Path                | Role                                                                   | Status      |
| ------------------- | ---------------------------------------------------------------------- | ----------- |
| `packages/crdt`     | Pure CRDT library. Zero runtime dependencies, no I/O, injected clocks. | implemented |
| `packages/protocol` | Sync messages (zod) and the sync logic as pure functions.              | implemented |
| `apps/server`       | Node 22 sync server: `ws` WebSockets, `better-sqlite3` in `./.data/`.  | implemented |
| `apps/web`          | React 18 + Vite client: board page, canvas, sticky notes, sync.        | implemented |
| `e2e`               | Playwright end-to-end suite: real server and build, several browsers.  | implemented |
| `bench`             | Benchmarks and the report behind `PERFORMANCE.md`.                     | implemented |

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

- **Dots.** Every write creates a _dot_: an `OpId` `(n, replica)` where `n` is that replica's next
  _map_ counter (contiguous, taken from the map's version vector). A dot stores the value written
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
_entire_ state), and optionally `merge`, `observe` (feed the HLC) and `idempotentApply`. States may
be mutated in place by `apply` (the text sequence does this); such a spec must have an idempotent
`apply`, and cannot use `merge`. `checkConvergence(spec, { numRuns = 1000, replicas })` then
generates random scenarios on 3 replicas, or on 3 to 5 with `replicas: { min: 3, max: 5 }`:

- local operations, with the replicas' physical clocks randomly advanced or moved backwards;
- deliveries of single operations to a replica, chosen at random among those that are _causally
  ready_ (everything the origin had applied when it created the operation is already applied);
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
  to deleted characters. Tombstones are kept forever for now; when they could safely be dropped, and
  what they cost until then, is worked out in `PERFORMANCE.md` ("Tombstones").
- **API.** `insert(index, text)` and `delete(index, length)` apply locally and return the
  operations to send; `apply(op)` takes remote (or echoed) operations; `toString()`, `length`,
  `nodes()` (the whole tree in document order, for snapshots and tests) and `pendingCount`. Indices
  count code points (not UTF-16 units, not grapheme clusters). The replica is a mutable object while
  its operations are immutable.
- **Index to character and back.** Editing needs "the character at index i" on every keystroke, and
  the Fugue rules need "the node after this one in document order". Both come from an `OrderTree`
  (`order-tree.ts`): an order-statistic B+ tree over the nodes in document order, tombstones
  included, whose leaves hold up to 64 nodes and whose inner nodes up to 16 children, each knowing
  how many nodes lie below it and how many of them are shown. Index to node descends by those counts,
  node to index climbs the parent pointers, and inserting next to a node, hiding one and reading the
  length are O(log n); the text is cached per leaf, so reading it after an edit costs one leaf and a
  join, not a walk of the document. A node is put into the tree when it arrives: where it goes is
  decided by the Fugue rules alone (before the first node of its next sibling; else right before its
  parent on the left, or right after the last node of its previous sibling or of the parent on the
  right), so no operation ever rebuilds the order. Nodes are only added and hidden, never removed, so
  the tree splits and never merges. An earlier version rebuilt the whole order, with an explicit stack,
  after every change: O(n) per edit, 264 s for 100,000 edits against 81 ms now (`PERFORMANCE.md`).
  The order is checked against a plain walk of the tree in `text-sequence-index.test.ts`.
- **Causal delivery buffer.** `CausalBuffer` is a small generic class: `apply` sends every operation
  through it. An insert requires its parent, a delete requires its target. An operation whose
  requirement has not arrived is parked under that one missing id and applied, together with
  whatever it unblocks and parents before children, as soon as the missing operation is applied.
  Duplicates are harmless. The buffer has no size limit or timeout; `pendingCount` lets the sync
  layer notice a stuck stream and ask for the missing operations again.

#### Interleaving

Question checked: two replicas concurrently type a word at the same position. Each character must
not be mixed in with the other word's characters.

- **Plain RGA** (insert after a predecessor, siblings by descending id) keeps _forward_ typing
  together: each character is inserted after the one typed before it, so a word is a chain and a
  chain is one subtree. It fails for _backward_ typing (a word typed right to left, or any run where
  the cursor stays put): every character is inserted after the same predecessor, so the characters
  of both words are siblings and the id order mixes them. Typing `c b a` and `z y x` at the start
  gives ids `A1 c, A2 b, A3 a` and `B1 z, B2 y, B3 x`; descending order gives `xaybzc`. The
  "why the sequence is not plain RGA" tests reproduce this with a 15-line RGA model.
- **Fugue** puts backward-typed characters on the _left_ side: after the first character, each new
  one lands directly before the previous one, which makes it the previous one's left child (the
  insert rule above, with `origin` = the character before the cursor, whose right subtree now
  starts with the previous character). So a backward run is a chain of left children and a forward
  run a chain of right children. Either way the only siblings are the _first_ characters of the
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

  | Call                                                 | Operations returned                                                                    |
  | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | `createNote({ x, y, color, text })` -> `{ id, ops }` | a map write with all four fields (one timestamp, `z` = top + 1), then the text inserts |
  | `moveNote(id, x, y)`                                 | one map write; `x` and `y` share a timestamp                                           |
  | `setColor(id, color)`                                | one map write                                                                          |
  | `bringToFront(id)`                                   | one map write; `z` = top + 1 (the only way to write `z` after creation)                |
  | `editText(id, index, deleteCount, insert)`           | text deletes, text inserts, then a map write that re-asserts the note                  |
  | `deleteNote(id)`                                     | one map remove of the dots this replica has seen                                       |

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

### Undo and redo **[implemented]**

Source: `packages/crdt/src/history.ts` (`BoardHistory`). Undo and redo reverse only the local user's
own changes, never anyone else's, by generating _inverse operations_: an undo is a new edit that
converges like any other, not a rewind, so it cannot touch what others did. Local edits go through
the history (`createNote`, `moveNote`, `setColor`, `editText`, `deleteNote`, which forward to the
`Board` and return its operations); `undo()` and `redo()` return the operations to send. Each step
is described by what it _did_, in terms that stay true while others edit:

- **Text is undone by id, never by index.** A text step names the characters it typed and the
  characters it deleted. Undoing deletes the typed ones wherever they have ended up (a remote edit
  shifts every index but not an id) unless they are already gone, and types the deleted ones again as
  a block directly after the visible character that stood before them, which is recorded with the
  step (`after`; `null` is the start). Text others typed before, after or inside stays, and a
  character someone else deleted from the user's typing is not brought back. `Board.textNodes`
  (every character in document order, tombstones included), `TextSequence.insertAfter` and
  `Board.insertTextAfter` (type after a character that may be deleted: a tombstone keeps its place)
  exist for this.
- **Typed again means new characters.** A deletion cannot be revoked (a tombstone is permanent), so
  undo types the text anew, and the steps _before_ it still name the originals. `Copies` maps each
  original to the copy that took its place, followed through any number of undos and redos, and is
  applied to the characters to take out and to the `after` anchor. It is keyed by note, because
  character ids are only unique within a note. Two anchors that look natural and failed in testing:
  the character's own tombstone (text typed again goes in front of the old tombstones, so anything
  that stood between two of them lands behind all the copies) and the previous character _including_
  tombstones (while undoing last step first, that one is a tombstone of a step not yet redone).
  Steps are undone last first, so the visible character before a deletion is there, or has a copy.
- **Redo is the inverse of the inverse.** Undoing a step yields the step that undoes it, in the same
  shape (a text step's inverse takes out what was put back and puts back what was taken out), and
  that goes on the redo stack. A new edit clears redo; remote edits clear nothing.
- **Fields** (position, colour) are restored only while they still hold what the user wrote. If
  someone else has moved or recoloured the note since, that value is theirs and the step is skipped.
  A move is one step for `x` and `y`, which are always written together. Raising a note
  (`bringToFront`, done on every click) is not recorded.
- **A deleted note** is put back (`Board.restoreNote`) with the fields it had, _including their old
  timestamps_, so anything another replica wrote since wins over it; its text was kept. If the note
  exists already (another user's concurrent edit kept it: add wins) there is nothing to restore. A
  note someone else deleted stays deleted: every step on it is skipped. **A created note** is undone
  by deleting it, text others added included; redo restores it.
- **Steps that would change nothing are skipped** (and dropped), so undo carries on to the step
  before and a key press does something whenever anything can be undone.
- **Rapid typing is one step.** An edit joins the open typing step if it is in the same note, at most
  1 s after the last edit (the gap, not the total) and right where the caret was left: it starts at
  the caret (typing on, forward delete) or ends at it (backspace, replacing a selection that ends
  there). The caret is remembered as a character id, so remote edits do not move it. Joining folds
  the net effect into one step (typed and then erased characters cancel; a step that cancels
  entirely disappears). An undo, a redo, any other kind of step, another note or a pause closes the
  group. At most 100 steps are kept. The history is in memory: a page load is a new replica, and
  nothing from before can be undone.
- **Limits.** If two people delete the same character at once, the one who undoes brings it back.
  Text taken out of several places in one step comes back as one block at the first place. After
  redo, text typed inside another's edits may land beside rather than inside them. Ctrl+Y is not
  bound. The caret after undoing a deletion stays in front of the restored text (the textarea keeps
  it where it was, as for any change from outside).

**In the web client.** `BoardStore` owns a `BoardHistory` (timed by the session's monotonic clock)
and offers `undo()`, `redo()` and a stable `getHistoryState` for `useSyncExternalStore`; the
operations go out through `submit` like any other. `useHistoryShortcuts` (`UndoRedo` mounts it
beside the Undo and Redo buttons) listens on `window` for Ctrl/Cmd+Z (undo) and Shift+Ctrl/Cmd+Z
(redo) wherever the focus is, and stops the browser's own undo: the textareas are changed from
outside, so their native undo stack would be wrong. It also takes the `beforeinput` events
`historyUndo` and `historyRedo` that the Edit menu or a shake send. Keys of an input method that is
composing, Alt combinations and the one-line name field (which keeps its own undo) are left alone;
the rules are pure (`lib/history-keys.ts`).

**Tested.** `history.test.ts`: grouping (the gap boundary, backspace, forward delete, other note,
after undo), undo and redo of typing, deletions and replacements, **undo after concurrent remote
edits to the same note** (typing at the start and end, inside the user's own typing, deleting part of
it, appending after deleted text, typing in the middle of it), **undo of a note deletion** (fields,
text, for other replicas, redo, when a concurrent edit kept the note, when someone else deleted it),
undoing creation, position and colour (also when someone else changed them), skipped steps, the
stacks and their limit, and two properties on random histories: one person undoing everything
empties the board and redoing everything brings back exactly the same notes, and three people with
random deliveries converge, every `delete` that an undo or redo makes targets a character of the
undoer, and undoing every step keeps every character anyone else wrote. Also `insertAfter`,
`textNodes`, `getFields`, `restoreNote` and `insertTextAfter` in their own tests, and in the web
client `board-store`, `history-keys`, `undo-sessions` (devices with a server in between, offline,
reloads, a random three-device session with undo and redo) and the component tests of `UndoRedo`
and `BoardPage`.

## Sync protocol **[implemented as pure logic; the server and the web client use it]**

Source: `packages/protocol/src`. `messages.ts` (zod schemas, parse/encode), `ops.ts` and `store.ts`
(stamped operations and the operation store), `sync.ts` (one connection's state machine), `room.ts`
(the server side for one board). Nothing there sends, stores or times anything: every function takes
state and returns the next state, the messages to send and the operations that are new.

**Transport.** One WebSocket per client per board, frames of at most 1 MiB. Control messages
(`hello`, `ack`, `presence`, `error`) are JSON text parsed with zod (`parseMessage`); `ops` messages
are **binary frames**, a compact batch of operations (`binary.ts`, below). `encodeFrame` and
`parseFrame` produce and read either kind (`parseFrame` also accepts `ops` as JSON text) and never
throw; an invalid frame gets an `error` and never reaches application code.

**Binary operations** (`binary.ts`, `bytes.ts`; format version 1, protocol version 3). The canonical
JSON of an operation is about 100 bytes for a typed character and 400 for the note being put again
that every text edit also writes. `encodeOps` writes a batch as: varints (seven bits per byte), the
replica and note ids once per batch and an index after that, and these shortcuts. A run of text
inserts by one replica into one note, each hanging to the right of the one before (a typed word or a
paste), is one item with the first insert written whole and a code point per character. The same for
a run of deletes of consecutive counters, up or down. A text edit's re-assertion of its note, which
repeats the note's latest fields as the replica's next dot, is two bytes or, when it follows an
insert or delete that continues a run, nothing at all (the run is of _pairs_, which is what typing a
key at a time makes). A put that changes some fields writes only those, with timestamps as
differences. `decodeOps` gives back exactly the same operations, same key order, so that stored
operations still compare equal as text; it is strict about its input (every length is checked against
what is left, run lengths against the group, replica ids against their syntax) and the operations
it returns still go through `canonicalizeOp` like any others. Sizes against JSON are in
`PERFORMANCE.md`: 27 times smaller for a person typing a key at a time, 117 times for a board with
long texts, 40 times on the wire for a sync after a long offline period.

**Operation identity.** The author of an operation stamps it with `(origin, seq)`: its own replica id
and a number counting that replica's operations 1, 2, 3, ... without gaps (`authorOps`). A
version vector `origin -> count` therefore says exactly which operations a replica holds, and "the
operations a peer is missing" is "everything beyond its vector". The stamp is separate from the
board's own ids, so the sync layer does not look inside operations; the payload is the board
operation's JSON form (`board-json.ts`). Operations of one origin travel in order; operations of
different origins may arrive in any order because `Board.applyRemote` tolerates that.

| Message    | Fields                                                           | Purpose                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`    | `version` (3), `replicaId`, `boardId`, `versionVector`, `token`? | Opens a connection: who I am and exactly what I hold. Sent by the client, answered by the server with its own. The optional `token` is a secret of this replica; see "Security and robustness".                                  |
| `ops`      | `ops: [{ origin, seq, op }]`, 1 to 500                           | A batch of operations the receiver is missing. A binary frame.                                                                                                                                                                   |
| `ack`      | `versionVector`                                                  | "I hold everything this covers." Sent after receiving operations that were new.                                                                                                                                                  |
| `presence` | `replicaId`, `state: { cursor, editing, name, color } \| null`   | Ephemeral: where the pointer is (board coordinates, or `null`), which note is being edited (or `null`), and the person's name (1 to 80 characters) and colour (`#rrggbb`). Relayed, never stored. `null` means the replica left. |
| `error`    | `code`, `message`                                                | A protocol violation; the sender then closes the connection.                                                                                                                                                                     |

Error codes: `invalid_message`, `unsupported_version`, `wrong_board`, `unexpected_message`
(for example `ops` before `hello`), `out_of_order` (an operation skips ahead of its origin's stream),
`conflicting_op` (a different operation under an origin and number already stored), `internal_error`
and `rate_limited` (the connection sent more than it is allowed to).

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
session, if the new one knows the secret the old one came with (`hello.token`); one that does not is
refused.

**Validation.** `receive` checks every operation payload in depth (`BoardFormatError` rules from the
board JSON), stores it in canonical form, and rejects the whole batch, leaving the store unchanged,
for a bad payload, a gap, a conflict or an operation that breaks the rules for the ids of its origin
(`storeAdd`: `invalid`, answered with `invalid_message`; see "Security and robustness"). A client may
only send presence for itself.

**Presence.** Relayed to the other ready sessions, never stored with the operations or written to
the database. A client sends its _whole_ state each time, so a message never depends on an earlier
one and a lost or repeated one does no harm. The room keeps, in memory only, the latest state of
every replica that is on the board, for one purpose: when a client says `hello`, the server follows
its replies with one `presence` message for each replica already here, so a newcomer sees everyone
at once and not as they happen to move. That memory goes when the replica leaves, when its
connection is closed for breaking the protocol (the others are told, as for any departure) and when
the last client leaves the board and the room is dropped. When a client's connection ends the server
relays `state: null` for it. A client that is _silent but not gone_ (a frozen tab on a connection
the server has not noticed is dead) is not the server's business: clients drop whoever they have
not heard from, see "Presence" under the web client. Protocol version 2 changed the state (it had a
list of selected notes and an optional name); version 3 moved operations into binary frames. A client
of another version is refused with `unsupported_version`.

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

**Not yet:** operations are never compacted away, and replica ids must be unique per device and tab
(two live tabs sharing one id would write conflicting streams; `conflicting_op` catches that only
when the operations differ). The web client takes a fresh id on every page load for this reason.
What the protocol does against peers that misbehave is in "Security and robustness".

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
no per-user access control or expiry. What a connection may send is limited, see "Security and robustness".

**Rooms.** `SyncHub` keeps one `Room` (from `@driftboard/protocol`) per board id that has a
connection. The first `hello` for an id loads the board from SQLite; when the last connection
leaves, the room is dropped. The hub is the glue and does no I/O of its own: it receives frames,
runs the pure sync logic, **writes the new operations to storage before anything is sent about
them** (so an `ack` means the operations are on disk; if storing fails the step is discarded, the
connection is closed with 1011 and the room still matches the disk), then sends the messages.

**Validation.** Every frame is checked before it reaches the sync logic, and a connection that
fails a check gets one `error` message and is closed:

| Problem                                                                                                                                     | Close code |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| binary frame that is not a batch of operations (bad bytes, no operations, more than 500), or a frame whose kind and data disagree           | 1003       |
| larger than the limit (`maxMessageBytes`, default 1 MiB; also enforced by the WebSocket layer, which cuts the connection off with no reply) | 1009       |
| text that is not JSON, or not valid against the zod schemas                                                                                 | 1008       |
| first message is not `hello`, or its board id is not acceptable                                                                             | 1008       |
| no valid `hello` within `helloTimeoutMs` (default 10 s)                                                                                     | 1008       |
| protocol violation (bad version, gap, conflict, invalid operation payload, presence for another replica)                                    | 1008       |
| storage failure                                                                                                                             | 1011       |
| the same replica connected again (the older connection is closed)                                                                           | 4001       |
| more messages or operations than the rate limits allow (`rate_limited`), see "Security and robustness"                                      | 1008       |
| an unexpected error while handling a frame                                                                                                  | 1011       |

Other connections, and the board, are unaffected. Compression is off, so a small frame cannot expand
past the limit.

**Storage** (SQLite under `./.data/`, schema version 2, WAL, `synchronous = FULL`, migrations in
`db.ts`). A board's operation log is kept in two places:

- `ops(board_id, origin, seq, payload)`: the **tail**, one row per operation since the last
  compaction, primary key `(board_id, origin, seq)`.
- `snapshots(board_id, op_count, payload, updated_at)`: the **snapshot**, every operation up to the
  last compaction in one row: the gzip of one binary batch of the operations (`encodeOps`, each
  origin's operations together, origins in order of id), which is the **version 2** snapshot. The
  **version 1** format, gzipped JSON `{ "v": 1, "origins": [[origin, [op, ...]], ...] }`, is still
  read, so existing databases keep working, and is replaced by version 2 at the next compaction of
  each board. The two are told apart by the first byte after unzipping (0xDB, or `{`). Tail rows
  stay JSON text, one operation each: they are few (a compaction empties them) and one operation
  alone gains little from the binary form.

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
binary frames that are not batches, oversized messages, a missing or bad `hello`, invalid operations and a silent
connection are rejected and close the connection while other clients keep syncing; `/healthz`.

**Not yet:** no heartbeat (a dead TCP connection is noticed only when the OS gives up on it), no limit
on connections or rooms, compaction does not `VACUUM` (freed pages are reused but the file does not
shrink), loading and compacting a board are synchronous and block the event loop for their duration,
and the server holds a board's whole log in memory while it is open.

## Security and robustness **[implemented]**

The threat is a misbehaving _participant_: someone who has the board id (the id is the only access
control, see "Access") and sends what they like, from a modified client or by hand. Nothing
authenticates people or replica ids. The aim is that such a peer cannot crash the server or another
client, cannot wedge an honest replica with anything cheap, cannot make anyone's memory grow without a
bound at the rate it can send, and cannot make honest replicas disagree. It can still do what any
participant can: write, move and delete.

There are four layers. Each rule is applied where it can be decided the same way everywhere.

**1. The frame (`hub.ts`, `server.ts`).** A frame is at most 1 MiB and must parse (see "Validation"
above). Everything a frame can set off runs inside one `try`: an error the hub does not expect is
reported through `onError` and closes _that_ connection with 1011 (the old code guarded only the sync
logic, not the parser), and `server.ts` has a last guard around the hub call, because an exception in
a `ws` event handler would end the process for every board.

**2. Rate limits, per connection (`rate-limit.ts`).** Two token buckets: _messages_ (burst 1000,
200 a second) and _operations_ (burst 200,000, 10,000 a second), paid for before the frame is parsed
and before a batch is applied. A connection that cannot pay gets `rate_limited` and is closed with 1008. Honest clients send about 20 presence updates a second at most and a message per keystroke, and
a long time offline goes out as a burst of messages of 500 operations, so there is room several times
over; a device that has more than the burst to send gets there over a few reconnects, because what
was stored stays stored. Set `DRIFTBOARD_RATE_MESSAGE_BURST`, `DRIFTBOARD_RATE_MESSAGES_PER_SECOND`,
`DRIFTBOARD_RATE_OP_BURST` and `DRIFTBOARD_RATE_OPS_PER_SECOND` to change them (a burst of 0 turns
that limit off). A flood on connections that never say `hello` is cut off at the first message.

**3. The operation stream (`store.ts`).** `storeAdd` holds every origin's operations to rules about
_ids_, on the server and on every client alike. Because they concern one origin's stream, in the
order it was written, the answer does not depend on the order in which different origins' operations
arrive, so every replica reaches the same verdict:

- an id an operation introduces (a text insert's `id`, a write's `dot`) belongs to its origin, which
  is the rule against claiming another replica's counter range;
- it is the next in the origin's numbering: write dots 1, 2, 3, ... and, per note, character
  counters 1, 2, 3, ... (this is also what keeps two operations from using one id for different
  characters, the one thing that made applying a text throw);
- an id of the origin's own that an operation refers to (a parent, a delete target, a replaced or
  removed dot) is one it has introduced already, so an origin's operations never wait for its own
  future.

The server adds two things a client cannot ask of what it is sent: a board has operations from at
most 1000 replicas (a `hello` has room for no more, so a board with a 1001st could not be joined),
and, in the `Room`, a note's text holds at most `maxNoteNodes` characters, 100,000 by default and
`DRIFTBOARD_MAX_NOTE_NODES` to change, deleted ones included because they stay in memory (`ledger.ts`;
the count only grows, so arrival order cannot change the answer). A violation is a protocol violation:
the batch is stored nowhere, the sender gets `invalid_message` and is closed.

Two more rules need the room, which sees every connection. **A connection may not write in the name
of a replica that another connection is speaking for**, so a live replica's stream cannot be extended
by someone else. It _may_ write the operations of a replica that is not connected: every page load
is a new replica, and the next page load sends what the last could not, in the order of the replica
ids and not of anyone's writing. For the same reason the server does not ask that an id of another
origin that an operation refers to exists yet. And **a `hello` for a replica id that is already
connected is let in only with that replica's secret**: `hello.token`, made when the replica is (the
web client makes it from the same source as the id), sent only in its own `hello` and never relayed.
A reconnect before the server noticed the old connection died has the secret and replaces it, as
before; someone who only knows or replays the id is refused and the replica stays where it is. Without
this, saying a replica's id pushed it off the board, and its own reconnect pushed the intruder off in
turn. A replica that came without a secret can be replaced by anyone, as before.

**4. Applying (`Board.applyUntrusted`, `SyncConnection`).** The sync layer applies what the server
sends with `applyUntrusted`, which never throws because of an operation. An operation that is
malformed, would give one id two characters, would make a text longer than `maxNoteNodes` (default
100,000) or arrives when 250,000 others (`MAX_PENDING_OPS`, shared by the note map and every note's
text) already wait for something missing, is **quarantined**: set aside with a reason, counted
(`Board.quarantinedCount`, `Board.quarantine` for the last 100, `SyncConnection.quarantinedCount`),
and the rest of the batch goes through. When a buffer refuses an operation it refuses what waits for
it too, and remembers the id (10,000 of them) to refuse what arrives later and needs it, so one
refused character does not leave the rest of its run waiting for ever and using up the budget.
`Board.applyRemote` keeps its old contract, an exception and no partial effect for a malformed batch,
for logs that are trusted. The same care covers the disk: `restoreStore` keeps each origin's longest
valid start and counts the rest as dropped, instead of failing to open the board, and `SyncConnection`
catches whatever a message sets off, including the app's own callbacks, and closes only that
connection (which retries).

**Convergence under forged references.** An operation may refer to an id of a replica that does not
exist yet, and the server cannot tell it from one that is merely late. Such an operation waits in the
causal buffer, and it used to be that the replica itself never released it when it later wrote that
id, while every other replica did: they never agreed. The fuzz test below found this. Now a local
write tells the buffer (`CausalBuffer.supplied`), what was waiting is applied and subscribers hear of
it as a _remote_ change, not as part of the edit the call returns (those operations are sent on as
the replica's own).

| Limit                         | Value                            | Where                                    |
| ----------------------------- | -------------------------------- | ---------------------------------------- |
| frame                         | 1 MiB                            | `ws`, `hub.ts`, `parseFrame`             |
| operations in a message       | 500                              | `parseFrame`, schema                     |
| messages / operations a conn. | 1000 + 200/s, 200,000 + 10,000/s | `rate-limit.ts`                          |
| replicas on a board           | 1000                             | `storeAdd` on the server                 |
| characters in a note's text   | 100,000                          | `Room` (server), `Board` (every replica) |
| operations waiting for others | 250,000 per board                | `Board` (`PendingBudget`)                |
| ids in one operation's list   | 1000                             | `board-json.ts`, `board-ops.ts`          |
| quarantine kept               | last 100                         | `Board`                                  |

**Not protected.** These are the limits of having no accounts, and of what a server can know:

- **Replica ids and secrets are not accounts.** Someone can write operations that extend the stream
  of a replica that is not connected. If that replica later returns, its next operation conflicts
  with theirs and its connection is closed; the web client takes a new replica on every page load, so
  in practice only the unsent operations of an earlier page load can be affected, not the page.
- **Operations that wait for ids that never come.** An operation may refer to an id of another
  origin that does not exist, and is accepted because it may only be late. It waits at every client,
  up to the budget of 250,000, after which later operations that must wait are quarantined (a reload
  clears the buffer). The refusal of what waits for a refused operation, and the per-origin rules,
  keep this from growing by itself.
- **A note's text cannot be shortened.** Characters stay in memory as tombstones and count against
  the 100,000, so a note that has been edited a very great deal stops accepting text. Collecting
  tombstones is in `PERFORMANCE.md`; it is not done.
- **No limit on a board as a whole**, on its operations or its notes, other than the rate; none on the
  number of connections or boards; no heartbeat; presence is relayed as the schema allows it, and
  whatever a client does with a name or a position is the client's business.
- **A flood of connections** is not slowed down; the limits are per connection.

**Tested.** `crdt/src/untrusted.test.ts` (budget, refusals and their dependents, limits, junk and
forged input to `applyUntrusted`, the release of waiting operations by a local write);
`protocol/src/hostile.test.ts` (each kind of forged id, the order independence of the rules, the
origin cap, the room's rules, the secret); `server/src/hub.test.ts` (rate limits with a clock the test
moves, forged operations, the cap on a note, a frame that makes the parser throw, the secret);
and two **fuzz tests** with fast-check:

- `protocol/src/fuzz.test.ts` runs 500 random sessions of up to 60 actions against a `Room`. Two honest
  clients edit while a hostile one sends raw text, JSON and bytes (also on connections that never said
  `hello`), copies of real frames with bytes flipped, cut, repeated or inserted, and real operations
  spoiled in thirteen ways (another origin, a skipped or repeated number, another replica's id, a
  counter pushed ahead or to the largest integer, a parent or target that is not there, another or no
  note, a text that is not one character, a side that is not a side, lists of 1000 ids, a replay).
  It rejoins under a new replica when it is thrown out. Nothing may throw; neither honest client may
  be closed; their stores must hold everything the room holds and their boards be identical with
  nothing quarantined; and what the room holds must pass `storeAdd` from scratch, be canonical and
  obey the limit on a note. It must also have got operations through and been refused, so that both
  paths ran.
- `server/src/fuzz.test.ts` does it over real sockets and a real database: 40 sessions of up to 25
  actions with two honest clients and hostile connections that send garbage, bytes, mutated copies of
  honest frames (never a `hello`, which carries a secret), spoiled operations, floods, frames of 2 MiB
  and connections that say `hello` and then nothing. The server must stay up and answer `/healthz`,
  report no unexpected error, keep both honest clients connected with identical boards, give a client
  that joins afterwards the same board, and store only canonical operations; floods must be cut off.

The fuzz tests found two real problems while they were written, both fixed and both now covered by
the tests above: the release of waiting operations by a local write, and a `hello` that pushed a
replica off the board. A mutation check of the protections (23 deliberate bugs, one at a time, each in
the code that holds the rule) was caught by the tests in all 23 cases.

## Web client **[implemented]**

## Web client **[implemented]**

Source: `apps/web/src`. React 18 and Vite; routing is two paths read from `location` (`/` and
`/b/:boardId`, `lib/route.ts`), with no router library. Everything that is not drawing lives in
plain modules under `lib/` that do not import React, so it is tested without a browser; the
components are thin.

**Pages.** `/` makes a board: a new id from `crypto.getRandomValues` (`generateBoardId` from
`@driftboard/protocol`, the same rule the server enforces) and a client-side navigation to
`/b/:boardId`. A board page shows the canvas, whether it is online, syncing or offline with the
number of changes waiting (see "Offline-first approach"), and a _Copy link_ button, since the link is
the only access control (see "Server"). An id the server would refuse is shown as "Not found"
without opening a socket. The board is read from this device first, so it opens with no network.

**From document to React.** `BoardStore` (`lib/board-store.ts`) follows the `Board` through its
change events and keeps one immutable `NoteView` per note, replaced only when that note's fields or
text really changed, and a list of note ids, replaced only when a note appears or disappears. React
reads it with `useSyncExternalStore`: `useNoteIds` subscribes to the list and `useNote(id)` to one
note, so a change to one note renders only that note's `NoteCard` (memoised on `store`, `id` and a
stable `viewportRef`), and panning or zooming renders no note. Ids are in a fixed order and
stacking is the note's `z`, so raising a note never reorders the DOM or makes React move a focused
textarea. The store's mutators change the board, through its `BoardHistory` so that they can be
undone (see "Undo and redo"), and hand the resulting operations to `SyncConnection.submit`;
changing nothing (moving to the same place, picking the same colour, raising the top note) sends
nothing, and a note that someone else deleted meanwhile is ignored quietly.

**Sync.** `SyncConnection` (`lib/sync-connection.ts`) runs the protocol's pure `Session` over a
WebSocket (replaceable in tests through `SocketFactory`, and its timers through `Timers`): it opens
with `hello`, applies what the server sends with `Board.applyRemote`, and sends local operations once
the server's `hello` has arrived. It reconnects forever with delays of 500 ms doubling to 15 s, each
scaled by a random factor between 0.5 and 1. Events from a socket that has been replaced are ignored.
A message that is not text or not valid, or an `error` from the server, closes the connection (the
reason is kept in `lastError`) and the usual retry follows.
`openBoardSession` (`lib/session.ts`) reads the board from storage, then joins the replica id (new
on every page load), `Board`, `BoardStore`, `SyncConnection` and the write-behind `Persistence`.
Storage, the pending count and the indicator are described under "Offline-first approach".

**Canvas.** The camera is `{x, y, scale}` (`lib/viewport.ts`, pure): a board point is drawn at
`world * scale + (x, y)`. Dragging the background pans, scrolling pans, a pinch or Ctrl/Cmd + scroll
zooms around the pointer (scale 0.2 to 3), and there are zoom buttons. The wheel handler is added
by hand because React's wheel listeners are passive and cannot stop the page from scrolling.
Double-clicking the background adds a note centred on the pointer. A note is dragged by its header;
it follows the pointer locally and the move is written to the board once, when the pointer is
released, so one drag is one operation. Notes can be recoloured from six swatches and deleted.

**Text and the caret.** The textarea is uncontrolled, so React never overwrites it behind the
browser's back, and `NoteTextArea` is a thin shell over `createTextBinding` (`lib/text-binding.ts`):

- _The user's change becomes one operation._ `diffText` (`lib/text-diff.ts`) trims the common prefix
  and suffix of the last text the textarea and the document agreed on and the textarea's new value.
  What is left is one replacement, which is the shape of `Board.editText`, so typing, pasting,
  cutting and replacing a selection are each one edit however long. It is counted in code points as
  the board counts, and also in UTF-16 units as the DOM counts; a surrogate pair is never cut in
  half. When a text is ambiguous (typing a second `a` after `a`) the earliest position is chosen.
- _Remote changes keep the caret._ When the document text changes by other means, `applyRemoteText`
  (`lib/caret.ts`) diffs the textarea's current value against it, sets the value, and puts the
  selection back through `mapIndex`: a caret before the change stays, one after it moves with the
  text, one inside replaced text goes to the end of the replacement, and a caret exactly where text
  is inserted stays in front of it. Direction and scroll position are kept. A textarea without
  focus is only updated. Assigning `value` directly would move the caret to the end.
- _Input method composition._ While a composition (Japanese, Chinese, accents) is in progress
  nothing is reported and nothing is overwritten. Changes to the document are only remembered, and
  when the composition ends its result is reported moved over each of them (`rebaseEdit`), so it
  lands where the user typed and not at an offset others' edits shifted. If the composed text
  replaced text that others changed meanwhile, only the inserted text is kept, after the other
  change. A composition that changed nothing just catches the textarea up.
- The textarea has no `defaultValue`: React assigns it to the DOM node and, for a textarea whose
  text has not been edited, that can replace the text without the binding noticing. The first text is
  set in a layout effect instead.

**Tests.** The logic above is tested without React or a browser through `FakeTextarea`
(`lib/test-support.ts`, which models the rule that setting `value` moves the caret to the end),
`FakeNetwork` (`lib/test-network.ts`, the protocol's real `Room` behind fake sockets, with timers the
test advances by hand) and `Device` (`lib/test-device.ts`: one person's browser with a disk that
survives page loads and a network that can be switched off), including property tests over random
sessions of typing, remote edits and compositions, and over random edits, disconnects and reloads on
three devices. Time is virtual: `FakeTimers` has a clock that `advance(ms)` moves, running what
falls due in order, so throttling and timeouts are tested to the millisecond (`presence-sender`,
`presence-store`) and across devices on a shared clock (`presence-sessions`, which also checks that
presence is not written to any disk and that, after random moves, edits, renames, disconnects and
reloads on three devices, everyone sees exactly the others who are online as they last said). The
components (`NoteTextArea`, `NoteCard`, `BoardPage`, `SyncIndicator`, `PwaBanner`, `Cursors`,
`PeopleList`, `UndoRedo`, `HomePage`, `App`) are tested with React and jsdom through
`test-render.ts`.

### Presence **[implemented]**

Who is looking at the board, where their pointers are and which note each is editing. It is
ephemeral: it travels over the same WebSocket as the operations, is never written to IndexedDB or
to SQLite, never counts as a pending change, and is gone when the page or the connection is.

- **Who you are.** A name ("Brave Otter") and one of eight colours, picked at random the first time
  and kept in `localStorage` (`lib/identity.ts`), so it is the same on every board and every page
  load; if storage is blocked it lasts as long as the page. The name can be edited in the bar
  (Enter or leaving the field saves, Escape cancels, an empty name is refused). A stored identity
  that does not validate is replaced.
- **What is sent** (`lib/presence-sender.ts`, `lib/presence.ts`): the whole state `{ cursor, editing,
name, color }`. The cursor is the pointer in _board_ coordinates (so it is right whatever either
  person's pan and zoom is), rounded to whole units, and `null` when the pointer leaves the canvas.
  Panning under a still pointer also counts, since the pointer is then over another part of the
  board. `editing` is the note whose textarea has the focus; it is cleared on blur and when the note
  is deleted or the page closes. Nothing is sent unless the connection is _online_.
- **Throttled to 20 a second.** At least 50 ms pass between two messages. A change that finds the
  line free goes out at once; changes that come sooner are merged and the latest state goes out
  when the interval is over, so the end of a movement is never lost. There is one timer, always set
  for the next moment something is due.
- **Heartbeat.** With nothing new to say the state is sent again every 2 s, so that someone who is
  perfectly still can be told from someone who is gone. On a new connection the state goes out at
  once, because the server and the others know nothing of the new connection.
- **Timeout** (`lib/presence-store.ts`). Everyone else is dropped after 6 s without a message (three
  heartbeats, so one lost message does not make a person flicker away), when they say they have
  left, and all at once when the connection is lost, because nothing can be known about them then;
  when it returns the server's snapshot tells who is here. One timer is pending while anyone is
  here, set for the moment the oldest entry could expire; a message that refreshes an entry only
  notes the time. All timing uses a monotonic clock (`performance.now`), not the wall clock, which
  can be set back.
- **What is shown.** The bar lists this person first ("you", name editable) and then the others by
  name, with "editing a note" next to anyone who is. Each other person's pointer is drawn over the
  canvas with an arrow in their colour and a name label (it keeps its size at any zoom and glides
  over the 50 ms steps with a short CSS transition), and a note being edited gets an outline in the
  editor's colour and a "Name is editing" badge. Names are only ever put into the page as text.
- **Only what changed renders.** `PresenceStore` hands out stable snapshots like `BoardStore`: the
  list of people, and per note a list of its editors that changes only when _that note's_ editors
  do. A moving cursor renders the pointers and the list, never a note.

**Not yet:** presence shows the focused note, not the caret or selection inside it. The server
cannot tell a frozen tab on an open connection from a quiet one, which is why timing out is the
clients' job. Cursors do not follow a person who scrolls the page rather than the canvas. There is
no undo, no keyboard shortcuts for notes and no touch-specific design beyond pointer events.
Concurrent edits of the same word by two people merge as the sequence CRDT dictates, which can read
oddly.

## Offline-first approach **[implemented]**

- **The local replica is the source of truth.** The UI reads and writes the local CRDT state
  only. Edits apply immediately and never wait on the network, on acknowledgements or on the disk.
- **Durable local storage.** Each board's operation log is kept in IndexedDB through the `idb`
  package (`lib/idb-storage.ts`, database `driftboard`). Everything the replica holds is stored,
  its own operations and the ones it received, because the log is what the board is rebuilt from
  and what a version vector is counted over. Three object stores:
  - `ops`, one row per operation, keyed `[boardId, origin, seq]` so that writing an operation twice
    changes nothing (two tabs may receive the same one);
  - `snapshots`, one row per board holding the operations folded so far. When the tail of `ops`
    reaches 500 rows one transaction folds it into the snapshot and deletes it, so loading a long
    log reads one record and not thousands. Nothing is discarded: other replicas are still caught up
    from the full log by version vector;
  - `sync`, one row per board with what the server was last known to hold.
- **Loading before connecting.** `openBoardSession` reads the board from storage and puts every
  operation into a fresh `Board` before anything connects, so a board opens with no network and a
  reload shows what was there. Only an origin's operations 1..n without a gap can be used; anything
  after a gap (a partly written store) is left out, counted in `droppedOps`, and fetched again from
  the server if it has it, so damaged storage never stops a board from opening.
- **Writes behind the app.** `Persistence` (`lib/persistence.ts`) queues what `SyncConnection`
  reports (`onStored` for every operation that enters the store, `onHeld` when the server's holdings
  change) and writes it in order, in as few transactions as it can. If a write fails the failed
  batch stays at the front of the queue, so nothing later is stored ahead of it (that would leave a
  gap), the error is shown ("Not saved on this device") and the next change tries again. Closing the
  page writes what is queued first. Where IndexedDB cannot be opened the board still works from a
  stand-in in memory and says that it is not kept.
- **Replica ids.** A page load is a new replica with a new id, because two tabs sharing one id would
  write conflicting streams. Operations an earlier page load made and never sent are not lost by
  that: they are in the stored log, the server's `hello` vector does not cover them, and they are
  sent like any other operation it lacks. The price is that the version vector gains an entry for
  every page load that wrote something.
- **Outbox and pending changes.** There is no separate queue. The changes waiting are the operations
  in the store beyond what the server is known to hold (`countPending`). That is the server's own
  word: its `hello` vector replaces whatever was stored when a connection starts (the server may
  have lost data), after which its acks can only add to it. It is stored, so a reload while offline
  still knows how many changes are waiting. The count is of operations: a text edit is one per
  character plus one for the note.
- **Reconnect.** The client reconnects with capped exponential backoff and jitter and opens with
  `hello`; the vectors decide what is sent, so exactly what the server lacks goes out, once. Going
  offline is a normal state, not an error. When the browser reports `online` the client connects at
  once instead of waiting out the delay, and when it reports `offline` it gives up a connection that
  may look open for minutes (`lib/network.ts`).
- **The indicator** (`lib/indicator.ts`, `SyncIndicator`) shows _Online_ when connected and the
  server has everything, _Syncing…_ when connected with changes still going out (and during the
  first connection attempt, so opening a board does not flash "offline"), and _Offline_ with "N
  pending changes" when not connected, including while retrying. The syncing state fades in after
  0.4 s so that the few milliseconds every edit spends unacknowledged are not shown.
- **Merge on reconnect.** Remote operations are applied to the local replica with the same
  functions used for local edits, so offline edits made by several people converge without a manual
  merge step. Two people who edit the same board offline, even after reloading in between, end up
  with the same board when both are back; an edit to a note someone else deleted meanwhile keeps
  the note (add wins).
- **Installable and usable offline (PWA).** `vite-plugin-pwa` generates a Workbox service worker
  that precaches every file of the build and serves the cached `index.html` for any navigation, so
  `/` and `/b/:boardId` open with no network, and a web app manifest (`src/pwa-manifest.ts`) with
  192 and 512 pixel icons and a maskable icon, which is what makes the browser offer to install it.
  The icons in `public/` come from `scripts/make-icons.mjs`, which draws them with no
  dependencies. The worker is registered in `main.tsx` and uses the _prompt_ flow: a new version
  waits, `PwaBanner` offers _Reload_, and nothing reloads under someone who is typing. The worker
  only exists in a build (`vite build` then `vite preview` on port 22102), not in `vite dev`. It
  caches the app, not the data: boards come from IndexedDB, and the WebSocket to the sync server is
  not intercepted.
- **Deterministic core.** Because `packages/crdt` takes its clock and ids as inputs, offline,
  reordering and partition scenarios can be simulated deterministically in unit and property tests,
  and in the Playwright end-to-end tests (see _End-to-end tests_).

**Not yet.** Two tabs of the same board on one device see each other's changes only through the
server (they share the stored log but each loaded it once), so they do not sync with each other
offline until one reloads. The log is never truncated, so storage grows with the board's history, and
the browser may evict it under storage pressure (`navigator.storage.persist()` is not requested).
Presence is not stored. A dead connection is noticed by the browser's `offline` event or by the
socket closing; there is no heartbeat on either side yet.

## End-to-end tests **[implemented; not yet run, see AGENTS.md]**

The unit and component tests cover the pieces; the `e2e` package (`@driftboard/e2e`) checks the
whole: the real sync server, the production build of the web app and real browsers, with the claim
the product makes, that everyone ends with the same board.

- **What runs.** `pnpm e2e` runs Playwright with one worker and a Chromium project. Its `webServer`
  builds the web app into `e2e/dist/web` with `VITE_SYNC_URL` pointing at the test server, and serves
  it with `vite preview` on port 22151. A worker-scoped auto fixture, `syncServer`, starts the real
  server (`node --import tsx apps/server/src/main.ts`, so that killing the process kills the server;
  `tsx` on its own would leave a child behind) on port 22150 with an empty database under `.data/`
  and with `DRIFTBOARD_COMPACT_AFTER_OPS=50`, so that boards are folded into snapshots and a restart
  loads from one. Both ports differ from the dev servers' (22100 to 22102).
- **People.** Fixture `openBoard('ann', 'ben', 'cat')` makes a board on the front page and opens it
  in a browser context per name (`support/person.ts`). A context has its own IndexedDB, local
  storage and connection, so it is another device; service workers are blocked so that the pages
  always come from the network and going offline is the network's doing alone. A `Person` drives the
  page the way a person does (double-click the canvas, type with the keyboard into a note's
  textarea, drag a note by its header with the mouse, click the colour, delete, undo and redo
  buttons) and reads what it shows (`.sync[data-state]`, each note's `data-note-id`, `data-color`,
  inline `transform` and `z-index`, and the textarea's value), so a test sees what a user sees.
  Failed tests keep a Playwright trace for every person.
- **Convergence.** Every test ends with `expectConverged(people)`: everyone's indicator must say
  _Online_ (connected, nothing left to send), and then every person's board, read from the page and
  sorted by note id, must be the same on three reads in a row (so two boards that agree by chance on
  the way somewhere else do not pass), or the error says which note differs in which field. It also
  fails on any uncaught error in a page.
- **Specs** (`e2e/tests`): _concurrent typing_ (two people at one place; three before, inside and
  after a shared text, where the result is exact; one erasing a phrase while another types after it),
  _concurrent moves_ (two people dragging one note, letting go together or one while the other still
  drags, where the result must be one of the moves whole, never an x from one and a y from the
  other; three people dragging two notes), _offline_ (`context.setOffline(true)`, typing, colouring,
  creating, nothing reaching the others while it lasts, then `setOffline(false)` and a merge of
  everything; two people offline in one note; many short outages), _server restart_ (stop and
  restart with edits made while it is down, kill in the middle of typing, a restart for each of three
  people; a newcomer after the restart gets the whole board from the database) and _reload_ (the
  same board comes back, a reload in the middle of someone's typing, and a reload while the server is
  away, which keeps what was typed and sends it when the server returns).
- **Monkey test.** `planMonkey(seed, 200, 3)` (`support/monkey-plan.ts`) is a plan of 200 actions
  from a seeded generator (Mulberry32, `support/rng.ts`): create, type, erase, move, recolour,
  delete, undo, redo, go offline, come back, reload and pause, with typing the most common and text
  that includes `é` and an emoji. The plan says what, not where: the note is a pick taken modulo the
  notes the person sees, the caret a fraction of the text, the spot for a new note a free one found
  from the notes on the page (`support/geometry.ts`). `runMonkey` (`support/monkey-run.ts`) carries
  the plan out step after step without waiting for the others between steps, so what one person did
  is still on its way when the next acts. A step that cannot be done (the note was deleted or is
  covered, nothing to undo) is skipped and counted, and a run with fewer than 100 steps done fails as
  not testing much. At the end everyone is put back online and `expectConverged` decides. The seed is
  in the test's title (`E2E_SEED=n` repeats it, `E2E_MONKEY_RUNS=n` runs n consecutive seeds), and the
  plan and the per-step report are attached to the result.
- **Unit-tested helpers.** What can be tested without a browser is, with Vitest, by `pnpm test`: the
  seeded generator, the plan, the runner (against a fake person), reading and comparing boards,
  geometry, polling, and `SyncServer` (start, stop, kill and restart on the same database, against a
  stand-in server).

**Not covered.** Chromium only. The service worker and offline _page loads_ (the PWA) are not
exercised, because the suite blocks service workers; offline here means a loaded page that loses its
network. Presence (cursors, who is editing) is not asserted. A server that comes back with an empty
database is not tried. There are no retries: a failure is a finding.

## Local-only environment

Everything runs inside the repository folder: Node is pinned in `.nvmrc` and `engines`, pnpm is
pinned by the `packageManager` field and run through corepack, the pnpm store is `./.pnpm-store`,
SQLite databases live in `./.data/`, and Playwright's Chromium is installed into the project with
`PLAYWRIGHT_BROWSERS_PATH=0` (`pnpm e2e:install`). Dev servers use loopback ports 22100–22199 (sync
server 22100, Vite dev server 22101, Vite preview 22102); the end-to-end suite uses 22150 and 22151,
the server's WebSocket tests 22110 to 22139, its fuzz test 22140, and the unit test of `SyncServer` 22195.
