#!/usr/bin/env node
// Run a scripted task suite against the MCP server and record rounds, time and pass/fail.
//
// The README benchmark table (mirror task: rounds and seconds per model) was measured by
// hand. A suite file turns such a task into data, so the same steps can be rerun against a
// real game after any change, or against the fake game in CI to prove the harness works.
//
//   node scripts/run-tasks.js [suite.json] [--fake] [--report <path>] [--ledger <path>]
//
// Without --fake the suite runs against the game on PMGT_CDP_PORT (start it first, and put
// it in the state the suite expects, e.g. with scripts/goto-explore.js). With --fake it runs
// against test/fake-cdp.js, which proves the wiring only. A human at the keyboard still
// times real model runs; this runner times tool rounds for a fixed script.
//
// Suite format: { name, description, steps: [{ name, tool, args, expect }] } where each
// expect entry is { path, equals } | { path, includes } | { path, exists: true }. Paths are
// dot-separated keys into the parsed tool result ("state.state", "0.name"); "$" is the whole
// result, "$error" the error code, "$isError" whether the call failed.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connectMcp, startSeededFake } from '../test/helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node scripts/run-tasks.js [suite.json] [--fake] [--report <path>] [--ledger <path>]';
// Unknown flags are errors, not silently ignored: a mistyped --fake must not run a suite
// against a live game by accident.
let suiteArg = null;
let fakeMode = false;
let reportPath = null;
let ledgerPath = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake') fakeMode = true;
    else if (a === '--report' || a === '--ledger') {
      if (argv[i + 1] === undefined) { console.error(`${a} needs a path\n${USAGE}`); process.exit(2); }
      if (a === '--report') reportPath = argv[++i];
      else ledgerPath = argv[++i];
    } else if (a.startsWith('--')) {
      console.error(`unknown flag ${a}\n${USAGE}`);
      process.exit(2);
    } else if (!suiteArg) suiteArg = a;
    else {
      console.error(`unexpected argument ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
}
const suitePath = suiteArg || path.join(HERE, '../tasks/mirror.json');

const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
if (!suite.name || !Array.isArray(suite.steps) || suite.steps.length === 0) {
  console.error(`invalid suite ${suitePath}: needs name and a non-empty steps array`);
  process.exit(2);
}

function valueAt(value, isError, p) {
  if (p === '$') return value;
  if (p === '$error') return value?.error ?? null;
  if (p === '$isError') return !!isError;
  let cur = value;
  for (const seg of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

function checkExpect(value, isError, exp) {
  const got = valueAt(value, isError, exp.path);
  if ('equals' in exp) return JSON.stringify(got) === JSON.stringify(exp.equals)
    || `${exp.path}: expected ${JSON.stringify(exp.equals)}, got ${JSON.stringify(got)}`;
  if ('includes' in exp) return JSON.stringify(got ?? '').includes(exp.includes)
    || `${exp.path}: expected to include ${JSON.stringify(exp.includes)}, got ${JSON.stringify(got)?.slice(0, 120)}`;
  if (exp.exists) return got !== undefined || `${exp.path}: missing`;
  return `${exp.path}: unknown expectation ${JSON.stringify(exp)}`;
}

const fake = fakeMode ? await startSeededFake() : null;
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PMGT_')) env[k] = process.env[k];
if (fake) env.PMGT_CDP_PORT = String(fake.port);

const client = await connectMcp(env);
const steps = [];
const t0 = Date.now();
try {
  for (const step of suite.steps) {
    const s0 = Date.now();
    const { result, value } = await call(client, step.tool, step.args || {});
    const ms = Date.now() - s0;
    const failures = (step.expect || []).map(e => checkExpect(value, result.isError, e)).filter(r => r !== true);
    if (!step.expect?.length && result.isError) failures.push(`tool error: ${value?.error || 'unknown'}`);
    const pass = failures.length === 0;
    steps.push({ name: step.name || step.tool, tool: step.tool, ms, pass, failures });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${step.name || step.tool} (${step.tool}, ${ms} ms)${pass ? '' : `: ${failures.join('; ')}`}`);
  }
} finally {
  await client.close();
  if (fake) await fake.close();
}

const report = {
  suite: suite.name,
  at: new Date().toISOString(),
  mode: fakeMode ? 'fake' : 'live',
  rounds: steps.length,
  total_ms: Date.now() - t0,
  pass: steps.every(s => s.pass),
  steps,
};
console.log(`\n${suite.name}: ${report.pass ? 'PASS' : 'FAIL'} in ${report.rounds} rounds, ${report.total_ms} ms (${report.mode})`);
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
if (ledgerPath) {
  const { steps: _steps, ...summary } = report;
  appendFileSync(ledgerPath, JSON.stringify(summary) + '\n');
}
process.exit(report.pass ? 0 : 1);
