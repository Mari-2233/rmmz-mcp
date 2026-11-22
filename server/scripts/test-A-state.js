#!/usr/bin/env node
// NOTE: this test uses DEV FIXTURE (cheat) setup (teleport / give items / set variables) to reach
// test situations quickly. Allowed in tests only; the demo must use real play progress (README: 公平性).
// State machine acceptance tests. Starts a NEW game via goto-explore.js (never saves).
//   PMGT_CDP_PORT=9334 node scripts/test-A-state.js [--skip-boot]
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CdpClient } from '../src/cdp.js';
import { BRIDGE_PATH } from '../src/tools/dev.js';

const PORT = Number(process.env.PMGT_CDP_PORT || 9334);
const here = path.dirname(fileURLToPath(import.meta.url));
const cdp = new CdpClient({ port: PORT });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = (expr, timeoutMs = 20000) => cdp.evaluate(expr, { timeoutMs });
const call = (m, args = []) => cdp.callBridge(m, args, { timeoutMs: 20000 });
let fails = 0;
const check = (name, ok, info) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' — ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`);
  if (!ok) fails++;
};
const reload = async () => {
  const code = await readFile(BRIDGE_PATH, 'utf8');
  await ev(`(0, eval)(${JSON.stringify(code + '\n//# sourceURL=ai-bridge.js')}); true`);
  return call('ping');
};
const pressOk = `(async()=>{Input._currentState.ok=true;await new Promise(r=>setTimeout(r,60));Input._currentState.ok=false;await new Promise(r=>setTimeout(r,60));return true})()`;

// Play out the current event: advance dialogue / pick first choice until idle EXPLORE.
async function finishEvent(maxSteps = 60) {
  for (let i = 0; i < maxSteps; i++) {
    const w = await call('waitIdle', [5000]);
    const s = w.state.state;
    if (s === 'EXPLORE') return w.state;
    if (s === 'CHOICE') await ev(`(()=>{const w=SceneManager._scene._choiceListWindow;w.select(0);w.processOk();return 1})()`);
    else await ev(pressOk);
  }
  return call('getState');
}

try {
  const p0 = await reload();
  check('parts load without FAILED', !p0.parts.some(p => p.includes('FAILED')), p0.parts);

  // 1. state sequence during goto-explore
  if (!process.argv.includes('--skip-boot')) {
    // Record crash stacks (the game loop stops silently on exceptions).
    await ev(`(()=>{ if (!SceneManager.__aiTestCatch) { const o = SceneManager.catchException; SceneManager.catchException = function (e) { window.__aiTestErr = String(e && e.stack || e); return o.apply(this, arguments); }; SceneManager.__aiTestCatch = 1; } return 1; })()`);
    // goto-explore's setupNewGame() while a Scene_Map is live can crash the engine: start from the title.
    if (await ev('SceneManager._scene instanceof Scene_Map')) {
      await ev(`(async()=>{ SceneManager.goto(Scene_Title); const t=Date.now(); while(!(SceneManager._scene instanceof Scene_Title && !SceneManager.isSceneChanging()) && Date.now()-t<15000) await new Promise(r=>setTimeout(r,100)); return 1; })()`);
    }
    const seq0 = await ev('__ai._log.latest()');
    const child = spawn(process.execPath, [path.join(here, 'goto-explore.js')], { env: { ...process.env, PMGT_CDP_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; child.stdout.on('data', d => { out += d; });
    const done = new Promise(r => child.on('exit', r));
    const samples = []; let finished = false; done.then(() => { finished = true; });
    while (!finished) { try { samples.push(await ev('__ai.currentState()', 3000)); } catch (e) { samples.push('ERR'); } await sleep(100); }
    console.log('goto-explore:', out.trim());
    const err = await ev('window.__aiTestErr || null'); if (err) console.log('ENGINE ERROR:', err.slice(0, 1500));
    const runs = [];
    for (const s of samples) { if (runs.length && runs[runs.length - 1][0] === s) runs[runs.length - 1][1]++; else runs.push([s, 1]); }
    console.log('sampled runs:', runs.map(([s, n]) => `${s}x${n}`).join(' '));
    // Frame-exact view from the log.
    const log = await call('getLog', [seq0, ['state'], 500]);
    const st = log.entries;
    let shortRuns = 0; const shortList = [];
    for (let i = 0; i + 1 < st.length; i++) {
      const len = st[i + 1].frame - st[i].frame;
      const imm = ['TRANSFER', 'SCENE_CHANGING', 'VIDEO', 'BOOT'];
      // len < 0: setupNewGame resets Graphics.frameCount. A short run cut off by an immediate state is legit.
      if (len >= 0 && len < 3 && !imm.includes(st[i].data.to) && !imm.includes(st[i + 1].data.to)) { shortRuns++; shortList.push(`${st[i].data.to}@${st[i].frame}(${len}f)`); }
    }
    check('1a no sub-3-frame debounced states', shortRuns === 0, shortList.slice(0, 10).join(' ') || `${st.length} transitions`);
    const transientExplore = runs.slice(0, -1).filter(([s, n]) => s === 'EXPLORE' && n <= 2).length;
    check('1b no transient EXPLORE (<=200ms) before the end', transientExplore === 0, `transient=${transientExplore}`);
    const final = await call('currentState');
    check('1c final EXPLORE', final === 'EXPLORE', final);
    check('1d saw TRANSFER', samples.includes('TRANSFER') || st.some(e => e.data.to === 'TRANSFER'));
  }

  // 2. explore snapshot / facing / nearby
  let s = await call('getState');
  check('2a allowed_actions has walk', s.state === 'EXPLORE' && s.allowed_actions.includes('walk'), { state: s.state, allowed: s.allowed_actions, p: s.player });
  await ev(`(async()=>{ if ($gamePlayer.x===19 && $gamePlayer.y===12) $gamePlayer.executeMove(8); else $gamePlayer.setDirection(8);
    while ($gamePlayer.isMoving()) await new Promise(r=>setTimeout(r,16)); return [$gamePlayer.x,$gamePlayer.y]; })()`);
  await call('waitIdle', [3000]);
  s = await call('getState');
  check('2b facing.id === 9', s.facing && s.facing.id === 9, { player: s.player, facing: s.facing });
  check('2c nearby non-null', !!s.nearby, s.nearby);

  // 3. mirror dialogue
  const seq3 = s.seq;
  await ev(`$gamePlayer.checkEventTriggerThere([0,1,2]); $gameMap.setupStartingEvent()`);
  const w3 = await call('waitFor', [['DIALOGUE', 'CHOICE'], 8000]);
  check('3a state DIALOGUE', w3.ok && w3.state.state === 'DIALOGUE', w3.state.state);
  check('3b message mentions mirror', /mirror/i.test(w3.state.message?.text || ''), w3.state.message);
  check('3c allowed_actions only dialogue actions', JSON.stringify([...w3.state.allowed_actions].sort()) === '["advance","read_dialogue"]', w3.state.allowed_actions);
  const end3 = await finishEvent();
  check('3d back to EXPLORE', end3.state === 'EXPLORE', end3.state);

  // 4. log order
  const lg = await call('getLog', [seq3, null, 200]);
  const types = lg.entries.map(e => e.type);
  const iS = types.indexOf('event_start'), iM = types.indexOf('message'), iE = types.lastIndexOf('event_end');
  check('4 event_start -> message -> event_end', iS >= 0 && iM > iS && iE > iM && types.includes('state'), types.join(','));

  // 5. transfer + waitIdle
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  const w5 = await ev(`(async()=>{ $gamePlayer.reserveTransfer(23,18,12,2,0); const r = await __ai.waitIdle(10000);
    return { ok: r.ok, state: r.state.state, ms: r.waitedMs, fade: SceneManager._scene._fadeDuration, started: SceneManager._scene._started, p: [$gamePlayer.x,$gamePlayer.y] }; })()`);
  check('5 waitIdle after transfer: EXPLORE, fade done', w5.ok && w5.state === 'EXPLORE' && w5.fade === 0 && w5.started && w5.p[0] === 18, w5);

  // 6. reload twice, repeat 3 and check no duplicate entries
  await reload(); const p6 = await reload();
  check('6a reload twice OK', !p6.parts.some(p => p.includes('FAILED')));
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev(`(async()=>{ $gamePlayer.reserveTransfer(23,19,11,8,0); await __ai.waitIdle(10000); return 1; })()`);
  const seq6 = await ev('__ai._log.latest()');
  await ev(`$gamePlayer.checkEventTriggerThere([0,1,2]); $gameMap.setupStartingEvent()`);
  await call('waitFor', [['DIALOGUE', 'CHOICE'], 8000]);
  const end6 = await finishEvent();
  const lg6 = (await call('getLog', [seq6, null, 200])).entries;
  const starts = lg6.filter(e => e.type === 'event_start').length;
  const ends = lg6.filter(e => e.type === 'event_end').length;
  const msgKeys = lg6.filter(e => e.type === 'message').map(e => e.frame + '|' + e.data.text);
  const dupMsg = msgKeys.length - new Set(msgKeys).size;
  const msgs3 = lg.entries.filter(e => e.type === 'message').length;
  const msgs6 = lg6.filter(e => e.type === 'message').length;
  check('6b no duplicate log entries after reload', starts === 1 && ends === 1 && dupMsg === 0 && end6.state === 'EXPLORE',
    { starts, ends, dupMsg, msgs3, msgs6, end: end6.state });
} catch (e) {
  console.error('ERROR', e.code || '', e.message);
  fails++;
} finally {
  cdp.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exitCode = fails ? 1 : 0;
}
