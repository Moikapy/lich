/**
 * Spawn `lich serve`, wait for boot JSON, expose stop().
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  build_serve_command,
  build_ws_url,
  extract_boot_from_stdout,
  type BackendCommandOptions,
  type ServeBootInfo,
} from "./backend-command.js";

export interface RunningServe {
  boot: ServeBootInfo;
  ws_url: string;
  child: ChildProcess;
  stop(): void;
}

export async function spawn_lich_serve(
  options: BackendCommandOptions,
  timeout_ms = 20_000,
): Promise<RunningServe> {
  const cmd = build_serve_command(options);
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const boot = await wait_for_boot(child, timeout_ms);
    return {
      boot,
      ws_url: build_ws_url(boot),
      child,
      stop: () => {
        if (child.killed !== true) {
          child.kill("SIGTERM");
        }
      },
    };
  } catch (error) {
    if (child.killed !== true) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

function wait_for_boot(child: ChildProcess, timeout_ms: number): Promise<ServeBootInfo> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`serve boot timeout; stderr=${stderr}`));
    }, timeout_ms);

    const on_err = (chunk: Buffer | string): void => {
      stderr += String(chunk);
    };
    const on_out = (chunk: Buffer | string): void => {
      const extracted = extract_boot_from_stdout(String(chunk), buffer);
      buffer = extracted.buffer;
      if (extracted.boot !== undefined) {
        cleanup();
        resolve(extracted.boot);
      }
    };
    const on_exit = (code: number | null): void => {
      cleanup();
      reject(new Error(`serve exited early with code ${code}; stderr=${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", on_out);
      child.stderr?.off("data", on_err);
      child.off("exit", on_exit);
    };

    child.stdout?.on("data", on_out);
    child.stderr?.on("data", on_err);
    child.once("exit", on_exit);
  });
}
