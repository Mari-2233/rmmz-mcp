// 75-pause (lead): turn-based play for a model that thinks for seconds between moves.
// Auto-pause: while the model is thinking the game is frozen — no frames (events, enemies, timers,
// play time), sound and movies paused, gsap tweens paused. An action tool unfreezes it for exactly
// as long as the action runs, then it freezes again. Like a player pausing the game to think.
// Off until ai.pause.auto(true) — the MCP server turns it on with PMGT_AUTOPAUSE=1.
// Never frozen while the boot screens are being passed (__newGame runs as an action).
//   ai.pause.auto(on)  ai.pause.status()  ai.pause.freeze() / ai.pause.thaw() (dev)
//
// Sprint: walk / approach accept {run} (default true): the player holds dash, as most people do.
const P = (window.__aiPause = window.__aiPause || { auto: false, frozen: false, depth: 0, frozenMs: 0, since: 0 });
P.depth = 0; // a hot reload never happens mid-action

// Movies created by the game (MZ Video and any <video> made by plugins).
const VIDEOS = (window.__aiVideos = window.__aiVideos || new Set());
if (!document.createElement.__aiVideo) {
  const make = document.createElement;
  document.createElement = function (tag) {
    const el = make.apply(this, arguments);
    if (String(tag).toLowerCase() === 'video') VIDEOS.add(el);
    return el;
  };
  document.createElement.__aiVideo = true;
}

let paused = []; // what we paused, so thaw resumes only that
function setFrozen(on) {
  if (on === P.frozen) return;
  P.frozen = on;
  try {
    if (on) {
      P.since = Date.now();
      paused = [];
      const vids = new Set(VIDEOS);
      if (window.Video && Video._element) vids.add(Video._element);
      for (const v of vids) if (v && !v.paused && !v.ended) { v.pause(); paused.push(v); }
      if (window.WebAudio && WebAudio._context && WebAudio._context.state === 'running') WebAudio._context.suspend();
      if (window.gsap && gsap.globalTimeline) gsap.globalTimeline.pause();
    } else {
      P.frozenMs += Date.now() - P.since;
      for (const v of paused) { try { v.play(); } catch (e) { /* ignore */ } }
      paused = [];
      if (window.WebAudio && WebAudio._context && WebAudio._context.state === 'suspended') WebAudio._context.resume();
      if (window.gsap && gsap.globalTimeline) gsap.globalTimeline.resume();
    }
  } catch (e) { console.error('[ai] pause', e); }
}
const idle = () => P.auto && P.depth === 0 && !window.__aiBooting;
// Don't freeze in the middle of a scene change (e.g. the save menu the AI mode is closing):
// let the game finish it first, then freeze (at most ~3 s).
const unsettled = () => {
  try {
    const sc = SceneManager._scene;
    return !!(SceneManager._nextScene || SceneManager.isSceneChanging() || (sc && !sc._started) ||
      (window.Scene_Save && sc instanceof Scene_Save) ||
      (ai.rawState && ai.currentState() !== ai.rawState())); // debounced state still catching up
  } catch (e) { return false; }
};
let settleTimer = null;
function freezeWhenSettled(t0 = Date.now()) {
  clearTimeout(settleTimer); settleTimer = null;
  if (!idle()) return;
  if (unsettled() && Date.now() - t0 < 3000) { setFrozen(false); settleTimer = setTimeout(() => freezeWhenSettled(t0), 100); return; }
  setFrozen(true);
}

util.ready(() => {
  // No game frames while frozen; the canvas keeps rendering (the HUD and picture stay up).
  util.wrap(SceneManager, 'determineRepeatNumber', orig => function () {
    const n = orig.apply(this, arguments);
    return P.frozen ? 0 : n;
  }, '75-pause:SceneManager.determineRepeatNumber');
  // Sprint while an AI move asks for it.
  util.wrap(Game_Player.prototype, 'isDashButtonPressed', orig => function () {
    return window.__aiRun ? true : orig.apply(this, arguments);
  }, '75-pause:Game_Player.isDashButtonPressed');
});

ai.pause = {
  auto(on = true) { P.auto = !!on; if (idle()) freezeWhenSettled(); else setFrozen(false); return ai.pause.status(); },
  freeze() { setFrozen(true); return ai.pause.status(); },
  thaw() { setFrozen(false); return ai.pause.status(); },
  status() { return { auto: P.auto, frozen: P.frozen, frozen_s: Math.round((P.frozenMs + (P.frozen ? Date.now() - P.since : 0)) / 1000) }; },
};

// Actions run the game; reads never do. Outermost wrapper (loaded after 60/65/66).
const RUN_ARG = { walk: 2, approach: 1 }; // index of the opts argument carrying {run}
const ACTIONS = ['walk', 'face', 'interact', 'advance', 'choose', 'approach', 'readDialogue',
  'useItemOn', 'pickItem', 'waitFor', 'waitIdle', '__newGame'];
for (const name of ACTIONS) {
  const base = ai[name];
  if (typeof base !== 'function' || base.__paused) continue;
  const fn = async function (...args) {
    // Only the outermost action sets dash (approach's inner walks keep approach's choice).
    const ri = P.depth === 0 ? RUN_ARG[name] : null;
    P.depth++;
    setFrozen(false);
    const prevRun = window.__aiRun;
    if (ri != null) {
      window.__aiRun = !(args[ri] && args[ri].run === false);
      try { if (window.$gamePlayer && !$gamePlayer.isMoving()) $gamePlayer.updateDashing(); } catch (e) { /* ignore */ }
    }
    try { return await base.apply(this, args); } finally {
      if (ri != null) window.__aiRun = prevRun;
      P.depth = Math.max(0, P.depth - 1);
      if (idle()) freezeWhenSettled();
    }
  };
  fn.__paused = true;
  ai[name] = fn;
}

// The snapshot says when the world is paused for the model.
if (ai.getState && !ai.getState.__paused) {
  const base = ai.getState;
  ai.getState = function () {
    const s = base.apply(this, arguments);
    if (P.auto) s.paused = P.frozen;
    return s;
  };
  ai.getState.__paused = true;
}
