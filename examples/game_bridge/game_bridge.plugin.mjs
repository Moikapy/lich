/**
 * Combat-commander bridge. Tools write `.lich/game/` files; Godot drains them.
 * Plain `.mjs` so Node (>=20) loads it from config.plugins with no type-strip.
 */
import { dungeon_memory_read_tool, dungeon_memory_write_tool } from "./dungeon_memory.mjs";
import { enemy_actions_tool } from "./enemy_actions.mjs";
import { meteor_veto } from "./meteor_veto.mjs";

const game_bridge = {
  name: "game_bridge",
  tools: [enemy_actions_tool, dungeon_memory_read_tool, dungeon_memory_write_tool],
  hooks: {
    before_tool_call: meteor_veto,
  },
};

export default game_bridge;
