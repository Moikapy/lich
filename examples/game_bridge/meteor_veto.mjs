const METEOR_GATE_ROUND = 3;
const METEOR_REASON = "meteor_gates_closed_until_round_3";

export async function meteor_veto(info) {
  if (info.tool_name !== "enemy_actions") {
    return;
  }
  const round = Number(info.args.round ?? 0);
  const actions = Array.isArray(info.args.actions) ? info.args.actions : [];
  if (round < METEOR_GATE_ROUND && uses_meteor(actions) === true) {
    return { block: true, reason: METEOR_REASON };
  }
}

function uses_meteor(actions) {
  return actions.some((action) => {
    if (typeof action !== "object" || action === null) {
      return false;
    }
    return String(action.action).includes("meteor");
  });
}
