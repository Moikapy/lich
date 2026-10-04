/**
 * CommandBar keys: Esc cancels a running turn (#133) and does nothing while idle.
 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { CommandBar } from "../src/tui/command_bar.js";

/** Minimal TTY streams ink accepts; `press` feeds raw key bytes. */
function fake_tty() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
    pending: [] as string[],
    read(): string | null {
      return stdin.pending.shift() ?? null;
    },
  });
  const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true, write: () => true });
  const press = async (bytes: string): Promise<void> => {
    stdin.pending.push(bytes);
    stdin.emit("readable");
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return { stdin, stdout, press };
}

async function render_bar(busy: boolean) {
  const on_cancel = vi.fn();
  const on_submit = vi.fn();
  const tty = fake_tty();
  const instance = render(createElement(CommandBar, { busy, on_submit, on_cancel }), {
    stdin: tty.stdin as unknown as NodeJS.ReadStream,
    stdout: tty.stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { on_cancel, on_submit, press: tty.press, unmount: () => instance.unmount() };
}

describe("CommandBar", () => {
  it("calls on_cancel on Esc while busy", async () => {
    const bar = await render_bar(true);
    try {
      await bar.press("\u001b");
      expect(bar.on_cancel).toHaveBeenCalledTimes(1);
    } finally {
      bar.unmount();
    }
  });

  it("ignores Esc while idle", async () => {
    const bar = await render_bar(false);
    try {
      await bar.press("\u001b");
      await bar.press("hi");
      await bar.press("\r");
      expect(bar.on_cancel).not.toHaveBeenCalled();
      expect(bar.on_submit).toHaveBeenCalledWith("hi");
    } finally {
      bar.unmount();
    }
  });
});
