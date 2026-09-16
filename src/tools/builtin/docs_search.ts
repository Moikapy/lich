import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, clamp_output, optional_number_arg, require_string_arg } from "../guard.js";
import { DOCS_UNAVAILABLE, list_doc_files, require_docs_root, walk_doc_files } from "./docs_read.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;
const SNIPPET_CHARS = 160;
const MAX_TERM_HITS = 5;
const PHRASE_BONUS = 10;
const TITLE_SCORE = 3;
const FILENAME_SCORE = 2;
const BODY_SCORE = 1;
const MAX_DOC_OUTPUT_CHARS = 20000;
export const STOP_WORDS = new Set(["the", "a", "an", "is", "how", "to", "in", "for", "of", "and", "or"]);

let cached_sections: string | undefined;
let cached_sections_list: DocSection[] = [];

interface DocSection {
  rel_path: string;
  heading: string;
  body: string;
}

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    query: { type: "string", description: "Words to look for across all lich docs" },
    max_results: { type: "number", description: "Maximum number of results (default 5, cap 20)" },
  },
  required: ["query"],
  additionalProperties: false,
};

/** Clear the memoized section index (used by tests). */
export function reset_docs_search_cache(): void {
  cached_sections = undefined;
  cached_sections_list = [];
}

function split_sections(rel_path: string, content: string): DocSection[] {
  const sections: DocSection[] = [];
  const heading = `# ${rel_path}`;
  const chunks = content.split(/^## /m);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk.length === 0) {
      continue;
    }
    if (index === 0) {
      sections.push({ rel_path, heading, body: chunk });
      continue;
    }
    const newline = chunk.indexOf("\n");
    const title = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? "" : chunk.slice(newline + 1);
    sections.push({ rel_path, heading: `## ${title}`, body });
  }
  return sections;
}

/** Split each doc into "## "-delimited sections; the file head is a pseudo-section. */
function build_section_index(root: string, files: string[]): DocSection[] {
  const sections: DocSection[] = [];
  for (const rel_path of files) {
    try {
      sections.push(...split_sections(rel_path, readFileSync(path.join(root, rel_path), "utf8")));
    } catch {
      // unreadable docs are skipped silently
    }
  }
  return sections;
}

function load_sections(root: string, files: string[]): DocSection[] {
  if (cached_sections === root) {
    return cached_sections_list;
  }
  const sections = build_section_index(root, files);
  cached_sections = root;
  cached_sections_list = sections;
  return sections;
}

function query_terms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (raw.length > 0 && STOP_WORDS.has(raw) === false) {
      terms.push(raw);
    }
  }
  return terms;
}

function count_term(haystack: string, term: string): number {
  let count = 0;
  let position = haystack.indexOf(term);
  while (position !== -1 && count < MAX_TERM_HITS) {
    count += 1;
    position = haystack.indexOf(term, position + term.length);
  }
  return count;
}

/** Pure scoring: title +3, file-stem +2, body +1/occurrence (cap 5), exact phrase +10. */
export function score_sections(query: string, sections: DocSection[]): Array<DocSection & { score: number }> {
  const lower_query = query.toLowerCase();
  const terms = query_terms(query);
  const scored: Array<DocSection & { score: number }> = [];
  for (const section of sections) {
    let score = 0;
    const lower_heading = section.heading.toLowerCase();
    const lower_body = section.body.toLowerCase();
    for (const term of terms) {
      if (lower_heading.includes(term) === true) {
        score += TITLE_SCORE;
      }
      if (section.rel_path.toLowerCase().includes(term) === true) {
        score += FILENAME_SCORE;
      }
      score += BODY_SCORE * count_term(lower_body, term);
    }
    if (terms.length > 0 && lower_body.includes(lower_query) === true) {
      score += PHRASE_BONUS;
    }
    if (score > 0) {
      scored.push({ ...section, score });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  return scored;
}

function first_term_match(section: DocSection, terms: string[]): string {
  for (const term of terms) {
    const position = section.body.toLowerCase().indexOf(term);
    if (position !== -1) {
      const start = Math.max(0, position - 40);
      return section.body.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim();
    }
  }
  return section.body.replace(/\s+/g, " ").slice(0, SNIPPET_CHARS).trim();
}

function flatten_results(query: string, sections: DocSection[], max_results: number): string {
  const scored = score_sections(query, sections);
  if (scored.length === 0) {
    return `no results for: ${query}`;
  }
  const terms = query_terms(query);
  const lines: string[] = [];
  for (let index = 0; index < Math.min(scored.length, max_results); index += 1) {
    const hit = scored[index];
    if (hit === undefined) {
      continue;
    }
    lines.push(`${index + 1}. ${hit.rel_path} — ${hit.heading} (score ${hit.score})`);
    lines.push(`   ${first_term_match(hit, terms)}`);
  }
  return lines.join("\n");
}

/** Skills dir under work_dir; existence-only check, no index.md gate. */
function skills_root(context: ToolContext): string | undefined {
  const candidate = path.join(context.work_dir, ".lich", "skills");
  return existsSync(candidate) === true ? path.resolve(candidate) : undefined;
}

export const docs_search_tool: Tool = {
  name: "docs_search",
  description: "Search across all bundled lich docs and .lich/skills; returns scored section matches with short excerpts.",
  parameters,
  execute: async (args, context) =>
    capture_errors(async () => {
      const root = require_docs_root(context);
      const query = require_string_arg(args, "query");
      const max_results = Math.min(
        MAX_RESULTS_CAP,
        Math.max(1, Math.trunc(optional_number_arg(args, "max_results", DEFAULT_MAX_RESULTS))),
      );
      // Package docs stay memoized; skills are a fresh copy so user-writable
      // sections never land in that cache (fresh walk, every call).
      const sections = [...load_sections(root, list_doc_files(root))];
      const skills = skills_root(context);
      if (skills !== undefined) {
        sections.push(...build_section_index(skills, walk_doc_files(skills)));
      }
      const output = flatten_results(query, sections, max_results);
      return { ok: true, output: clamp_output(output, MAX_DOC_OUTPUT_CHARS) };
    }),
};
