// 10-state (A-state): main state machine (§3.2), snapshot getState() (§3.4), waitFor/waitIdle (B7).
// Per-frame computation with a 3-frame debounce.

const P = ai.PROFILE;
const IMMEDIATE = ['BOOT', 'TRANSFER', 'SCENE_CHANGING', 'VIDEO'];
const IDLE = ['EXPLORE', 'DIALOGUE', 'CHOICE', 'NUMBER_INPUT', 'ITEM_SELECT', 'GAME_OVER', 'OTHER_SCENE'];
const DEBOUNCE = 3;
const MAX_WAIT = 14500; // contract: every call ends within 15 s

const sw = id => { try { return !!$gameSwitches.value(id); } catch (e) { return false; } };
const sceneName = sc => (sc && sc.constructor ? sc.constructor.name : null);

// Running parallel map events (ids) and parallel common events (ids).
function parallelInfo() {
  const ev = [], ce = [];
  try {
    for (const e of $gameMap.events()) if (e && e._interpreter && e._interpreter.isRunning()) ev.push(e.eventId());
    for (const c of $gameMap._commonEvents || []) if (c && c._interpreter && c._interpreter.isRunning()) ce.push(c._commonEventId);
  } catch (e) { /* ignore */ }
  return { ev, ce };
}

// Raw (undebounced) state. Returns [state, blockedBy|null].
function computeRaw() {
  const SM = window.SceneManager;
  if (!SM) return ['BOOT', null];
  const sc = SM._scene;
  if (!sc || (window.Scene_Boot && sc instanceof Scene_Boot)) return ['BOOT', null];
  const isMap = window.Scene_Map && sc instanceof Scene_Map;
  // A transfer inside Scene_Map goes through goto(Scene_Map): report it as TRANSFER, not SCENE_CHANGING.
  if (isMap && window.$gamePlayer && ($gamePlayer.isTransferring() || SM._nextScene instanceof Scene_Map)) return ['TRANSFER', null];
  if (SM.isSceneChanging()) return ['SCENE_CHANGING', null];
  if ((window.Scene_Gameover && sc instanceof Scene_Gameover) || (isMap && sw(P.switches.gameOver))) return ['GAME_OVER', null];
  if (!isMap) return ['OTHER_SCENE', null];
  if ($gamePlayer.isTransferring() || !sc._started || sc._fadeDuration > 0) return ['TRANSFER', null];
  if (window.Video && Video.isPlaying()) return ['VIDEO', null];
  const m = $gameMessage;
  if (m.isChoice()) {
    const w = sc._choiceListWindow;
    if (w && w.active && w.isOpen()) return ['CHOICE', null];
  }
  if (m.isNumberInput()) return ['NUMBER_INPUT', null];
  if (m.isItemChoice()) return ['ITEM_SELECT', null];
  if (m.isBusy()) return ['DIALOGUE', null];
  if ($gameMap.isEventRunning()) return ['CUTSCENE', null];
  if ($gamePlayer.isMoveRouteForcing()) return ['FORCED_MOVE', null];
  if ($gamePlayer.isMoving()) return ['MOVING', null];
  if ($gamePlayer.canMove()) return ['EXPLORE', null];
  // BLOCKED: try to name the reason.
  let by = 'unknown';
  try {
    if ($gamePlayer.areFollowersGathering && $gamePlayer.areFollowersGathering()) by = 'followers_gathering';
    else {
      const p = parallelInfo();
      if (p.ev.length) by = 'parallel:' + p.ev.join(',');
      else if (p.ce.length) by = 'parallel_common:' + p.ce.join(',');
    }
  } catch (e) { /* ignore */ }
  return ['BLOCKED', by];
}

function safeRaw() {
  try { return computeRaw(); } catch (e) { return ['BOOT', 'error:' + e.message]; }
}

// Debounced state machine. Kept on window so hot reload does not reset it.
const S = (window.__aiStateMachine = window.__aiStateMachine || { committed: null, blockedBy: null, pending: null, count: 0, raw: null, frame: -1, since: 0 });

function commit(to, by) {
  const from = S.committed;
  S.committed = to;
  S.blockedBy = by;
  S.since = window.Graphics ? Graphics.frameCount : 0;
  if (from !== to) {
    const data = { from, to };
    if (to === 'BLOCKED') data.blockedBy = by;
    try { ai._log && ai._log.push('state', data); } catch (e) { /* ignore */ }
    if (!ai._log) util.notify('state', data);
  }
}

function step() {
  const [raw, by] = safeRaw();
  S.raw = raw;
  S.frame = window.Graphics ? Graphics.frameCount : S.frame + 1;
  if (S.committed === null) { commit(raw, by); S.pending = null; S.count = 0; return; }
  if (raw === S.committed) { S.pending = null; S.count = 0; if (raw === 'BLOCKED') S.blockedBy = by; return; }
  if (IMMEDIATE.includes(raw)) { commit(raw, by); S.pending = null; S.count = 0; return; }
  if (raw === S.pending) S.count++;
  else { S.pending = raw; S.count = 1; }
  if (S.count >= DEBOUNCE) { commit(raw, by); S.pending = null; S.count = 0; }
}

util.onFrame(step);

ai.currentState = function () {
  if (S.committed === null) step();
  return S.committed;
};
ai.rawState = () => safeRaw()[0];

// ---------- snapshot ----------

function stripCodes(t) {
  if (typeof t !== 'string') return t;
  return t
    .replace(/<br>/gi, '\n')
    .replace(/\x1bWrapBreak\[\d*\]/g, ' ')          // VisuMZ word wrap turns every space into this
    .replace(/[\x1b\\][A-Za-z]+\[[^\]]*\]/g, '')   // \C[2] \V[1] (raw or converted)
    .replace(/[\x1b\\][A-Za-z]+<[^>]*>/g, '')       // VisuMZ \n<Name> style
    .replace(/[\x1b\\][{}$.|!><^\\]/g, '')         // \{ \} \. \| \! ...
    .replace(/<\/?[A-Za-z][A-Za-z0-9 _:,\-]*>/g, '') // <WordWrap>, <center> ...
    .replace(/\x1b/g, '');
}

// Human-readable text: run the game's own escape conversion (speaker codes like "[ukG]" -> "????",
// "[ej]" -> "Enjel"; \N[n] -> actor name), then strip remaining control codes.
function cleanText(t) {
  if (typeof t !== 'string' || !t) return t;
  let s = t;
  try {
    const w = window.SceneManager && SceneManager._scene && SceneManager._scene._messageWindow;
    if (w && w.convertEscapeCharacters) s = w.convertEscapeCharacters(t);
  } catch (e) { s = t; }
  return stripCodes(s);
}
ai.cleanText = cleanText;

function evName(e) { try { return e.event().name; } catch (x) { return null; } }
function validPage(e) { return e && !e._erased && e._pageIndex >= 0 && !!e.page(); }

function facingInfo() {
  const px = $gamePlayer.x, py = $gamePlayer.y, d = $gamePlayer.direction();
  const x2 = $gameMap.roundXWithDirection(px, d), y2 = $gameMap.roundYWithDirection(py, d);
  const cands = $gameMap.eventsXy(x2, y2).filter(validPage);
  // Prefer same-as-characters priority (the ones the action button really hits first).
  cands.sort((a, b) => (b._priorityType === 1) - (a._priorityType === 1));
  const f = cands[0];
  const u = $gameMap.eventsXy(px, py).filter(e => validPage(e) && e._trigger === 0 && e._priorityType === 0)[0];
  return {
    facing: f ? { id: f.eventId(), name: evName(f) } : null,
    under: u ? { id: u.eventId(), name: evName(u) } : null,
  };
}

// Mirrors TDS Game_Player.checkPromptEventsProximity: closest isActiveProximityEvent(); shown when
// _proximityIconIndex >= 0. Fallback (no TDS): nearest valid trigger-0 event within distance 2.
function nearbyInfo() {
  const pl = $gamePlayer;
  const hasTds = typeof Game_Event.prototype.isActiveProximityEvent === 'function';
  let best = null, bestD = Infinity;
  for (const e of $gameMap.events()) {
    if (!validPage(e)) continue;
    const ok = hasTds ? e.isActiveProximityEvent() : e._trigger === 0;
    if (!ok) continue;
    const dist = $gameMap.distance(pl.x, pl.y, e.x, e.y);
    if (dist < bestD) { best = e; bestD = dist; }
  }
  if (!best) return null;
  if (hasTds ? !(pl._proximityIconIndex >= 0) : bestD > 2) return null;
  return { id: best.eventId(), name: evName(best), dist: bestD };
}

function messageInfo(state, sc) {
  if (state !== 'DIALOGUE' && state !== 'CHOICE') return null;
  const m = $gameMessage;
  let speaker = null;
  try { speaker = (m.speakerName && m.speakerName()) || null; } catch (e) { /* ignore */ }
  const out = { text: cleanText(m.allText()), speaker: speaker ? cleanText(speaker) || null : null };
  if (state === 'CHOICE') {
    const w = sc && sc._choiceListWindow;
    out.choices = w && w._list ? w._list.map(c => ({ index: c.ext, text: cleanText(c.name), enabled: !!c.enabled })) : [];
  }
  return out;
}

function interpreterInfo() {
  let i = $gameMap._interpreter;
  if (!i || !i.isRunning()) return null;
  const eventId = i._eventId;
  let depth = 0;
  while (i._childInterpreter && i._childInterpreter.isRunning() && depth < 10) { i = i._childInterpreter; depth++; }
  const cmd = i._list && i._list[i._index];
  return { eventId, index: i._index, code: cmd ? cmd.code : null, depth };
}

function flagsInfo(state) {
  const sws = P.switches;
  const chase = [].concat(sws.chase || []).some(sw);
  const p = parallelInfo();
  const pictures = [];
  try {
    for (const pic of $gameScreen._pictures) {
      if (pic && pic._name) { pictures.push(pic._name); if (pictures.length >= 10) break; }
    }
  } catch (e) { /* ignore */ }
  const f = {
    puzzle: sw(sws.puzzleStart) && !sw(sws.puzzleFinish),
    qte: sw(sws.qte),
    chase,
    parallel: p.ev,
    parallelCommon: p.ce,
    pictures,
  };
  if (state === 'BLOCKED') f.blockedBy = S.blockedBy;
  return f;
}

ai.getState = function () {
  const state = ai.currentState();
  const sc = window.SceneManager ? SceneManager._scene : null;
  const snap = {
    seq: ai._log ? ai._log.latest() : 0,
    frame: window.Graphics ? Graphics.frameCount : null,
    state,
    scene: sceneName(sc),
    flags: {},
    map: null, player: null, facing: null, under: null, nearby: null,
    message: null, interpreter: null,
    allowed_actions: ai.allowedActions(state),
  };
  const onMap = window.Scene_Map && sc instanceof Scene_Map && window.$gameMap && $gameMap.mapId() > 0;
  if (!window.$gameMap || !window.$gameSwitches) return snap;
  try { snap.flags = flagsInfo(state); } catch (e) { snap.flags = { error: e.message }; }
  if (!onMap) return snap;
  try {
    const id = $gameMap.mapId();
    snap.map = { id, name: ($dataMapInfos[id] && $dataMapInfos[id].name) || null, w: $gameMap.width(), h: $gameMap.height(), level: $gameMap.currentMapLevel ?? null };
    snap.player = { x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() };
    if (state !== 'TRANSFER') {
      Object.assign(snap, facingInfo());
      snap.nearby = nearbyInfo();
    }
    snap.message = messageInfo(state, sc);
    snap.interpreter = interpreterInfo();
  } catch (e) { snap.error = e.message; }
  return snap;
};

// ---------- waiting (B7) ----------

async function waitStates(set, timeoutMs) {
  const t = Math.max(0, Math.min(Number(timeoutMs) || 10000, MAX_WAIT));
  const start = Date.now();
  for (;;) {
    const s = ai.currentState();
    // Also require the raw state to agree, so a just-triggered change (debounce pending) is not missed.
    if (set.includes(s) && ai.rawState() === s) return { ok: true, waitedMs: Date.now() - start, state: ai.getState() };
    if (Date.now() - start >= t) return { ok: false, waitedMs: Date.now() - start, state: ai.getState() };
    await Promise.race([util.nextFrame(), util.sleep(50)]);
  }
}

ai.waitFor = function (states, timeoutMs = 10000) {
  const set = [].concat(states || []);
  if (!set.length) throw new Error('BAD_ARGS: states must be a non-empty list');
  const bad = set.filter(s => !ai.STATES.includes(s));
  if (bad.length) throw new Error('BAD_ARGS: unknown state(s) ' + bad.join(','));
  return waitStates(set, timeoutMs);
};

ai.waitIdle = function (timeoutMs = 10000) {
  return waitStates(IDLE, timeoutMs);
};
ai.IDLE_STATES = IDLE;
