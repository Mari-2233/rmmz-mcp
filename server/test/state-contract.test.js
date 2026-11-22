// Offline contract checks: the state tables exist twice (game parts + state-contract.js)
// because the game side runs in Chromium 85 and cannot import server modules. These tests
// execute the game copies and fail when the two sides drift, when a tool goes missing, or
// when a forbidden cheat tool appears. No game process is needed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED, FAIR_PLAY_HIDDEN, FORBIDDEN_TOOLS, GATED_ACTION_TOOLS, IDLE_STATES,
  META_ACTION_TOOLS, READ_TOOLS, STATES, allowedActions, registeredTools,
} from '../src/state-contract.js';
import { EventLog } from '../src/events.js';
import { registerAll } from '../src/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

test('game/parts/00-core.js STATES and ALLOWED match the contract', () => {
  const ai = {};
  const util = { ready() {}, onFrame() {}, notify() {} };
  // eslint-disable-next-line no-new-func
  new Function('ai', 'util', read('game/parts/00-core.js'))(ai, util);
  assert.deepEqual(ai.STATES, [...STATES]);
  assert.deepEqual(ai.ALLOWED, JSON.parse(JSON.stringify(ALLOWED)));
  // The game-side guard agrees with the mirrored allowedActions helper.
  assert.deepEqual(ai.allowedActions('EXPLORE'), allowedActions('EXPLORE'));
  ai.PROFILE.unsupported = ['use_item'];
  assert.deepEqual(ai.allowedActions('EXPLORE'), allowedActions('EXPLORE', ['use_item']));
});

test('game/parts/10-state.js IDLE set matches the contract', () => {
  const m = /const IDLE = \[([^\]]*)\]/.exec(read('game/parts/10-state.js'));
  assert.ok(m, 'IDLE declaration not found in 10-state.js');
  const idle = [...m[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1]);
  assert.deepEqual(idle, [...IDLE_STATES]);
});

test('contract tables are internally consistent', () => {
  for (const s of IDLE_STATES) assert.ok(STATES.includes(s), `IDLE state ${s} not in STATES`);
  const gated = new Set();
  for (const [state, actions] of Object.entries(ALLOWED)) {
    assert.ok(STATES.includes(state), `ALLOWED key ${state} not in STATES`);
    for (const a of actions) gated.add(a);
  }
  assert.deepEqual([...gated].sort(), [...GATED_ACTION_TOOLS].sort(),
    'ALLOWED values and GATED_ACTION_TOOLS must name the same tools');
  for (const t of META_ACTION_TOOLS) assert.ok(!gated.has(t), `meta tool ${t} must not be state-gated`);
  const all = [...READ_TOOLS, ...GATED_ACTION_TOOLS, ...META_ACTION_TOOLS];
  assert.equal(new Set(all).size, all.length, 'tool listed in two contract groups');
  for (const t of FORBIDDEN_TOOLS) assert.ok(!all.includes(t), `forbidden tool ${t} in contract`);
  for (const t of FAIR_PLAY_HIDDEN) assert.ok(READ_TOOLS.includes(t), `fair-play hides non-read tool ${t}`);
  assert.deepEqual(allowedActions('NOPE'), []);
});

function capture(extra = {}) {
  const regs = [];
  const server = { registerTool(name, cfg, handler) { regs.push({ name, cfg, handler }); } };
  const cdp = { host: '127.0.0.1', port: 0, targetSuffix: 'index.html', target: null };
  registerAll({ server, cdp, events: new EventLog(10), dev: false, fairPlay: false, transcript: null, ...extra });
  return regs;
}

test('registered tools match the contract in every mode', () => {
  for (const mode of [{}, { fairPlay: true }, { dev: true }, { dev: true, fairPlay: true }]) {
    const names = capture(mode).map(r => r.name).sort();
    assert.deepEqual(names, [...registeredTools(mode)].sort(), `mode ${JSON.stringify(mode)}`);
    for (const f of FORBIDDEN_TOOLS) assert.ok(!names.includes(f), `forbidden ${f} registered`);
  }
});

test('fair play hides exactly the spoiler and human-only tools', () => {
  const names = capture({ fairPlay: true }).map(r => r.name);
  for (const t of FAIR_PLAY_HIDDEN) assert.ok(!names.includes(t), `${t} visible under fair play`);
  assert.ok(names.includes('get_state') && names.includes('approach'), 'play tools missing under fair play');
});

test('every tool declares complete annotations', () => {
  // Tools that never leave the server process. Everything else talks to the live game.
  const LOCAL = new Set(['ask_user', 'get_pushed_events']);
  for (const { name, cfg } of capture({ dev: true })) {
    assert.equal(typeof cfg.annotations?.readOnlyHint, 'boolean', `${name} readOnlyHint`);
    assert.equal(typeof cfg.annotations?.idempotentHint, 'boolean', `${name} idempotentHint`);
    assert.equal(cfg.annotations?.openWorldHint, !LOCAL.has(name), `${name} openWorldHint`);
    if (READ_TOOLS.includes(name)) assert.equal(cfg.annotations.readOnlyHint, true, `${name} must be read-only`);
    if (name === 'restart') assert.equal(cfg.annotations.destructiveHint, true, 'restart wipes the run');
  }
});

test('tool descriptions stay within the smoke test budget', () => {
  // scripts/smoke.js fails when descriptions reach 3000 chars (they sit in the model
  // context every turn). Guard the same budget offline, dev tools included.
  const total = capture({ dev: true }).reduce((n, r) => n + (r.cfg.description?.length || 0), 0);
  assert.ok(total < 3000, `descriptions total ${total} chars, budget is 3000`);
});

test('every game part compiles as a function body and the bridge parses', () => {
  const dir = path.join(ROOT, 'game/parts');
  const parts = readdirSync(dir).filter(n => /^\d\d-.*\.js$/.test(n)).sort();
  assert.ok(parts.length >= 15, `expected the bridge parts, found ${parts.length}`);
  for (const name of parts) {
    // eslint-disable-next-line no-new-func
    assert.doesNotThrow(() => new Function('ai', 'util', readFileSync(path.join(dir, name), 'utf8')), name);
  }
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(read('game/ai-bridge.js')), 'ai-bridge.js');
});
