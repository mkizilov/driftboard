# A sceptical review of `packages/crdt`

Question: **in which cases can two replicas that have received the same operations end up in different
states?** This is the answer after reading all of the library (`hlc`, `lww-register`, `version-vector`,
`aw-map`, `causal-buffer`, `text-sequence` with its `order-tree`, `board`, `board-json`, `board-ops`,
`history`) and trying each suspicion on the code instead of arguing it. The cases are tests in
`packages/crdt/src/review.test.ts`.

"Converged" means what the convergence harness means: equal `Board.snapshot()` (the version vector,
every surviving write with its timestamps, every node of every text with its tombstone flag, and the
count of operations still waiting). A replica that has not yet received something is not a
divergence; the question is about replicas that have received the same set.

## Summary

| #   | Case                                                                                    | Can honest replicas reach it?                                                                                                              | Status                                                  |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| F1  | A timestamp the clock cannot move past made `Board` skip releasing waiting writes       | No (needs a hostile timestamp)                                                                                                             | **Fixed**, tests added                                  |
| F2  | `-0` stayed `-0` on the writer and became `0` everywhere else                           | Yes, by dragging to exactly `-0`                                                                                                           | **Fixed**, test added                                   |
| O1  | One id, two different contents: the first to arrive wins on each replica                | Only by reusing a replica id after losing its history                                                                                      | Open in the library; blocked by the protocol            |
| O2  | Limits that refuse operations (`maxNoteNodes`, `maxPendingOps`) keep what arrived first | The note limit: only at the limit. The pending budget: on a cold load of a board of hundreds of thousands of operations by several authors | Open; the server keeps the note limit from being passed |
| O3  | A replica whose offline text passes the note limit can never sync it                    | Yes, with about 100,000 characters in one note                                                                                             | Open                                                    |
| O4  | The strict `applyRemote` drops the rest of a batch after the first failure              | Not through the app (it uses `applyUntrusted`)                                                                                             | Open by design                                          |
| O5  | Limits are part of the protocol but not versioned                                       | Through version skew                                                                                                                       | Open; the server refuses the worst misconfiguration     |
| O6  | A quarantined operation is not retried until the page is reloaded                       | Only after O1 to O3                                                                                                                        | Open                                                    |

Not divergence, but found on the way: a far-future timestamp freezes a note's fields (see the end).

## Method

1. **Read** every file of the library as an adversary: for each function, what input makes two
   replicas take different paths, and what state is changed before something can throw.
2. **Pushed the existing property tests much harder.** The convergence harness (3 to 5 replicas,
   random local operations, random delivery order, redelivery) was run at **50,000 scenarios each**
   for the register, the add-wins map, the text sequence and the whole `Board`: no divergence. That
   says the happy path is sound. It also says little about inputs the generators never produce, which
   is where everything below was found.
3. **Wrote each suspicion as a test** and ran it. One suspicion was **wrong** and is struck out:
   I expected a note id containing a lone UTF-16 surrogate to be altered by the binary codec (UTF-8
   cannot hold one), which would make clients and server disagree about the key. It round-trips
   exactly.
4. **Checked that the tests for the fixes can fail**: each of F1's two layers, removed alone, makes
   one of its tests fail, and the tests of F2 failed before the fix.

## Found and fixed

### F1. A write that took effect, followed by a clock that threw

`Board` applies a write to the map, records it, and then moves its own hybrid clock past the write's
timestamps (`#observe`). `HybridLogicalClock.receive` throws when the remote timestamp has the largest
logical counter (`0xffff`), because adding one overflows, and it throws **only on replicas whose
physical clock is behind the timestamp's wall time**; a replica whose clock is ahead takes the same
timestamp without complaint. The exception came out of the buffer's `apply` callback _after_ the map
had changed, and `CausalBuffer` then skipped releasing the operations that were waiting for that
write's id. So, for the same operations in the same order:

- the replica with the faster clock applied the waiting write;
- the replica with the slower clock kept it pending **forever**, and reported the applied write as
  quarantined.

Any participant can send such a timestamp, and the server accepted it (the format allows it). It
cannot happen to an honest replica, which would need 65,535 events in one millisecond.

_Fix, in two layers_: `#observe` is advisory and no longer throws (a clock that cannot move past a
timestamp stays where it was, which is what `receive` guarantees on failure); and `CausalBuffer`, when
an `apply` throws after the id it provides has been applied, releases what waits for it, so that no
future bug of that shape can make replicas differ in what they hold. Tests: `fixed: a clock that
cannot take a timestamp` (three), and a buffer test of the late throw.

### F2. Signed zero

`-0` is a valid coordinate (`Number.isFinite(-0)`), but JSON and the binary form both drop the sign.
The replica that wrote it kept `-0`; every replica that heard of it, and the server after a restart,
held `0`. The snapshots compared equal (they are JSON), so the harness could not see it, but
`Object.is` and `1 / x` can.

_Fix_: coordinates are normalised to plain zero where a replica writes them (`createNote`,
`moveNote`) and where operations are read (`boardOpFromJson`). Test: `fixed: zero with a sign`.

## Still open

### O1. One id, two different contents

Every CRDT here assumes an id names one thing. If it names two, each replica keeps whichever it saw
first, so replicas that saw them in different orders disagree, and so do all the operations that
build on the one they discarded:

- a text character id (`counter@replica` in a note) used for two different characters (the second is
  refused with `RangeError` by whoever has the first);
- an add-wins map dot used for two different writes (the second is silently ignored);
- on the standalone `LwwRegister`, one timestamp used for two values. Inside a `Board` this one is
  **not** a problem: surviving writes are joined in the order of their dots, so a tie is broken the
  same way everywhere. (The test for the register class is there so that nobody relies on it
  standing alone.)

_Who can cause it_: a misbehaving replica; or an **honest replica that is started again with the same
replica id but without its history**, because it then numbers its next operations from 1 again
(`createNote` would make a second note `1@r`); or two tabs sharing one replica id. The web client
takes a fresh replica id on every page load for exactly this reason.

_What the rest of the system does_: `packages/protocol` makes it impossible for one **stream** to reuse
an id (each origin's ids are checked to be the next in its numbering, per note for characters); a
connection cannot write in the name of a replica that is connected; and saying a replica's id does
not take its place (`hello` carries a secret). What is not covered: an id reused by a replica that
is _not_ connected, whose stream someone else can extend. The library alone cannot prevent any of
this, because it cannot tell a repeat from a forgery.

### O2. Limits that refuse operations depend on arrival order

`TextSequence` can be given `maxNodes` and `Board` has `maxNoteNodes` and `maxPendingOps`. An
operation over a limit is refused, so when more is offered than fits, **which part is kept depends on
which arrived first**, and two replicas that heard in different orders keep different parts. The same
holds for the 10,000 ids a buffer remembers as refused.

The note limit is not reached by honest use at normal sizes. The server enforces the same limit, in
the order it receives operations, and relays only what fits, so a client of the server never holds
more than the limit; the server's configuration cannot be set above what clients accept
(`DRIFTBOARD_MAX_NOTE_NODES` is checked at start).

The **pending budget can be reached by honest use**, at scale. A client that loads a board from
scratch is sent the operations sorted by replica id, which is random and not the order they were
written in. An author's operations that build on another author's wait until those arrive, so on a
very large board written by several people the number waiting can approach the number of
operations of the authors that sort first. Past 250,000 the client refuses real operations, and a
reload gives the same order and the same refusals. Nothing in this repository is that large and
multi-author (the 842,485-operation benchmark board has one author, so nothing ever waits), but it is
a limit and not an impossibility. The real fix is for the server to send operations in the order it
received them, which is a causal order, so that nothing has to wait; the stored log would need to
keep that order, which it does not today.

### O3. Going past the note limit while offline

The local edit of a replica is not refused by what others have added, because it cannot know. If
someone offline adds text that, together with what others added meanwhile, passes the limit, the
server refuses their batch and closes the connection; the next connection sends the same batch, and
the same happens. The rest of the board syncs, but **that part of that replica never reaches anyone**,
so it differs for as long as the text is there. It needs about 100,000 characters in one note
(deleted ones count), so it is far from ordinary use, but it is reachable by an honest user and is
the one case in this list that is a liveness problem and not a stray input. A real fix needs a rule
for what the replica does with the refused part (for example, keep it as a note of its own).

### O4. The strict `applyRemote` stops at the first failure

`Board.applyRemote` is kept for trusted logs and validates a whole batch first, but if applying
fails halfway (an id reused for another character), the operations after it are **not integrated at
all**, while a replica that was given them one at a time has them. The app never calls it with
network input (`applyUntrusted` does not stop), but `bench` and the tests do, and any new caller
should know.

### O5. The limits are part of the protocol but are not versioned

`MAX_NOTE_NODES`, `MAX_PENDING_OPS` and `MAX_OP_REFS` decide which operations are valid or kept. Two
replicas built with different values disagree as in O2. The protocol version covers the wire format
only; changing a limit should change it.

### O6. A quarantined operation is not retried within the session

If an operation is refused (O1 to O3) the replica does not try it again; the operation is in the
stored log, so reloading the page rebuilds the board from the store and may apply it. Until then, the
board differs from one that did not refuse it.

## Considered and found sound

- **Sibling order** in the text tree is by `(counter, replicaId)` of the node ids, which are unique
  once O1 is excluded, so it is the same total order everywhere, whatever the arrival order. The
  counters are per replica and per note, not a global Lamport clock, so the order does not follow
  causality across replicas, only agreement; that is a quality question (what goes where), not a
  convergence one.
- **Left and right children** are placed by the same rule on every replica, and the derived order
  tree (`order-tree.ts`) is only an index: `assertConsistent` compares it with the tree in the
  property tests, and a mutation check of it (21 deliberate bugs) was caught each time. This is
  evidence, not a proof.
- **Add-wins map**: surviving writes are joined in the order of their dots and the join is
  commutative, so the visible value does not depend on arrival order; a write is applied only after
  everything it replaces and its predecessor from the same replica (the buffer's `requires`), which
  is what makes the version vector a valid memory of removals.
- **Redelivery and duplication**: every operation is idempotent (a seen dot, a node that exists with
  the same content, a tombstone that is already one, a register that already holds a newer write).
- **Deletes before inserts**: a delete of a character that has not arrived waits for it.
- **Text indices** count code points and are only used locally; operations carry ids, not positions.
- **No hidden inputs**: the library reads no clock, no randomness, no environment (a lint rule), so a
  replica's state depends only on the operations and the injected clock.
- **Lone surrogates** in note ids or characters: the JSON and the binary form both keep them exactly.
- **Equal timestamps from different replicas** differ in the replica id; equal timestamps with
  different values inside a `Board` are broken by dot order (see O1).
- **`BoardHistory`** (undo) only produces ordinary operations through the `Board`'s own methods, so
  it converges like any edit; whether an undo does what the person meant is tested but is not a
  convergence matter.

## Assumptions the library makes

These are not checked by the library; anyone embedding it must provide them.

1. Replica ids are unique among live replicas, and a replica id is **never reused without its full
   history** (O1).
2. Each origin's operations are applied in order. `Board` guarantees this with its buffer; `AwMap`
   alone throws `CausalOrderError` otherwise.
3. Every replica uses the same limits and constants (O2, O5).
4. Operations come from a source that applies the rules of `packages/protocol` (`storeAdd`), or else
   O1 is open.
5. The physical clock returns integer milliseconds in `[0, 2^48)`. A replica does not reject
   far-future timestamps (`maxDriftMs` is effectively infinite, deliberately: a replica that dropped
   what another applied would diverge), so bounding them is for the server.

## Related, not divergence

- **Clock poisoning.** A timestamp far in the future from a misbehaving peer makes a note's fields
  win over every later write until real time catches up (a year-10000 timestamp: never), and moves
  every replica that hears of it onto that time, so their later writes still order after it but
  within it. Everyone agrees; the note just cannot be moved. The server could reject timestamps more
  than a day ahead of its own clock; it does not yet.
- **Grapheme clusters** can be split by concurrent edits, because the unit is the code point.
- **Quarantine counts differ** between replicas that were given operations in different forms; they
  are not part of the replicated state.

## What this review did not do

It is not a proof. The text sequence was not compared with the published Fugue algorithm line by line,
`order-tree.ts` and `history.ts` were checked by tests (property tests, mutation checks) and not by
reasoning to the end, and the random generators are small (a few operations per scenario). A
model-based comparison with a reference implementation, and a much longer fuzz of the text sequence
with many replicas and many operations, are the next things to do.
