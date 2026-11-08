# driftboard

A local-first collaborative sticky-note board. See [DESIGN.md](DESIGN.md) for the architecture and
[AGENTS.md](AGENTS.md) for commands and contribution rules.

```sh
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm check             # lint + typecheck + tests
pnpm e2e:install       # once: Playwright's Chromium, into this folder
pnpm check:all         # pnpm check, then the end-to-end suite (pnpm e2e)
```

Run the app (two terminals, loopback only):

```sh
pnpm --filter @driftboard/server dev   # sync server, ws://127.0.0.1:22100/ws
pnpm --filter @driftboard/web dev      # web client, http://127.0.0.1:22101
```

Boards are kept in the browser (IndexedDB), so they open with no network and changes made offline are
sent when the connection returns; the bar shows _Online_, _Syncing…_ or _Offline_ with the number of
pending changes. The app is a PWA that can be installed and used offline once it has been loaded;
the service worker only exists in a build:

```sh
pnpm --filter @driftboard/web build
pnpm --filter @driftboard/web preview   # http://127.0.0.1:22102
```

Open the web client and choose _Create a board_. The link is the only key to the board: open it in
another tab or browser to edit together. Double-click the background to add a note, drag a note by
its header, scroll to pan and Ctrl/Cmd + scroll (or pinch) to zoom.

Ctrl/Cmd+Z undoes your last change and Shift+Ctrl/Cmd+Z redoes it (there are Undo and Redo buttons
too). Undo only reverses _your own_ changes, never what others did: your typing comes out of a note
whoever else has typed in it, text you deleted comes back where it was, and a note you deleted comes
back. Rapid typing is one step. History lasts as long as the page.

People on the same board see each other: the bar lists who is here, each person's pointer is drawn
with their name and colour, and a note that someone is typing in is outlined with their name on it.
You get a random name and colour, kept in this browser; click your name in the bar to change it.
This is _presence_: it is never stored, is sent at most 20 times a second, and someone who has said
nothing for 6 seconds drops off the list.

The end-to-end suite (`e2e/`, Playwright) starts the real sync server and the production web build
on loopback ports 22150 and 22151 and opens two or three browser contexts on one board. Its specs
type in the same note at once, move the same note at once, take one context offline with
`context.setOffline(true)`, restart or kill the server mid-session and reload the page, and a
randomized monkey test does 200 random actions across three contexts; every test ends by checking
that all contexts show identical boards. `E2E_SEED=n pnpm e2e` repeats a monkey run and
`E2E_MONKEY_RUNS=n pnpm e2e` makes n runs on consecutive seeds. A failed test keeps a Playwright
trace per person in `e2e/test-results/`.

Performance: `PERFORMANCE.md` has the numbers before and after the work on the text sequence and the
binary encoding of operations (100,000 local edits: 264 s to 76 ms; a sync of 120,000 operations: 17.6
MB to 437 KB), and what it would take to garbage-collect tombstones. `pnpm bench:report` reproduces
the tables and `pnpm bench` runs the same scenarios under `vitest bench`.

Requires Node 22 (`.nvmrc`). Everything stays inside this folder: dependencies in `node_modules`,
the pnpm store in `.pnpm-store`, SQLite databases in `.data/`.
