// Gameplay Evidence Exchange v0.1 adapter for the existing PMGT-MCP tools.
// This module has no CDP connection and adds no gameplay authority. Live capture
// requires caller-supplied get_state and existing-tool invocation functions.

import { createHash } from 'node:crypto';

export const BASE_REVISION = 'dd291a34fae97b5e451a4ec0ca83329b1fb3c29d';
export const DOMAIN = 'pmgt-pocket-mirror';
export const RECEIPT_SCHEMA = 'rmmz-gameplay-observation/v0.1';
export const ARTIFACT_SCHEMA = 'gameplay-evidence/v0.1';
export const FIXTURE_MARK = 'FIXTURE_ONLY';

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLAIM_KINDS = new Set(['route', 'state_transition', 'goal', 'counterexample', 'observation']);

// Names already registered in server/src/tools/game.js. No bridge method is
// invoked by this allowlist itself; EvidenceRecorder calls only the supplied
// invokeTool callback and only after validating the requested action.
export const EXISTING_ACTION_TOOLS = Object.freeze([
  'walk', 'face', 'interact', 'approach', 'read_dialogue', 'reflect',
  'remember', 'restart', 'ask_user', 'advance', 'choose', 'wait',
  'use_item', 'pick_item',
]);
const ACTION_TOOLS = new Set(EXISTING_ACTION_TOOLS);

function problem(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function invariant(condition, code, message) {
  if (!condition) problem(code, message);
}
function object(value, path) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'TYPE', `${path} must be an object`);
}
function keys(value, expected, path) {
  object(value, path);
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  invariant(actual.length === wanted.length && actual.every((key, i) => key === wanted[i]),
    'KEYS', `${path} keys must be exactly ${wanted.join(',')}`);
}
function text(value, path) {
  invariant(typeof value === 'string' && value.length > 0, 'TEXT', `${path} must be nonempty text`);
}
function digest(value, path) {
  invariant(typeof value === 'string' && DIGEST.test(value) && value !== ZERO_DIGEST,
    'DIGEST', `${path} must be a nonzero lowercase SHA-256 digest`);
}
function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}
function copy(value) {
  return parseJson(canonicalStringify(value));
}

// Python compares Unicode code points when sort_keys=True. JavaScript's default
// UTF-16 sort differs for some non-BMP keys, so compare decoded code points.
function codePoints(value) {
  return Array.from(value, character => character.codePointAt(0));
}
function compareCodePoints(left, right) {
  const a = codePoints(left);
  const b = codePoints(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function asciiString(value) {
  // JSON.stringify uses the same JSON escapes as json.dumps for ASCII. Escape
  // every remaining UTF-16 code unit to match ensure_ascii=True, including
  // surrogate pairs and line/paragraph separators.
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function assertJson(value, path = '$', active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    // JS cannot distinguish 1 from 1.0 after parsing. parseJson rejects the
    // latter lexically; here all non-integer and unsafe numeric values close.
    invariant(Number.isSafeInteger(value), 'NON_CANONICAL_NUMBER',
      `${path} must be a safe integer (floating point and non-finite values are forbidden)`);
    const integer = BigInt(value);
    invariant(integer >= I64_MIN && integer <= I64_MAX, 'INT64_RANGE', `${path} is outside signed 64-bit range`);
    return;
  }
  invariant(typeof value === 'object', 'JSON_TYPE', `${path} is not a JSON value`);
  invariant(!active.has(value), 'CYCLE', `${path} contains a cycle`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        invariant(Object.hasOwn(value, i), 'ARRAY_HOLE', `${path}[${i}] is an array hole`);
        assertJson(value[i], `${path}[${i}]`, active);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    invariant(prototype === Object.prototype || prototype === null, 'JSON_OBJECT', `${path} must be a plain object`);
    invariant(Object.getOwnPropertySymbols(value).length === 0, 'JSON_KEY', `${path} has a symbol key`);
    for (const key of Object.keys(value)) assertJson(value[key], `${path}.${key}`, active);
  } finally {
    active.delete(value);
  }
}
function encodeCanonical(value, path = '$') {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value) === value ? asciiString(value) : String(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry, i) => encodeCanonical(entry, `${path}[${i}]`)).join(',')}]`;
  return `{${Object.keys(value).sort(compareCodePoints).map(key =>
    `${asciiString(key)}:${encodeCanonical(value[key], `${path}.${key}`)}`).join(',')}}`;
}

export function canonicalStringify(value) {
  assertJson(value);
  return encodeCanonical(value);
}
export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}
function utf8Bytes(value, path = 'raw') {
  invariant(typeof value === 'string', 'TEXT', `${path} must be text`);
  // Buffer silently replaces unpaired surrogates. Reject them rather than hash
  // bytes different from the purported exact source text.
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      invariant(i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff,
        'INVALID_UNICODE', `${path} contains an unpaired high surrogate`);
      i += 1;
    } else {
      invariant(unit < 0xdc00 || unit > 0xdfff, 'INVALID_UNICODE', `${path} contains an unpaired low surrogate`);
    }
  }
  return Buffer.from(value, 'utf8');
}
export function sha256Raw(value) {
  return createHash('sha256').update(utf8Bytes(value)).digest('hex');
}

// Strict JSON parsing preserves Python's duplicate-key and numeric fail-closed
// behavior. JSON.parse alone would silently collapse duplicates and 1.0 -> 1.
export function parseJson(input) {
  invariant(typeof input === 'string', 'JSON_TEXT', 'JSON input must be text');
  let offset = 0;
  let depth = 0;
  const error = (code, message) => problem(code, `${message} at character ${offset}`);
  function ws() { while (/^[ \t\n\r]$/.test(input[offset] || '')) offset += 1; }
  function string() {
    const start = offset;
    invariant(input[offset] === '"', 'JSON_STRING', 'Expected a string');
    offset += 1;
    while (offset < input.length) {
      const unit = input.charCodeAt(offset);
      if (input[offset] === '"') {
        offset += 1;
        return JSON.parse(input.slice(start, offset));
      }
      invariant(unit > 0x1f, 'JSON_STRING', 'Unescaped control character in string');
      if (input[offset] === '\\') {
        offset += 1;
        invariant(/^[ "\\/bfnrtu]$/.test(input[offset] || ''), 'JSON_STRING', 'Invalid string escape');
        if (input[offset] === 'u') {
          invariant(/^[0-9a-fA-F]{4}$/.test(input.slice(offset + 1, offset + 5)), 'JSON_STRING', 'Invalid Unicode escape');
          offset += 4;
        }
      }
      offset += 1;
    }
    error('JSON_STRING', 'Unterminated string');
  }
  function value() {
    ws();
    depth += 1;
    invariant(depth <= 128, 'JSON_DEPTH', 'JSON nesting exceeds 128 levels');
    try {
      const char = input[offset];
      if (char === '"') return string();
      if (char === '{') {
        offset += 1;
        ws();
        const result = {};
        if (input[offset] === '}') { offset += 1; return result; }
        for (;;) {
          ws();
          const key = string();
          invariant(!Object.hasOwn(result, key), 'DUPLICATE_JSON_KEY', `Duplicate object key ${JSON.stringify(key)}`);
          ws();
          invariant(input[offset] === ':', 'JSON_OBJECT', 'Expected colon');
          offset += 1;
          const child = value();
          // defineProperty is required for the legal JSON key __proto__.
          Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
          ws();
          if (input[offset] === '}') { offset += 1; return result; }
          invariant(input[offset] === ',', 'JSON_OBJECT', 'Expected comma');
          offset += 1;
        }
      }
      if (char === '[') {
        offset += 1;
        ws();
        const result = [];
        if (input[offset] === ']') { offset += 1; return result; }
        for (;;) {
          result.push(value());
          ws();
          if (input[offset] === ']') { offset += 1; return result; }
          invariant(input[offset] === ',', 'JSON_ARRAY', 'Expected comma');
          offset += 1;
        }
      }
      if (input.startsWith('true', offset)) { offset += 4; return true; }
      if (input.startsWith('false', offset)) { offset += 5; return false; }
      if (input.startsWith('null', offset)) { offset += 4; return null; }
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(offset));
      invariant(match, 'JSON_VALUE', 'Expected a JSON value');
      const token = match[0];
      invariant(!/[.eE]/.test(token), 'NON_CANONICAL_NUMBER', `Floating-point number ${token} is forbidden`);
      const integer = BigInt(token);
      invariant(integer >= I64_MIN && integer <= I64_MAX, 'INT64_RANGE', `Integer ${token} is outside signed 64-bit range`);
      invariant(integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER),
        'JS_SAFE_INTEGER', `Integer ${token} exceeds this adapter's exact JS-number boundary`);
      offset += token.length;
      return Number(integer);
    } finally {
      depth -= 1;
    }
  }
  const result = value();
  ws();
  invariant(offset === input.length, 'JSON_TRAILING', 'Trailing JSON content');
  return result;
}

function validateAction(action, path) {
  keys(action, ['tool', 'arguments'], path);
  invariant(ACTION_TOOLS.has(action.tool), 'TOOL_AUTHORITY', `${path}.tool is not an existing action tool`);
  object(action.arguments, `${path}.arguments`);
}
function validateModel(model) {
  object(model, 'model');
  assertJson(model, '$.model');
}
function resultState(result) {
  object(result, 'action result');
  if (typeof result.state === 'string') return result;
  if (result.state && typeof result.state === 'object' && !Array.isArray(result.state)) return result.state;
  problem('AFTER_STATE', 'existing tool result contains no post-action state snapshot');
}
function validateReceipt(receipt) {
  keys(receipt, ['schema', 'capture', 'model', 'initial_state', 'actions', 'trajectory', 'outcome'], 'receipt');
  invariant(receipt.schema === RECEIPT_SCHEMA, 'RECEIPT_SCHEMA', 'wrong source receipt schema');
  keys(receipt.capture, ['mode', 'recorder', 'bridge_revision'], 'receipt.capture');
  invariant(['fixture', 'replay', 'live'].includes(receipt.capture.mode), 'CAPTURE_MODE', 'unknown capture mode');
  text(receipt.capture.recorder, 'receipt.capture.recorder');
  text(receipt.capture.bridge_revision, 'receipt.capture.bridge_revision');
  if (receipt.capture.mode !== 'live') {
    invariant(receipt.capture.recorder !== 'EvidenceRecorder.record', 'LIVE_PROVENANCE',
      'fixture/replay cannot use the live recorder provenance');
  } else {
    invariant(receipt.capture.recorder === 'EvidenceRecorder.record', 'LIVE_PROVENANCE',
      'live receipts require existing-tool recorder provenance');
  }
  validateModel(receipt.model);
  object(receipt.initial_state, 'receipt.initial_state');
  invariant(Array.isArray(receipt.actions) && receipt.actions.length > 0, 'ACTIONS', 'receipt.actions must be nonempty');
  invariant(Array.isArray(receipt.trajectory) && receipt.trajectory.length === receipt.actions.length,
    'TRAJECTORY_LENGTH', 'trajectory must contain exactly one observation per action');
  object(receipt.outcome, 'receipt.outcome');
  let expectedBefore = receipt.initial_state;
  receipt.trajectory.forEach((entry, index) => {
    const path = `receipt.trajectory[${index}]`;
    keys(entry, ['index', 'before', 'action', 'after', 'result'], path);
    invariant(entry.index === index, 'STEP_INDEX', `${path}.index is not contiguous`);
    invariant(same(entry.before, expectedBefore), 'STALE_PRESTATE', `${path}.before does not match the committed predecessor`);
    validateAction(entry.action, `${path}.action`);
    validateAction(receipt.actions[index], `receipt.actions[${index}]`);
    invariant(same(entry.action, receipt.actions[index]), 'ACTION_BINDING', `${path}.action differs from actions[${index}]`);
    object(entry.after, `${path}.after`);
    object(entry.result, `${path}.result`);
    invariant(same(resultState(entry.result), entry.after), 'RESULT_BINDING', `${path}.after is not the existing tool result state`);
    expectedBefore = entry.after;
  });
  assertJson(receipt, '$.receipt');
  return receipt;
}

export function makeReceipt({ capture, model, initialState, actions, trajectory, outcome }) {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    capture,
    model,
    initial_state: copy(initialState),
    actions: copy(actions),
    trajectory: copy(trajectory),
    outcome: copy(outcome),
  };
  return validateReceipt(receipt);
}
export const createSourceReceipt = makeReceipt;

// Live observations use get_state before an explicitly requested action and the
// action's returned state afterward. No post-action get_state or wait is added.
export class EvidenceRecorder {
  constructor({ readState, invokeTool, model, bridgeRevision }) {
    invariant(typeof readState === 'function' && typeof invokeTool === 'function',
      'RECORDER_CALLBACKS', 'readState and invokeTool callbacks are required');
    validateModel(model);
    text(bridgeRevision, 'bridgeRevision');
    this.readState = readState;
    this.invokeTool = invokeTool;
    this.model = copy(model);
    this.bridgeRevision = bridgeRevision;
    this.initialState = null;
    this.trajectory = [];
  }
  async record(tool, args = {}) {
    const action = { tool, arguments: copy(args) };
    validateAction(action, 'action');
    const before = copy(await this.readState());
    object(before, 'before');
    if (this.initialState === null) this.initialState = before;
    invariant(this.trajectory.length === 0 || same(before, this.trajectory.at(-1).after),
      'STALE_PRESTATE', 'pre-action state differs from the preceding observed post-state; action was not invoked');
    // Only this explicitly authorized existing-tool call can mutate the game.
    const returned = await this.invokeTool(tool, copy(args));
    const result = copy(returned);
    const after = copy(resultState(result));
    const entry = { index: this.trajectory.length, before, action, after, result };
    this.trajectory.push(entry);
    return returned;
  }
  receipt(outcome = null) {
    invariant(this.initialState !== null && this.trajectory.length > 0, 'EMPTY_RECEIPT', 'no live observations recorded');
    const finalOutcome = outcome === null
      ? { observed_steps: this.trajectory.length, terminal_state: this.trajectory.at(-1).after.state || 'unspecified' }
      : outcome;
    return makeReceipt({
      capture: { mode: 'live', recorder: 'EvidenceRecorder.record', bridge_revision: this.bridgeRevision },
      model: this.model,
      initialState: this.initialState,
      actions: this.trajectory.map(entry => entry.action),
      trajectory: this.trajectory,
      outcome: finalOutcome,
    });
  }
}

export const FIXTURE_MODEL = Object.freeze({
  profile: 'pmgt-existing-tool-fixture/v0.1',
  rules: {
    walk: 'walk one safe-integer grid tile through the existing walk tool; synthetic completed result',
    use_item: 'item 1 used through use_item on the faced shortcut event starts its synthetic event chain',
  },
  assumptions: [
    'This model covers only the two supplied synthetic observations.',
    'It is not a complete RPG Maker, Pocket Mirror, collision, route-search, or event interpreter.',
  ],
});

export function replayFixtureReceipt(receipt) {
  validateReceipt(receipt);
  invariant(same(receipt.model, FIXTURE_MODEL), 'MODEL_PROFILE', 'receipt does not use the fixture replay model');
  receipt.trajectory.forEach((entry, index) => {
    const path = `trajectory[${index}]`;
    const before = entry.before;
    const after = copy(before);
    invariant(Number.isSafeInteger(before.seq), 'STATE_SCHEMA', `${path}.before.seq must be an integer`);
    after.seq = before.seq + 1;
    let expectedResult;
    if (entry.action.tool === 'walk') {
      keys(entry.action.arguments, ['direction', 'run', 'steps'], `${path}.action.arguments`);
      const { direction, run, steps } = entry.action.arguments;
      invariant(['up', 'down', 'left', 'right'].includes(direction) && steps === 1 && typeof run === 'boolean',
        'ACTION_SCHEMA', `${path} is outside the one-step walk fixture`);
      invariant(before.state === 'EXPLORE', 'PRECONDITION', `${path} walk requires EXPLORE`);
      const player = before.player;
      invariant(player && Number.isSafeInteger(player.x) && Number.isSafeInteger(player.y),
        'STATE_SCHEMA', `${path} requires integer player coordinates`);
      after.player = { ...player };
      if (direction === 'right') after.player.x += 1;
      if (direction === 'left') after.player.x -= 1;
      if (direction === 'down') after.player.y += 1;
      if (direction === 'up') after.player.y -= 1;
      expectedResult = {
        path: [{ x: after.player.x, y: after.player.y }],
        state: after,
        stop_reason: 'completed',
      };
    } else if (entry.action.tool === 'use_item') {
      keys(entry.action.arguments, ['item_id'], `${path}.action.arguments`);
      invariant(entry.action.arguments.item_id === 1, 'ACTION_SCHEMA', `${path} uses an item outside the fixture`);
      const event = before.nearby_event;
      invariant(event && Number.isSafeInteger(event.id) && event.shortcut === true,
        'PRECONDITION', `${path} requires a faced shortcut event`);
      after.state = 'CUTSCENE';
      after.allowed_actions = ['advance', 'wait'];
      expectedResult = { eventId: event.id, started: true, state: after };
    } else {
      problem('MODEL_PROFILE', `${path} tool is not covered by the fixture replay`);
    }
    invariant(same(entry.after, after), 'TRAJECTORY_MISMATCH', `${path}.after is not the replayed post-state`);
    invariant(same(entry.result, expectedResult), 'RESULT_MISMATCH', `${path}.result is not the replayed existing-tool result`);
  });
  return { passed: true, steps: receipt.trajectory.length };
}

export function makeFixtureReceipt() {
  const initial = {
    seq: 0,
    state: 'EXPLORE',
    map: 1,
    player: { x: 5, y: 5, d: 'right' },
    nearby_event: { id: 7, shortcut: true },
    allowed_actions: ['walk', 'use_item'],
  };
  const walked = {
    ...initial,
    seq: 1,
    player: { ...initial.player, x: 6 },
  };
  const triggered = {
    ...walked,
    seq: 2,
    state: 'CUTSCENE',
    allowed_actions: ['advance', 'wait'],
  };
  const walk = { tool: 'walk', arguments: { direction: 'right', run: false, steps: 1 } };
  const item = { tool: 'use_item', arguments: { item_id: 1 } };
  return makeReceipt({
    capture: { mode: 'fixture', recorder: 'synthetic-fixture', bridge_revision: 'not-connected' },
    model: FIXTURE_MODEL,
    initialState: initial,
    actions: [walk, item],
    trajectory: [
      {
        index: 0,
        before: initial,
        action: walk,
        after: walked,
        result: { path: [{ x: 6, y: 5 }], state: walked, stop_reason: 'completed' },
      },
      {
        index: 1,
        before: walked,
        action: item,
        after: triggered,
        result: { eventId: 7, started: true, state: triggered },
      },
    ],
    outcome: { event_started: true, event_id: 7, observed_steps: 2 },
  });
}

export const SIMGRAMMAR_MECHANICS = Object.freeze({
  direct_avatar: {
    id: 'direct-avatar',
    path: 'data/mechanics/direct-avatar.yaml',
    source_revision: 'a1156e80714de0221fefdb037bf2732824a6d156',
    raw_sha256: '938a4f7e40be95ddcd445d16da6559843f5f3d7d450f41ede72f4e11ae7009e1',
  },
  triggered_event_chains: {
    id: 'triggered-event-chains',
    path: 'data/mechanics/triggered-event-chains.yaml',
    source_revision: 'a1156e80714de0221fefdb037bf2732824a6d156',
    raw_sha256: '9fe6ebac3c91b7c218f7745a86ce114630a448aea1f7ae1a89c69ec8c4cb789b',
  },
});

function validateChecker(checker) {
  keys(checker, ['name', 'revision', 'artifact_sha256'], 'checker');
  text(checker.name, 'checker.name');
  text(checker.revision, 'checker.revision');
  digest(checker.artifact_sha256, 'checker.artifact_sha256');
}
function commitments(payload) {
  return {
    initial_state_sha256: payload.initial_state_sha256,
    actions_sha256: payload.actions_sha256,
    trajectory_sha256: payload.trajectory_sha256,
  };
}
function validateCheck(check, payload, path) {
  keys(check, ['kind', 'status', 'checker', 'source_labels', 'initial_state_sha256', 'actions_sha256', 'trajectory_sha256'], path);
  invariant(['model_replay', 'model_proof', 'live_execution'].includes(check.kind), 'CHECK_KIND', `${path}.kind is unknown`);
  invariant(['PASS', 'FAIL'].includes(check.status), 'CHECK_STATUS', `${path}.status must be PASS or FAIL`);
  validateChecker(check.checker);
  invariant(Array.isArray(check.source_labels) && check.source_labels.every(label => typeof label === 'string' && label.length > 0),
    'SOURCE_LABELS', `${path}.source_labels must contain nonempty strings`);
  invariant(same(commitments(payload), commitments(check)), 'CHECK_COMMITMENTS', `${path} commitments differ from payload`);
}
function assertLiveProvenance(receipt) {
  invariant(receipt.capture.mode === 'live' && receipt.capture.recorder === 'EvidenceRecorder.record',
    'FALSE_LIVE_LABEL', 'fixture and replay receipts can never carry a live_execution check');
}
export function makeCheck(receipt, { kind, checker, sourceLabels }) {
  validateReceipt(receipt);
  invariant(kind !== 'model_proof', 'MODEL_PROOF_AUTHORITY', 'this adapter has no model prover');
  if (kind === 'model_replay') replayFixtureReceipt(receipt);
  if (kind === 'live_execution') assertLiveProvenance(receipt);
  invariant(['model_replay', 'live_execution'].includes(kind), 'CHECK_KIND', 'unknown evidence check kind');
  validateChecker(checker);
  const payload = payloadFromReceipt(receipt);
  return {
    kind,
    status: 'PASS',
    checker: copy(checker),
    source_labels: copy(sourceLabels),
    ...commitments(payload),
  };
}
function payloadFromReceipt(receipt) {
  return {
    domain: DOMAIN,
    model: copy(receipt.model),
    model_sha256: sha256Canonical(receipt.model),
    initial_state: copy(receipt.initial_state),
    initial_state_sha256: sha256Canonical(receipt.initial_state),
    actions: copy(receipt.actions),
    actions_sha256: sha256Canonical(receipt.actions),
    trajectory: copy(receipt.trajectory),
    trajectory_sha256: sha256Canonical(receipt.trajectory),
    outcome: copy(receipt.outcome),
  };
}
function validateMechanic(mechanic, path) {
  keys(mechanic, ['id', 'path', 'source_revision', 'raw_sha256'], path);
  invariant(IDENTIFIER.test(mechanic.id), 'MECHANIC_ID', `${path}.id is invalid`);
  invariant(mechanic.path.endsWith('.yaml') && !mechanic.path.startsWith('/') && !mechanic.path.split('/').includes('..'),
    'MECHANIC_PATH', `${path}.path is not repository relative YAML`);
  invariant(COMMIT.test(mechanic.source_revision), 'MECHANIC_REVISION', `${path}.source_revision is invalid`);
  digest(mechanic.raw_sha256, `${path}.raw_sha256`);
}
function validateProducer(producer) {
  keys(producer, ['repository', 'revision', 'adapter'], 'producer');
  invariant(REPOSITORY.test(producer.repository), 'PRODUCER_REPOSITORY', 'producer.repository must be owner/repository');
  invariant(COMMIT.test(producer.revision), 'PRODUCER_REVISION', 'producer.revision must be a 40-character commit');
  text(producer.adapter, 'producer.adapter');
}
function validateClaim(claim) {
  keys(claim, ['id', 'kind', 'statement'], 'claim');
  invariant(IDENTIFIER.test(claim.id), 'CLAIM_ID', 'claim.id is invalid');
  invariant(CLAIM_KINDS.has(claim.kind), 'CLAIM_KIND', 'claim.kind is unknown');
  text(claim.statement, 'claim.statement');
}
function validateControls(controls) {
  invariant(Array.isArray(controls), 'NEGATIVE_CONTROLS', 'negative_controls must be an array');
  controls.forEach((control, index) => {
    keys(control, ['name', 'mutation', 'observed', 'passed'], `negative_controls[${index}]`);
    text(control.name, `negative_controls[${index}].name`);
    text(control.mutation, `negative_controls[${index}].mutation`);
    text(control.observed, `negative_controls[${index}].observed`);
    invariant(typeof control.passed === 'boolean', 'NEGATIVE_CONTROL_RESULT', 'negative control passed must be a boolean');
  });
}
function seal(envelope) {
  const unsigned = {};
  for (const key of Object.keys(envelope)) if (key !== 'artifact_sha256') unsigned[key] = envelope[key];
  envelope.artifact_sha256 = sha256Canonical(unsigned);
  return envelope;
}
export function sealEvidenceEnvelope(envelope) {
  invariant(!Object.hasOwn(envelope, 'source_badges') && !Object.hasOwn(envelope, 'admitted_badges'),
    'BADGE_FIELD', 'badge report fields cannot be embedded in artifacts');
  return seal(envelope);
}

export function buildEvidenceEnvelope({ receipt, producer, claim, mechanics = [], checks, negativeControls, limitations }) {
  const parsed = typeof receipt === 'string' ? parseJson(receipt) : receipt;
  validateReceipt(parsed);
  const raw = typeof receipt === 'string' ? receipt : canonicalStringify(parsed);
  sha256Raw(raw);
  const payload = payloadFromReceipt(parsed);
  validateProducer(producer);
  validateClaim(claim);
  invariant(Array.isArray(mechanics), 'MECHANICS', 'mechanics must be an array');
  mechanics.forEach((entry, index) => validateMechanic(entry, `mechanics[${index}]`));
  invariant(Array.isArray(checks) && checks.length > 0, 'CHECKS', 'at least one evidence check is required');
  checks.forEach((check, index) => validateCheck(check, payload, `checks[${index}]`));
  for (const check of checks.filter(entry => entry.status === 'PASS')) {
    if (check.kind === 'model_replay') replayFixtureReceipt(parsed);
    if (check.kind === 'live_execution') {
      assertLiveProvenance(parsed);
      invariant(checks.some(entry => entry.status === 'PASS' && ['model_replay', 'model_proof'].includes(entry.kind)),
        'LIVE_MODEL_SUPPORT', 'live_execution requires a supporting passing model check on the same commitments');
      invariant(negativeControls.some(control => control.passed === true),
        'LIVE_NEGATIVE_CONTROL', 'live_execution requires a passing negative control');
    }
  }
  validateControls(negativeControls);
  invariant(Array.isArray(limitations) && limitations.length > 0 && limitations.every(entry => typeof entry === 'string' && entry.length > 0),
    'LIMITATIONS', 'limitations must be a nonempty array of nonempty strings');
  if (parsed.capture.mode !== 'live') {
    invariant(!checks.some(entry => entry.kind === 'live_execution'), 'FALSE_LIVE_LABEL',
      'fixture/replay artifacts cannot contain live_execution checks, even failed ones');
    invariant(checks.every(entry => entry.source_labels.includes(FIXTURE_MARK)), 'FIXTURE_MARK',
      'every fixture/replay check must retain FIXTURE_ONLY');
    invariant(limitations.some(entry => /no live/i.test(entry)), 'FIXTURE_LIMITATION',
      'fixture/replay limitations must explicitly state no live execution');
  }
  const envelope = {
    schema: ARTIFACT_SCHEMA,
    artifact_sha256: ZERO_DIGEST,
    producer: copy(producer),
    claim: copy(claim),
    mechanics: copy(mechanics),
    payload,
    evidence: { checks: copy(checks), negative_controls: copy(negativeControls), limitations: copy(limitations) },
    source: { media_type: 'application/json', raw_sha256: sha256Raw(raw), raw },
  };
  sealEvidenceEnvelope(envelope);
  verifyEvidenceEnvelope(envelope);
  return envelope;
}

export function verifyEvidenceEnvelope(document) {
  const envelope = typeof document === 'string' ? parseJson(document) : document;
  keys(envelope, ['schema', 'artifact_sha256', 'producer', 'claim', 'mechanics', 'payload', 'evidence', 'source'], 'artifact');
  invariant(envelope.schema === ARTIFACT_SCHEMA, 'ARTIFACT_SCHEMA', 'wrong artifact schema');
  digest(envelope.artifact_sha256, 'artifact_sha256');
  assertJson(envelope, '$.artifact');
  validateProducer(envelope.producer);
  validateClaim(envelope.claim);
  invariant(Array.isArray(envelope.mechanics), 'MECHANICS', 'mechanics must be an array');
  envelope.mechanics.forEach((entry, index) => validateMechanic(entry, `mechanics[${index}]`));
  const payload = envelope.payload;
  keys(payload, ['domain', 'model', 'model_sha256', 'initial_state', 'initial_state_sha256',
    'actions', 'actions_sha256', 'trajectory', 'trajectory_sha256', 'outcome'], 'payload');
  invariant(IDENTIFIER.test(payload.domain), 'DOMAIN', 'payload.domain is invalid');
  validateModel(payload.model);
  object(payload.initial_state, 'payload.initial_state');
  invariant(Array.isArray(payload.actions), 'ACTIONS', 'payload.actions must be an array');
  invariant(Array.isArray(payload.trajectory), 'TRAJECTORY', 'payload.trajectory must be an array');
  object(payload.outcome, 'payload.outcome');
  for (const field of ['model', 'initial_state', 'actions', 'trajectory']) {
    digest(payload[`${field}_sha256`], `payload.${field}_sha256`);
    invariant(payload[`${field}_sha256`] === sha256Canonical(payload[field]),
      'PAYLOAD_COMMITMENT', `payload.${field}_sha256 does not commit to ${field}`);
  }
  keys(envelope.evidence, ['checks', 'negative_controls', 'limitations'], 'evidence');
  invariant(Array.isArray(envelope.evidence.checks) && envelope.evidence.checks.length > 0, 'CHECKS', 'checks must be nonempty');
  envelope.evidence.checks.forEach((check, index) => validateCheck(check, payload, `evidence.checks[${index}]`));
  validateControls(envelope.evidence.negative_controls);
  const limitations = envelope.evidence.limitations;
  invariant(Array.isArray(limitations) && limitations.length > 0 && limitations.every(entry => typeof entry === 'string' && entry.length > 0),
    'LIMITATIONS', 'limitations must be a nonempty array of nonempty strings');
  keys(envelope.source, ['media_type', 'raw_sha256', 'raw'], 'source');
  invariant(envelope.source.media_type === 'application/json', 'SOURCE_MEDIA', 'source media_type must be application/json');
  digest(envelope.source.raw_sha256, 'source.raw_sha256');
  text(envelope.source.raw, 'source.raw');
  invariant(envelope.source.raw_sha256 === sha256Raw(envelope.source.raw), 'SOURCE_COMMITMENT', 'source raw digest mismatch');
  const receipt = parseJson(envelope.source.raw);
  validateReceipt(receipt);
  invariant(same(payloadFromReceipt(receipt), payload), 'SOURCE_PAYLOAD_BINDING', 'payload differs from the source observation receipt');
  for (const check of envelope.evidence.checks.filter(entry => entry.status === 'PASS')) {
    if (check.kind === 'model_replay') replayFixtureReceipt(receipt);
    if (check.kind === 'live_execution') {
      assertLiveProvenance(receipt);
      invariant(envelope.evidence.checks.some(entry => entry.status === 'PASS' && ['model_replay', 'model_proof'].includes(entry.kind)),
        'LIVE_MODEL_SUPPORT', 'live_execution lacks a supporting passing model check');
      invariant(envelope.evidence.negative_controls.some(control => control.passed === true),
        'LIVE_NEGATIVE_CONTROL', 'live_execution lacks a passing negative control');
    }
  }
  if (receipt.capture.mode !== 'live') {
    invariant(!envelope.evidence.checks.some(check => check.kind === 'live_execution'), 'FALSE_LIVE_LABEL',
      'fixture/replay cannot contain live_execution checks');
    invariant(envelope.evidence.checks.every(check => check.source_labels.includes(FIXTURE_MARK)), 'FIXTURE_MARK',
      'fixture/replay checks must retain FIXTURE_ONLY');
    invariant(limitations.some(entry => /no live/i.test(entry)), 'FIXTURE_LIMITATION', 'missing no-live limitation');
  }
  const expectedDigest = sha256Canonical(Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'artifact_sha256')));
  invariant(envelope.artifact_sha256 === expectedDigest, 'ARTIFACT_COMMITMENT', 'artifact_sha256 mismatch');
  return { valid: true, artifact_sha256: envelope.artifact_sha256, capture_mode: receipt.capture.mode };
}

export function validateChecks(payload, checks, receipt = null) {
  try {
    checks.forEach((check, index) => validateCheck(check, payload, `checks[${index}]`));
    if (receipt !== null) {
      validateReceipt(receipt);
      invariant(same(payloadFromReceipt(receipt), payload), 'SOURCE_PAYLOAD_BINDING', 'payload differs from receipt');
      for (const check of checks.filter(entry => entry.status === 'PASS')) {
        if (check.kind === 'model_replay') replayFixtureReceipt(receipt);
        if (check.kind === 'live_execution') assertLiveProvenance(receipt);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function rejectedControl(name, mutation, operation) {
  try {
    operation();
  } catch (error) {
    return { name, mutation, observed: `${error.code || 'ERROR'}: ${error.message}`, passed: true };
  }
  problem('NEGATIVE_CONTROL_ACCEPTED', `${name} mutation was not rejected`);
}
export function fixtureNegativeControls(receipt) {
  const controls = [];
  controls.push(rejectedControl('stale-prestate', 'initial_state.seq changed without matching trajectory', () => {
    const mutant = copy(receipt);
    mutant.initial_state.seq = 99;
    replayFixtureReceipt(mutant);
  }));
  controls.push(rejectedControl('action-substitution', 'walk direction changed in actions and trajectory without replaying its result', () => {
    const mutant = copy(receipt);
    mutant.actions[0].arguments.direction = 'left';
    mutant.trajectory[0].action.arguments.direction = 'left';
    replayFixtureReceipt(mutant);
  }));
  controls.push(rejectedControl('skipped-step', 'last trajectory observation removed while action commitment retained', () => {
    const mutant = copy(receipt);
    mutant.trajectory.pop();
    replayFixtureReceipt(mutant);
  }));
  controls.push(rejectedControl('trajectory-mismatch', 'walk post-state x coordinate increased without an action', () => {
    const mutant = copy(receipt);
    mutant.trajectory[0].after.player.x += 1;
    replayFixtureReceipt(mutant);
  }));
  controls.push(rejectedControl('false-live-label', 'live_execution requested for a synthetic fixture', () => {
    assertLiveProvenance(receipt);
  }));
  controls.push(rejectedControl('invalid-safe-integer', 'unsafe JavaScript integer inserted into initial state', () => {
    const mutant = copy(receipt);
    mutant.initial_state.unsafe = Number.MAX_SAFE_INTEGER + 1;
    replayFixtureReceipt(mutant);
  }));
  return controls;
}

export const FIXTURE_CHECKER_BUNDLE = Object.freeze({
  algorithm: 'pmgt-existing-tool-fixture/v0.1',
  implementation: 'server/src/evidence.js:replayFixtureReceipt',
  semantics: 'strict receipt binding plus synthetic one-step walk/use_item transition replay',
});

export function buildPositiveEnvelope({
  revision = BASE_REVISION,
  checkerArtifactSha256 = sha256Canonical(FIXTURE_CHECKER_BUNDLE),
} = {}) {
  const receipt = makeFixtureReceipt();
  const checker = {
    name: 'rmmz-mcp existing-tool fixture replay',
    revision,
    artifact_sha256: checkerArtifactSha256,
  };
  const check = makeCheck(receipt, {
    kind: 'model_replay',
    checker,
    sourceLabels: [FIXTURE_MARK, 'OBSERVED', 'REPLAYED'],
  });
  return buildEvidenceEnvelope({
    receipt,
    producer: {
      repository: 'Mari-2233/rmmz-mcp',
      revision,
      adapter: 'server/scripts/evidence-fixture.js',
    },
    claim: {
      id: 'pmgt-fixture-walk-use-item',
      kind: 'observation',
      statement: 'A synthetic existing-tool walk followed by use_item starts event 7 in this fixture; this is not a live Pocket Mirror observation.',
    },
    mechanics: [SIMGRAMMAR_MECHANICS.direct_avatar, SIMGRAMMAR_MECHANICS.triggered_event_chains],
    checks: [check],
    negativeControls: fixtureNegativeControls(receipt),
    limitations: [
      'FIXTURE_ONLY: every state and existing-tool result is synthetic; no live game or RPG Maker engine was run.',
      'The replay covers only the two supplied synthetic transitions, not general Pocket Mirror rules, collision completeness, route search or minimality, milestones, or game completion.',
      'Only direct-avatar and triggered-event-chains are exercised; the other candidate SimGrammar mechanics are deliberately unbound.',
      'LIVE_CONFIRMED requires separate genuine live_execution evidence plus a supporting model check and negative control on identical initial-state, action, and trajectory commitments; structural consumers admit only OBSERVED.',
    ],
  });
}
