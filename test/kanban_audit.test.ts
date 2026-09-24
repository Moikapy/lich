/**
 * Regression tests for `.claude/skills/lich-kanban/scripts/kanban.sh audit`:
 * PR linkage must come from closingIssuesReferences (GitHub's own `Closes #N`
 * / `Fixes #N` keyword parsing), never from a bare `#N` mention in a PR
 * title/body, and a jq failure must fail the audit instead of printing
 * "audit complete". Also covers the item-list page-cap guard.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TMP_BASE } from "./helpers/tmp_base.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KANBAN = path.join(REPO, ".claude/skills/lich-kanban/scripts/kanban.sh");

/** Raw `gh project item-list` board item, as items() consumes it. */
interface BoardItem {
  id: string;
  content: { number: number; type: string; title: string };
  status?: string;
  labels?: string[];
}

interface OpenIssue {
  number: number;
  labels: { name: string }[];
}

/** gh API payload for `gh pr list --state open`. */
interface OpenPr {
  number: number;
  title: string;
  body: string | null;
  closingIssuesReferences: { number: number }[];
}

/** Build a fake `gh` in dir answering the three calls `audit` makes. */
function make_gh_stub(dir: string): void {
  writeFileSync(path.join(dir, "gh"), [
    "#!/usr/bin/env bash\n",
    '# Fake gh: answer each kanban.sh call with canned JSON files.\n',
    'case "$*" in\n',
    '  *"project item-list"*) cat "$(dirname "$0")/board.json" ;;\n',
    '  *"issue list"*)        cat "$(dirname "$0")/issues.json" ;;\n',
    '  *"pr list"*)           cat "$(dirname "$0")/prs.json" ;;\n',
    '  *)                     printf \'{"items":[]}\' ;;\n',
    "esac\n",
  ].join(""));
  chmodSync(path.join(dir, "gh"), 0o755);
}

function write_board(dir: string, items: BoardItem[], totalCount: number): void {
  writeFileSync(path.join(dir, "board.json"), JSON.stringify({ items, totalCount }));
}

function write_issues(dir: string, issues: OpenIssue[]): void {
  writeFileSync(path.join(dir, "issues.json"), JSON.stringify(issues));
}

function write_prs(dir: string, prs: OpenPr[]): void {
  writeFileSync(path.join(dir, "prs.json"), JSON.stringify(prs));
}

/** Run kanban.sh audit with the fake gh (and an optional fake jq) on PATH. */
function run_audit(dir: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("bash", [KANBAN, "audit"], {
    cwd: REPO,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const BOARD: BoardItem[] = [
  { id: "i1", content: { number: 113, type: "Issue", title: "Architecture audit" }, status: "Todo", labels: [] },
  { id: "i3", content: { number: 114, type: "Issue", title: "deferred work" }, status: "Deferred", labels: ["deferred"] },
];

const OPEN_ISSUES: OpenIssue[] = [
  { number: 113, labels: [] },
  { number: 114, labels: [{ name: "deferred" }] },
];

let dir: string;

beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(path.join(TMP_BASE, "kanban-audit-"));
  make_gh_stub(dir);
  write_board(dir, BOARD, BOARD.length);
  write_issues(dir, OPEN_ISSUES);
});

describe("kanban.sh audit", () => {
  it("does not flag a mention-only PR (bare #N in title/body)", () => {
    write_prs(dir, [{ number: 124, title: "docs: project wiki", body: "Part of #113", closingIssuesReferences: [] }]);
    const res = run_audit(dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("audit complete");
    expect(res.stdout).not.toContain("HAS-PR");
  });

  it("flags an issue with an open PR via closingIssuesReferences", () => {
    write_prs(dir, [{ number: 124, title: "docs: project wiki", body: "Closes #113", closingIssuesReferences: [{ number: 113 }] }]);
    const res = run_audit(dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("HAS-PR    #113 has an open PR");
  });

  it("fails when jq errors instead of reporting audit complete", () => {
    write_prs(dir, []);
    writeFileSync(path.join(dir, "jq"), '#!/usr/bin/env bash\necho "boom" >&2\nexit 5\n');
    chmodSync(path.join(dir, "jq"), 0o755);
    const res = run_audit(dir);
    expect(res.code).not.toBe(0);
    expect(res.stdout).not.toContain("audit complete");
  });

  it("fails when the board exceeds the item-list page cap", () => {
    write_prs(dir, []);
    write_board(dir, [], 600);
    const res = run_audit(dir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("board has 600 items");
  });
});