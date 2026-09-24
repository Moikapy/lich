import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { spawn_lich_serve } from "./serve-process.js";

describe("spawn_lich_serve", () => {
  const previous_path = process.env.PATH;

  afterEach(() => {
    process.env.PATH = previous_path;
  });

  it("rejects a missing command without leaking ENOENT", async () => {
    process.env.PATH = "";
    let caught: unknown;
    try {
      await spawn_lich_serve(
        {
          repo_root: "/unused",
          work_dir: os.tmpdir(),
          prefer_packaged: true,
        },
        5_000,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("serve failed to start");
    expect(String(caught)).not.toContain("ENOENT");
  });
});
