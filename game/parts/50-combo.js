// 50-combo (lead): composite actions that save model turns. Every model turn costs a round trip
// (and, under load, a queue wait), so "walk, face, interact, advance x5" becomes one call.
//   ai.approach(target, opts) : BFS path (our own, on $gamePlayer.canPass — not the game's
//                               pathfinding) to the target, face it, optionally interact and read
//                               the resulting dialogue.
//   ai.readDialogue(opts)     : advance through dialogue/cutscene until input is needed; returns
//                               all lines at once.
// Both keep within ~14 s; if the budget runs out they return done:false so the model can call again.

const BUDGET_MS = 14000;
const MAX_NODES = 6000;
const DIRS = [[2, 0, 1], [4, -1, 0], [6, 1, 0], [8, 0, -1]];
const DIRNAME = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' };
const STOP_READ = ['EXPLORE', 'CHOICE', 'NUMBER_INPUT', 'ITEM_SELECT', 'GAME_OVER', 'OTHER_SCENE'];

function lineOf(m) {
  if (!m || !m.text) return null;
  const t = String(m.text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return m.speaker ? `${m.speaker}: ${t}` : t;
}

// ---------------------------------------------------------------- readDialogue
ai.readDialogue = async function (opts = {}) {
  const t0 = Date.now();
  const budget = Math.min(Number(opts.budgetMs) || BUDGET_MS, BUDGET_MS);
  const lines = [];
  let last = null, steps = 0;
  const push = () => {
    const l = lineOf(ai.getState().message);
    if (l && l !== last) { lines.push(l); last = l; }
  };
  while (Date.now() - t0 < budget && steps < 60) {
    const s = ai.currentState();
    if (STOP_READ.includes(s)) break;
    if (s === 'DIALOGUE') {
      push();
      await ai.advance();
      steps++;
      continue;
    }
    // CUTSCENE / TRANSFER / VIDEO / MOVING ...: let it play; most cutscenes don't need input.
    const w = await ai.waitIdle(Math.min(2500, budget - (Date.now() - t0)));
    if (!w.ok && ai.currentState() === 'CUTSCENE') { await ai.advance(); steps++; } // waiting for a key
  }
  const state = ai.currentState();
  if (state === 'CHOICE') push(); // the question that comes with the choice
  return { done: STOP_READ.includes(state), lines, steps, waitedMs: Date.now() - t0, state: ai.getState() };
};

// ---------------------------------------------------------------- approach
function targetOf(t) {
  if (t && t.eventId != null) {
    const e = $gameMap.event(Number(t.eventId));
    if (!e || e._erased) throw new Error(`NOT_FOUND: no event ${t.eventId} on this map`);
    if (e._pageIndex < 0 || !e.page()) throw new Error(`INVALID_STATE: event ${t.eventId} is inactive (page -1)`);
    let name = null; try { name = e.event().name; } catch (x) { /* ignore */ }
    // Floor-level events (below characters, or touch/through) are used by standing ON them.
    const standOn = e._priorityType !== 1 || e.isThrough();
    return { x: e.x, y: e.y, eventId: e.eventId(), name, standOn };
  }
  if (t && Number.isInteger(t.x) && Number.isInteger(t.y)) return { x: t.x, y: t.y, eventId: null, name: null, standOn: true };
  throw new Error('BAD_ARGS: target needs eventId or integer x,y');
}

// BFS over tiles using the engine's own passability for the player (terrain + events + plugins).
function bfs(goalFn) {
  const W = $gameMap.width(), sx = $gamePlayer.x, sy = $gamePlayer.y;
  const key = (x, y) => y * W + x;
  const prev = new Map([[key(sx, sy), null]]);
  const q = [[sx, sy]];
  let n = 0;
  while (q.length && n++ < MAX_NODES) {
    const [x, y] = q.shift();
    if (goalFn(x, y)) {
      const steps = []; let k = key(x, y);
      while (prev.get(k)) { const p = prev.get(k); steps.push(p.d); k = p.from; }
      return { x, y, dirs: steps.reverse() };
    }
    for (const [d, dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!$gameMap.isValid(nx, ny) || prev.has(key(nx, ny))) continue;
      if (!$gamePlayer.canPass(x, y, d)) continue;
      prev.set(key(nx, ny), { from: key(x, y), d });
      q.push([nx, ny]);
    }
  }
  return null;
}

function runs(dirs) {
  const out = [];
  for (const d of dirs) { const r = out[out.length - 1]; if (r && r.d === d && r.n < 20) r.n++; else out.push({ d, n: 1 }); }
  return out;
}

ai.approach = async function (target, opts = {}) {
  ai.requireAction('walk');
  const t0 = Date.now();
  const tg = targetOf(target);
  const doInteract = opts.interact !== false && tg.eventId != null;
  const doRead = opts.read !== false;
  const adj = (x, y) => Math.abs(x - tg.x) + Math.abs(y - tg.y) === 1;
  const goal = tg.standOn ? (x, y) => x === tg.x && y === tg.y : adj;
  // A solid target that is also reachable by standing on it doesn't exist; a floor target that
  // can't be stood on (e.g. counter) falls back to adjacent.
  let plan = bfs(goal) || (tg.standOn ? bfs(adj) : null);
  if (!plan) return { reached: false, reason: 'no path (blocked)', target: tg, state: ai.getState() };

  const path = [];
  let stop = null, replans = 0;
  walking: for (;;) {
    for (const r of runs(plan.dirs)) {
      if (Date.now() - t0 > BUDGET_MS - 1500) { stop = 'budget'; break walking; }
      const w = await ai.walk(DIRNAME[r.d], r.n);
      path.push(...w.path);
      if (w.stop === 'state_changed' || w.stop === 'busy') { stop = w.stop; break walking; }
      if (w.stop === 'blocked') {
        // Something moved into the way (NPC): re-plan from here, at most twice.
        if (replans++ >= 2) { stop = 'blocked'; break walking; }
        plan = bfs(goal) || (tg.standOn ? bfs(adj) : null);
        if (!plan) { stop = 'blocked'; break walking; }
        continue walking;
      }
    }
    break;
  }
  const px = $gamePlayer.x, py = $gamePlayer.y;
  const reached = (px === tg.x && py === tg.y) || adj(px, py);
  const out = { reached, stop, path, target: { eventId: tg.eventId, name: tg.name, x: tg.x, y: tg.y } };
  if (!reached || stop) { out.state = ai.getState(); return out; }

  // Face the target when standing next to it.
  if (adj(px, py)) {
    const d = tg.x > px ? 6 : tg.x < px ? 4 : tg.y > py ? 2 : 8;
    if ($gamePlayer.direction() !== d) await ai.face(DIRNAME[d]);
  }
  if (!doInteract) { out.state = ai.getState(); return out; }

  const it = await ai.interact();
  out.interacted = { started: it.started, eventId: it.eventId };
  if (it.started && doRead) {
    const rd = await ai.readDialogue({ budgetMs: BUDGET_MS - (Date.now() - t0) });
    out.dialogue = rd.lines;
    out.dialogueDone = rd.done;
    out.state = rd.state;
  } else out.state = it.state || ai.getState();
  return out;
};
