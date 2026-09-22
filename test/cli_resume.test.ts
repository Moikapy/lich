/**
 * CLI --resume: parse_args happy/missing-value, non-TUI rejection.
 */
import { describe, expect, it } from "vitest";
import { parse_args, run_cli } from "../src/cli.js";

describe("parse_args --resume", () => {
  it("accepts --resume with a value", () => {
    expect(parse_args(["--resume", "latest"]).resume).toBe("latest");
    expect(parse_args(["tui", "--resume", "abc-1"]).resume).toBe("abc-1");
  });

  it("requires a value for --resume", () => {
    expect(() => parse_args(["--resume"])).toThrow("--resume requires a value");
  });

  it("includes --resume in usage via --help path", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await run_cli(["--help"])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toMatch(/--resume <id\|latest>/);
  });
});

describe("run_cli --resume mode guard", () => {
  it("rejects --resume in one-shot, chat, and gateway", async () => {
    await expect(run_cli(["--resume", "latest", "say hi"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not one-shot)",
    );
    await expect(run_cli(["chat", "--resume", "latest"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not chat)",
    );
    await expect(run_cli(["gateway", "--resume", "x"])).rejects.toThrow(
      "--resume is only supported in TUI mode (not gateway)",
    );
  });
});
