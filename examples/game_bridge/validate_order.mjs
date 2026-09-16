const TARGET_REF = /^(hero|enemy):.+$/;

export function validate_enemy_actions(args) {
  if (typeof args.round !== "number" || Number.isFinite(args.round) === false) {
    return "round_must_be_number";
  }
  if (typeof args.rationale !== "string" || args.rationale.length === 0) {
    return "rationale_required";
  }
  if (Array.isArray(args.actions) === false) {
    return "actions_must_be_array";
  }
  for (const action of args.actions) {
    const problem = validate_action(action);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

export function normalize_actions(actions) {
  return actions.map((action) => ({
    enemy_id: action.enemy_id,
    action: action.action,
    target_ref: action.target_ref,
  }));
}

function validate_action(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "action_must_be_object";
  }
  if (typeof action.enemy_id !== "string" || action.enemy_id.length === 0) {
    return "enemy_id_required";
  }
  if (typeof action.action !== "string" || action.action.length === 0) {
    return "action_required";
  }
  if (typeof action.target_ref !== "string" || TARGET_REF.test(action.target_ref) === false) {
    return "target_ref_must_be_hero_or_enemy";
  }
  return undefined;
}
