// Build the in-game bridge as one script: parts are shipped inline, so it also works when the game
// runs on another machine (only CDP reaches it). Used for auto-injection and reload_bridge.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game');

export async function bridgeBundle() {
  const dir = path.join(GAME, 'parts');
  const names = (await readdir(dir)).filter(n => /^\d\d-.*\.js$/.test(n)).sort();
  const parts = await Promise.all(names.map(async name => ({ name, code: await readFile(path.join(dir, name), 'utf8') })));
  const bridge = await readFile(path.join(GAME, 'ai-bridge.js'), 'utf8');
  const hash = createHash('sha1').update(bridge).update(JSON.stringify(parts)).digest('hex').slice(0, 12);
  return { hash, code: `window.__AI_BRIDGE_PARTS = ${JSON.stringify(parts)};\n${bridge}\nwindow.__AI_BRIDGE_HASH = ${JSON.stringify(hash)};\n//# sourceURL=ai-bridge.js` };
}

// Inject the bridge if the page doesn't have it (remote game without linux-inject.js).
// Also replaces an older bridge the game loaded from its own disk (e.g. a stale copy on Windows):
// the page's bundle hash must match ours.
export async function ensureBridge(cdp) {
  const b = await bridgeBundle();
  const cur = await cdp.evaluate('window.__ai && window.__ai.parts && window.__ai.parts.length ? (window.__AI_BRIDGE_HASH || "disk") : null');
  if (cur === b.hash) return false;
  await cdp.evaluate(`(0, eval)(${JSON.stringify(b.code)}); true`);
  return cur ? 'replaced' : 'injected';
}

// Per-connection settings from env (also re-applied after restart's page reload).
export async function applyConfig(cdp) {
  const env = process.env;
  const view = Number(env.PMGT_VIEW_RADIUS || 0);
  if (view > 0) await cdp.evaluate(`window.__ai && __ai.vision && __ai.vision.set(${view}); true`);
  if (env.PMGT_BACKGROUND === '1') await cdp.evaluate('window.__ai && __ai.background && __ai.background(true); true');
  const size = /^(\d+)x(\d+)$/.exec(env.PMGT_WINDOW || '');
  if (size) await cdp.evaluate(`window.__ai && __ai.windowSize && __ai.windowSize(${size[1]}, ${size[2]}); true`);
  if (env.PMGT_BUDGET === '1') await cdp.evaluate('window.__ai && __ai.budget && __ai.budget.enable(true); true');
  if (env.PMGT_HUD === '1') await cdp.evaluate(`window.__ai && __ai.hud && __ai.hud.show(true, ${JSON.stringify(env.PMGT_HUD_LABEL || '')}); true`);
  // AI play mode: a game still on its boot screens (fresh launch) is started for the model, the
  // same way restart does it. Not awaited; the model sees BOOT and waits.
  if (env.PMGT_BUDGET === '1') {
    await cdp.evaluate(`(() => {
      const n = window.SceneManager && SceneManager._scene && SceneManager._scene.constructor.name;
      const boot = ['Scene_Boot', 'Scene_PMSplashScreen', 'Scene_Language_Selection', 'Scene_Title'];
      if (window.__ai && __ai.__newGame && boot.includes(n) && !window.__aiBooting) __ai.__newGame().catch(e => console.error('[ai] newGame', e));
      return n;
    })()`);
  }
}

// Fresh game: reload the page (all JS state gone; localStorage lessons survive), then a new game.
// NW.js does not re-run inject_js_start on reload, so the same inject script is registered to run
// at document start first (case-insensitive paths, Steam-less greenworks), as on a normal launch.
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function restartGame(cdp) {
  const inject = await readFile(path.join(GAME, '../runtime/linux-inject.js'), 'utf8');
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  const t0 = Date.now();
  try {
    await cdp.send('Page.reload', {});
    for (;;) {
      await sleep(500);
      try { if (await cdp.evaluate('!!(window.SceneManager && SceneManager._scene && window.$dataSystem)')) break; } catch (e) { /* context switching */ }
      if (Date.now() - t0 > 40000) throw new Error('TIMEOUT: game did not boot after reload');
    }
  } finally {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  }
  await ensureBridge(cdp);
  await applyConfig(cdp);
  // Pass the boot screens inside the page (not awaited: on slow machines it can take a minute,
  // longer than a client's request timeout). Wait up to 25 s for the first map.
  await cdp.evaluate('__ai.__newGame().catch(e => console.error("[ai] newGame", e)); true');
  let onMap = false;
  for (let i = 0; i < 50 && !onMap; i++) { await sleep(500); onMap = await cdp.evaluate('SceneManager._scene instanceof Scene_Map').catch(() => false); }
  const state = await cdp.evaluate('__ai.getState()');
  return {
    restarted: true, ms: Date.now() - t0, inGame: onMap,
    next: onMap ? 'New game started. Read the opening dialogue.' : 'Boot screens are being passed automatically; call wait until the game starts.',
    state,
  };
}
