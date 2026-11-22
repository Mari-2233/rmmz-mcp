// Append-only, hash-chained session transcript (JSONL). Opt in with PMGT_TRANSCRIPT=<path>.
//
// Why: the README claims fair play (no teleport, no switch writes, no spoilers), and benchmark
// tables claim rounds and wall time per task. A transcript makes those claims checkable after
// the fact: which tools ran, in what order, with what arguments, and whether they failed.
// Each entry links to the previous entry's SHA-256, so editing or deleting a line breaks the
// chain and `node scripts/verify-transcript.js <file>` reports the first bad entry. Without a
// secret key this is tamper-evident, not tamper-proof: anyone can rewrite the whole file and
// recompute the chain. Keep the head hash somewhere else (a commit, an issue) to pin a run.
//
// What is stored: tool name, redacted arguments (capped), ok/error, duration, and the SHA-256
// plus byte length of the full result. Full results are not stored, so screenshots and whole
// dialogue dumps stay out of the file. Secret-looking strings are redacted before hashing.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { log } from './util.js';

export const GENESIS = '0'.repeat(64);
const REDACTED = '[REDACTED]';
const MAX_ARGS_CHARS = 2000;

// Credential-shaped patterns, redacted wherever they appear in recorded values.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`],
  [/(\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|password)\s*[:=]\s*)["']?[^\s"',;}{]{8,}["']?/gi, `$1${REDACTED}`],
];

// Keys whose values are credentials by position, whatever shape the value has.
const SECRET_KEY = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)/i;

export function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = typeof k === 'string' ? redact(k) : k;
      out[key] = SECRET_KEY.test(String(k)) && (typeof v === 'string' || typeof v === 'number') ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

// Deterministic JSON: object keys sorted at every level. Numbers must be finite.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in transcript entry');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Cap recorded arguments so one huge call cannot bloat the ledger; keep a hash of the whole.
// Arguments first pass through a JSON round-trip, so functions, signals and other non-JSON
// values a caller might hand in are dropped before hashing. Without this, the hash computed
// at record time could cover values that JSON.stringify never wrote to the file.
function capArgs(args) {
  let plain;
  try { plain = JSON.parse(JSON.stringify(args ?? {})); }
  catch { plain = { unserializable: true }; }
  const clean = redact(plain);
  const text = canonicalJson(clean);
  if (text.length <= MAX_ARGS_CHARS) return clean;
  return { truncated: true, sha256: sha256(text), bytes: Buffer.byteLength(text), head: text.slice(0, 500) };
}

function entryHash(entry) {
  const { hash, ...rest } = entry;
  return sha256(`${entry.prev}\n${canonicalJson(rest)}`);
}

// Verify a transcript file. Returns counts and the first bad entry, if any. Read-only.
export function verifyTranscript(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const tools = {};
  let errors = 0;
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); }
    catch { return { ok: false, entries: i, tools, errors, head: prev, firstBad: { seq: i + 1, reason: 'line is not JSON' } }; }
    const bad = reason => ({ ok: false, entries: i, tools, errors, head: prev, firstBad: { seq: entry?.seq ?? i + 1, reason } });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad('entry is not an object');
    if (entry.seq !== i + 1) return bad(`seq ${entry.seq} out of order (expected ${i + 1})`);
    if (entry.prev !== prev) return bad('prev does not match the previous hash');
    let recomputed;
    try { recomputed = entryHash(entry); }
    catch { return bad('entry cannot be canonicalized (non-finite number?)'); }
    if (recomputed !== entry.hash) return bad('hash does not match the entry contents');
    tools[entry.tool] = (tools[entry.tool] || 0) + 1;
    if (!entry.ok) errors++;
    prev = entry.hash;
  }
  return { ok: true, entries: lines.length, tools, errors, head: prev, firstBad: null };
}

export class Transcript {
  // Opens the file for appending. An existing file is verified first, so a new session
  // continues a good chain and refuses to extend a broken one. Throws on a broken chain;
  // the caller decides whether to run without a transcript.
  constructor(filePath) {
    this.path = filePath;
    this.seq = 0;
    this.prev = GENESIS;
    this.disabled = false;
    try {
      const v = verifyTranscript(filePath);
      if (!v.ok) throw new Error(`transcript chain broken at seq ${v.firstBad.seq}: ${v.firstBad.reason}`);
      this.seq = v.entries;
      this.prev = v.head;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    this.fd = openSync(filePath, 'a');
  }

  // Append one tool call. Never throws: a full disk must not take the game down with it.
  record({ tool, args, ok, error, ms, result }) {
    if (this.disabled) return;
    try {
      // Hash a summary of image results instead of copying base64 screenshots through
      // JSON.stringify on every call. Full results are never stored either way.
      const summarized = Array.isArray(result?.content)
        ? { ...result, content: result.content.map(c => (c?.type === 'image' ? { type: 'image', bytes: c.data?.length || 0, mimeType: c.mimeType } : c)) }
        : result;
      const resultText = JSON.stringify(summarized ?? null);
      const entry = {
        seq: this.seq + 1,
        ts: new Date().toISOString(),
        kind: 'tool',
        tool,
        args: capArgs(args),
        ok: !!ok,
        error: error || null,
        ms: Math.round(ms || 0),
        result_sha256: sha256(resultText),
        result_bytes: Buffer.byteLength(resultText),
        prev: this.prev,
      };
      entry.hash = entryHash(entry);
      writeSync(this.fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(this.fd);
      this.seq = entry.seq;
      this.prev = entry.hash;
    } catch (e) {
      this.disabled = true;
      log('transcript disabled after write failure:', e.message);
    }
  }

  close() {
    try { closeSync(this.fd); } catch { /* already closed */ }
  }
}

