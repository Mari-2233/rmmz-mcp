import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_SCHEMA,
  BASE_REVISION,
  DOMAIN,
  EvidenceRecorder,
  EXISTING_ACTION_TOOLS,
  FIXTURE_MARK,
  FIXTURE_MODEL,
  SIMGRAMMAR_MECHANICS,
  buildEvidenceEnvelope,
  buildPositiveEnvelope,
  canonicalStringify,
  fixtureNegativeControls,
  makeCheck,
  makeFixtureReceipt,
  parseJson,
  replayFixtureReceipt,
  sealEvidenceEnvelope,
  sha256Canonical,
  sha256Raw,
  validateChecks,
  verifyEvidenceEnvelope,
} from './evidence.js';

function clone(value) {
  return parseJson(JSON.stringify(value));
}
function refreshPayload(envelope) {
  const payload = envelope.payload;
  for (const field of ['model', 'initial_state', 'actions', 'trajectory']) {
    payload[`${field}_sha256`] = sha256Canonical(payload[field]);
  }
  for (const check of envelope.evidence.checks) {
    for (const field of ['initial_state', 'actions', 'trajectory']) {
      check[`${field}_sha256`] = payload[`${field}_sha256`];
    }
  }
  return sealEvidenceEnvelope(envelope);
}
function fakeChecker() {
  return { name: 'mutation checker', revision: BASE_REVISION, artifact_sha256: sha256Canonical({ mutation: 'checker' }) };
}

test('canonical JSON matches Python sorting, compact encoding, and ensure_ascii', () => {
  const value = { z: 2, astral: '😀', '\ue000': 1, '😀': 2, a: [1, { b: 3 }], line: '\u2028', ctrl: '\n' };
  assert.equal(
    canonicalStringify(value),
    '{"a":[1,{"b":3}],"astral":"\\ud83d\\ude00","ctrl":"\\n","line":"\\u2028","z":2,"\\ue000":1,"\\ud83d\\ude00":2}',
  );
  // Python: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
  // The astral key sorts after U+E000 by Unicode code point, unlike native JS UTF-16 sort.
  assert.equal(canonicalStringify({ n: -0 }), '{"n":0}');
});

test('canonical values reject floats, non-finite values, unsafe integers, cycles, and holes', () => {
  for (const value of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => canonicalStringify({ value }), /NON_CANONICAL_NUMBER/);
  }
  assert.throws(() => canonicalStringify({ bigint: 1n }), /JSON_TYPE/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalStringify(cycle), /CYCLE/);
  assert.throws(() => canonicalStringify(new Array(1)), /ARRAY_HOLE/);
  assert.equal(canonicalStringify({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    '{"max":9007199254740991,"min":-9007199254740991}');
});

test('strict parser rejects duplicate keys and lexical floats including 1.0', () => {
  assert.throws(() => parseJson('{"a":1.0}'), /NON_CANONICAL_NUMBER/);
  assert.throws(() => parseJson('{"a":1e0}'), /NON_CANONICAL_NUMBER/);
  assert.throws(() => parseJson('{"a":1,"a":2}'), /DUPLICATE_JSON_KEY/);
  assert.throws(() => parseJson('{"outer":{"a":1,"a":2}}'), /DUPLICATE_JSON_KEY/);
  assert.throws(() => parseJson('{"n":9007199254740992}'), /JS_SAFE_INTEGER/);
  assert.throws(() => parseJson('{"n":9223372036854775808}'), /INT64_RANGE/);
  const proto = parseJson('{"__proto__":{"safe":true}}');
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test('positive fixture is a sealed source-only OBSERVED/REPLAYED artifact', () => {
  const envelope = buildPositiveEnvelope();
  const result = verifyEvidenceEnvelope(envelope);
  assert.equal(result.valid, true);
  assert.equal(result.capture_mode, 'fixture');
  assert.equal(envelope.schema, ARTIFACT_SCHEMA);
  assert.equal(envelope.payload.domain, DOMAIN);
  assert.equal(envelope.evidence.checks.length, 1);
  assert.equal(envelope.evidence.checks[0].kind, 'model_replay');
  assert.equal(envelope.evidence.checks[0].status, 'PASS');
  assert.ok(envelope.evidence.checks[0].source_labels.includes(FIXTURE_MARK));
  assert.ok(envelope.evidence.checks[0].source_labels.includes('REPLAYED'));
  assert.ok(!('source_badges' in envelope));
  assert.ok(!('admitted_badges' in envelope));
  assert.ok(!('badges' in envelope));
  assert.equal(envelope.evidence.negative_controls.length, 6);
  assert.ok(envelope.evidence.negative_controls.every(control => control.passed === true));
  assert.ok(envelope.evidence.limitations.some(line => /no live game/i.test(line)));
  assert.ok(validateChecks(envelope.payload, envelope.evidence.checks, parseJson(envelope.source.raw)));
});

test('fixture binds only the mechanics exercised by walk and use_item', () => {
  const envelope = buildPositiveEnvelope();
  assert.deepEqual(envelope.mechanics.map(mechanic => mechanic.id), ['direct-avatar', 'triggered-event-chains']);
  assert.deepEqual(envelope.mechanics[0], SIMGRAMMAR_MECHANICS.direct_avatar);
  assert.deepEqual(envelope.mechanics[1], SIMGRAMMAR_MECHANICS.triggered_event_chains);
  assert.ok(!envelope.mechanics.some(mechanic => ['agent-pathfinding', 'milestone-unlocks', 'scenario-objectives'].includes(mechanic.id)));
});

test('every payload, check, source, and artifact digest is nonzero and current', () => {
  const envelope = buildPositiveEnvelope();
  for (const field of ['model', 'initial_state', 'actions', 'trajectory']) {
    assert.equal(envelope.payload[`${field}_sha256`], sha256Canonical(envelope.payload[field]));
  }
  const check = envelope.evidence.checks[0];
  for (const field of ['initial_state', 'actions', 'trajectory']) {
    assert.equal(check[`${field}_sha256`], envelope.payload[`${field}_sha256`]);
  }
  assert.notEqual(check.checker.artifact_sha256, '0'.repeat(64));
  assert.equal(envelope.source.raw_sha256, sha256Raw(envelope.source.raw));
  const unsigned = clone(envelope);
  delete unsigned.artifact_sha256;
  assert.equal(envelope.artifact_sha256, sha256Canonical(unsigned));
});

test('fixture replay accepts only byte-equivalent canonical observations', () => {
  const receipt = makeFixtureReceipt();
  assert.deepEqual(replayFixtureReceipt(receipt), { passed: true, steps: 2 });
  const controls = fixtureNegativeControls(receipt);
  assert.deepEqual(controls.map(control => control.name), [
    'stale-prestate', 'action-substitution', 'skipped-step',
    'trajectory-mismatch', 'false-live-label', 'invalid-safe-integer',
  ]);
  assert.ok(controls.every(control => /rejected|_/.test(control.observed)));
});

test('re-sealed stale pre-state is rejected', () => {
  const envelope = clone(buildPositiveEnvelope());
  envelope.payload.initial_state.seq = 99;
  refreshPayload(envelope);
  assert.throws(() => verifyEvidenceEnvelope(envelope), /STALE_PRESTATE|SOURCE_PAYLOAD_BINDING/);
  assert.equal(validateChecks(envelope.payload, envelope.evidence.checks), true); // commitments alone match
  assert.equal(validateChecks(envelope.payload, envelope.evidence.checks, parseJson(envelope.source.raw)), false);
});

test('re-sealed action substitution is rejected', () => {
  const envelope = clone(buildPositiveEnvelope());
  envelope.payload.actions[0].arguments.direction = 'left';
  envelope.payload.trajectory[0].action.arguments.direction = 'left';
  refreshPayload(envelope);
  assert.throws(() => verifyEvidenceEnvelope(envelope), /ACTION_BINDING|SOURCE_PAYLOAD_BINDING/);
  const receipt = makeFixtureReceipt();
  receipt.actions[0].arguments.direction = 'left';
  receipt.trajectory[0].action.arguments.direction = 'left';
  assert.throws(() => replayFixtureReceipt(receipt), /TRAJECTORY_MISMATCH|RESULT_MISMATCH/);
});

test('re-sealed skipped step is rejected', () => {
  const envelope = clone(buildPositiveEnvelope());
  envelope.payload.trajectory.pop();
  refreshPayload(envelope);
  assert.throws(() => verifyEvidenceEnvelope(envelope), /TRAJECTORY_LENGTH|SOURCE_PAYLOAD_BINDING/);
  const receipt = makeFixtureReceipt();
  receipt.trajectory.pop();
  assert.throws(() => replayFixtureReceipt(receipt), /TRAJECTORY_LENGTH/);
});

test('re-sealed trajectory mismatch is rejected', () => {
  const envelope = clone(buildPositiveEnvelope());
  envelope.payload.trajectory[0].after.player.x += 1;
  refreshPayload(envelope);
  assert.throws(() => verifyEvidenceEnvelope(envelope), /STALE_PRESTATE|SOURCE_PAYLOAD_BINDING|TRAJECTORY_MISMATCH/);
  const receipt = makeFixtureReceipt();
  receipt.trajectory[0].after.player.x += 1;
  assert.throws(() => replayFixtureReceipt(receipt), /RESULT_BINDING|STALE_PRESTATE|TRAJECTORY_MISMATCH/);
});

test('false live label is rejected even with matching commitments and a fresh artifact digest', () => {
  const envelope = clone(buildPositiveEnvelope());
  const payload = envelope.payload;
  envelope.evidence.checks.push({
    kind: 'live_execution',
    status: 'PASS',
    checker: fakeChecker(),
    source_labels: [FIXTURE_MARK, 'LIVE_CONFIRMED'],
    initial_state_sha256: payload.initial_state_sha256,
    actions_sha256: payload.actions_sha256,
    trajectory_sha256: payload.trajectory_sha256,
  });
  sealEvidenceEnvelope(envelope);
  assert.throws(() => verifyEvidenceEnvelope(envelope), /FALSE_LIVE_LABEL/);
  assert.equal(validateChecks(payload, envelope.evidence.checks, parseJson(envelope.source.raw)), false);
  assert.throws(() => makeCheck(makeFixtureReceipt(), {
    kind: 'live_execution', checker: fakeChecker(), sourceLabels: [FIXTURE_MARK],
  }), /FALSE_LIVE_LABEL/);
});

test('unsafe integer mutation is rejected even when its JSON spelling looks integral', () => {
  const receipt = makeFixtureReceipt();
  receipt.initial_state.bad = 9007199254740992;
  assert.throws(() => replayFixtureReceipt(receipt), /NON_CANONICAL_NUMBER/);
  const envelope = clone(buildPositiveEnvelope());
  envelope.payload.initial_state.bad = 1.5;
  assert.throws(() => refreshPayload(envelope), /NON_CANONICAL_NUMBER/);
});

test('source raw digest tampering and label promotion cannot hide', () => {
  const rawTamper = clone(buildPositiveEnvelope());
  rawTamper.source.raw = rawTamper.source.raw.replace('"seq":0', '"seq":9');
  sealEvidenceEnvelope(rawTamper);
  assert.throws(() => verifyEvidenceEnvelope(rawTamper), /SOURCE_COMMITMENT/);
  const labels = clone(buildPositiveEnvelope());
  labels.evidence.checks[0].source_labels = ['MODEL_PROVEN', 'LIVE_CONFIRMED'];
  sealEvidenceEnvelope(labels);
  assert.throws(() => verifyEvidenceEnvelope(labels), /FIXTURE_MARK/);
});

test('badge fields cannot be inserted by the sealing helper', () => {
  const envelope = clone(buildPositiveEnvelope());
  envelope.source_badges = ['LIVE_CONFIRMED'];
  assert.throws(() => sealEvidenceEnvelope(envelope), /BADGE_FIELD/);
});

test('CLI emits the contract artifact itself, not a wrapper with badge claims', () => {
  const script = fileURLToPath(new URL('../scripts/evidence-fixture.js', import.meta.url));
  const raw = execFileSync(process.execPath, [script, '--revision', BASE_REVISION], { encoding: 'utf8' });
  const envelope = parseJson(raw);
  assert.equal(verifyEvidenceEnvelope(envelope).capture_mode, 'fixture');
  assert.equal(envelope.producer.revision, BASE_REVISION);
  assert.equal(envelope.evidence.checks[0].kind, 'model_replay');
  assert.ok(!('envelope' in envelope));
});

test('EvidenceRecorder records before/action/after with one pre-read per explicit tool call', async () => {
  const fixture = makeFixtureReceipt();
  let current = clone(fixture.initial_state);
  let reads = 0;
  const invocations = [];
  const recorder = new EvidenceRecorder({
    readState: async () => { reads += 1; return current; },
    invokeTool: async (tool, args) => {
      invocations.push({ tool, args });
      const index = invocations.length - 1;
      current = clone(fixture.trajectory[index].after);
      return fixture.trajectory[index].result;
    },
    model: FIXTURE_MODEL,
    bridgeRevision: 'unit-test-existing-bridge',
  });
  await recorder.record('walk', { direction: 'right', run: false, steps: 1 });
  await recorder.record('use_item', { item_id: 1 });
  const receipt = recorder.receipt({ observed_steps: 2 });
  assert.equal(reads, 2); // no post-action polling: post-states came from tool results
  assert.deepEqual(invocations.map(call => call.tool), ['walk', 'use_item']);
  assert.equal(receipt.capture.mode, 'live');
  assert.equal(receipt.capture.recorder, 'EvidenceRecorder.record');
  assert.deepEqual(replayFixtureReceipt(receipt), { passed: true, steps: 2 });
});

test('recorder rejects forbidden power without invoking anything', async () => {
  let invoked = false;
  const recorder = new EvidenceRecorder({
    readState: async () => ({ state: 'EXPLORE', seq: 0 }),
    invokeTool: async () => { invoked = true; return {}; },
    model: { rules: {} },
    bridgeRevision: 'unit-test-existing-bridge',
  });
  await assert.rejects(() => recorder.record('set_switch', { id: 1, value: true }), /TOOL_AUTHORITY/);
  assert.equal(invoked, false);
  assert.ok(!EXISTING_ACTION_TOOLS.includes('teleport'));
  assert.ok(!EXISTING_ACTION_TOOLS.includes('start_event'));
});

test('recorder rejects stale pre-state before invoking the requested tool', async () => {
  const fixture = makeFixtureReceipt();
  let current = clone(fixture.initial_state);
  let invocations = 0;
  const recorder = new EvidenceRecorder({
    readState: async () => current,
    invokeTool: async () => { invocations += 1; current = clone(fixture.trajectory[0].after); return fixture.trajectory[0].result; },
    model: FIXTURE_MODEL,
    bridgeRevision: 'unit-test-existing-bridge',
  });
  await recorder.record('walk', { direction: 'right', run: false, steps: 1 });
  current = { ...current, seq: 500 };
  await assert.rejects(() => recorder.record('use_item', { item_id: 1 }), /STALE_PRESTATE/);
  assert.equal(invocations, 1);
});

test('adapter source contains no added hidden gameplay tool bridge', () => {
  const source = readFileSync(fileURLToPath(new URL('./evidence.js', import.meta.url)), 'utf8');
  assert.ok(!/cdp\.callBridge|cdp\.evaluate|registerTool\(/.test(source));
  for (const forbidden of ['set_switch', 'set_variable', 'teleport', 'start_event', 'skip_video']) {
    assert.ok(!EXISTING_ACTION_TOOLS.includes(forbidden));
  }
  // The module itself never imports the CDP or tool-registration layers.
  assert.ok(buildEvidenceEnvelope instanceof Function);
});
