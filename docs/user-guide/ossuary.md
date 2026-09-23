# Ossuary guide

> What you'll learn: how to open the Electron desktop shell from a Lich clone, chat through `lich serve`, and use the docked panes shipped with this tip.

Ossuary is the desktop UI for Lich. It lives under `apps/ossuary` in the git tree (not in the published npm package). Closing the window stops the child `lich serve` process it started.

## Clone → chat

Requires Node >= 20, [Bun](https://bun.sh), and a resolvable provider (same as every other mode).

```sh
git clone https://github.com/Moikapy/lich.git && cd lich
bun install
bun install --cwd apps/ossuary

# write a local config once (or use the bare-lich wizard in a TTY)
bun src/cli.ts init --provider-kind ollama --model llama3.2

# open ossuary (builds the Electron app on first run, then opens a window)
bun src/cli.ts ossuary
# equivalents from the repo root:
#   lich ossuary          # after `bun run build` + linked/global bin
#   bun run ossuary
```

`--work-dir <path>` sets `LICH_WORK_DIR` for the Electron process (default: your current working directory). Ossuary uses that directory for `.lich/config.json`, session transcripts, and the saved Dockview layout (`.lich/ossuary-layout.json`).

When the window opens:

1. Electron starts a loopback `lich serve` and connects over WebSocket.
2. The Chat pane creates a serve session and shows connection status.
3. Type a message and press Enter — the same Think-Act-Observe loop as the TUI runs behind serve.
4. Rearrange panes; quit and relaunch to keep the layout.

For a Vite hot-reload loop while hacking the renderer: `bun run ossuary:dev` (repo root) or `bun run --cwd apps/ossuary dev`.

## Panes on this tip

| Pane | Placement | Role |
| --- | --- | --- |
| Chat | main | Multi-turn prompt + transcript via `prompt.submit` / serve events |
| Sessions | left | `session.list` / resume / new session |
| Status | right | Connection + run phase summary |
| Tool log | bottom | Live tool-call / result rows from serve events |

Dockview supports split/reorder in-window, layout persistence across restarts, and a popout path that loads the renderer over `http://127.0.0.1` (see `apps/ossuary/docs/popout-spike.md`). Right-click a tab for **Open in New Window** or in-window **Float**.

## Serve without the desktop

Headless clients can talk to the same protocol:

```sh
bun src/cli.ts serve --port 0
# stdout: {"port":…,"token":…}
```

Details: [CLI reference — Serve](cli.md) and [serve architecture](../architecture/serve.md).

## Known limitations

- Ossuary is clone-only today; `npm install -g @moikapy/lich` does not ship `apps/ossuary`.
- First `lich ossuary` / `bun run ossuary` builds the renderer and Electron main process (needs network once for the Electron binary via `ensure_electron`).
- No token streaming yet — replies appear when the model finishes a turn (same as the TUI).
- Popout windows share the http renderer origin; see the spike report for Dockview re-dock notes.

## Tips

- Prefer `--work-dir` (or `cd` into the project) so sessions and layout stay with that project's `.lich/`.
- If Chat shows a serve error, check that `.lich/config.json` (or env) resolves a model the same way `lich serve` would.
- Use the Sessions pane to resume a prior transcript; Chat resets its on-screen history with a resume notice, matching `/resume` in the TUI.
