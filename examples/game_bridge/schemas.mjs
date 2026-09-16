export const enemy_actions_schema = {
  type: "object",
  properties: {
    round: {
      type: "number",
      description: "Current combat round number (from the battle snapshot).",
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          enemy_id: { type: "string", description: "Acting enemy's id." },
          action: {
            type: "string",
            description: "Ability id from the enemy's kit, or the literal move: attack|defend|flee.",
          },
          target_ref: { type: "string", description: "Target reference: hero:<id> or enemy:<id>." },
        },
        required: ["enemy_id", "action", "target_ref"],
      },
    },
    rationale: {
      type: "string",
      description: "One-line explanation of the round plan; doubles as the replayable combat log entry.",
    },
  },
  required: ["round", "actions", "rationale"],
  additionalProperties: false,
};

export const dungeon_memory_read_schema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const dungeon_memory_write_schema = {
  type: "object",
  properties: {
    note: {
      type: "string",
      description: "Durable cross-run observation about the player; appended to dungeon memory.",
    },
  },
  required: ["note"],
  additionalProperties: false,
};
