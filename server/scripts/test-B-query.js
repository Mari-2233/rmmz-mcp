#!/usr/bin/env node
// NOTE: this test uses DEV FIXTURE (cheat) setup (teleport / give items / set variables) to reach
// test situations quickly. Allowed in tests only; the demo must use real play progress (README: 公平性).
// B-query acceptance tests (B4 30-query.js, B10 35-describe.js).
//   PMGT_CDP_PORT=9335 node scripts/test-B-query.js [--reload] [--verbose]
// Needs the game in map 23 (scripts/goto-explore.js). Never saves. Restores any item it adds.
import { readFile } from 'node:fs/promises';
import { CdpClient } from '../src/cdp.js';
import { BRIDGE_PATH } from '../src/tools/dev.js';

const cdp = new CdpClient({ port: Number(process.env.PMGT_CDP_PORT || 9335) });
const verbose = process.argv.includes('--verbose');
let fails = 0;
const ok = (cond, name, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ': ' + info : ''}`);
};
const call = (m, args = []) => cdp.callBridge(m, args, { timeoutMs: 15000 });

try {
  if (process.argv.includes('--reload')) {
    const code = await readFile(BRIDGE_PATH, 'utf8');
    await cdp.evaluate(`(0, eval)(${JSON.stringify(code + '\n//# sourceURL=ai-bridge.js')}); true`);
  }
  const ping = await call('ping');
  ok(!ping.parts.some(p => /FAILED/.test(p)), 'parts load', ping.parts.join(', '));

  // 1. listEvents
  const evs = await call('listEvents');
  const e9 = evs.find(e => e.id === 9), e3 = evs.find(e => e.id === 3);
  ok(Array.isArray(evs) && evs.length > 0, 'listEvents', `${evs.length} events`);
  ok(e9 && e9.name === 'objMirror' && e9.x === 19 && e9.y === 10 && e9.priority === 1 && e9.proximity != null,
    'event 9 objMirror', JSON.stringify(e9));
  ok(e3 && e3.name === 'Tele: HUB' && e3.trigger === 1, 'event 3 Tele: HUB', JSON.stringify(e3));
  const near = await call('listEvents', [{ radius: 3 }]);
  ok(near.every(e => e.dist <= 3) && near.every((e, i) => !i || near[i - 1].dist <= e.dist), 'listEvents radius 3 sorted', near.map(e => `${e.id}:${e.dist}`).join(' '));
  if (verbose) console.log(evs.map(e => JSON.stringify(e)).join('\n'));

  // 2. mapGrid vs appendix B
  const g = await call('mapGrid', [{ x: 13, y: 8, w: 14, h: 8 }]);
  console.log(`mapGrid origin ${JSON.stringify(g.origin)} player ${JSON.stringify(g.player)}\n  ` + g.rows.join('\n  '));
  const ref = ['#############.', '#############.', '######E######.', '###E#.@.#E###.', '##E...E....###', '##..........E#', '##E.......E###', '##############'];
  let same = 0, tot = 0;
  g.rows.forEach((r, y) => [...r].forEach((ch, x) => { tot++; const rc = ref[y][x]; if (ch === rc || (ch === '@' || rc === '@')) same++; }));
  ok(g.rows.length === 8 && g.rows[0].length === 14 && same / tot > 0.9, 'mapGrid ~ appendix B', `${same}/${tot} cells match (ignoring @)`);
  const gd = await call('mapGrid');
  ok(gd.rows.length === 15 && gd.rows[0].length === 21 && gd.rows.join('').includes('@'), 'mapGrid default 21x15 with @');

  // 3. listItems (add + restore)
  const itemId = await cdp.evaluate(`(() => { for (let i = 1; i < $dataItems.length; i++) if ($dataItems[i] && $dataItems[i].name && !$gameParty.hasItem($dataItems[i])) return i; return 0; })()`);
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await cdp.evaluate(`$gameParty.gainItem($dataItems[${itemId}], 1); true`);
  const items = await call('listItems');
  // DEV FIXTURE (cheat): test setup only — never in AI tools, demo or submission (README: 公平性)
  await cdp.evaluate(`$gameParty.gainItem($dataItems[${itemId}], -1); true`);
  const it = items.find(i => i.id === itemId);
  ok(it && it.count === 1 && !/\\[A-Za-z]\[/.test(it.name + it.description), 'listItems', JSON.stringify(it));
  ok(!(await call('listItems')).some(i => i.id === itemId), 'listItems restored');

  // 4. switches / variables
  const sw = await call('getSwitches', [{ named: true }]);
  ok(sw.length >= 230 && sw.length <= 240, 'getSwitches named', `${sw.length} named; on: ${sw.filter(s => s.value).map(s => s.id).join(',')}`);
  const vars = await call('getVariables', [{ ids: [21, 22, 23] }]);
  const pos = await cdp.evaluate(`[$gameMap.mapId(), $gamePlayer.x, $gamePlayer.y]`);
  ok(vars.length === 3, 'getVariables 21-23', `${JSON.stringify(vars)} vs actual ${JSON.stringify(pos)}`);
  let bad = null;
  try { await call('getVariables', [{ ids: [99999] }]); } catch (e) { bad = e.message; }
  ok(bad && /BAD_ARGS/.test(bad), 'getVariables bad id -> BAD_ARGS', bad);

  // 5. describeEvent(9)
  const d9 = await call('describeEvent', [9]);
  console.log(`describeEvent(9) page ${d9.page} trigger ${d9.trigger} conds ${JSON.stringify(d9.conditions)}\n  ` + d9.lines.join('\n  '));
  ok(d9.lines.length > 5 && d9.lines.some(l => /^\s*Text/.test(l)) && d9.lines.some(l => /^\s*If /.test(l)), 'describeEvent(9) readable');

  // 6. page -1 event
  const neg = evs.find(e => e.page === -1);
  const negId = neg ? neg.id : null;
  if (negId != null) {
    const dn = await call('describeEvent', [negId]);
    ok(dn.page === -1 && Array.isArray(dn.pages), `describeEvent(${negId}) page -1`, JSON.stringify(dn.pages).slice(0, 300));
  } else console.log('SKIP no page -1 event on this map');
  // every event decompiles without throwing
  let errs = [];
  for (const e of evs) { try { await call('describeEvent', [e.id]); } catch (err) { errs.push(`${e.id}: ${err.message}`); } }
  ok(errs.length === 0, 'describeEvent all events', errs.join('; '));
  let nf = null;
  try { await call('describeEvent', [9999]); } catch (e) { nf = e.message; }
  ok(nf && /NOT_FOUND/.test(nf), 'describeEvent(9999) -> NOT_FOUND', nf);
} catch (e) {
  fails++;
  console.log(`FAIL exception: ${e.code || ''} ${e.message}`);
} finally {
  cdp.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exitCode = fails ? 1 : 0;
}
