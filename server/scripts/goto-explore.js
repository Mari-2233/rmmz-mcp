#!/usr/bin/env node
// Dev helper: from any scene, start a NEW game and play through the prologue until the player
// can move in map 23 (mirror room). Uses raw engine calls only, so it works
// before the bridge has a state machine. ~1–3 minutes. Never saves.
//   PMGT_CDP_PORT=9334 node scripts/goto-explore.js
// If the game is on an error screen, crash evidence is saved first (~/.local/share/nwjs/crash/);
// it then exits 3: restart the instance with game.sh (never location.reload(), see below).
import { CdpClient } from '../src/cdp.js';

const cdp = new CdpClient({ port: Number(process.env.PMGT_CDP_PORT || 9333) });
const code = `(async () => {
  // Run token: the in-page loop outlives a client timeout, and two concurrent runs (two
  // setupNewGame/goto) corrupt the game (map 0, "Cannot read property 'undefined' of undefined").
  // A newer run takes over; older loops see the token change and exit.
  const token = Math.random(); window.__gotoExploreRun = token;
  const mine = () => window.__gotoExploreRun === token;
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  const sleep = async ms => { await _sleep(ms); if (!mine()) throw new Error('SUPERSEDED: a newer goto-explore run took over'); };
  await _sleep(600); // let an older loop notice and stop before we touch the game
  const until = async (p, ms) => { const t = Date.now(); while (!p()) { if (Date.now() - t > ms) return false; await sleep(50); } return true; };
  await until(() => window.DataManager && $dataSystem && SceneManager._scene, 60000);
  // Let splash/language scenes finish first, otherwise their own goto() overrides ours.
  const tb = Date.now();
  while (Date.now() - tb < 60000) {
    const n = SceneManager._scene && SceneManager._scene.constructor.name;
    if (n === 'Scene_Title' || n === 'Scene_Map' || n === 'Scene_Gameover') break;
    if (!SceneManager.isSceneChanging()) { Input._currentState.ok = true; await sleep(60); Input._currentState.ok = false; }
    await sleep(200);
  }
  // goto() calls stop() on the current scene, which crashes if that scene never finished starting.
  await until(() => !SceneManager.isSceneChanging() && SceneManager._scene && SceneManager._scene._started, 15000);
  // Never setupNewGame() while a Scene_Map is alive: it swaps $gameMap for an empty map 0 under the live
  // spriteset, and the next sprite update crashes in Game_Map.tilesetFlags (Last Error.txt, 04:24).
  if (!(SceneManager._scene instanceof Scene_Title)) {
    SceneManager.goto(Scene_Title);
    await until(() => SceneManager._scene instanceof Scene_Title && SceneManager._scene._started && !SceneManager.isSceneChanging(), 15000);
  }
  DataManager.setupNewGame(); SceneManager.goto(Scene_Map);
  await until(() => SceneManager._scene instanceof Scene_Map, 10000);
  const t0 = Date.now(); let stable = 0, presses = 0;
  while (Date.now() - t0 < 240000) {
    if (Video.isPlaying()) {
      // Skip like a natural end: pause, then fire the element's own 'ended' event (the engine and
      // plugins listen there). Don't seek near the end: the decoder can stall there with a white
      // frame and 'ended' never fires (white-screen freeze, 05:40).
      // Detach the engine's late handlers first: a load finishing later would show the video again
      // (onloadeddata -> play), and a late load failure throws LoadError (crash seen 10:01 on Linux).
      try {
        const v = Video._element;
        v.onloadeddata = null; v.onerror = null;
        v.pause(); Video._loading = false;
        v.dispatchEvent(new Event('ended'));
        if (Video._isVisible()) Video._onEnd();
        v.removeAttribute('src'); v.load(); // stop the background download
      } catch (e) {}
      await sleep(300); stable = 0; continue;
    }
    const sc = SceneManager._scene;
    const idle = sc instanceof Scene_Map && sc._started && !SceneManager.isSceneChanging() && !$gamePlayer.isTransferring()
      && $gamePlayer.canMove() && !$gameMap.isEventRunning() && !$gameMessage.isBusy();
    if (idle) { stable += 100; if (stable >= 2000) break; await sleep(100); continue; }
    stable = 0;
    if ($gameMessage.isChoice() && sc._choiceListWindow && sc._choiceListWindow.active) { const w = sc._choiceListWindow; w.select(0); w.processOk(); }
    Input._currentState.ok = true; await sleep(60); Input._currentState.ok = false; await sleep(90); presses++;
  }
  return { ok: stable >= 2000, presses, ms: Date.now() - t0, map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y,
           scene: SceneManager._scene && SceneManager._scene.constructor.name };
})()`;
try {
  // A crashed game is evidence: dump it first (01-crashlog part + screenshot), then stop.
  const crashed = await cdp.evaluate(`!!(window.Graphics && Graphics._errorPrinter && Graphics._errorPrinter.innerText.trim())`).catch(() => false);
  if (crashed) {
    const file = await cdp.evaluate(`window.__ai && __ai.dumpCrash ? __ai.dumpCrash('goto-explore found error screen') : null`).catch(e => `ERR ${e.message}`);
    try {
      const img = await cdp.screenshot({ scale: 0.5 });
      const shot = String(file || `/tmp/pmgt-crash-${Date.now()}.json`).replace(/\.json$/, '') + '.jpg';
      (await import('node:fs')).writeFileSync(shot, Buffer.from(img.data, 'base64'));
      console.error(`crash evidence: ${file} + ${shot}`);
    } catch (e) { console.error(`crash evidence: ${file} (screenshot failed: ${e.message})`); }
    // Don't location.reload(): a reloaded page loses linux-inject's path fixes (assets 404, seen 04:30).
    console.error(`game is on an error screen. Evidence saved. Restart it: scripts/game.sh stop ${process.env.PMGT_CDP_PORT || 9333} && scripts/game.sh start ${process.env.PMGT_CDP_PORT || 9333}`);
    process.exit(3);
  }
  const r = await cdp.evaluate(code, { timeoutMs: 300000 });
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
} catch (e) { console.error(`${e.code || 'ERROR'}: ${e.message}`); process.exitCode = 1; }
finally { cdp.close(); }
