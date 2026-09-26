/**
 * Process-group kill used by terminal timeouts. No real children:
 * process.kill is stubbed so the fallback path stays deterministic.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kill_process_group } from "../src/tools/process_group.js";

function fake_child(pid: number | undefined): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
  });
  return child as unknown as ChildProcess;
}

describe("kill_process_group", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signals the negative process group and leaves the child handle alone", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fake_child(4242);
    kill_process_group(child, "SIGKILL");
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to child.kill when the group signal throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const child = fake_child(7);
    kill_process_group(child);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("swallows a second failure when the child is already gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const child = fake_child(8);
    vi.mocked(child.kill).mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => kill_process_group(child)).not.toThrow();
  });

  it("does nothing when the child has no pid", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fake_child(undefined);
    kill_process_group(child);
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
