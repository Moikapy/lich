import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  build_serve_command,
  build_ws_url,
  extract_boot_from_stdout,
  parse_serve_boot_line,
  resolve_repo_root_from_electron_dir,
} from "./backend-command.js";

describe("backend-command", () => {
  it("builds bun src/cli.ts serve argv for dev", () => {
    const repo_root = path.resolve(import.meta.dirname, "../../..");
    const cmd = build_serve_command({
      repo_root,
      work_dir: "/tmp/lich-work",
      host: "127.0.0.1",
      port: 0,
    });
    expect(cmd.command).toBe("bun");
    expect(cmd.args).toEqual([
      path.join(repo_root, "src", "cli.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--work-dir",
      "/tmp/lich-work",
    ]);
    expect(cmd.cwd).toBe("/tmp/lich-work");
  });

  it("builds packaged lich serve argv when prefer_packaged", () => {
    const cmd = build_serve_command({
      repo_root: "/unused",
      work_dir: "/tmp/w",
      prefer_packaged: true,
    });
    expect(cmd).toEqual({
      command: "lich",
      args: ["serve", "--host", "127.0.0.1", "--port", "0", "--work-dir", "/tmp/w"],
      cwd: "/tmp/w",
    });
  });

  it("parses boot JSON and builds wsUrl", () => {
    const boot = parse_serve_boot_line('{"port":41234,"token":"abc"}');
    expect(boot).toEqual({ port: 41234, token: "abc" });
    expect(build_ws_url(boot)).toBe("ws://127.0.0.1:41234/?token=abc");
  });

  it("extracts boot from chunked stdout", () => {
    const first = extract_boot_from_stdout('noise\n{"port":9,"tok', "");
    expect(first.boot).toBeUndefined();
    const second = extract_boot_from_stdout('en":"x"}\n', first.buffer);
    expect(second.boot).toEqual({ port: 9, token: "x" });
  });

  it("resolves repo root from dist/electron", () => {
    const electron_dir = path.join("/repo", "apps", "ossuary", "dist", "electron");
    expect(resolve_repo_root_from_electron_dir(electron_dir)).toBe(path.resolve("/repo"));
  });
});
