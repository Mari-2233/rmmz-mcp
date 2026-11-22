// 00-core: shared contract for all parts.
// Every part is the body of `function (ai, util)`. Game classes are NOT defined yet when parts
// load at startup — wrap/patch them inside util.ready(() => { ... }).
// Errors: throw new Error('CODE: message') — the server turns it into {error: CODE}.

// Main states in priority order (§3.2).
ai.STATES = ['BOOT', 'SCENE_CHANGING', 'GAME_OVER', 'OTHER_SCENE', 'TRANSFER', 'VIDEO', 'CHOICE',
  'NUMBER_INPUT', 'ITEM_SELECT', 'DIALOGUE', 'CUTSCENE', 'FORCED_MOVE', 'MOVING', 'EXPLORE', 'BLOCKED'];

// THE single state -> allowed action table. getState().allowed_actions and every action's
// INVALID_STATE check both read this. Read-only queries (get_state, list_events, ...) and
// `wait` are always allowed and are not listed.
ai.ALLOWED = {
  EXPLORE: ['approach', 'walk', 'face', 'interact', 'use_item'],
  DIALOGUE: ['read_dialogue', 'advance'],
  CUTSCENE: ['read_dialogue', 'advance'],
  CHOICE: ['choose'],
  OTHER_SCENE: ['pick_item'],
  GAME_OVER: ['remember', 'restart'], // only meaningful when scene === 'Scene_Item' (B9)
};

// Pocket Mirror specific bits (§7). Core code must reference these, never raw IDs.
ai.PROFILE = {
  name: 'Pocket Mirror ~ GoldenerTraum',
  switches: { qte: 8, puzzleStart: 13, puzzleFinish: 14, chase: [16, 233, 260], gameOver: 20, puzzleAid: 30 },
  vars: { itemId: 12 },
  okKey: 'ok',             // TDS_Input: ok is bound to Z (keyCode 90) only; we set Input._currentState.ok
  unsupported: [],         // actions to remove from ALLOWED for other games, e.g. ['use_item','pick_item']
};

// Current main state. 10-state.js replaces this with the real state machine.
ai.currentState = ai.currentState || function () { return 'UNKNOWN'; };

// Allowed actions for a state (Profile may only remove).
ai.allowedActions = function (state) {
  const s = state || ai.currentState();
  return (ai.ALLOWED[s] || []).filter(a => !ai.PROFILE.unsupported.includes(a));
};

// Guard for action APIs: throws INVALID_STATE unless `action` is allowed now.
// Before 10-state.js exists (state 'UNKNOWN') it lets everything through.
ai.requireAction = function (action) {
  const s = ai.currentState();
  if (s === 'UNKNOWN') return s;
  if (ai.PROFILE.unsupported.includes(action)) throw new Error(`UNSUPPORTED: ${action} is not supported for this game`);
  if (!ai.allowedActions(s).includes(action)) {
    throw new Error(`INVALID_STATE: ${action} not allowed in ${s}; allowed: ${ai.allowedActions(s).join(',') || 'none (use wait)'}`);
  }
  return s;
};

// Direction helpers.
ai.DIR = { down: 2, left: 4, right: 6, up: 8 };
ai.dirNum = d => (typeof d === 'number' ? d : ai.DIR[d]) || (() => { throw new Error(`BAD_ARGS: direction ${d}`); })();
