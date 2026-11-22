// getCapabilities against stub CDP clients: every status, including the malformed-endpoint
// cases. This tool exists to report broken setups as data, so it must never throw on them.
// The happy path and the down-game path also run end to end in integration.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCapabilities } from '../src/capabilities.js';

function stubCdp({ targets, probe, listError } = {}) {
  return {
    host: '127.0.0.1',
    port: 9333,
    targetSuffix: 'index.html',
    async listTargets() {
      if (listError) throw listError;
      return targets;
    },
    async evaluate() { return probe; },
  };
}
const PAGE = [{ type: 'page', url: 'file:///game/index.html' }];

test('unreachable endpoint reports cdp_unreachable', async () => {
  const r = await getCapabilities({ cdp: stubCdp({ listError: new Error('connect ECONNREFUSED') }) });
  assert.equal(r.status, 'cdp_unreachable');
  assert.equal(r.cdp.reachable, false);
});

test('a non-game endpoint is reported, never thrown', async () => {
  for (const targets of [{ not: 'a list' }, [null], [{ type: 'page' }], [{ type: 'page', url: 42 }]]) {
    const r = await getCapabilities({ cdp: stubCdp({ targets }) });
    assert.equal(r.status, 'target_not_found', JSON.stringify(targets));
    assert.equal(r.cdp.reachable, true);
  }
});

test('no matching page reports target_not_found with the seen urls', async () => {
  const r = await getCapabilities({ cdp: stubCdp({ targets: [{ type: 'page', url: 'about:blank' }] }) });
  assert.equal(r.status, 'target_not_found');
  assert.deepEqual(r.cdp.targets, ['about:blank']);
});

test('page without the bridge reports bridge_missing', async () => {
  const probe = { scene: 'Scene_Title', loaded: false, version: null, parts: [], hash: null, state: null, profile: null };
  const r = await getCapabilities({ cdp: stubCdp({ targets: PAGE, probe }) });
  assert.equal(r.status, 'bridge_missing');
  assert.equal(r.bridge.loaded, false);
});

test('bridge loaded from disk reports bridge_stale', async () => {
  const probe = { scene: 'Scene_Map', loaded: true, version: '0.1.0', parts: ['00-core.js'], hash: 'disk', state: 'EXPLORE', profile: 'X' };
  const r = await getCapabilities({ cdp: stubCdp({ targets: PAGE, probe }) });
  assert.equal(r.status, 'bridge_stale');
  assert.ok(r.bridge.local_hash, 'local bundle hash present for comparison');
});

test('a throwing page probe reports bridge_missing with the error attached', async () => {
  const cdp = stubCdp({ targets: PAGE });
  cdp.evaluate = async () => { throw new Error('CDP disconnected'); };
  const r = await getCapabilities({ cdp });
  assert.equal(r.status, 'bridge_missing');
  assert.match(r.bridge.error, /disconnected/);
});

test('modes reflect a disabled transcript honestly', async () => {
  const r = await getCapabilities({
    cdp: stubCdp({ listError: new Error('down') }),
    transcript: { disabled: true, record() {} },
  });
  assert.equal(r.modes.transcript, false);
});
