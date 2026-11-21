// 05-devclock (lead): keeps the game loop running in hidden/occluded windows during development.
// Wayland/XWayland stops delivering requestAnimationFrame to windows that aren't visible, so a
// background game drops to ~2 fps. When rAF stalls, drive PIXI's ticker from setInterval instead
// (timers aren't throttled: game.sh starts NW.js with --disable-background-timer-throttling).
// Only active for instances started by scripts/game.sh (detected by its flags); the normal
// ./run-linux.sh launch (demo) is untouched.
const argv = (window.nw && nw.App && nw.App.argv) || [];
const enabled = argv.includes('--ai-dev-clock') || argv.includes('--disable-renderer-backgrounding');
if (window.__aiDevClock) { clearInterval(window.__aiDevClock); window.__aiDevClock = null; }
ai.devClock = { enabled, driven: 0 };
if (enabled) {
  let lastFrame = -1, stalled = 0;
  window.__aiDevClock = setInterval(() => {
    const t = window.Graphics && Graphics._app && Graphics._app.ticker;
    if (!t) return;
    if (Graphics.frameCount === lastFrame) {
      if (++stalled >= 2) { t.update(performance.now()); ai.devClock.driven++; }
    } else stalled = 0;
    lastFrame = Graphics.frameCount;
  }, 16);
}
