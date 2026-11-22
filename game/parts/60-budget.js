// 60-budget (lead): action cost so that "interact with everything" stops being free.
// Off by default (dev tests); the MCP server turns it on with PMGT_BUDGET=1.
//
// Costs  : interact / approach-with-interact = 1, use_item = 2; moving, dialogue and reads are free.
// Refund : an action that shows dialogue never seen before is free; a new item or a first visit
//          to a map gives +2 on top. Repeating something that yields nothing new costs full price.
// Room   : budget = ceil(1.5 x interactive events), clamped 6..20, kept per map (leaving and
//          coming back does not refill it). A new item gives every room +2 (new possibilities).
// Empty  : only `reflect` is allowed. reflect #1/#2/#3 in a room restores 50/25/12% of the room
//          max, must differ from the previous reflection and must name a concrete next action.
// Plan   : until the planned action is done, any other paid action costs double, and each
//          wasteful step (revisiting a tile walked since the plan, or moving farther from the
//          plan's target by BFS distance) costs 1. Without a plan, moving is free.
// Stuck  : after 3 reflections with an empty budget the room is "stuck": interacting is blocked;
//          the player may leave (walk/face/approach without interact) or ask_user.
// Visible signals only (dialogue text, inventory, map) decide refunds — never hidden switches.

const B = (window.__aiBudget = window.__aiBudget || {
  enabled: false, rooms: {}, seenLines: [], visited: [], notes: [], plan: null,
});
const RESTORE = [0.5, 0.25, 0.12];
const COST = { interact: 1, use_item: 2 };
const seen = new Set(B.seenLines);

ai.budget = {
  enable(on = true) { B.enabled = !!on; return ai.budget.status(); },
  status() { return roomStatus(); },
  reset() { B.rooms = {}; B.seenLines = []; seen.clear(); B.visited = []; B.notes = []; B.plan = null; return true; },
};

function interactiveCount() {
  return $gameMap.events().filter(e => e && !e._erased && e._pageIndex >= 0 && e.page() && e._trigger <= 2).length;
}
function room() {
  const id = $gameMap.mapId();
  if (!B.rooms[id]) {
    const max = Math.max(6, Math.min(20, Math.ceil(interactiveCount() * 1.5)));
    B.rooms[id] = { max, left: max, reflects: 0, lastReflect: null };
  }
  return B.rooms[id];
}
function phase(r) {
  if (r.left > 0) return 'ok';
  return r.reflects >= RESTORE.length ? 'stuck' : 'think';
}
function roomStatus(extra) {
  if (!B.enabled || !window.$gameMap || !$gameMap.mapId()) return { enabled: false };
  const r = room();
  const s = { left: r.left, max: r.max, phase: phase(r), reflects_left: RESTORE.length - r.reflects };
  if (B.plan) s.plan = B.plan.text;
  Object.assign(s, extra || {});
  if (s.phase === 'think') s.warning = 'Budget empty: only reflect is allowed (sum up clues, hypothesis, a concrete plan).';
  else if (s.phase === 'stuck') s.warning = 'Stuck in this room: interacting is blocked. Leave the room (walk / approach with interact:false) or ask_user.';
  else if (r.left <= 2) s.warning = `Only ${r.left} left in this room: stop trying things at random; think about the clues first.`;
  return s;
}
// New-game resets memory too.
util.ready(() => {
  // The AI never saves: the save folder is the player's real one. Leave save menus at once.
  if (window.Scene_Save) util.wrap(Scene_Save.prototype, 'start', orig => function () {
    const r = orig.apply(this, arguments);
    if (B.enabled) {
      B.last = { kind: 'save', spent: 0, note: 'save point: saving is disabled for the AI, menu closed', t: Date.now() };
      if (ai._log && ai._log.push) ai._log.push('message', { text: '(Saving is disabled for the AI. The save menu was closed.)', speaker: null });
      setTimeout(() => { if (SceneManager._scene === this) SceneManager.pop(); }, 0);
    }
    return r;
  }, '60-budget:Scene_Save.start');
  util.wrap(DataManager, 'setupNewGame', orig => function () { ai.budget.reset(); return orig.apply(this, arguments); }, '60-budget:DataManager.setupNewGame');
});

// ---- novelty (visible signals only) ----
function snapshot() {
  return {
    map: $gameMap.mapId(),
    seq: ai.getLog ? ai.getLog(0, null, 1).latest : 0,
    items: new Map($gameParty.items().map(i => [i.id, $gameParty.numItems(i)])),
  };
}
function novelty(before) {
  let newLines = 0, newItem = false, newMap = false;
  if (ai.getLog) {
    for (const e of ai.getLog(before.seq, ['message'], 200).entries) {
      const t = e.data && e.data.text && String(e.data.text).trim();
      if (t && !seen.has(t)) { seen.add(t); B.seenLines.push(t); newLines++; }
    }
  }
  for (const i of $gameParty.items()) if ($gameParty.numItems(i) > (before.items.get(i.id) || 0)) newItem = true;
  const m = $gameMap.mapId();
  if (m !== before.map && !B.visited.includes(m)) { B.visited.push(m); newMap = true; }
  return { newLines, newItem, newMap };
}
function markVisited() { const m = $gameMap.mapId(); if (m && !B.visited.includes(m)) B.visited.push(m); }

// ---- plan matching ----
function planMatches(kind, ids) {
  const p = B.plan;
  if (!p || p.map !== $gameMap.mapId()) return true; // no plan in this room: normal price
  if (p.action !== kind && !(p.action === 'interact' && kind === 'approach')) return false;
  if (p.event_id != null && ids.event_id != null && p.event_id !== ids.event_id) return false;
  if (p.item_id != null && ids.item_id != null && p.item_id !== ids.item_id) return false;
  return true;
}

// ---- charging wrapper ----
let depth = 0;

// ---- movement cost under a plan ----
// Only while a plan exists in this room, and only for moves the AI makes through our tools.
// Per step at most 1: stepping on a tile already walked since the plan was set, OR the BFS
// distance to the plan's target growing. Before a plan, moving is always free (exploration).
let moveCharge = null; // { steps } during an outermost AI action
function planTarget() {
  const p = B.plan;
  if (!p || p.map !== $gameMap.mapId() || p.event_id == null) return null;
  const e = $gameMap.event(p.event_id);
  return e ? { x: e.x, y: e.y } : null;
}
function planDistance() {
  const t = planTarget();
  if (!t) return null;
  const W = $gameMap.width(), key = (x, y) => y * W + x;
  const seenT = new Set([key($gamePlayer.x, $gamePlayer.y)]);
  let frontier = [[$gamePlayer.x, $gamePlayer.y]], d = 0;
  while (frontier.length && seenT.size < 6000) {
    const next = [];
    for (const [x, y] of frontier) {
      if (Math.abs(x - t.x) + Math.abs(y - t.y) <= 1) return d; // next to (or on) the target
      for (const [dir, dx, dy] of [[2, 0, 1], [4, -1, 0], [6, 1, 0], [8, 0, -1]]) {
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (seenT.has(k) || !$gameMap.isValid(nx, ny) || !$gamePlayer.canPass(x, y, dir)) continue;
        seenT.add(k); next.push([nx, ny]);
      }
    }
    frontier = next; d++;
  }
  return null; // unreachable: only the revisit rule applies
}
function startPlanTracking() {
  B.planTiles = [`${$gamePlayer.x},${$gamePlayer.y}`];
  B.planDist = planDistance();
}
util.ready(() => {
  util.wrap(Game_Player.prototype, 'increaseSteps', orig => function () {
    const r0 = orig.apply(this, arguments);
    try {
      if (B.enabled && moveCharge && B.plan && B.plan.map === $gameMap.mapId()) {
        const k = `${this.x},${this.y}`;
        const tiles = B.planTiles || (B.planTiles = []);
        const revisit = tiles.includes(k);
        const dist = planDistance();
        const farther = B.planDist != null && dist != null && dist > B.planDist;
        if (revisit || farther) { const rm = room(); rm.left = Math.max(0, rm.left - 1); moveCharge.steps++; }
        if (!revisit) tiles.push(k);
        B.planDist = dist;
      }
    } catch (e) { /* never break movement */ }
    return r0;
  }, '60-budget:Game_Player.increaseSteps');
});
function guard(kind, paid) {
  if (!B.enabled) return;
  const r = room(), ph = phase(r);
  if (ph === 'think') throw new Error('BUDGET_EXHAUSTED: budget for this room is empty; call reflect first');
  if (ph === 'stuck' && paid) throw new Error('STUCK: interacting is blocked in this room; leave the room or ask_user');
  if (paid && r.left <= 0) throw new Error('BUDGET_EXHAUSTED: call reflect first');
}
function wrapAction(name, kind, getIds, isPaid) {
  const base = ai[name];
  if (!base || base.__budgeted) return;
  const fn = async function (...args) {
    if (!B.enabled || depth > 0) { depth++; try { return await base.apply(this, args); } finally { depth--; } }
    const paid = isPaid(args);
    guard(kind, paid);
    markVisited();
    const before = snapshot();
    const ids = getIds(args);
    const r = room();
    const onPlan = planMatches(kind, ids);
    depth++;
    moveCharge = { steps: 0 };
    let res, mv = 0;
    try { res = await base.apply(this, args); } finally { depth--; mv = moveCharge.steps; moveCharge = null; }
    let spent = 0, note;
    if (paid) {
      const cost = (COST[kind === 'approach' ? 'interact' : kind] || 0) * (onPlan ? 1 : 2);
      const nv = novelty(before);
      const started = res && (res.started || (res.interacted && res.interacted.started));
      if (nv.newLines > 0 || nv.newItem || nv.newMap) { spent = 0; note = 'new information: free'; }
      else { spent = cost; note = started ? 'nothing new happened' : 'nothing happened'; }
      if (!onPlan) note += ' (off-plan: double cost)';
      r.left = Math.max(0, r.left - spent);
      const bonus = (nv.newItem ? 2 : 0) + (nv.newMap ? 2 : 0);
      if (nv.newItem) for (const k of Object.keys(B.rooms)) if (+k !== $gameMap.mapId()) B.rooms[k].left += 2;
      if (bonus) { room().left += bonus; note += ` (+${bonus} bonus)`; }
      if (B.plan && onPlan && B.plan.map === before.map) B.plan = null; // plan carried out
    } else {
      const nv = novelty(before);
      if (nv.newMap) { room().left += 2; note = 'new room (+2)'; }
    }
    if (mv) { spent += mv; note = (note ? note + '; ' : '') + `${mv} wasteful step(s) under plan (revisit / farther): -${mv}`; }
    B.last = { kind, spent, note, t: Date.now() };
    if (res && typeof res === 'object') {
      res.state = ai.getState(); // refresh so allowed_actions reflects the new budget
      res.budget = roomStatus({ spent, note });
    }
    return res;
  };
  fn.__budgeted = true;
  ai[name] = fn;
}

const facingId = () => { try { const s = ai.getState(); return (s.facing && s.facing.id) || (s.under && s.under.id) || null; } catch (e) { return null; } };
wrapAction('interact', 'interact', () => ({ event_id: facingId() }), () => true);
wrapAction('useItemOn', 'use_item', a => ({ item_id: Number(a[0]), event_id: facingId() }), () => true);
wrapAction('approach', 'approach', a => ({ event_id: a[0] && a[0].eventId != null ? Number(a[0].eventId) : null }),
  a => !!(a[0] && a[0].eventId != null) && !(a[1] && a[1].interact === false));
wrapAction('walk', 'walk', () => ({}), () => false);
wrapAction('face', 'face', () => ({}), () => false);

// allowed_actions follows the budget phase (single source: ai.allowedActions).
if (!ai.allowedActions.__budgeted) {
  const baseAllowed = ai.allowedActions;
  ai.allowedActions = function (state) {
    const list = baseAllowed(state);
    if (!B.enabled || (state || ai.currentState()) !== 'EXPLORE') return list;
    const ph = phase(room());
    if (ph === 'think') return ['reflect'];
    if (ph === 'stuck') return ['walk', 'face', 'approach', 'ask_user'];
    return list.concat(['reflect']);
  };
  ai.allowedActions.__budgeted = true;
}

// Snapshot carries budget + the last notes (the player's notebook).
if (!ai.getState.__budgeted) {
  const baseGet = ai.getState;
  ai.getState = function () {
    const s = baseGet.apply(this, arguments);
    if (B.enabled) { s.notes = B.notes.slice(-3).map(n => n.text); s.budget = roomStatus(); }
    return s;
  };
  ai.getState.__budgeted = true;
}

// ---- reflect ----
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
ai.reflect = function (r = {}) {
  if (!B.enabled) throw new Error('UNSUPPORTED: budget is off');
  const clues = Array.isArray(r.clues) ? r.clues.map(String).filter(c => c.trim().length >= 6) : [];
  const hyp = String(r.hypothesis || '').trim();
  const p = r.plan || {};
  const actions = ['interact', 'use_item', 'approach', 'leave', 'ask_user'];
  if (clues.length < 2) throw new Error('BAD_ARGS: list at least 2 concrete clues you have seen');
  if (hyp.length < 10) throw new Error('BAD_ARGS: hypothesis is too short');
  if (!actions.includes(p.action)) throw new Error(`BAD_ARGS: plan.action must be one of ${actions.join(', ')}`);
  if ((p.action === 'interact' || p.action === 'approach') && p.event_id == null) throw new Error('BAD_ARGS: plan needs event_id');
  if (p.action === 'use_item' && p.item_id == null) throw new Error('BAD_ARGS: plan needs item_id (and event_id)');
  const rm = room();
  const key = norm(hyp) + '|' + p.action + '|' + (p.event_id ?? '') + '|' + (p.item_id ?? '');
  const text = `[map ${$gameMap.mapId()}] ${hyp} -> plan: ${p.action}${p.item_id != null ? ' item ' + p.item_id : ''}${p.event_id != null ? ' on event ' + p.event_id : ''}`;
  const same = rm.lastReflect === key;
  if (!same) { B.notes.push({ text, clues }); if (B.notes.length > 30) B.notes.shift(); }
  let restored = 0, note;
  if (same) note = 'same as your previous reflection: nothing restored. Think of something different.';
  else if (rm.left > 0) note = 'noted (budget not empty, nothing to restore)';
  else if (rm.reflects >= RESTORE.length) note = 'no reflections left in this room: leave or ask_user';
  else { restored = Math.max(1, Math.round(rm.max * RESTORE[rm.reflects])); rm.left += restored; rm.reflects++; note = `restored ${restored}`; }
  rm.lastReflect = key;
  B.last = { kind: 'reflect', spent: 0, note, t: Date.now() };
  B.plan = { map: $gameMap.mapId(), action: p.action === 'approach' ? 'interact' : p.action, event_id: p.event_id ?? null, item_id: p.item_id ?? null, text };
  startPlanTracking();
  return { noted: text, state: ai.getState(), budget: roomStatus({ restored, note }) };
};

// list_events: in budget (play) mode hide system events the player can't see or use.
if (ai.listEvents && !ai.listEvents.__budgeted) {
  const baseList = ai.listEvents;
  ai.listEvents = function (...a) {
    const list = baseList.apply(this, a);
    return B.enabled ? list.filter(e => e.page >= 0 && e.trigger <= 2) : list;
  };
  ai.listEvents.__budgeted = true;
}
