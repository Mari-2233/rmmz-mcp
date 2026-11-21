// 40-actions (C-actions): walk / face / interact / advance / choose.
// Works with or without 10-state.js: when ai.currentState() is 'UNKNOWN' we fall back to raw checks.

const MAX_MS = 14000; // keep every call under the 15 s contract

const hasA = () => typeof ai.getState === 'function' && ai.currentState() !== 'UNKNOWN';

function rawState() {
  return {
    state: 'UNKNOWN',
    map: $gameMap.mapId(),
    player: { x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() },
    busy: $gameMap.isEventRunning() || $gameMessage.isBusy(),
  };
}
function snap() {
  try { return hasA() ? ai.getState() : rawState(); } catch (e) { return rawState(); }
}

// Explore-equivalent check (used between walk steps and after interact).
// Uses the UNdebounced raw state when 10-state provides it (committed state lags 3 frames and
// stays MOVING across consecutive steps).
function canAct() {
  if (hasA()) return (ai.rawState ? ai.rawState() : ai.currentState()) === 'EXPLORE';
  return $gamePlayer.canMove() && !$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$gamePlayer.isTransferring();
}

// Events on the tile the player faces (helps the AI when interact does nothing).
function facingInfo() {
  const d = $gamePlayer.direction();
  const x = $gameMap.roundXWithDirection($gamePlayer.x, d);
  const y = $gameMap.roundYWithDirection($gamePlayer.y, d);
  const events = $gameMap.eventsXy(x, y).map(e => ({
    id: e.eventId(), name: e.event().name, page: e._pageIndex, trigger: e.page() ? e._trigger : null,
  }));
  return { dir: d, x, y, events };
}

// Wait out a tiny MOVING window so back-to-back calls don't fail spuriously.
async function settleMoving() {
  if ($gamePlayer.isMoving() || (hasA() && ai.currentState() === 'MOVING')) {
    await util.waitUntil(() => !$gamePlayer.isMoving() && !(hasA() && ai.currentState() === 'MOVING'), 1000);
  }
}

async function frames(n) { for (let i = 0; i < n; i++) await util.nextFrame(); }

// ---------------------------------------------------------------- walk
ai.walk = async function (dir, n = 1) {
  const d = ai.dirNum(dir);
  n = Number(n);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('BAD_ARGS: n must be an integer 1..20');
  await settleMoving();
  ai.requireAction('walk');
  const t0 = Date.now();
  const path = [];
  let stop = null;
  for (let i = 0; i < n; i++) {
    const w = await util.waitUntil(() => !$gamePlayer.isMoving(), MAX_MS - (Date.now() - t0));
    if (!w.ok) { stop = 'busy'; break; }
    if (!canAct()) { stop = hasA() ? 'state_changed' : 'busy'; break; }
    $gamePlayer.executeMove(d);
    if (!$gamePlayer.isMovementSucceeded()) {
      // Bumping a touch-trigger event can start it (checkEventTriggerTouchFront).
      await frames(2);
      stop = canAct() ? 'blocked' : 'state_changed';
      break;
    }
    path.push([$gamePlayer.x, $gamePlayer.y]);
    if (Date.now() - t0 > MAX_MS) { stop = 'busy'; break; }
  }
  if (stop === null) {
    await util.waitUntil(() => !$gamePlayer.isMoving(), Math.max(200, MAX_MS - (Date.now() - t0)));
    await frames(2); // let touch / here triggers start
    if (!canAct()) stop = 'state_changed';
  }
  await settleMoving(); // let the debounced state catch up so the snapshot isn't a stale MOVING
  return { moved: path.length, path, stop, state: snap() };
};

// ---------------------------------------------------------------- face
ai.face = async function (dir) {
  const d = ai.dirNum(dir);
  await settleMoving();
  ai.requireAction('face');
  $gamePlayer.setDirection(d);
  // Same refresh TDS does after executeMove (Interact prompt / _proximityIconIndex).
  if ($gamePlayer.checkPromptEventsProximity) $gamePlayer.checkPromptEventsProximity();
  await util.nextFrame();
  return { facing: facingInfo(), state: snap() };
};

// ---------------------------------------------------------------- interact
// Equivalent of the confirm key in Game_Player.triggerButtonAction (without needing Input).
function startButtonEvent() {
  $gamePlayer.checkEventTriggerHere([0]);
  if ($gameMap.setupStartingEvent()) return true;
  $gamePlayer.checkEventTriggerThere([0, 1, 2]);
  return $gameMap.setupStartingEvent();
}

// After an event was set up: grab its id, then give the state up to 30 frames to leave EXPLORE.
async function afterStart(started) {
  if (!started) return { started: false, eventId: null, facing: facingInfo(), state: snap() };
  const eventId = $gameMap._interpreter.eventId() || null;
  await util.waitUntil(() => (hasA() ? ai.currentState() !== 'EXPLORE' : !canAct()), 500);
  return { started: true, eventId, state: snap() };
}
ai.__afterStart = afterStart; // shared with 45-items

ai.interact = async function () {
  await settleMoving();
  ai.requireAction('interact');
  return afterStart(startButtonEvent());
};

// ---------------------------------------------------------------- advance
function msgWindow() {
  const s = SceneManager._scene;
  return s && s._messageWindow;
}
// Something the AI would perceive as "the screen changed".
function signature() {
  const w = msgWindow();
  return JSON.stringify([
    hasA() ? ai.currentState() : null,
    $gameMessage.allText(),
    $gameMessage.isChoice(),
    !!(w && w._textState),
    !!(w && w.pause),
    $gameMap._interpreter._index,
    $gameMap._interpreter.eventId(),
  ]);
}
function typing() {
  const w = msgWindow();
  return !!(w && (w._textState || w.isOpening() || w.isClosing()));
}
// While our simulated OK is held, the player must not "press OK" on the map: if the cutscene ends
// mid-press, Game_Player.triggerButtonAction would re-start the event in front (seen with door 3).
let suppressPlayerOk = false;
util.ready(() => {
  util.wrap(Game_Player.prototype, 'triggerButtonAction', orig => function () {
    if (suppressPlayerOk) return false;
    return orig.apply(this, arguments);
  }, '40-actions:Game_Player.triggerButtonAction');
});
async function pressOk() {
  const key = ai.PROFILE.okKey || 'ok';
  suppressPlayerOk = true;
  try {
    Input._currentState[key] = true;
    await frames(2);
    Input._currentState[key] = false;
    await frames(2);
  } finally { suppressPlayerOk = false; }
}

ai.advance = async function () {
  ai.requireAction('advance');
  const t0 = Date.now();
  const before = signature();
  // A press can be swallowed (e.g. right after a message window opens, or during a \\. wait):
  // if nothing reacts within 500 ms, press again (at most 3 presses, ~1.5 s total).
  let presses = 0, reacted = false;
  while (presses < 3 && !reacted) {
    await pressOk();
    presses++;
    reacted = (await util.waitUntil(() => signature() !== before, 500)).ok;
  }
  // Then let the message window settle (not typing/opening/closing), within the budget.
  if (reacted) await util.waitUntil(() => !typing(), Math.max(100, 1500 - (Date.now() - t0)));
  if (typing() && msgWindow() && msgWindow()._textState) {
    // Still typing: one more press shows the rest of the page.
    await pressOk();
    await util.waitUntil(() => !typing(), 500);
  }
  return { changed: signature() !== before, presses, waitedMs: Date.now() - t0, state: snap() };
};

// ---------------------------------------------------------------- choose
// §4.1 U1 method A. `index` is the ORIGINAL choice index (ext), hidden choices are not in _list.
// Never use $gameMessage.onChoice (hangs the message window).
ai.choose = async function (index) {
  index = Number(index);
  if (!Number.isInteger(index) || index < 0) throw new Error('BAD_ARGS: index must be a non-negative integer');
  // The choice window opens a few frames after the message (state is still DIALOGUE meanwhile).
  const choicePending = () => {
    if ($gameMessage.isChoice()) return true;
    const it = $gameMap._interpreter, c = it._list && it._list[it._index];
    return !!(c && c.code === 102); // 102 waits for the previous message window to close
  };
  if (hasA() && ai.currentState() !== 'CHOICE' && choicePending()) {
    await util.waitUntil(() => ai.currentState() === 'CHOICE' || !choicePending(), 3000);
  }
  ai.requireAction('choose');
  const getW = () => SceneManager._scene && SceneManager._scene._choiceListWindow;
  const ready = await util.waitUntil(() => { const w = getW(); return w && w.active && w.isOpen(); }, 1000);
  if (!ready.ok) throw new Error('INVALID_STATE: no active choice window');
  const w = getW();
  const list = w._list || [];
  const hasExt = list.some(c => c.ext !== undefined && c.ext !== null);
  const k = hasExt ? list.findIndex(c => c.ext === index) : (index < list.length ? index : -1);
  const visible = list.map(c => ({ index: hasExt ? c.ext : list.indexOf(c), name: c.name, enabled: c.enabled }));
  if (k < 0) throw new Error(`NOT_FOUND: choice ${index} hidden or missing; visible: ${JSON.stringify(visible)}`);
  if (!list[k].enabled) throw new Error(`INVALID_STATE: choice ${index} disabled`);
  w.select(k);
  w.processOk();
  await util.waitUntil(() => (hasA() ? ai.currentState() !== 'CHOICE' : !$gameMessage.isChoice()), 1000);
  return { chosen: index, name: list[k].name, state: snap() };
};
