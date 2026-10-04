---
name: lich-wiki
description: Maintain and use the Lich project wiki (wiki/), an LLM-maintained knowledge base of research, architecture rationale, decisions and game/engine knowledge. Use when asked about the wiki or knowledge base, "what do we know about X", to ingest a source or research findings, to record or revisit a decision, or to lint the wiki; and after a PR merges, a review or audit completes, or research on an external system finishes.
---

# Lich wiki

`wiki/` holds **what we know and why**. The authority on its structure is
[`wiki/SCHEMA.md`](../../../wiki/SCHEMA.md). Read that file first and follow it
wherever it differs from this summary.

| Question | Source of truth |
|---|---|
| What Lich does | code + tests (these always win) |
| How to use it | `docs/` |
| What to do next, and its status | the kanban (`lich-kanban` skill) and issues |
| Why, research, history | **this wiki** |

## Orient (every session, before touching the wiki)

1. Read `wiki/SCHEMA.md`, then `wiki/index.md`.
2. Read the last ~30 lines of `wiki/log.md`.
3. Search before creating anything: `grep -ril "<topic>" wiki --include=*.md`.

## Ingest a source

1. Save it under `wiki/raw/<audits|issues|reviews|external>/`, with a date prefix if it may be re-ingested later.
2. Stamp it. The hash covers the body only, with trailing newlines stripped:
   ```bash
   f=wiki/raw/external/x.md; url="https://…"; body=$(cat "$f"); sha=$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)
   { printf -- '---\nsource_url: %s\ningested: %s\nsha256: %s\n---\n' "$url" "$(date +%F)" "$sha"; printf '%s\n' "$body"; } > "$f.tmp" && mv "$f.tmp" "$f"
   ```
   To snapshot an issue, write `gh issue view N --json title,body,comments` to a file, then stamp it.
3. Update the affected pages, or create new ones:
   - frontmatter as defined in the schema
   - at least 2 `[[links]]`
   - code cited as `path:line@sha`
   - `^[raw/…]` provenance on pages that synthesize several sources
4. Add new pages to `index.md` and bump `updated:` on the pages you edited.
5. Append to `log.md`.

## Query

- Answer from the wiki first and cite the pages (`[[slug]]`). Where the answer depends on code, check the code at `HEAD`; the code wins.
- If an answer will matter again, file it as `wiki/queries/<slug>.md`, add it to the index and log it.

## Record a decision

1. Use the next number: `ls wiki/decisions | sort | tail -1`, plus one. Name the file `NNNN-slug.md`.
2. Frontmatter: `type: decision`, `status: proposed|accepted|superseded|rejected`, `issue: "#N"`, `revisit_when: "<one-line trigger>"`.
3. Body sections: **Context**, **Decision**, **Consequences**, **Alternatives considered**.
4. If you reverse an old decision, set its `status: superseded` and `superseded_by:`. Never delete it.
5. If the work is deferred, make sure #114 has a matching item with the same trigger.

## Lint

Run `node wiki/scripts/lint.mjs`. It checks frontmatter, tags, links, index coverage, orphans and raw hashes, and lists the SHAs cited. Then check by judgment:
- **Stale citations:** look at `git log --oneline <sha>..origin/main -- <path>`. If the cited file changed, re-verify the claim and update the SHA.
- **Fired triggers:** compare each decision's `revisit_when` with the current state of `main`, and each #114 item likewise.
- **Weak pages:** those with `contested: true` or `confidence: low`.
- **Contradictions:** claims in the wiki that disagree with `docs/` or the code.

Log the results. Fix mechanical problems directly and report the rest to the maintainer.

The **weekly triage** in the `lich-kanban` skill includes this lint pass. Report fired revisit triggers there as candidates to move out of Deferred.

## When to update (on events, not continuously)

- **A PR merges:** update the entity and concept pages that describe the changed code, and re-pin their SHAs.
- **A review or audit completes:** ingest its report into `raw/`, then update the pages it affects.
- **Research on an outside system finishes** (Hermes, an engine, a paper): ingest it, then add entity or comparison pages.
- **A decision is made or reversed:** add or update a page in `decisions/`.

## Rules

- **Never edit `raw/`.** If a source changes, ingest it again as a new dated file.
- **Code beats wiki.** When they disagree, fix the wiki and log the correction.
- **Never copy kanban status** or issue checklists into the wiki. Link `#N` instead.
- **Log format** is one line per action: `- YYYY-MM-DD <op> | <summary> | <pages>`, where `<op>` is one of ingest, create, update, decision, query, lint, archive.
- **Ask before archiving** a page (moving it to `_archive/`) or deleting anything. Never delete raw sources.
- Keep pages under about 150 lines. Split them rather than letting them grow.
