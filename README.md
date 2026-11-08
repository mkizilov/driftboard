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

Open the web client and choose *Create a board*. The link is the only key to the board: open it in
another tab or browser to edit together. Double-click the background to add a note, drag a note by
its header, scroll to pan and Ctrl/Cmd + scroll (or pinch) to zoom.

Requires Node 22 (`.nvmrc`). Everything stays inside this folder: dependencies in `node_modules`,
the pnpm store in `.pnpm-store`, SQLite databases in `.data/`.
