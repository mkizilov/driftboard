# Performance

What was measured, how, before and after the work of this document, and what it would take to
garbage-collect tombstones. The benchmarks are in `bench/` (`pnpm bench` runs them under Vitest,
`pnpm bench:report` prints the tables below).

## How the numbers were made

- **Machine.** An Apple M4 Mac (arm64, 10 cores, 16 GB) running Node v26.13.0. The repository pins
  Node 22; 26 was what was installed here. One process, one run of each scenario, a warm machine, no
  other load. Two complete runs of the same code agreed within about 10% (100,000 local edits took
  81 ms in one and 76 ms in the other); the second is the one tabulated.
- **Before** is the code of commit `35ea06c`, run from a copy of that tree. **After** is this commit.
  Both run `bench/src/report.ts` with the same seeds and sizes, so they run the same operations. That
  is checked, not assumed: the 100,000 operations of the text benchmark have the same fingerprint
  (`2add3280`) and leave the same 67,888 characters in 83,944 nodes before and after.
- **Where the tables come from.** `report.ts` times each scenario once with `performance.now()`. The
  `*.bench.ts` files are the same scenarios wrapped in `bench()` for `pnpm bench`, which has its own
  section below. The scenario code is also covered by `bench/src/scenarios.test.ts` at small sizes.
  The "before" and the first "after" were measured at a time when dependencies could not be installed,
  so the zod schema check of text messages is not in the sync timings (it is the same before and
  after); `JSON.parse` and `JSON.stringify` are. Neither the real `ws` server nor a browser is in any
  timing (see "Not measured").
- **Heap** is `process.memoryUsage().heapUsed` after a forced collection (`--expose-gc`).

## Summary

|                                                                                            |                  before |           after |
| ------------------------------------------------------------------------------------------ | ----------------------: | --------------: |
| **100,000 text operations performed locally** (an index to a character on every edit)      |          **264,168 ms** |       **76 ms** |
| the same, 40,000 / 20,000 / 10,000 operations                                              | 19,818 / 3,832 / 951 ms | 32 / 20 / 11 ms |
| 10,000 edits, the whole text read after each (an editor)                                   |                1,407 ms |           37 ms |
| read the text once, after 100,000 operations                                               |                 10.3 ms |          4.0 ms |
| 100,000 operations applied by another replica, in order                                    |                   90 ms |           75 ms |
| the same, in random order (causal buffer)                                                  |                  140 ms |          129 ms |
| heap of one replica, 83,944 nodes                                                          |                 26.6 MB |         27.8 MB |
| **load a board of 1,000 notes, 800 typed characters each** (842,485 operations), from JSON |                1,819 ms |        1,847 ms |
| the same, from the binary encoding                                                         |                     n/a |        1,507 ms |
| **sync after 50,000 offline operations** (120,009 moved), bytes on the wire                |               17,649 KB |          437 KB |
| the same, time to be in sync                                                               |                  330 ms |          311 ms |
| whole benchmark process                                                                    |                   295 s |            10 s |

The sequence went from quadratic to logarithmic per edit. Loading and syncing are not limited by it
(below), so their times did not move; what moved there is size.

## 1. Applying 100,000 text operations

A person typing: 78% inserts at the caret, 12% backspaces, 3% forward deletes, and about 7% of the
time a jump of the caret to somewhere else (`editScript`). Operations are counted per character.

| scenario                                       |     before | per operation |  after | per operation |
| ---------------------------------------------- | ---------: | ------------: | -----: | ------------: |
| local edits, 10,000                            |     951 ms |       95.1 µs |  11 ms |        1.1 µs |
| local edits, 20,000                            |   3,832 ms |      191.6 µs |  20 ms |        1.0 µs |
| local edits, 40,000                            |  19,818 ms |      495.5 µs |  32 ms |        0.8 µs |
| local edits, 100,000                           | 264,168 ms |    2,641.7 µs |  76 ms |        0.8 µs |
| apply 100,000 on a fresh replica, in order     |      90 ms |        0.9 µs |  75 ms |        0.7 µs |
| apply 100,000 on a fresh replica, random order |     140 ms |        1.4 µs | 129 ms |        1.3 µs |
| 10,000 edits, text read after each             |   1,407 ms |      140.7 µs |  37 ms |        3.7 µs |

**Why it was slow.** `TextSequence` needed, on every edit, the character at an index and the node
after a node. Both came from two arrays of the whole document in order, and any change marked them
stale; the next edit or read rebuilt them by walking the whole tree. That is O(n) per edit, so the
time per operation grew with the text (95 µs, 192 µs, 495 µs, 2.6 ms: it did a little worse than
quadratic once the working set outgrew the CPU caches). Applying someone else's operations never
read an index and so never paid for it, which is why the "apply" rows were fast before and are
barely different now.

**What was done.** `packages/crdt/src/order-tree.ts` is an order-statistic B+ tree over the nodes in
document order (tombstones included). Leaves hold up to 64 nodes, inner nodes up to 16 children,
and every node knows how many nodes lie below it and how many are shown. Index to node descends by
the counts; node to index climbs parent pointers; insert next to a node, hide a node and the length
are O(log n); the text is cached per leaf, so reading it after an edit rebuilds one leaf and joins
(the 10,000-edit editor row: 40× faster). `TextSequence` puts a node into the tree as it arrives,
from the Fugue rules alone: before the first node of its next sibling, else right before its parent
(left side) or right after the last node of its previous sibling or of the parent (right side). The
public API did not change. A B-tree was chosen over a cached array of positions because a cache is
invalidated by exactly the edits that matter; the tree is updated in place.

**Checked.** The 309 existing CRDT tests (including the 1,000-run convergence properties) pass
unchanged. New tests compare the maintained order with a slow walk of the Fugue tree after every kind
of edit, on random concurrent edits delivered in any order and duplicated, on texts of thousands of
characters, and compare the tree with a plain array through thousands of random operations
(`order-tree.test.ts`, `text-sequence-index.test.ts`). On the final code, mutating the new code in
21 ways (a count off, a cache not cleared, an anchor on the wrong node) was caught by the tests in
all 21 cases (a throwaway script, not part of the repository).

**Limit.** Putting a concurrent sibling into the order finds the first or last node of a neighbouring
subtree by walking down it, which is as long as that subtree's chain. Typing makes chains (one
node per character), so a person who inserts at exactly the place where someone else's long run of
typing starts or ends, concurrently, pays for walking that run once. Local typing never does this.

## 2. Loading a board with 1,000 notes and long texts

1,000 notes, each with 800 characters typed in sessions of 10 to 79 at random places, 30% of them
followed by a few characters erased: 842,485 operations, 783,197 characters shown, the log that a
server stores and a client loads.

| step                                | before (JSON) | after (JSON) | after (binary) |
| ----------------------------------- | ------------: | -----------: | -------------: |
| parse and check the operations      |        661 ms |       673 ms |         397 ms |
| apply them to a new board           |      1,088 ms |     1,133 ms |       1,074 ms |
| read every note, as the screen does |         70 ms |        41 ms |          36 ms |
| **load in all**                     |  **1,819 ms** | **1,847 ms** |   **1,507 ms** |
| write the operations                |           n/a |       327 ms |         100 ms |

Heap held by the loaded board: 300 MB before (one board); after, the JSON and binary loads together
held 611 MB (two boards, measured together), so roughly the same per board.

Loading does not use the index at all, and the table shows it: the sequence is part of
`applyRemote`, not the bulk. Applying just the 816,803 text operations straight to sequences takes
495 to 582 ms, against 1,149 to 1,399 ms for the whole `applyRemote` (three runs of a separate
script, in a process of its own: 582, 495 and 577 ms against 1,399, 1,149 and 1,152 ms). The rest,
roughly 650 to 800 ms, is the board's own work per operation. I did not profile it; from reading the
code I suspect the checking of each operation, the op log and change record, and the add-wins map
copying its entries on each note write. A faster load would have to start there. The binary
encoding's gain here is the parse (1.7×) and the size on disk and wire, not the apply.

## 3. Syncing after a long offline period

Two clients and a server (the protocol's real `Room` and sessions, in one process, no sockets). Both
hold a board of 200 notes. One goes offline and makes 50,000 operations (typing, erasing, moving,
recolouring, raising); the other makes 20,000 meanwhile and sends them to the server. Timed: the
offline client reconnects, receives what it missed, sends what it did, the server stores and relays it
and the other client applies that, until everything is quiet and both boards are equal. 484 messages
of at most 500 operations, 120,009 operations moved in all.

| wire format       | messages | bytes on the wire | time to be in sync |
| ----------------- | -------: | ----------------: | -----------------: |
| JSON text         |      484 |         17,649 KB |             314 ms |
| binary operations |      484 |            437 KB |             311 ms |

Time is the same because it is spent on checking and applying 120,009 operations, not on parsing
them (I did not profile it further). Bytes are 40 times fewer. On a link this would matter, but no link was involved here: for
scale only, 17.6 MB at 10 Mbit/s is about 14 s and 437 KB about 0.35 s (arithmetic, not a
measurement).

## 4. Binary encoding of operations

`packages/protocol/src/binary.ts` (format in the header of the file and in `DESIGN.md`, "Binary
operations"): varints, replica and note ids written once per batch, **runs** of text inserts by one
replica into one note that hang one on the other (a typed word, a paste), runs of deletes of
consecutive counters (up or down), a text edit's re-assertion of its note folded into the run so that
typing a key at a time is a run of pairs, and a put that writes only the fields that changed. The
decoder returns exactly the operations it was given, key order included.

| workload                                       | operations |       JSON |   binary | smaller by | JSON gzipped | binary gzipped |
| ---------------------------------------------- | ---------: | ---------: | -------: | ---------: | -----------: | -------------: |
| one person typing 20,000 keys, a key at a time |     40,001 |   9,481 KB |   348 KB |      27.2× |       406 KB |         109 KB |
| the board of section 2                         |    842,485 | 128,629 KB | 1,100 KB |     116.9× |     9,308 KB |         724 KB |
| the sync of section 3, on the wire             |    120,009 |  17,649 KB |   437 KB |      40.4× |              |                |
| one keystroke on its own, as a message         |          2 |      502 B |     61 B |       8.2× |              |                |

(JSON is the stamped operations as the system moves them, `{origin, seq, op}`; the log file
`serializeBoardOps` writes is smaller, 97,473 KB for the board.) Reading it: a run of typed
characters costs a byte each plus a header of about ten bytes, which is why the board, typed in
sessions of 10 to 80, shrinks 117 times; a person who types a key at a time with the caret jumping
about breaks runs every few keys: 18 bytes a key, 27 times. Gzip finds much of what the encoding
removes, and not all: binary and then gzip is still 3.7 times smaller than gzipped JSON for the
typing and 12.9 times for the board. A message of one keystroke has no earlier message to lean on
(the format has no memory between messages), so the put in it is written whole: 61 bytes instead of 502.

**Where it is used.** Protocol version 3: `ops` messages are binary WebSocket frames
(`encodeFrame`, `parseFrame`; control messages stay JSON text); the server hub and the web
`SyncConnection` send and read them; the server's snapshot is the gzip of a binary batch (version 2,
version 1 JSON snapshots are still read). **Where it is not.** Tail rows in SQLite stay one JSON text
per operation (a compaction empties them); IndexedDB on the device stores operations as objects;
`serializeBoardOps` (the file format) is still JSON. Those are unchanged on purpose: a single
operation gains little from it, and the first two are structured, not text.

**Checked.** 152 protocol tests, 69 server tests (in the hub's tests the peers now send and receive
binary frames for operations) and the web sync tests (binary frames between a client and the room)
pass. The server's `server.test.ts`, which needs the real `ws` and better-sqlite3, was updated for
binary frames and not run. The codec round-trips random three-person editing histories, any stretch of a stream and
batches with gaps; it is refused every prefix of a batch, damaged and random bytes with its own
error and never another, and lying lengths (a billion operations, a run of a million characters in
twelve bytes) at once. On the final code, mutating the codec in 20 ways (a run that joins when it
must not, a counter one off, a size not checked, ...) was caught in all 20 cases (a throwaway
script, not part of the repository).

## 5. Tombstones

A deleted character stays in the sequence as a tombstone. That is not an accident: it is how
concurrent edits find their place.

**Growth.** One note of 1,000 characters, edited 100,000 times by selecting one to five characters and
typing as many over them (the text never grows):

| edits   | shown | nodes held | tombstones | heap of the sequence | time for these edits | per edit |
| ------- | ----: | ---------: | ---------: | -------------------: | -------------------: | -------: |
| 0       | 1,000 |      1,000 |       0.0% |               0.0 MB |                      |          |
| 25,000  | 1,000 |     75,904 |      98.7% |              35.0 MB |                87 ms |   3.5 µs |
| 50,000  | 1,000 |    151,062 |      99.3% |              69.9 MB |               123 ms |   4.9 µs |
| 75,000  | 1,000 |    226,352 |      99.6% |             101.5 MB |               127 ms |   5.1 µs |
| 100,000 | 1,000 |    301,153 |      99.7% |             139.9 MB |               181 ms |   7.3 µs |

The same text with its tombstones dropped: 1,000 nodes, 0.45 MB. So:

- Nodes held are the characters ever typed: about three per edit here, never fewer. Memory is about
  485 bytes a node here (about 350 in the text benchmark): a node is an object with its operation,
  an id, two child lists and a tree slot. That is about 1.4 KB for the characters of every edit.
- Time per edit stays in microseconds as the pile grows (3.5 to 7.3 µs): the tree makes tombstones cost
  memory, not speed. (Before the tree they cost speed too, every edit walking all of them.)
- The log grows by the same edits. A separate measurement (a board edit for each, a different seed
  from the table, so not the same operations): 10,000 such edits are 71,274 operations, 10.7 MB as
  JSON (711 KB gzipped), 262 KB in the binary encoding (26.8 bytes an edit; 144 KB gzipped).
  Dropping tombstones from memory would not shrink the log (below).
- In ordinary use this is small. A sticky note is a few hundred characters edited a few hundred
  times; the table's note is a thousand characters edited a hundred thousand. The 83,944 nodes of
  the text benchmark, 19% tombstones, are 100,000 operations on one text.

**What a tombstone is used for.** (1) The parent of its children: the nodes typed next to it. (2) The
target of any `delete` that has not been applied yet (a delete whose target is missing waits in the
causal buffer for it). (3) An anchor for operations of replicas that have not seen the delete, who
made inserts next to it. (4) An anchor for new local inserts: inserting after a character that has
right children makes the new character the _left child of the next node in document order_, which
can be a tombstone, so replicas that did see the delete go on writing operations whose parent is T.
(5) The anchor of undo: `insertTextAfter` types after a character that may be deleted.

**When it is safe to garbage-collect one.** All of these hold; none is true today:

1. **The delete is causally stable.** Every replica that can still write to the note has the delete.
   The sync layer can say this: an `ack` carries a version vector, a session keeps what its peer
   `acked`, and the delete is operation `(origin, seq)`. The condition is that the pointwise minimum of
   the acknowledged vectors of all those replicas covers it.
2. **"All those replicas" is a set that is known and bounded.** That is the hard part, and the reason
   it is not done. Replica ids are fresh on every page load (`session.ts`), there is no registry of
   devices, and a phone that was offline for a month comes back with operations next to T. Either a
   replica that has been away longer than a lease (say 30 days) is _evicted_: it must reload the
   board from a snapshot, and its unsynced operations are replayed as a diff against the new text
   instead of being merged, which loses their fine intent; or every device registers and the server
   waits for each to acknowledge, a dead one holding the garbage forever.
3. **Nobody will name T again, and everyone knows it.** Because of use (4) a replica that has seen
   T's delete still writes operations with parent T until told not to. Dropping T the moment it is
   stable on the server would leave a late operation with a parent nobody has. So it is two phases:
   first the server announces that T is condemned at some vector; replicas stop using it as an
   anchor (they take the next live node instead) and acknowledge; only when every replica in the set
   has acknowledged the announcement and every operation they wrote before it has been applied is T
   dropped, everywhere, at the same point of the log. The same goes for undo history: it holds the ids
   of characters, so a replica must forget history that names T (history already ends with the page).
4. **T has no children left that matter.** A leaf tombstone can be dropped. A tombstone with live
   children is structure: removing it means re-parenting the children, which changes the operations
   that name it as their parent (the ids are in the log and in every peer). In practice a run of
   deleted text is dropped from its leaves up, or the whole note is rewritten (below).
5. **The log is allowed to forget.** Dropping T from memory does not drop the operations that made
   and deleted it: a replica joining from scratch replays the log, creating T and deleting it again.
   To make the log shrink too, the log before the stable point has to be replaced by a snapshot of
   state plus a base version vector, and the "operations 1..n without gaps" rule of `store.ts` has
   to start from that base. That is a protocol change (version 4), not a cleanup.

**Order of work I would take, safest first.**

1. **Store runs, not characters.** Typed text has consecutive ids; Yjs and Automerge keep a run as one
   block, and tombstones as one range. That would take a node from about 485 bytes to a few per
   character and needs no coordination at all, because ids and operations are unchanged (the encoding
   of section 4 already does this on the wire). It is the cheapest large win, and it changes how big
   a tombstone problem has to be before it matters.
2. **Measure real notes.** Count nodes and tombstones per note on a real server. If no note is past
   tens of thousands of nodes, stop here.
3. **Per-note epochs, only past a threshold** (say 50,000 nodes and 90% tombstones, ~25 MB): when all
   of 1 to 4 hold for a quiet note, rewrite it as a fresh run of its shown text under a new epoch,
   with a log entry for the epoch, drop the history that names the old nodes and the log before it
   (item 5), and have replicas that miss it reload. A property test with the convergence harness
   (random edits, random epochs, replicas offline across them) is the check I would not skip, because
   the failure of this feature is a document that two people see differently.

## Not measured, and limits

- The tables above were made without a browser, a real WebSocket, better-sqlite3, zod or React (none
  was installed then), on Node 26 and not the pinned Node 22. Once the real packages were installed,
  `pnpm bench:report` was run again on Node 22.12 (see "After the security work" below). The
  scenarios are in-process: no browser, socket or SQLite is in the timings, and the end-to-end suite
  measures nothing.
- One run per scenario on one machine (two for the full report). Numbers are for comparison between
  the two columns, not forecasts.
- The sync scenario is in one process: it measures the work of the protocol and the boards, not
  latency or a real network.
- Memory per node was measured on two texts only. Per-note counts on real boards are unknown.
- `vitest bench` has run (see "`pnpm bench`" below), but it takes 2 to 3 samples of the heavy
  scenarios, so its spread is wide; use `report.ts` for the tables.

## After the security work

The security work made `storeAdd` parse the ids of every new operation (to hold each origin's stream to its
numbering, see "Security and robustness" in `DESIGN.md`), made `Room` count the characters of every
note when it is created and as operations arrive, and made the board count what it holds back. To see
what that costs, `pnpm bench:report` was run again, once, on the pinned Node 22.12 with the real
packages installed. It is not an A/B on one runtime (the first run was Node 26.13), so differences of
about 15% are within what the two runtimes and a single run can explain.

| scenario                                                    | before it (Node 26) | after it (Node 22.12) |
| ----------------------------------------------------------- | ------------------: | --------------------: |
| 100,000 local text edits                                    |               76 ms |                 74 ms |
| apply 100,000 operations on a fresh replica (in order)      |               75 ms |                 65 ms |
| load a board of 842,485 operations, JSON, in all            |             1847 ms |               1956 ms |
| load the same board, binary, in all                         |             1507 ms |               1517 ms |
| sync after a long offline period (120,009 ops), JSON wire   |              314 ms |                319 ms |
| sync after a long offline period (120,009 ops), binary wire |              311 ms |                354 ms |

Loading a board goes through `Board.applyRemote`, which these changes did not touch, and does not
call `storeAdd`. The sync scenario does, on both sides, for all 120,009 operations; the binary column
is the one that moved most (about 40 ms), which is the cost of the id checks, if it is not noise.

The server pays for the same checks when it opens a board. Measured separately, on the board of
842,485 operations (3 rounds, Node 22.12): `storeAdd` over the whole log 85 to 95 ms, the scan that
builds the per-note ledger 8 to 10 ms, `createRoom` (which includes that scan) 8 to 11 ms. That is
about a tenth of a second on top of reading the board from the database, once per board per time
its first client arrives.

## `pnpm bench`

`pnpm bench` (`vitest bench --run`, Vitest 2.1.8, Node 22.12, one machine) was run for the first time
after everything above, and it passes (exit 0, about 45 s, 2.5 GB resident at most). Its first run
failed: the sync scenario prepares one world per call (a reconnect uses its world up), and tinybench
calls the function two more times than the runs, untimed, to find out whether it is async. The
scenario ran out of worlds and reported no samples. `bench/src/sync.bench.ts` now prepares for those
calls.

Means of the final run, with the number of samples Vitest took:

| benchmark                                                            |          mean |  samples |
| -------------------------------------------------------------------- | ------------: | -------: |
| 100,000 text operations, performed as a person types                 |         90 ms |        3 |
| the same, applied as another replica, in order                       |         83 ms |        3 |
| the same, in random order, through the causal buffer                 |        163 ms |        3 |
| 10,000 edits, the whole text read after each                         |         35 ms |        3 |
| sync after 30,000 offline and 10,000 meanwhile operations, JSON text |        283 ms |        2 |
| the same, binary operations                                          |        236 ms |        2 |
| load a board of 1,000 notes with long texts, from JSON               |       3479 ms |        3 |
| the same, from the binary batch                                      |       3269 ms |        3 |
| the same, only applying the operations to a new board                |       1484 ms |        3 |
| encode 40,000 operations: `JSON.stringify` / `encodeOps`             | 15.3 / 5.9 ms |  33 / 86 |
| decode 40,000 operations: `JSON.parse` / `decodeOps`                 | 36.2 / 5.0 ms | 14 / 102 |

These are for checking that the benchmarks run and agree in order of magnitude with the tables above
(binary beats JSON on the wire, the tree makes 100,000 edits take tenths of a second); they are not
the figures to quote. The heavy scenarios are too big to repeat, so Vitest reports a relative margin
of error of 8% to 96% for them, and a first run of the same code gave 1.9 s instead of 3.5 s for
loading from JSON. Loading in `report.ts` (1.96 s on Node 22.12) and here are not the same
measurement.
