# Lich Wiki

This is the project's working knowledge: **what we know and why**. It complements the other sources of truth:
- user docs (`docs/`): what Lich does
- the kanban ([Lich Roadmap](https://github.com/users/Moikapy/projects/2)): what to do next
- the code: what Lich actually does, which always wins

It follows [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
- immutable sources live in `raw/`
- agents maintain interlinked pages built from them
- `SCHEMA.md` defines the rules
- `index.md` is the catalog
- `log.md` records history

**Where to start:**
- [`SCHEMA.md`](SCHEMA.md): conventions. Read it before you edit anything.
- [`index.md`](index.md): every page, each with a one-line summary.
- [`log.md`](log.md): what has changed, and when.

**Check the structure** with `node wiki/scripts/lint.mjs`.

**Working with agents:** the `lich-wiki` skill (`.claude/skills/lich-wiki/`) covers orient, ingest, query and lint. Any markdown-reading agent (Cursor, Herdr, Hermes, Lich) can follow `SCHEMA.md` directly.

The wiki is **not shipped** in the npm package, because `package.json` `files` is a whitelist. It is also not part of the VitePress site. It opens fine in Obsidian.
