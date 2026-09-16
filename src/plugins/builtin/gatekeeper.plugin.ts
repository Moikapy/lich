/**
 * Gatekeeper plugin: the self-improvement loop's safety floor (v0.4.0 spec).
 * Fail-closed by construction — if this plugin never registers, no git_commit
 * tool exists anywhere. Vetoes git_commit unless tests passed on the current
 * tree (tests_ok), nothing was edited since (dirty false), and the run has
 * committed nothing yet (max 1). Also vetoes terminal commands matching the
 * hardcoded git denylist. Per-run state lives in the plugin state channel.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { clamp_output, resolve_safe_path } from "../../tools/guard.js";
import type { Tool } from "../../tools/types.js";
import type {
  AfterToolCallInfo,
  BeforeToolCallInfo,
  BeforeToolCallResult,
  HookContext,
  Plugin,
  PluginHooks,
} from "../types.js";

/** -c beats repo config; --no-verify does not skip post-commit. */
const HOOKS_OFF: readonly string[] = ["-c", "core.hooksPath=/dev/null"];

/** Pathspec magic that must never reach git (glob, magic signatures). */
const PATHSPEC_MAGIC = /[:*?[]/;

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

/**
 * Denylist hit on the raw command. commit-tree and update-ref are
 * any-occurrence; commit/push stay flag-tolerant whole words. Not a shell parser.
 */
function matches_git_denylist(command: string): string | undefined {
  const plumbing = /commit-tree|update-ref/.exec(command);
  if (plumbing !== null) {
    return plumbing[0];
  }
  const verb = /(?:^|\s)(-{0,2})(commit|push)(?=\s|$)/.exec(command);
  if (verb === null) {
    return undefined;
  }
  return `${verb[1] ?? ""}${verb[2] ?? ""}`;
}

/** One git subprocess; SIGKILL on abort so a timeout cannot leave a live child (terminal.ts wire_kill). */
function run_git(
  args: readonly string[],
  work_dir: string,
  signal?: AbortSignal,
): Promise<{ exit_code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: work_dir, env: process.env });
    let settled = false;
    let out = "";
    const on_abort = (): void => {
      child.kill("SIGKILL");
    };
    const finish = (code: number): void => {
      if (settled === true) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", on_abort);
      resolve({ exit_code: code, output: out });
    };
    if (signal?.aborted === true) {
      on_abort();
    } else {
      signal?.addEventListener("abort", on_abort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    // exit, not close: a grandchild holding inherited pipes must not keep git's caller alive after SIGKILL.
    child.on("exit", (code, signal_name) => {
      if (signal?.aborted === true || signal_name === "SIGKILL") {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code ?? -1);
      }
    });
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", () => finish(-1));
  });
}

/** True when the path exists and is not a regular file (a directory would stage sub/.env). */
function existing_non_file(resolved: string): boolean {
  try {
    return statSync(resolved).isFile() !== true;
  } catch {
    return false;
  }
}

/** Validate one path: pathspec magic, secrets, and non-files never reach git. */
function invalid_commit_path(raw: string, work_dir: string): string | undefined {
  if (raw === "" || raw === "." || raw === "./") {
    return `invalid_path: ${raw === "" ? "(empty)" : raw}`;
  }
  if (PATHSPEC_MAGIC.test(raw) === true) {
    return `invalid_path: ${raw}`;
  }
  const resolved = resolve_safe_path(work_dir, raw);
  if (resolved === path.resolve(work_dir)) {
    return `invalid_path: ${raw} resolves to work_dir`;
  }
  if (is_secret_path(raw) === true) {
    return `secret_path: ${raw}`;
  }
  if (existing_non_file(resolved) === true) {
    return `invalid_path: ${raw} is not a file`;
  }
  return undefined;
}

/** Validate commit paths against A2 + pathspec + secret basenames; returns error or undefined. */
function validate_paths(paths: readonly string[], work_dir: string): string | undefined {
  if (paths.length < 1 || paths.length > 50) {
    return "paths_must_have_1_to_50_entries";
  }
  for (const raw of paths) {
    const bad = invalid_commit_path(raw, work_dir);
    if (bad !== undefined) {
      return bad;
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
      const head = await run_git(["rev-parse", "--verify", "HEAD"], context.work_dir, context.signal);
      if (head.exit_code !== 0) {
        return { ok: false, output: "", error: "no_head_commit: refusing to commit on an unborn branch" };
      }
      const add = await run_git([...HOOKS_OFF, "add", "--", ...path_strings], context.work_dir, context.signal);
      if (add.exit_code !== 0) {
        return { ok: false, output: "", error: clamp_output(`git_add_failed: ${add.output.trim()}`) };
      }
      const commit = await run_git(
        [...HOOKS_OFF, "-c", "user.name=lich", "-c", "user.email=lich@localhost", "commit", "--only", "-m", message, "--", ...path_strings],
        context.work_dir,
        context.signal,
      );
      if (commit.exit_code !== 0) {
        return { ok: false, output: "", error: clamp_output(`git_commit_failed: ${commit.output.trim()}`) };
      }
      const sha = await run_git(["rev-parse", "--short", "HEAD"], context.work_dir, context.signal);
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