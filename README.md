# driftboard

A local-first collaborative sticky-note board. See [DESIGN.md](DESIGN.md) for the architecture and
[AGENTS.md](AGENTS.md) for commands and contribution rules.

```sh
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm check             # lint + typecheck + tests
```

Run the app (two terminals, loopback only):

```sh
pnpm --filter @driftboard/server dev   # sync server, ws://127.0.0.1:22100/ws
pnpm --filter @driftboard/web dev      # web client, http://127.0.0.1:22101
```

Boards are kept in the browser (IndexedDB), so they open with no network and changes made offline are
sent when the connection returns; the bar shows *Online*, *Syncing…* or *Offline* with the number of
pending changes. The app is a PWA that can be installed and used offline once it has been loaded;
the service worker only exists in a build:

```sh
pnpm --filter @driftboard/web build
pnpm --filter @driftboard/web preview   # http://127.0.0.1:22102
```

Open the web client and choose *Create a board*. The link is the only key to the board: open it in
another tab or browser to edit together. Double-click the background to add a note, drag a note by
its header, scroll to pan and Ctrl/Cmd + scroll (or pinch) to zoom.

Ctrl/Cmd+Z undoes your last change and Shift+Ctrl/Cmd+Z redoes it (there are Undo and Redo buttons
too). Undo only reverses *your own* changes, never what others did: your typing comes out of a note
whoever else has typed in it, text you deleted comes back where it was, and a note you deleted comes
back. Rapid typing is one step. History lasts as long as the page.

People on the same board see each other: the bar lists who is here, each person's pointer is drawn
with their name and colour, and a note that someone is typing in is outlined with their name on it.
You get a random name and colour, kept in this browser; click your name in the bar to change it.
This is *presence*: it is never stored, is sent at most 20 times a second, and someone who has said
nothing for 6 seconds drops off the list.

Requires Node 22 (`.nvmrc`). Everything stays inside this folder: dependencies in `node_modules`,
the pnpm store in `.pnpm-store`, SQLite databases in `.data/`.
