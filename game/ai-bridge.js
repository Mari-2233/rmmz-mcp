// In-game bridge: defines window.__ai, called by the MCP server through CDP (Runtime.evaluate).
// Loaded before game scripts by linux-inject.js (inject_js_start); can be hot-reloaded with the
// dev tool `reload_bridge`, so everything here must be idempotent.
// Runs in Chromium 85 / Node 14 (NW.js 0.48): no Array.prototype.at, no structuredClone.
//
// Scaffold only: generic utilities. Game logic (state machine, actions) is written during the
// competition window.
(function () {
  'use strict';

  // Originals survive hot reloads, so re-wrapping always starts from the game's own function.
  const ORIG = (window.__aiOriginals = window.__aiOriginals || new Map());

  // Wrap obj[name] once. `make(orig)` returns the replacement. Safe to call again after reload.
  function wrap(obj, name, make, key) {
    const k = key || name;
    if (!ORIG.has(k)) ORIG.set(k, { obj, name, fn: obj[name] });
    const orig = ORIG.get(k).fn;
    obj[name] = make(orig);
    return orig;
  }

  // Restore every wrapped function (used before reload).
  function unwrapAll() {
    for (const { obj, name, fn } of ORIG.values()) obj[name] = fn;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Resolve on the next game frame (after SceneManager.updateMain). Falls back to rAF.
  const frameWaiters = [];
  function nextFrame() {
    return new Promise(r => frameWaiters.push(r));
  }

  // Poll `pred` once per frame until truthy or timeout. Resolves { ok, value, frames }.
  async function waitUntil(pred, timeoutMs = 10000) {
    const start = Date.now();
    let frames = 0;
    for (;;) {
      let v;
      try { v = pred(); } catch (e) { v = false; }
      if (v) return { ok: true, value: v, frames };
      if (Date.now() - start > timeoutMs) return { ok: false, frames };
      await nextFrame();
      frames++;
    }
  }

  // Push an event to the MCP server (binding exists only while the server is connected).
  function notify(type, data) {
    if (typeof window.__aiNotify === 'function') {
      try { window.__aiNotify(JSON.stringify({ type, data, frame: window.Graphics ? Graphics.frameCount : null })); } catch (e) { /* ignore */ }
    }
  }

  // Per-frame hooks: functions registered here run at the end of every SceneManager.updateMain.
  const frameHooks = [];
  function onFrame(fn) { frameHooks.push(fn); }

  function installFrameHook() {
    if (typeof SceneManager === 'undefined') return false;
    wrap(SceneManager, 'updateMain', orig => function () {
      orig.apply(this, arguments);
      for (const fn of frameHooks) { try { fn(); } catch (e) { console.error('[ai-bridge] frame hook', e); } }
      const waiters = frameWaiters.splice(0);
      for (const r of waiters) r();
    });
    return true;
  }

  // Game scripts aren't loaded yet when inject_js_start runs; install hooks once they are.
  function whenGameReady(cb) {
    if (typeof SceneManager !== 'undefined' && typeof Scene_Boot !== 'undefined') return cb();
    window.addEventListener('load', cb, { once: true });
  }

  if (window.__ai && window.__ai.__unwrapAll) window.__ai.__unwrapAll();

  window.__ai = {
    version: '0.1.0',
    loadedAt: Date.now(),
    util: { wrap, sleep, nextFrame, waitUntil, notify, onFrame, ready: whenGameReady },
    __unwrapAll: unwrapAll,

    ping() {
      return { ok: true, version: this.version, parts: this.parts, scene: window.SceneManager && SceneManager._scene ? SceneManager._scene.constructor.name : null };
    },

    // Game API is added by parts/*.js.
  };

  // Load parts/NN-name.js in file-name order. Each part is the body of `function (ai, util)`.
  // Parts are re-read from disk on every (re)load, so editing a part + reload_bridge is enough.
  window.__ai.parts = [];
  try {
    const fs = require('fs'), path = require('path');
    const dir = window.__AI_BRIDGE_DIR || path.join(process.cwd(), 'mcp-mod', 'game', 'parts');
    for (const f of fs.readdirSync(dir).filter(n => /^\d\d-.*\.js$/.test(n)).sort()) {
      try {
        const fn = (0, eval)('(function (ai, util) {\n' + fs.readFileSync(path.join(dir, f), 'utf8') + '\n})\n//# sourceURL=parts/' + f);
        fn(window.__ai, window.__ai.util);
        window.__ai.parts.push(f);
      } catch (e) {
        console.error('[ai-bridge] part failed', f, e);
        window.__ai.parts.push(f + ' (FAILED: ' + e.message + ')');
      }
    }
  } catch (e) { console.error('[ai-bridge] parts loader', e); }

  whenGameReady(() => {
    installFrameHook();
    notify('bridge_loaded', { version: window.__ai.version });
  });
})();
