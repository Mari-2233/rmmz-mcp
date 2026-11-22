// Offline unit tests for the pure server helpers. No game process is needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeBundle } from '../src/bridge.js';
import { CdpError } from '../src/cdp.js';
import { EventLog } from '../src/events.js';
import { budgetLast, compactResult, compactState } from '../src/tools/game.js';
import { ok, safe } from '../src/util.js';

test('EventLog keeps order, honours since/limit and evicts past capacity', () => {
  const log = new EventLog(3);
  for (const p of ['a', 'b', 'c', 'd']) log.push(p);
  assert.equal(log.seq, 4);
  assert.deepEqual(log.since(0).map(e => e.payload), ['b', 'c', 'd']);
  assert.deepEqual(log.since(2, 1).map(e => e.payload), ['c']);
  assert.deepEqual(log.since(4), []);
});

test('ok wraps a value as one JSON text block', () => {
  const r = ok({ a: 1 });
  assert.equal(r.content.length, 1);
  assert.deepEqual(JSON.parse(r.content[0].text), { a: 1 });
  assert.equal(r.isError, undefined);
});

test('safe maps bridge "CODE: message" errors to readable tool errors', async () => {
  const h = safe(async () => { throw new CdpError('JS_EXCEPTION', 'Error: INVALID_STATE: walk not allowed in DIALOGUE\n at ...'); });
  const r = await h({});
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).error, 'INVALID_STATE');
});

test('safe does not misread a TypeError as an error code', async () => {
  const h = safe(async () => { throw new CdpError('JS_EXCEPTION', 'TypeError: Cannot read properties of undefined'); });
  const r = await h({});
  assert.equal(JSON.parse(r.content[0].text).error, 'JS_EXCEPTION');
});

test('safe passes CdpError codes through and buckets the rest as INTERNAL', async () => {
  const a = await safe(async () => { throw new CdpError('NOT_READY', 'bridge missing'); })({});
  assert.equal(JSON.parse(a.content[0].text).error, 'NOT_READY');
  const b = await safe(async () => { throw new Error('boom'); })({});
  assert.equal(JSON.parse(b.content[0].text).error, 'INTERNAL');
  const c = await safe(async () => ok({ fine: true }))({});
  assert.equal(c.isError, undefined);
});

test('compactState drops nulls but keeps falsy values', () => {
  assert.deepEqual(compactState({ a: null, b: undefined, c: 0, d: false, e: '' }), { c: 0, d: false, e: '' });
  assert.equal(compactState(null), null);
  assert.deepEqual(compactState([1, null]), [1, null]);
});

test('compactResult compacts snapshots and nested state only', () => {
  const snap = { state: 'EXPLORE', allowed_actions: [], message: null };
  assert.deepEqual(compactResult(snap), { state: 'EXPLORE', allowed_actions: [] });
  const nested = { moved: 1, state: { state: 'EXPLORE', message: null } };
  assert.deepEqual(compactResult(nested), { moved: 1, state: { state: 'EXPLORE' } });
  assert.deepEqual(compactResult({ plain: true }), { plain: true });
});

test('budgetLast moves budget to the final key', () => {
  assert.deepEqual(Object.keys(budgetLast({ budget: 3, a: 1, b: 2 })), ['a', 'b', 'budget']);
  assert.deepEqual(budgetLast({ a: 1 }), { a: 1 });
});

test('bridgeBundle is deterministic, sorted and carries every part', async () => {
  const a = await bridgeBundle();
  const b = await bridgeBundle();
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{12}$/);
  const m = /window\.__AI_BRIDGE_PARTS = (\[.*?\]);\n/s.exec(a.code);
  assert.ok(m, 'parts payload not found in bundle');
  const names = JSON.parse(m[1]).map(p => p.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('00-core.js') && names.includes('10-state.js'));
  assert.ok(a.code.includes(`window.__AI_BRIDGE_HASH = ${JSON.stringify(a.hash)}`));
});
