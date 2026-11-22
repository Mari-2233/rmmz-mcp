// The formal state contract, mirrored from the game side so it can be checked offline.
//
// The game parts are the source of truth at runtime (game/parts/00-core.js owns STATES and
// ALLOWED, game/parts/10-state.js owns IDLE). They run inside Chromium 85 and cannot import
// this module, so the tables exist twice. server/test/state-contract.test.js executes the game
// copies and fails if they drift from the ones below. Change the game side first, then mirror
// the change here and let the test prove both copies agree.

// Main states in priority order (mirrors ai.STATES in game/parts/00-core.js).
export const STATES = Object.freeze([
  'BOOT', 'SCENE_CHANGING', 'GAME_OVER', 'OTHER_SCENE', 'TRANSFER', 'VIDEO', 'CHOICE',
  'NUMBER_INPUT', 'ITEM_SELECT', 'DIALOGUE', 'CUTSCENE', 'FORCED_MOVE', 'MOVING', 'EXPLORE',
  'BLOCKED',
]);

// State -> action tools allowed in it (mirrors ai.ALLOWED in game/parts/00-core.js).
// Read-only tools and `wait` are allowed in every state and are not listed.
export const ALLOWED = Object.freeze({
  EXPLORE: Object.freeze(['approach', 'walk', 'face', 'interact', 'use_item']),
  DIALOGUE: Object.freeze(['read_dialogue', 'advance']),
  CUTSCENE: Object.freeze(['read_dialogue', 'advance']),
  CHOICE: Object.freeze(['choose']),
  OTHER_SCENE: Object.freeze(['pick_item']),
  GAME_OVER: Object.freeze(['remember', 'restart']),
});

// States where the game waits for input (mirrors IDLE in game/parts/10-state.js).
export const IDLE_STATES = Object.freeze([
  'EXPLORE', 'DIALOGUE', 'CHOICE', 'NUMBER_INPUT', 'ITEM_SELECT', 'GAME_OVER', 'OTHER_SCENE',
]);

// Every read-only tool. Safe in any state; never changes the game.
export const READ_TOOLS = Object.freeze([
  'ping', 'screenshot', 'get_pushed_events', 'get_capabilities',
  'get_state', 'get_log', 'list_events', 'map_grid', 'list_items',
  'get_variables', 'get_switches', 'describe_event',
]);

// Action tools gated by ALLOWED through ai.requireAction on the game side.
export const GATED_ACTION_TOOLS = Object.freeze([
  'walk', 'face', 'interact', 'approach', 'read_dialogue',
  'advance', 'choose', 'use_item', 'pick_item', 'remember', 'restart',
]);

// Action tools that are deliberately not gated by ALLOWED, each for a stated reason:
// - wait: waiting must work in every state, including TRANSFER and VIDEO.
// - reflect: a thinking tool for the budget system; it never touches the game world.
// - ask_user: answered by the server itself; no bridge call happens.
export const META_ACTION_TOOLS = Object.freeze(['wait', 'reflect', 'ask_user']);

// Registered only with PMGT_MCP_DEV=1. Never enable these for the AI player.
export const DEV_TOOLS = Object.freeze(['eval_js', 'reload_bridge']);

// Tools that must never be registered. Fair play means the model gets no teleport, no item
// granting and no switch or variable writes (see server/src/tools/game.js).
export const FORBIDDEN_TOOLS = Object.freeze([
  'set_switch', 'set_variable', 'teleport', 'start_event', 'skip_video',
]);

// Hidden on the server when PMGT_FAIR_PLAY=1. Mirrors the client toolFilter list in the
// README, enforced here so a misconfigured client cannot leak spoilers or human-only views.
export const FAIR_PLAY_HIDDEN = Object.freeze([
  'describe_event', 'get_variables', 'get_switches', 'screenshot', 'get_pushed_events',
]);

// Allowed action tools for a state. A per-game profile may only remove entries.
export function allowedActions(state, unsupported = []) {
  return (ALLOWED[state] || []).filter(a => !unsupported.includes(a));
}

// Tool names the server registers for a mode combination. Registration code hides tools by
// the same rules; the contract test captures real registrations and compares them to this.
// Fair play wins over dev mode: eval_js can read or write anything in the game, so a
// fair-play server never registers the dev tools even when PMGT_MCP_DEV=1 is also set.
export function registeredTools({ dev = false, fairPlay = false } = {}) {
  const all = [...READ_TOOLS, ...GATED_ACTION_TOOLS, ...META_ACTION_TOOLS, ...(dev && !fairPlay ? DEV_TOOLS : [])];
  return fairPlay ? all.filter(t => !FAIR_PLAY_HIDDEN.includes(t)) : all;
}
