// A tiny in-memory stand-in for window.__ai, used only by tests and `run-tasks.js --fake`.
//
// It implements just enough of the bridge surface to exercise the real MCP server end to end:
// one map, one mirror event, the EXPLORE/DIALOGUE states and the same INVALID_STATE guard the
// real bridge applies through ai.requireAction. It is a test fixture, not a game: passing
// against it proves the server, the CDP client and the tool wiring work, never that a real
// RMMZ game behaves. The integration test cross-checks its allowed_actions against
// src/state-contract.js so the fixture cannot quietly invent its own rules.

const ALLOWED = {
  EXPLORE: ['approach', 'walk', 'face', 'interact', 'use_item'],
  DIALOGUE: ['read_dialogue', 'advance'],
  CUTSCENE: ['read_dialogue', 'advance'],
  CHOICE: ['choose'],
  OTHER_SCENE: ['pick_item'],
  GAME_OVER: ['remember', 'restart'],
};
const DIR_NUM = { down: 2, left: 4, right: 6, up: 8 };
const STEP = { 2: [0, 1], 4: [-1, 0], 6: [1, 0], 8: [0, -1] };
const MIRROR_LINE = "It's a big mirror.";

export function createFakeBridge() {
  let state = 'EXPLORE';
  let seq = 0;
  const player = { x: 10, y: 10, d: 8 };
  const checked = new Set();
  let pending = [];
  const events = [{ id: 9, name: 'Mirror', x: 10, y: 8 }];

  function requireAction(action) {
    if (!(ALLOWED[state] || []).includes(action)) {
      throw new Error(`INVALID_STATE: ${action} not allowed in ${state}; allowed: ${(ALLOWED[state] || []).join(',') || 'none (use wait)'}`);
    }
  }
  function facingEvent() {
    const [dx, dy] = STEP[player.d];
    return events.find(e => e.x === player.x + dx && e.y === player.y + dy) || null;
  }
  function snap() {
    const f = facingEvent();
    return {
      seq, frame: 1000, state, scene: 'Scene_Map',
      flags: { puzzle: false, qte: false, chase: false, parallel: [], parallelCommon: [], pictures: [] },
      map: { id: 23, name: 'Mirror Room', w: 20, h: 15, level: null },
      player: { ...player },
      facing: f ? { id: f.id, name: f.name } : null,
      under: null,
      nearby: f ? { id: f.id, name: f.name, dist: 1 } : null,
      message: state === 'DIALOGUE' ? { text: pending.join('\n'), speaker: null } : null,
      interpreter: null,
      allowed_actions: [...(ALLOWED[state] || [])],
    };
  }

  return {
    version: '0.1.0-fake',
    parts: [],
    PROFILE: { name: 'Fake Game (test fixture)' },
    currentState: () => state,
    getState: snap,
    getLog: (since = 0) => ({ latest: seq, entries: [{ seq, frame: 1000, type: 'state', data: { to: state } }].filter(e => e.seq > since) }),
    listEvents: () => events.map(e => ({
      ...e, dist: Math.abs(e.x - player.x) + Math.abs(e.y - player.y),
      page: 0, trigger: 0, priority: 1, shortcut: false, checked: checked.has(e.id),
    })),
    mapGrid: () => ({
      origin: { x: player.x - 2, y: player.y - 2 },
      rows: ['.....', '..E..', '..@..', '.....', '.....'],
      legend: '# wall . floor @ you E event',
    }),
    listItems: () => [{ id: 1, name: 'Brass Key', description: 'A small key.', count: 1 }],
    getVariables: (o = {}) => (o.ids || [21]).map(id => ({ id, name: `Var${id}`, value: 7 })),
    getSwitches: (o = {}) => (o.ids || [1]).map(id => ({ id, name: `Switch${id}`, value: true })),
    describeEvent: id => ({ id, name: 'Mirror', page: 0, lines: [`Show Text: ${MIRROR_LINE}`] }),
    walk(dir, n = 1) {
      requireAction('walk');
      const d = DIR_NUM[dir];
      if (!d) throw new Error(`BAD_ARGS: direction ${dir}`);
      player.d = d;
      const [dx, dy] = STEP[d];
      const path = [];
      for (let i = 0; i < n; i++) { player.x += dx; player.y += dy; path.push([player.x, player.y]); }
      seq++;
      return { moved: path.length, path, stop: null, state: snap() };
    },
    face(dir) {
      requireAction('face');
      const d = DIR_NUM[dir];
      if (!d) throw new Error(`BAD_ARGS: direction ${dir}`);
      player.d = d;
      return { state: snap() };
    },
    interact() {
      requireAction('interact');
      const f = facingEvent();
      if (!f) return { started: false, eventId: null, state: snap() };
      checked.add(f.id);
      pending = [MIRROR_LINE];
      state = 'DIALOGUE';
      seq++;
      return { started: true, eventId: f.id, state: snap() };
    },
    advance() {
      requireAction('advance');
      pending = [];
      state = 'EXPLORE';
      seq++;
      return snap();
    },
    readDialogue() {
      requireAction('read_dialogue');
      const lines = [...pending];
      pending = [];
      state = 'EXPLORE';
      seq++;
      return { lines, state: snap() };
    },
    approach(target = {}) {
      requireAction('approach');
      const ev = events.find(e => e.id === target.eventId);
      if (!ev) throw new Error(`BAD_ARGS: unknown event ${target.eventId}`);
      player.x = ev.x;
      player.y = ev.y + 1;
      player.d = 8;
      checked.add(ev.id);
      seq++;
      return { reached: true, path: [[player.x, player.y]], dialogue: [MIRROR_LINE], state: snap() };
    },
    choose() { requireAction('choose'); return snap(); },
    useItemOn() { requireAction('use_item'); return { started: false, eventId: null, state: snap() }; },
    pickItem() { requireAction('pick_item'); return snap(); },
    reflect: () => ({ noted: true }),
    remember: () => ({ saved: true }),
    waitFor: async () => ({ ok: true, waitedMs: 0, state: snap() }),
    waitIdle: async () => ({ ok: true, waitedMs: 0, state: snap() }),
  };
}
