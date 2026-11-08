# driftboard

A local-first collaborative sticky-note board. See [DESIGN.md](DESIGN.md) for the architecture and
[AGENTS.md](AGENTS.md) for commands and contribution rules.

```sh
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm check             # lint + typecheck + tests
```

Requires Node 22 (`.nvmrc`). Everything stays inside this folder: dependencies in `node_modules`,
the pnpm store in `.pnpm-store`, SQLite databases in `.data/`.
