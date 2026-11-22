// 05-devclock (lead): keeps the game loop running in hidden/occluded windows during development.
// Wayland/XWayland stops delivering requestAnimationFrame to windows that aren't visible, so a
// background game drops to ~2 fps. When rAF stalls, drive PIXI's ticker from setInterval instead
// (timers aren't throttled: game.sh starts NW.js with --disable-background-timer-throttling).
// Only active for instances started by scripts/game.sh (detected by its flags); the normal
// ./run-linux.sh launch (demo) is untouched.
const argv = (window.nw && nw.App && nw.App.argv) || [];
const byFlag = argv.includes('--ai-dev-clock') || argv.includes('--disable-renderer-backgrounding');
if (window.__aiDevClock) { clearInterval(window.__aiDevClock); window.__aiDevClock = null; }
const prevOn = !!(window.__aiDevClockOn);
ai.devClock = { enabled: false, driven: 0, enable };
function enable(on = true) {
  if (window.__aiDevClock) { clearInterval(window.__aiDevClock); window.__aiDevClock = null; }
  ai.devClock.enabled = window.__aiDevClockOn = !!on;
  if (!on) return false;
  let lastFrame = -1, stalled = 0;
  window.__aiDevClock = setInterval(() => {
    const t = window.Graphics && Graphics._app && Graphics._app.ticker;
    if (!t) return;
    if (Graphics.frameCount === lastFrame) {
      if (++stalled >= 2) { t.update(performance.now()); ai.devClock.driven++; }
    } else stalled = 0;
    lastFrame = Graphics.frameCount;
  }, 16);
  return true;
}
if (byFlag || prevOn) enable(true);

// Background mode (remote play): keep running without focus and while minimized.
// VisuMZ CoreEngine "RequireFocus" makes SceneManager.isGameActive() false on blur, which freezes
// the game; we answer true while background mode is on. Also drives frames when rAF stops.
ai.background = function (on = true) {
  window.__aiBackground = !!on;
  if (on) enable(true);
  return { background: window.__aiBackground, devClock: ai.devClock.enabled };
};
util.ready(() => {
  util.wrap(SceneManager, 'isGameActive', orig => function () {
    return window.__aiBackground ? true : orig.apply(this, arguments);
  }, '05-devclock:SceneManager.isGameActive');
});

// Resize the game window (the canvas scales itself). Returns the new outer size.
ai.windowSize = function (w, h) {
  const win = window.nw && nw.Window && nw.Window.get();
  if (!win) throw new Error('UNSUPPORTED: not running in NW.js');
  w = Math.max(320, Math.min(3840, Math.round(Number(w))));
  h = Math.max(240, Math.min(2160, Math.round(Number(h))));
  win.resizeTo(w, h);
  return { w, h };
};
