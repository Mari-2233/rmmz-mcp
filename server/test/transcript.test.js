// Offline tests for the hash-chained transcript. No game process is needed.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Transcript, canonicalJson, redact, verifyTranscript } from '../src/transcript.js';
import { ok, recorded } from '../src/util.js';

function tmpFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'pmgt-transcript-')), 'session.jsonl');
}

function recordThree(file) {
  const t = new Transcript(file);
  t.record({ tool: 'get_state', args: {}, ok: true, error: null, ms: 3, result: ok({ state: 'EXPLORE' }) });
  t.record({ tool: 'approach', args: { event_id: 9 }, ok: true, error: null, ms: 40, result: ok({ reached: true }) });
  t.record({ tool: 'choose', args: { index: 0 }, ok: false, error: 'INVALID_STATE', ms: 2, result: { isError: true } });
  t.close();
}

test('canonicalJson sorts keys at every level and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.throws(() => canonicalJson({ x: Infinity }), TypeError);
});

test('redact removes credential-shaped strings at any depth', () => {
  const out = redact({ note: 'token ghp_1234567890abcdefghij here', list: ['api_key=supersecretvalue'] });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('ghp_1234'));
  assert.ok(!text.includes('supersecretvalue'));
  assert.ok(text.includes('[REDACTED]'));
  assert.equal(redact('plain dialogue text'), 'plain dialogue text');
});

test('redact treats credential-named keys as secrets whatever the value shape', () => {
  const out = redact({ password: 'hunter2secret', token: 'abc123xyz789', event_id: 9, direction: 'up' });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.event_id, 9);
  assert.equal(out.direction, 'up');
});

test('verifyTranscript reports malformed entries instead of throwing', () => {
  for (const badLine of ['null', '[1,2]', '{"seq":1,"prev":"x","ms":1e999}']) {
    const file = tmpFile();
    writeFileSync(file, badLine + '\n');
    const v = verifyTranscript(file);
    assert.equal(v.ok, false, badLine);
    assert.ok(v.firstBad.reason, badLine);
  }
});

test('a recorded session verifies, with tool and error counts', () => {
  const file = tmpFile();
  recordThree(file);
  const v = verifyTranscript(file);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 3);
  assert.equal(v.errors, 1);
  assert.deepEqual(v.tools, { get_state: 1, approach: 1, choose: 1 });
  assert.match(v.head, /^[0-9a-f]{64}$/);
  assert.notEqual(v.head, '0'.repeat(64));
});

test('reopening a transcript continues the same chain', () => {
  const file = tmpFile();
  recordThree(file);
  const t = new Transcript(file);
  t.record({ tool: 'wait', args: {}, ok: true, error: null, ms: 1, result: ok({ ok: true }) });
  t.close();
  const v = verifyTranscript(file);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 4);
});

test('editing or deleting an entry breaks verification at that entry', () => {
  const file = tmpFile();
  recordThree(file);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const edited = JSON.parse(lines[1]);
  edited.args.event_id = 99;
  writeFileSync(file, [lines[0], JSON.stringify(edited), lines[2]].join('\n') + '\n');
  const v = verifyTranscript(file);
  assert.equal(v.ok, false);
  assert.equal(v.firstBad.seq, 2);
  assert.match(v.firstBad.reason, /hash/);

  writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
  const v2 = verifyTranscript(file);
  assert.equal(v2.ok, false);
  assert.match(v2.firstBad.reason, /seq|prev/);
  assert.throws(() => new Transcript(file), /chain broken/);
});

test('secrets in arguments never reach the file and huge arguments are capped', () => {
  const file = tmpFile();
  const t = new Transcript(file);
  t.record({
    tool: 'eval_js',
    args: { expression: 'fetch(x, {headers: "Bearer abcdefghijklmnop"})', blob: 'x'.repeat(5000) },
    ok: true, error: null, ms: 1, result: ok({ value: 1 }),
  });
  t.close();
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('abcdefghijklmnop'));
  const entry = JSON.parse(text.trim());
  assert.equal(entry.args.truncated, true);
  assert.match(entry.result_sha256, /^[0-9a-f]{64}$/);
});

test('non-JSON argument values are dropped before hashing, so the chain still verifies', () => {
  const file = tmpFile();
  const t = new Transcript(file);
  // Shape of the SDK request-context object handed to tools without an inputSchema.
  t.record({
    tool: 'get_state',
    args: { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {} },
    ok: true, error: null, ms: 1, result: ok({ state: 'EXPLORE' }),
  });
  t.close();
  assert.equal(verifyTranscript(file).ok, true);
});

test('recorded() captures the stable error code and is a no-op without a transcript', async () => {
  const seen = [];
  const fake = { record(e) { seen.push(e); } };
  const h = recorded(fake, 'choose', async () => ({ isError: true, content: [{ type: 'text', text: '{"error":"INVALID_STATE"}' }] }));
  await h({ index: 0 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'choose');
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].error, 'INVALID_STATE');
  const plain = async () => 1;
  assert.equal(recorded(null, 'x', plain), plain);
});
