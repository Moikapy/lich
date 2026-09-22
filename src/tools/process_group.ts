/**
 * Kill a detached child and its process group (negative pgid) so timeouts
 * do not leave orphan grandchildren holding pipes open.
 */
import type { ChildProcess } from "node:child_process";

const live_children = new Set<ChildProcess>();
let exit_handlers_installed = false;

function kill_all_live_children(): void {
  for (const child of live_children) {
    kill_process_group(child, "SIGKILL");
  }
  live_children.clear();
}

function install_exit_handlers(): void {
  if (exit_handlers_installed === true) {
    return;
  }
  exit_handlers_installed = true;
  // Sync-only: Node fires `exit` after SIGINT/SIGTERM default termination too.
  process.on("exit", kill_all_live_children);
}

/** Track a detached spawn so parent exit/signals can SIGKILL its process group. */
export function track_detached_child(child: ChildProcess): void {
  install_exit_handlers();
  live_children.add(child);
  const drop = (): void => {
    live_children.delete(child);
  };
  child.on("exit", drop);
  child.on("error", drop);
}

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
