// Game tools: thin wrappers over window.__ai.* (see README: MCP 工具).
// Descriptions are kept short and stable: they sit in the model context every turn (prompt cache).
// Deliberately NOT provided: set_switch, set_variable, teleport, start_event, skip_video.
import { z } from 'zod';
import { CdpError } from '../cdp.js';
import { ok, safe } from '../util.js';

const ACTION_TIMEOUT_MS = 20000; // game side guarantees < 15 s per call
const READ_TIMEOUT_MS = 10000;

const STATES = ['BOOT', 'SCENE_CHANGING', 'GAME_OVER', 'OTHER_SCENE', 'TRANSFER', 'VIDEO', 'CHOICE',
  'NUMBER_INPUT', 'ITEM_SELECT', 'DIALOGUE', 'CUTSCENE', 'FORCED_MOVE', 'MOVING', 'EXPLORE', 'BLOCKED'];
const Dir = z.enum(['up', 'down', 'left', 'right']);
const Ids = z.array(z.number().int().min(1)).max(200);

// Drop null/undefined fields of a state snapshot (saves tokens; absent == null).
function compactState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// Results that are snapshots themselves, or carry one in `.state`.
function compactResult(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  if (typeof r.state === 'string' && 'allowed_actions' in r) return compactState(r); // a snapshot
  if (r.state && typeof r.state === 'object') return { ...r, state: compactState(r.state) };
  return r;
}

// The model's attention follows the end of a tool result: keep `budget` as the last field.
function budgetLast(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !('budget' in r)) return r;
  const { budget, ...rest } = r;
  return { ...rest, budget };
}

export function register({ server, cdp }) {
  // Call window.__ai[method]; map "bridge/method missing" to NOT_READY so the model gets a clear error.
  // PMGT_BUDGET=1: make sure the in-game action budget is on (survives game restarts / bridge reloads).
  const BUDGET = process.env.PMGT_BUDGET === '1';
  // PMGT_HUD=1: report each call + the model's think time (gap since the previous result) to the overlay.
  const HUD = process.env.PMGT_HUD === '1';
  let lastEnd = 0;
  async function call(method, args = [], timeoutMs = READ_TIMEOUT_MS) {
    const think = lastEnd ? Date.now() - lastEnd : -1;
    if (HUD) cdp.evaluate(`window.__ai && __ai.hud && __ai.hud.tool(${JSON.stringify(method)}, ${think}); true`).catch(() => {});
    try {
      return await callInner(method, args, timeoutMs);
    } finally { lastEnd = Date.now(); }
  }
  async function callInner(method, args, timeoutMs) {
    try {
      if (BUDGET) await cdp.evaluate('window.__ai && __ai.budget && !window.__aiBudget.enabled && __ai.budget.enable(true); true').catch(() => {});
      return budgetLast(compactResult(await cdp.callBridge(method, args, { timeoutMs })));
    } catch (e) {
      if (e instanceof CdpError && e.code === 'JS_EXCEPTION') {
        if (/BRIDGE_NO_METHOD/.test(e.message)) throw new CdpError('NOT_READY', `bridge method ${method} missing (game-side part not loaded)`);
        if (/BRIDGE_NOT_LOADED/.test(e.message)) throw new CdpError('NOT_READY', 'in-game bridge (window.__ai) not loaded yet; retry shortly');
        // Bridge convention is "Error: CODE: message". Anything else (TypeError...) is a bridge bug:
        // report its first line instead of letting util.safe() mis-parse e.g. "TypeError: Cannot" as code "C".
        const first = String(e.message || '').split('\n')[0];
        if (!/Error: [A-Z][A-Z_]+:/.test(first)) throw new CdpError('GAME_ERROR', `${method}: ${first}`);
      }
      throw e;
    }
  }

  const tool = (name, title, description, inputSchema, readOnly, handler) => server.registerTool(name, {
    title, description, ...(inputSchema ? { inputSchema } : {}),
    annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
  }, safe(async args => ok(await handler(args))));

  // ---- S1: read-only ----
  tool('get_state', 'Get state',
    'Current game state snapshot: state, map, player {x,y,d}, facing/nearby event, message (text, choices), allowed_actions. Any state.',
    null, true, () => call('getState'));

  tool('get_log', 'Event log',
    'Game event log (state changes, map, messages, choices, items, switches, transfers) after seq `since`. Returns {latest, entries}.',
    {
      since: z.number().int().min(0).optional().describe('Only entries with seq > since (default 0)'),
      types: z.array(z.string()).optional().describe('Filter by type, e.g. ["message","item"]'),
      limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 50)'),
    }, true, ({ since = 0, types = null, limit = 50 }) => call('getLog', [since, types?.length ? types : null, limit]));

  tool('list_events', 'List events',
    'Events on the current map sorted by distance: id, name, x, y, dist, page (-1 = inactive), trigger, priority, shortcut (accepts use_item), proximity.',
    { radius: z.number().int().min(1).max(100).optional().describe('Only events within this Manhattan distance') },
    true, ({ radius }) => call('listEvents', [radius ? { radius } : {}]));

  tool('map_grid', 'Map grid',
    'ASCII passability map (default 21x15 centred on player). Returns {origin, rows, legend}; rows[i][j] is tile (origin.x+j, origin.y+i).',
    {
      x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(),
      w: z.number().int().min(1).max(60).optional(), h: z.number().int().min(1).max(40).optional(),
    }, true, ({ x, y, w, h }) => {
      const rect = {};
      for (const [k, v] of Object.entries({ x, y, w, h })) if (v !== undefined) rect[k] = v;
      return call('mapGrid', [rect]);
    });

  tool('list_items', 'List items', 'Items in the inventory: id, name, description, count.',
    null, true, () => call('listItems'));

  const varSchema = {
    ids: Ids.optional().describe('IDs to read (max 200)'),
    named: z.boolean().optional().describe('All entries that have a name (default when ids omitted)'),
  };
  const varArgs = ({ ids, named }) => [ids?.length ? { ids } : { named: named ?? true }];
  tool('get_variables', 'Get variables', 'Read game variables (read-only): [{id, name, value}].',
    varSchema, true, a => call('getVariables', varArgs(a)));
  tool('get_switches', 'Get switches', 'Read game switches (read-only): [{id, name, value}].',
    varSchema, true, a => call('getSwitches', varArgs(a)));

  tool('describe_event', 'Describe event',
    "An event's active page as readable pseudo-code: appearance conditions and command lines (dialogue, branches, switches, items). Spoilers: for your reasoning only, never tell the user unseen content.",
    { id: z.number().int().min(1).describe('Event id from list_events') }, true, ({ id }) => call('describeEvent', [id]));

  // ---- S2: actions (each returns the new state) ----
  tool('walk', 'Walk',
    'Walk N tiles in a straight line (EXPLORE only). Stops early if blocked or an event starts. Returns path, stop reason and the new state.',
    { direction: Dir, steps: z.number().int().min(1).max(20).optional().describe('Tiles (default 1)') },
    false, ({ direction, steps = 1 }) => call('walk', [direction, steps], ACTION_TIMEOUT_MS));

  tool('face', 'Face', 'Turn the player without moving (EXPLORE only). Returns the new state (check facing).',
    { direction: Dir }, false, ({ direction }) => call('face', [direction], ACTION_TIMEOUT_MS));

  tool('interact', 'Interact',
    'Press confirm on the tile underfoot / the faced event (EXPLORE only). Returns started, eventId and the new state.',
    null, false, () => call('interact', [], ACTION_TIMEOUT_MS));

  // ---- combos: one call instead of many turns ----
  tool('approach', 'Approach',
    'One call: walk to an event (or tile x,y), face it, interact and read the dialogue (EXPLORE only). Returns reached, path, dialogue, new state.',
    {
      event_id: z.number().int().min(1).optional().describe('Target event id from list_events'),
      x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(),
      interact: z.boolean().optional().describe('Interact on arrival (default true)'),
      read: z.boolean().optional().describe('Read dialogue after interacting (default true)'),
    }, false, ({ event_id, x, y, interact, read }) => {
      const target = event_id != null ? { eventId: event_id } : { x, y };
      return call('approach', [target, { interact, read }], ACTION_TIMEOUT_MS);
    });

  tool('read_dialogue', 'Read dialogue',
    'Advance through dialogue/cutscene until input is needed (EXPLORE, CHOICE, ...). Returns all lines at once and the new state.',
    null, false, () => call('readDialogue', [], ACTION_TIMEOUT_MS));

  tool('reflect', 'Reflect',
    'Think: clues seen, a hypothesis, ONE concrete next action. Required when budget is empty; restores part of it (less each time). Saved as a note.',
    {
      clues: z.array(z.string()).min(2).max(8).describe('Concrete things you saw/read in game'),
      hypothesis: z.string().describe('What you think the puzzle wants'),
      plan: z.object({
        action: z.enum(['interact', 'use_item', 'approach', 'leave', 'ask_user']),
        event_id: z.number().int().optional(), item_id: z.number().int().optional(),
      }).describe('The next action that tests the hypothesis'),
    }, false, a => call('reflect', [a]));

  tool('ask_user', 'Ask user',
    'Ask the user a question when stuck (like asking a friend). Then end your turn and wait for the answer.',
    { question: z.string().describe('What you need to know and what you already tried') },
    false, async ({ question }) => ({ asked: question, next: 'End your turn now and wait for the user to answer.' }));

  tool('advance', 'Advance', 'Press confirm once to advance dialogue (DIALOGUE/CUTSCENE). Returns the new state.',
    null, false, () => call('advance', [], ACTION_TIMEOUT_MS));

  tool('choose', 'Choose', 'Pick a choice (CHOICE only); index = message.choices[].index from the state. Returns the new state.',
    { index: z.number().int().min(0).describe('message.choices[].index') },
    false, ({ index }) => call('choose', [index], ACTION_TIMEOUT_MS));

  tool('wait', 'Wait',
    'Wait until the game needs input (default) or reaches one of `states`; use in TRANSFER/VIDEO/MOVING/FORCED_MOVE/BLOCKED. Returns {ok, waitedMs, state}.',
    {
      states: z.array(z.enum(STATES)).optional().describe('Target states (default: any input-ready state)'),
      timeout_ms: z.number().int().min(100).max(15000).optional().describe('Default 10000'),
    }, false, ({ states, timeout_ms = 10000 }) => (states?.length
      ? call('waitFor', [states, timeout_ms], ACTION_TIMEOUT_MS)
      : call('waitIdle', [timeout_ms], ACTION_TIMEOUT_MS)));

  // ---- S3: items ----
  tool('use_item', 'Use item',
    'Use an inventory item on the faced event (EXPLORE only; for events with shortcut:true). Returns started, eventId and the new state.',
    { item_id: z.number().int().min(1).describe('Item id from list_items') },
    false, ({ item_id }) => call('useItemOn', [item_id], ACTION_TIMEOUT_MS));

  tool('pick_item', 'Pick item',
    'Select an item when the game opens the item picker mid-event (OTHER_SCENE, scene Scene_Item). Returns the new state.',
    { item_id: z.number().int().min(1).describe('Item id from list_items') },
    false, ({ item_id }) => call('pickItem', [item_id], ACTION_TIMEOUT_MS));
}
