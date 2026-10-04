import os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn_lich_serve, wait_for_boot } from "./serve-process.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
}

function make_fake_child(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  return child;
}

function make_fake_boot_line(): string {
  return '{"port":41234,"token":"boot-token"}\n';
}

/** wait_for_boot expects a real ChildProcess; the fake only needs the events it subscribes to. */
function wait_for_boot_fake(
  child: FakeChild,
  timeout_ms: number,
): ReturnType<typeof wait_for_boot> {
  return wait_for_boot(child as unknown as ChildProcess, timeout_ms);
}

describe("wait_for_boot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves with boot info parsed from stdout", async () => {
    const child = make_fake_child();
    const pending = wait_for_boot_fake(child, 5_000);
    child.stdout.emit("data", make_fake_boot_line());
    await expect(pending).resolves.toEqual({ port: 41234, token: "boot-token" });
  });

  it("rejects with stable text on boot timeout and logs stderr details", async () => {
    vi.useFakeTimers();
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = make_fake_child();
    const pending = wait_for_boot_fake(child, 50);
    child.stderr.emit("data", "boom: secret detail");
    const assertion = expect(pending).rejects.toThrow("serve failed to start");
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(error_spy).toHaveBeenCalledTimes(1);
    expect(String(error_spy.mock.calls[0]?.[0])).toContain("serve boot timeout");
    expect(String(error_spy.mock.calls[0]?.[0])).toContain("secret detail");
  });

  it("rejects with stable text on early exit and logs stderr details", async () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = make_fake_child();
    const pending = wait_for_boot_fake(child, 5_000);
    child.stderr.emit("data", "crash: secret detail");
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow("serve failed to start");
    expect(error_spy).toHaveBeenCalledTimes(1);
    expect(String(error_spy.mock.calls[0]?.[0])).toContain("serve exited early with code 1");
  });

  it("does not reject with stderr content or absolute paths", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = make_fake_child();
    const pending = wait_for_boot_fake(child, 25);
    child.stderr.emit("data", "private /absolute/path detail");
    const assertion = expect(pending).rejects.toThrow("serve failed to start");
    await vi.advanceTimersByTimeAsync(40);
    try {
      await pending;
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("/absolute/path");
      expect(message).not.toContain("stderr=");
    }
    await assertion;
  });
});

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