/**
 * Kill a detached child and its process group (negative pgid) so timeouts
 * do not leave orphan grandchildren holding pipes open.
 */
import type { ChildProcess } from "node:child_process";

/** SIGKILL the process group for a detached spawn; falls back to child.kill. */
export function kill_process_group(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}
