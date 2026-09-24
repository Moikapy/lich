#!/usr/bin/env node
// Structural linter for the Lich wiki. Usage: node wiki/scripts/lint.mjs
// Checks frontmatter, tags, [[links]], index coverage, orphans, raw/ hashes,
// and lists cited code SHAs so humans can judge staleness. Exit 1 on errors.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WIKI = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL = new Set(["README.md", "SCHEMA.md", "index.md", "log.md"]);
const SKIP_DIRS = new Set(["raw", "_archive", "scripts"]);
const TYPES = new Set(["entity", "concept", "comparison", "decision", "query"]);
const REQUIRED = ["title", "created", "updated", "type", "tags"];
const DECISION_REQUIRED = ["status", "issue", "revisit_when"];

const errors = [];
const warns = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warns.push(`${file}: ${msg}`);

function walk(dir, skip = new Set()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skip.has(name) ? [] : walk(p, skip);
    return name.endsWith(".md") ? [p] : [];
  });
}

// Minimal YAML frontmatter: `key: value` lines; `[a, b]` becomes an array.
function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, "").trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    fm[kv[1]] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

const links = (text) => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => basename(m[1].trim(), ".md"));
const rel = (p) => relative(WIKI, p);

// Tag taxonomy from SCHEMA.md "## Tag taxonomy": "**Label:** a, b, c" lines.
const taxonomy = new Set();
const schemaPath = join(WIKI, "SCHEMA.md");
if (!existsSync(schemaPath)) err("SCHEMA.md", "missing");
else {
  const section = readFileSync(schemaPath, "utf8").split(/^## Tag taxonomy/m)[1]?.split(/^## /m)[0] ?? "";
  for (const m of section.matchAll(/\*\*[^*]+:\*\*\s*(.+)/g)) {
    m[1].split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => taxonomy.add(t));
  }
  if (taxonomy.size === 0) err("SCHEMA.md", "could not parse any tags from '## Tag taxonomy'");
}

// Wiki pages (layer 2).
const pages = walk(WIKI, SKIP_DIRS).filter((p) => !(dirname(p) === WIKI && TOP_LEVEL.has(basename(p))));
const slugs = new Map();
for (const p of pages) {
  const slug = basename(p, ".md");
  if (slugs.has(slug)) err(rel(p), `duplicate slug (also ${rel(slugs.get(slug))})`);
  slugs.set(slug, p);
}
const resolvable = new Set([...slugs.keys(), ...[...TOP_LEVEL].map((f) => basename(f, ".md"))]);

const inbound = new Map([...slugs.keys()].map((s) => [s, 0]));
const shas = new Map();
for (const p of pages) {
  const file = rel(p);
  const text = readFileSync(p, "utf8");
  const { fm, body } = parse(text);
  if (!fm) err(file, "missing frontmatter");
  else {
    for (const k of REQUIRED) if (fm[k] === undefined || fm[k] === "") err(file, `frontmatter missing '${k}'`);
    if (fm.type && !TYPES.has(fm.type)) err(file, `invalid type '${fm.type}'`);
    if (fm.type === "decision") for (const k of DECISION_REQUIRED) if (!fm[k]) err(file, `decision missing '${k}'`);
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    for (const t of tags) if (taxonomy.size && !taxonomy.has(t)) err(file, `tag '${t}' not in SCHEMA taxonomy`);
  }
  const out = new Set(links(body));
  if (out.size < 2) err(file, `only ${out.size} outbound [[link]](s); need ≥2`);
  for (const s of out) {
    if (!resolvable.has(s)) err(file, `broken link [[${s}]]`);
    else if (inbound.has(s) && s !== basename(p, ".md")) inbound.set(s, inbound.get(s) + 1);
  }
  for (const m of body.matchAll(/[\w./-]+\.\w+(?::[\d,-]+)?@([0-9a-f]{7,40})\b/g)) {
    shas.set(m[1], (shas.get(m[1]) ?? 0) + 1);
  }
}

// index.md coverage.
const indexPath = join(WIKI, "index.md");
if (!existsSync(indexPath)) err("index.md", "missing (every page must be listed there)");
else {
  const listed = new Set(links(readFileSync(indexPath, "utf8")));
  for (const s of listed) if (!resolvable.has(s)) err("index.md", `broken link [[${s}]]`);
  for (const [s, p] of slugs) if (!listed.has(s)) err(rel(p), "not listed in index.md");
}
if (!existsSync(join(WIKI, "log.md"))) err("log.md", "missing");

for (const [s, n] of inbound) if (n === 0) warn(rel(slugs.get(s)), "orphan (no inbound links besides index)");

// raw/ provenance + hash (body = text after frontmatter, trailing newlines stripped,
// matching `printf '%s' "$(cat file)" | sha256sum` used when stamping).
for (const p of walk(join(WIKI, "raw"))) {
  const file = rel(p);
  const { fm, body } = parse(readFileSync(p, "utf8"));
  if (!fm) { err(file, "raw file missing frontmatter"); continue; }
  for (const k of ["source_url", "ingested", "sha256"]) if (!fm[k]) err(file, `raw frontmatter missing '${k}'`);
  if (fm.sha256) {
    const actual = createHash("sha256").update(body.replace(/\n+$/, "")).digest("hex");
    if (actual !== fm.sha256) err(file, `sha256 mismatch (raw/ is immutable; re-ingest as a new file)`);
  }
}

if (shas.size) {
  warn("citations", `code SHAs cited (check staleness vs git log): ${[...shas].map(([s, n]) => `${s}×${n}`).join(", ")}`);
}

for (const e of errors) console.log(`ERROR ${e}`);
for (const w of warns) console.log(`WARN  ${w}`);
console.log(`\n${pages.length} pages, ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
