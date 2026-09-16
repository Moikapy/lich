/**
 * Gatekeeper plugin: the self-improvement loop's safety floor (v0.4.0 spec).
 * Fail-closed by construction — if this plugin never registers, no git_commit
 * tool exists anywhere. Vetoes git_commit unless tests passed on the current
 * tree (tests_ok), nothing was edited since (dirty false), and the run has
 * committed nothing yet (max 1). Also vetoes terminal commands matching the
 * hardcoded git denylist. Per-run state lives in the plugin state channel.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { resolve_safe_path } from "../../tools/guard.js";
import type { Tool } from "../../tools/types.js";
import type {
  AfterToolCallInfo,
  BeforeToolCallInfo,
  BeforeToolCallResult,
  HookContext,
  Plugin,
  PluginHooks,
} from "../types.js";

/** Flag-tolerant git verbs: commit/push with or without dashes + always-bad plumbing. */
const GIT_DENYLIST: readonly string[] = ["commit", "-commit", "--commit", "push", "-push", "--push", "commit-tree", "update-ref"];

/** Basenames never committable by the agent (secret-ish, hardcoded). */
const SECRET_BASENAMES: readonly string[] = [".env", ".env.local", "id_rsa"];

function is_secret_path(file_path: string): boolean {
  const base = path.basename(file_path);
  if (SECRET_BASENAMES.includes(base) === true) {
    return true;
  }
  return base.endsWith(".pem") === true || base.endsWith(".p12") === true || base.startsWith("id_rsa") === true;
}

/** Read a boolean flag from the plugin's per-run state sub-map. */
function state_bool(ctx: HookContext, key: string, fallback: boolean): boolean {
  const value = ctx.state?.get(key);
  return typeof value === "boolean" ? value : fallback;
}

/** Read a count from the plugin's per-run state sub-map. */
function state_count(ctx: HookContext, key: string): number {
  const value = ctx.state?.get(key);
  return typeof value === "number" ? value : 0;
}

/** Split a shell-ish command into words for denylist matching. */
function command_words(command: string): string[] {
  return command.split(/\s+/).filter((word) => word.length > 0);
}

/** True when the terminal command matches a denylisted git subcommand. */
function matches_git_denylist(command: string): string | undefined {
  const words = command_words(command);
  for (const pattern of GIT_DENYLIST) {
    const is_flag = pattern.startsWith("-") === true;
    const target = pattern.replace(/^-+/, "");
    for (const word of words) {
      const stripped = word.replace(/^-+/, "");
      if (is_flag === true && word.startsWith("-") === true && stripped === target) {
        return pattern;
      }
      if (is_flag === false && word === pattern) {
        return pattern;
      }
    }
  }
  return undefined;
}

/** One git subprocess call in work_dir; returns {exit_code, output} pairs. */
function run_git(args: readonly string[], work_dir: string): Promise<{ exit_code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: work_dir, env: process.env });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ exit_code: code ?? -1, output: out }));
    child.on("error", () => resolve({ exit_code: -1, output: "" }));
  });
}

/** Validate commit paths against A2 + secret basenames; returns error or undefined. */
function validate_paths(paths: readonly string[], work_dir: string): string | undefined {
  if (paths.length < 1 || paths.length > 50) {
    return "paths_must_have_1_to_50_entries";
  }
  for (const raw of paths) {
    if (raw === "" || raw === "." || raw === "./") {
      return `invalid_path: ${raw === "" ? "(empty)" : raw}`;
    }
    const resolved = resolve_safe_path(work_dir, raw);
    if (resolved === path.resolve(work_dir)) {
      return `invalid_path: ${raw} resolves to work_dir`;
    }
    if (is_secret_path(raw) === true) {
      return `secret_path: ${raw}`;
    }
  }
  return undefined;
}

/** The gatekeeper's own tool: scoped add + commit --only recipe (A1). */
function git_commit_tool(): Tool {
  return {
    name: "git_commit",
    description: "Commit the named paths with a message. Gated by the gatekeeper: tests must pass first.",
    timeout_ms: 60000,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "1-50 paths relative to work_dir to commit",
        },
      },
      required: ["message", "paths"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const message = args["message"];
      const paths = args["paths"];
      if (typeof message !== "string" || message.length === 0 || Array.isArray(paths) !== true) {
        return { ok: false, output: "", error: "invalid_args" };
      }
      const path_strings = paths.map((p) => (typeof p === "string" ? p : ""));
      const invalid = validate_paths(path_strings, context.work_dir);
      if (invalid !== undefined) {
        return { ok: false, output: "", error: invalid };
      }
      const head = await run_git(["rev-parse", "--verify", "HEAD"], context.work_dir);
      if (head.exit_code !== 0) {
        return { ok: false, output: "", error: "no_head_commit: refusing to commit on an unborn branch" };
      }
      const add = await run_git(["add", "--", ...path_strings], context.work_dir);
      if (add.exit_code !== 0) {
        return { ok: false, output: "", error: `git_add_failed: ${add.output.trim()}` };
      }
      const commit = await run_git(
        [
          "-c",
          "user.name=lich",
          "-c",
          "user.email=lich@localhost",
          "commit",
          "--only",
          "-m",
          message,
          "--",
          ...path_strings,
        ],
        context.work_dir,
      );
      if (commit.exit_code !== 0) {
        return { ok: false, output: "", error: `git_commit_failed: ${commit.output.trim()}` };
      }
      const sha = await run_git(["rev-parse", "--short", "HEAD"], context.work_dir);
      return { ok: true, output: `${sha.output.trim()} ${path_strings.join(" ")}` };
    },
  };
}

/** Fresh per-run defaults into the plugin's state sub-map (run start). */
function seed_state(ctx: HookContext): void {
  ctx.state?.set("tests_ok", false);
  ctx.state?.set("dirty", true);
  ctx.state?.set("commits", 0);
}

/** The hooks: state transitions in after_tool_call, vetoes in before_tool_call. */
function gatekeeper_hooks(allow_self_commit: boolean): PluginHooks {
  return {
    on_run_start: (_info, ctx) => {
      seed_state(ctx);
    },
    before_tool_call: (info: BeforeToolCallInfo, ctx): BeforeToolCallResult | void => {
      if (info.tool_name === "git_commit") {
        const tests_ok = state_bool(ctx, "tests_ok", false);
        const dirty = state_bool(ctx, "dirty", true);
        const commits = state_count(ctx, "commits");
        if (allow_self_commit !== true) {
          return { block: true, reason: "self_commit_disabled" };
        }
        if (tests_ok !== true) {
          return { block: true, reason: "tests_not_ok" };
        }
        if (dirty === true) {
          return { block: true, reason: "worktree_dirty" };
        }
        if (commits >= 1) {
          return { block: true, reason: "commit_budget_exhausted" };
        }
        return {};
      }
      if (info.tool_name === "terminal") {
        const command = typeof info.args["command"] === "string" ? (info.args["command"] as string) : "";
        const matched = matches_git_denylist(command);
        if (matched !== undefined) {
          return { block: true, reason: `git_denylist: ${matched}` };
        }
      }
      return {};
    },
    after_tool_call: (info: AfterToolCallInfo, ctx) => {
      if (info.ok !== true) {
        return;
      }
      if (info.tool_name === "write_file" || info.tool_name === "edit_file") {
        ctx.state?.set("dirty", true);
      } else if (info.tool_name === "run_tests") {
        ctx.state?.set("tests_ok", true);
        ctx.state?.set("dirty", false);
      } else if (info.tool_name === "git_commit") {
        ctx.state?.set("commits", state_count(ctx, "commits") + 1);
      }
    },
  };
}

/** Construct the gatekeeper plugin; any throw here means NO git_commit anywhere. */
export function gatekeeper_plugin(allow_self_commit: boolean): Plugin {
  return {
    name: "gatekeeper",
    tools: [git_commit_tool()],
    hooks: gatekeeper_hooks(allow_self_commit),
  };
}