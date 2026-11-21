#!/usr/bin/env node
// NOTE: this test uses DEV FIXTURE (cheat) setup (teleport / give items / set variables) to reach
// test situations quickly. Allowed in tests only; the demo must use real play progress (README: 公平性).
// Action acceptance tests. Needs a game already in map 23 EXPLORE
// (run goto-explore.js first). Never saves.   PMGT_CDP_PORT=9336 node scripts/test-C-actions.js [b8]
import { CdpClient } from '../src/cdp.js';

const cdp = new CdpClient({ port: Number(process.env.PMGT_CDP_PORT || 9336) });
const call = (m, ...a) => cdp.callBridge(m, a, { timeoutMs: 30000 });
const ev = e => cdp.evaluate(e, { timeoutMs: 30000 });
let fails = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`); if (!ok) fails++; };
const errOf = async p => { try { await p; return null; } catch (e) { return e.message; } };
const pos = async () => ev('[$gamePlayer.x, $gamePlayer.y]');
const st = async () => ev('__ai.currentState()');

// Same-map transfer back to the baseline tile, then wait for EXPLORE.
async function drain() {
  for (let i = 0; i < 15; i++) {
    const s = await st();
    if (s === 'EXPLORE') return;
    if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance');
    else if (s === 'CHOICE') await call('choose', 0);
    else await ev('__ai.waitIdle(3000)');
  }
}
async function reset(x = 19, y = 12, d = 2) {
  await drain();
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev(`$gamePlayer.reserveTransfer(23, ${x}, ${y}, ${d}, 0); true`);
  await ev('__ai.waitFor ? __ai.waitFor(["TRANSFER"], 2000) : 0');
  // Same-map transfers can take ~12 s here (overlay HUD keeps Scene_Map busy after the fade-out).
  let r;
  for (let i = 0; i < 3; i++) { r = await ev('__ai.waitFor(["EXPLORE"], 14000)'); if (r.ok) break; }
  return r;
}

async function main() {
  const ping = await call('ping');
  console.log('parts', ping.parts.join(' '));
  const hasA = (await st()) !== 'UNKNOWN';
  if (!(await ev('$gameMap.mapId()'))) throw new Error('no map loaded; run goto-explore.js');

  // 1. walk up 1 → (19,11); walk up again → blocked by the mirror.
  await reset();
  let r = await call('walk', 'up', 1);
  check('1a walk up 1', JSON.stringify(r.path) === '[[19,11]]' && r.stop === null, { path: r.path, stop: r.stop, state: r.state.state });
  r = await call('walk', 'up', 1);
  check('1b walk up blocked', r.stop === 'blocked' && r.moved === 0, { stop: r.stop, path: r.path });

  // 2. walk left 20 → stops at a wall, path matches real coordinates.
  await reset();
  r = await call('walk', 'left', 20);
  const p2 = await pos();
  const last = r.path[r.path.length - 1];
  check('2 walk left 20 blocked', r.stop === 'blocked' && r.moved > 0 && last[0] === p2[0] && last[1] === p2[1], { stop: r.stop, path: r.path, at: p2 });

  // 3. interact with the mirror, advance until explore, text mentions mirror.
  await reset();
  await call('walk', 'up', 1);
  r = await call('face', 'up');
  check('3a face up', r.facing.events.some(e => e.id === 9), r.facing);
  r = await call('interact');
  check('3b interact mirror', r.started === true && r.eventId === 9, { started: r.started, eventId: r.eventId, state: r.state.state });
  // 4. walk during dialogue → INVALID_STATE (needs 10-state).
  if (hasA) {
    await ev('__ai.waitIdle(3000)');
    const e4 = await errOf(call('walk', 'up', 1));
    check('4 walk in dialogue → INVALID_STATE', !!e4 && e4.includes('INVALID_STATE'), e4);
  } else console.log('SKIP 4 (no 10-state)');
  let texts = [], n = 0;
  for (; n < 10; n++) {
    const t = await ev('$gameMessage.allText()');
    if (t) texts.push(t);
    if ((await st()) === 'EXPLORE' && n > 0) break;
    const s = await st();
    if (s !== 'DIALOGUE' && s !== 'CUTSCENE') { await ev('__ai.waitIdle ? __ai.waitIdle(3000) : 0'); continue; }
    await call('advance');
  }
  const back = (await ev('__ai.waitFor ? __ai.waitFor(["EXPLORE"], 3000) : 0'));
  check('3c advance back to explore', (await st()) === 'EXPLORE' && texts.join(' ').toLowerCase().includes('mirror'), { advances: n, texts });

  // 5. choose with a temporary choice list (Beta hidden). V921 records the branch.
  const list = `[
    {code:102,indent:0,parameters:[["Alpha","Beta<Hide>","Gamma"],-1,0,2,0]},
    {code:402,indent:0,parameters:[0,"Alpha"]}, {code:122,indent:1,parameters:[921,921,0,0,100]}, {code:0,indent:1,parameters:[]},
    {code:402,indent:0,parameters:[1,"Beta"]},  {code:122,indent:1,parameters:[921,921,0,0,101]}, {code:0,indent:1,parameters:[]},
    {code:402,indent:0,parameters:[2,"Gamma"]}, {code:122,indent:1,parameters:[921,921,0,0,102]}, {code:0,indent:1,parameters:[]},
    {code:404,indent:0,parameters:[]}, {code:0,indent:0,parameters:[]}]`;
  for (const [pick, want] of [[0, 100], [2, 102]]) {
    // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
    await ev(`$gameVariables.setValue(921, 0); $gameMap._interpreter.setup(${list}, 0); true`);
    await ev('__ai.waitFor ? __ai.waitFor(["CHOICE"], 3000) : new Promise(r=>setTimeout(r,800))');
    if (pick === 2) {
      const e1 = await errOf(call('choose', 1));
      check('5b choose hidden 1 → NOT_FOUND', !!e1 && e1.includes('NOT_FOUND'), e1);
    }
    r = await call('choose', pick);
    await ev('__ai.waitFor ? __ai.waitFor(["EXPLORE"], 3000) : 0');
    const v = await ev('$gameVariables.value(921)');
    check(`5${pick === 0 ? 'a' : 'c'} choose ${pick}`, v === want && (await st()) === 'EXPLORE', { v, state: await st() });
  }
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev('$gameVariables.setValue(921, 0); true');

  // 6. walk into the transfer event 3 at (25,13).
  await reset();
  await call('walk', 'down', 1);
  r = await call('walk', 'right', 6);
  const s6 = await st();
  check('6 walk into teleport', r.stop === 'state_changed' || s6 === 'TRANSFER', { stop: r.stop, path: r.path, state: r.state.state, now: s6 });
  for (let i = 0; i < 10; i++) {           // clear the locked-door message
    const s = await st();
    if (s === 'EXPLORE') break;
    if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance'); else await ev('__ai.waitIdle(3000)');
  }
  console.log('after teleport', await ev('JSON.stringify([$gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, __ai.currentState()])'));
}

// B8: use the red marble (item 10) on Map022 event 9 redMarble (<shortcut2>, below-player priority at (18,12)).
async function b8() {
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev('$gamePlayer.reserveTransfer(22, 18, 12, 2, 0); true');
  await ev('__ai.waitFor(["TRANSFER"], 2000)');
  for (let i = 0; i < 3 && !(await ev('__ai.waitIdle(14000)')).ok; i++);
  for (let i = 0; i < 10 && (await st()) !== 'EXPLORE'; i++) { const s = await st(); if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance'); else await ev('__ai.waitIdle(3000)'); }
  console.log('at', await ev('JSON.stringify([$gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, __ai.currentState(), $gameMap.event(9)._pageIndex])'));
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev('$gameParty.numItems($dataItems[10]) || $gameParty.gainItem($dataItems[10], 1); true');
  let p0 = await pos();
  if (p0[0] === 18 && p0[1] === 12) await call('walk', 'right', 1);
  await call('face', 'left');
  const hint = await call('useItemOn', 10).catch(e => ({ err: e.message.split('\n')[0] }));
  console.log('use before stepping on it', JSON.stringify(hint.hint || hint.err));
  const p = await pos();
  if (p[0] !== 18 || p[1] !== 12) await call('walk', p[0] > 18 ? 'left' : 'right', Math.abs(p[0] - 18));
  console.log('now at', await pos());
  const e0 = await errOf(call('useItemOn', 9999));
  check('B8a bad item → BAD_ARGS', !!e0 && e0.includes('BAD_ARGS'), e0 && e0.split('\n')[0]);
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev('$gameVariables.setValue(12, 0); true');
  const r = await call('useItemOn', 10);
  const v12 = await ev('$gameVariables.value(12)');
  check('B8b useItemOn(10) on redMarble', r.started === true && r.eventId === 9 && v12 === 10, { started: r.started, eventId: r.eventId, v12, state: r.state.state });
  const texts = [];
  for (let i = 0; i < 25 && (await st()) !== 'EXPLORE'; i++) {
    const s = await st(); const t = await ev('$gameMessage.allText()'); if (t) texts.push(t);
    if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance'); else if (s === 'CHOICE') await call('choose', 0); else await ev('__ai.waitIdle(5000)');
  }
  check('B8c event ran back to EXPLORE', (await st()) === 'EXPLORE', { texts, selfA: await ev('$gameSelfSwitches.value([22,9,"A"])') });
  // Nothing in front/under → started:false.
  const r2 = await call('useItemOn', 10).catch(e => ({ err: e.message }));
  console.log('second use', JSON.stringify(r2).slice(0, 200));
}

// B9: interact (no item) with greenMarble (Map022 event 11 @ (20,12)) → item menu opens → pickItem(11).
async function b9() {
  await drain();
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  if ((await ev('$gameMap.mapId()')) !== 22) { await ev('$gamePlayer.reserveTransfer(22, 18, 12, 2, 0); true'); await ev('__ai.waitFor(["TRANSFER"], 2000)'); for (let i = 0; i < 3 && !(await ev('__ai.waitIdle(14000)')).ok; i++); await drain(); }
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await ev('$gameParty.numItems($dataItems[11]) || $gameParty.gainItem($dataItems[11], 1); $gameVariables.setValue(12, 0); true');
  const p = await pos();
  if (p[1] !== 12) throw new Error('expected y=12, at ' + p);
  if (p[0] !== 20) await call('walk', p[0] < 20 ? 'right' : 'left', Math.abs(p[0] - 20));
  console.log('at', await pos());
  const r = await call('interact');
  console.log('interact', r.started, r.eventId, r.state.state);
  let scene = null;
  for (let i = 0; i < 10; i++) {
    const s = await st();
    if (s === 'OTHER_SCENE') { scene = await ev('SceneManager._scene.constructor.name'); break; }
    if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance'); else await ev('__ai.waitIdle(3000)');
  }
  check('B9a item menu opened', scene === 'Scene_Item', { scene, state: await st() });
  if (scene !== 'Scene_Item') return;
  await ev('new Promise(r => setTimeout(r, 1000))'); // let the menu intro animation finish
  const pr = await call('pickItem', 11);
  const v12 = await ev('$gameVariables.value(12)');
  check('B9b pickItem(11) back on map with V12=11', pr.returned && v12 === 11, { returned: pr.returned, v12, state: pr.state.state });
  const texts = [];
  for (let i = 0; i < 25 && (await st()) !== 'EXPLORE'; i++) {
    const s = await st(); const t = await ev('$gameMessage.allText()'); if (t) texts.push(t);
    if (s === 'DIALOGUE' || s === 'CUTSCENE') await call('advance'); else if (s === 'CHOICE') await call('choose', 0); else await ev('__ai.waitIdle(5000)');
  }
  check('B9c marble inserted', (await ev('$gameSelfSwitches.value([22,11,"A"])')) === true, { texts, items: await ev('$gameParty.numItems($dataItems[11])') });
}

try { if (process.argv[2] === 'b9') await b9(); else if (process.argv[2] === 'b8') await b8(); else await main(); } catch (e) { console.error('ERROR', e.message); fails++; }
finally { cdp.close(); console.log(fails ? `${fails} FAIL` : 'ALL PASS'); process.exitCode = fails ? 1 : 0; }
