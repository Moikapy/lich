# Redot guide

> What you'll learn: how to add an editor MCP server, and why that is the opposite of in-game play.

Editor MCP and in-game play point opposite ways. This page is lich connecting **to** an editor. NPC control, vetoes, and the game master are the game connecting **to** lich: the webhook and [`examples/game_bridge`](https://github.com/Moikapy/lich/blob/main/examples/game_bridge/README.md). That contract is the [Godot guide](godot.md). A game master is another persona, not an editor tool.

The client is general, the same shape as Hermes and Claude: a named list you extend when you need a server. Redot is a catalog entry on that client, not a hard-wired spawner. lich does not ship the engine and does not download an addon.

## Client

`mcp_servers` is a closed record. Omit it and no MCP tools register. Each name is snake_case. Each value is either stdio or loopback HTTP. `enabled` defaults to `false`. Unknown keys are rejected.

```json
{
  "mcp_servers": {
    "notes": {
      "enabled": true,
      "command": "/usr/local/bin/notes-mcp",
      "args": ["--stdio"]
    }
  }
}
```

stdio is a local binary you named, plus `args`, plus optional `env`. The process is spawned with those argv, never a shell. `npx`, `uvx`, `curl`, a URL, and shell metacharacters are refused. lich does not run `npx -y` or fetch an addon. Values in `env` are passed to the process and are never logged.

HTTP is `{ "url": "http://127.0.0.1:9/mcp" }`. The host must be `127.0.0.1` or `localhost`. `0.0.0.0` and any other host are refused. There is no remote MCP in v1.

On connect the client sends `initialize`, then `tools/list`, then `tools/call`. Registered names are `mcp_<server>_<tool>`, so two servers cannot collide. They appear only when that server is `enabled` and `tools_enabled` is `"all"` or lists the prefixed name. `tools_enabled: []` drops them even when the server is enabled, and does not connect. The commander persona keeps `tools_enabled: []` and the `game_bridge` plugin only — `persona_config` does not copy `mcp_servers`.

## Add a server

Paste an entry, call `catalog_client_entry`, or use the CLI. None of these start a process. New entries stay disabled until you enable them.

```sh
lich mcp add redot --project-path /home/me/game
lich mcp enable redot
lich mcp list
lich mcp disable redot
lich mcp remove redot
```

`lich mcp add notes --command /usr/local/bin/notes-mcp --arg --stdio` is a custom stdio server. `--url` must be loopback. The command writes through the existing config writer and leaves providers, plugins, and gateway untouched. `lich mcp list` reads this work dir's `.lich/config.json`. A missing `mcp_servers` prints nothing and exits 0.

```ts
import { catalog_client_entry } from "@moikapy/lich";

catalog_client_entry("redot", { project_path: "/home/me/game" });
```

That returns a disabled stdio entry. Unknown names and the Godot catalog return an explanation instead of a spawn plan. Catalog files live in `optional-mcps/<name>/manifest.json`. A new server is a new manifest plus a config entry. It is not a new client.

## Redot

Official Redot 26.1+ only. The catalog command is the local `redot` binary. The args are exactly:

```text
redot --headless --mcp-server --path <project>
```

Basename must be `redot`. A missing binary tells you to install official Redot 26.1+ from [redotengine.org](https://redotengine.org). lich does not download a build.

```json
{
  "mcp_servers": {
    "redot": {
      "enabled": true,
      "command": "/usr/local/bin/redot",
      "args": ["--headless", "--mcp-server", "--path", "/home/me/game"]
    }
  }
}
```

`tools/list` discovers the five upstream controllers. There is no `execute` tool. Existing `.gd` files stay normal file edits (`edit_file` / `write_file`). Scene edits go through the scene tool. Do not rewrite `.tscn` as text.

| Registered name | Use it for |
| --- | --- |
| `mcp_redot_scene_action` | `.tscn` edits: nodes, properties, instances, signals |
| `mcp_redot_resource_action` | `.tres` files and asset import metadata |
| `mcp_redot_code_intel` | GDScript validation and engine docs |
| `mcp_redot_project_config` | Input map, autoloads, settings, run and stop |
| `mcp_redot_game_control` | Screenshots, clicks, and the live scene tree |

## Play is the other direction

These tools build and inspect the project. They do not queue combat orders. NPC and game-master play still use one `POST /message` per round, then drain `work_dir/.lich/game/orders.jsonl` and refresh `state.json`. Do not call lich per frame.

Godot has no official MCP server. lich does not spawn a community godot-mcp and does not download an Asset Library addon. If you later point a **different** server name at a local binary you already have, that is a normal stdio entry. The catalog name `godot` writes no spawn plan. Play for both editors stays the [Godot guide](godot.md).
