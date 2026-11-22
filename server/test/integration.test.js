// End-to-end tests: the real MCP server over stdio against the fake game (test/fake-cdp.js).
// These prove the server, CDP client, bridge handshake and tool wiring without NW.js or a
// commercial game. They say nothing about a real RMMZ title; scripts/smoke.js covers that.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ALLOWED, FAIR_PLAY_HIDDEN, FORBIDDEN_TOOLS } from '../src/state-contract.js';
import { verifyTranscript } from '../src/transcript.js';
import { call, connectMcp, startSeededFake } from './helpers.js';

const OPTS = { timeout: 30000 };

test('full MCP session against the fake game: mirror task', OPTS, async () => {
  const fake = await startSeededFake();
  const client = await connectMcp({ PMGT_CDP_PORT: String(fake.port) });
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('get_capabilities') && names.includes('approach'));
    for (const f of FORBIDDEN_TOOLS) assert.ok(!names.includes(f), `forbidden ${f} offered`);

    const caps = await call(client, 'get_capabilities');
    assert.equal(caps.result.isError, undefined);
    assert.equal(caps.value.status, 'ready');
    assert.equal(caps.value.bridge.page_hash, caps.value.bridge.local_hash);
    assert.equal(caps.value.game.state, 'EXPLORE');
    assert.equal(caps.value.game.profile, 'Fake Game (test fixture)');

    const ping = await call(client, 'ping');
    assert.equal(ping.value.connected, true);
    assert.equal(ping.value.scene, 'Scene_Map');

    const st = await call(client, 'get_state');
    assert.equal(st.value.state, 'EXPLORE');
    // The fake bridge and the formal contract must agree on what EXPLORE allows.
    assert.deepEqual(st.value.allowed_actions, [...ALLOWED.EXPLORE]);

    const ev = await call(client, 'list_events', { radius: 8 });
    assert.equal(ev.value[0].name, 'Mirror');

    // The README benchmark task, against the fixture: walk to the mirror and read it.
    const ap = await call(client, 'approach', { event_id: 9 });
    assert.equal(ap.value.reached, true);
    assert.ok(ap.value.dialogue.join(' ').includes('big mirror'));
    assert.equal(ap.value.state.state, 'EXPLORE');
    assert.deepEqual(ap.value.state.facing, { id: 9, name: 'Mirror' });

    const grid = await call(client, 'map_grid');
    assert.ok(grid.value.rows.some(r => r.includes('@')));

    // The long way round: interact opens dialogue, read_dialogue closes it. The fake
    // bridge and the contract must also agree on what DIALOGUE allows.
    const inter = await call(client, 'interact');
    assert.equal(inter.value.started, true);
    assert.equal(inter.value.state.state, 'DIALOGUE');
    assert.deepEqual(inter.value.state.allowed_actions, [...ALLOWED.DIALOGUE]);
    const rd = await call(client, 'read_dialogue');
    assert.ok(rd.value.lines.join(' ').includes('big mirror'));
    assert.equal(rd.value.state.state, 'EXPLORE');

    const wk = await call(client, 'walk', { direction: 'down', steps: 1 });
    assert.equal(wk.value.moved, 1);

    const shot = await client.callTool({ name: 'screenshot', arguments: { scale: 0.25 } });
    assert.equal(shot.content[0].type, 'image');

    // Wrong-state actions come back as readable errors, never as crashes.
    const bad = await call(client, 'choose', { index: 0 });
    assert.equal(bad.result.isError, true);
    assert.equal(bad.value.error, 'INVALID_STATE');
  } finally {
    await client.close();
    await fake.close();
  }
});

test('PMGT_FAIR_PLAY=1 removes spoiler tools from the live tool list', OPTS, async () => {
  const fake = await startSeededFake();
  const client = await connectMcp({ PMGT_CDP_PORT: String(fake.port), PMGT_FAIR_PLAY: '1' });
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const t of FAIR_PLAY_HIDDEN) assert.ok(!names.includes(t), `${t} offered under fair play`);
    assert.ok(names.includes('get_state') && names.includes('approach'));
    const caps = await call(client, 'get_capabilities');
    assert.equal(caps.value.modes.fair_play, true);
    assert.deepEqual(caps.value.tools.hidden_by_fair_play, [...FAIR_PLAY_HIDDEN]);
    assert.deepEqual([...caps.value.tools.registered].sort(), [...names].sort());
  } finally {
    await client.close();
    await fake.close();
  }
});

test('PMGT_TRANSCRIPT records the session as a verifiable chain', OPTS, async () => {
  const fake = await startSeededFake();
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pmgt-it-')), 'session.jsonl');
  const client = await connectMcp({ PMGT_CDP_PORT: String(fake.port), PMGT_TRANSCRIPT: file });
  try {
    await call(client, 'get_state');
    await call(client, 'approach', { event_id: 9 });
    await call(client, 'choose', { index: 0 }); // fails with INVALID_STATE, still recorded
  } finally {
    await client.close();
    await fake.close();
  }
  const v = verifyTranscript(file);
  assert.equal(v.ok, true);
  assert.ok(v.entries >= 3, `expected at least 3 entries, got ${v.entries}`);
  assert.equal(v.errors, 1);
  assert.ok(v.tools.approach >= 1);
});

test('get_capabilities reports a down game as data, not an error', OPTS, async () => {
  const client = await connectMcp({ PMGT_CDP_PORT: '1' });
  try {
    const caps = await call(client, 'get_capabilities');
    assert.equal(caps.result.isError, undefined);
    assert.equal(caps.value.status, 'cdp_unreachable');
    assert.equal(caps.value.cdp.reachable, false);
    assert.ok(caps.value.tools.registered.includes('get_state'));
  } finally {
    await client.close();
  }
});
