#!/usr/bin/env node
// Smoke test: spawn the MCP server over stdio with the official client, list tools, call them.
//   PMGT_MCP_DEV=1 PMGT_CDP_PORT=9337 npm run smoke
// Game must run on PMGT_CDP_PORT (default 9333) and be in map 23 EXPLORE (run scripts/goto-explore.js
// first) for the gameplay sequence. Steps whose bridge method isn't loaded yet are reported as SKIP.
// Never saves the game.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: { ...process.env, PMGT_MCP_DEV: process.env.PMGT_MCP_DEV ?? '1' },
  stderr: 'inherit',
});
const client = new Client({ name: 'pmgt-smoke', version: '0.0.0' });
await client.connect(transport);

const results = [];
const short = (s, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s);
function report(status, name, info) {
  results.push({ status, name });
  console.log(`${status.padEnd(4)} ${name}${info ? ': ' + info : ''}`);
}
// Call a tool, parse its JSON. NOT_READY / BRIDGE_* errors → SKIP (game-side part missing).
async function step(name, tool, args = {}, check = () => true, fmt = v => short(JSON.stringify(v))) {
  let r;
  try { r = await client.callTool({ name: tool, arguments: args }); } catch (e) {
    report('FAIL', name, `protocol error ${e.message}`); return null;
  }
  const text = r.content?.[0]?.text ?? '';
  let v; try { v = JSON.parse(text); } catch { v = text; }
  if (r.isError) {
    const skip = v?.error === 'NOT_READY';
    report(skip ? 'SKIP' : 'FAIL', name, short(text));
    return skip ? undefined : null;
  }
  let pass, why = '';
  try { pass = check(v); } catch (e) { pass = false; why = e.message; }
  if (typeof pass === 'string') { why = pass; pass = false; }
  report(pass ? 'PASS' : 'FAIL', name, (why ? why + ' | ' : '') + fmt(v));
  return v;
}

// ---- generic ----
const { tools } = await client.listTools();
console.log('tools:', tools.map(t => t.name).join(', '));
const expected = ['ping', 'screenshot', 'get_pushed_events', 'get_state', 'get_log', 'list_events', 'map_grid',
  'list_items', 'get_variables', 'get_switches', 'describe_event', 'walk', 'face', 'interact', 'advance',
  'choose', 'wait', 'use_item', 'pick_item'];
const missing = expected.filter(n => !tools.some(t => t.name === n));
const forbidden = ['set_switch', 'set_variable', 'teleport', 'start_event', 'skip_video'].filter(n => tools.some(t => t.name === n));
report(missing.length || forbidden.length ? 'FAIL' : 'PASS', 'tool list',
  `${tools.length} tools` + (missing.length ? `; missing ${missing}` : '') + (forbidden.length ? `; forbidden ${forbidden}` : ''));
const descChars = tools.reduce((n, t) => n + (t.description?.length || 0), 0);
const listChars = JSON.stringify(tools).length;
report(descChars < 2500 ? 'PASS' : 'FAIL', 'description size', `descriptions ${descChars} chars, tools/list JSON ${listChars} chars`);
const instr = client.getInstructions?.() ?? '';
report(instr.length > 0 && instr.length <= 2000 ? 'PASS' : 'FAIL', 'instructions', `${instr.length} chars`);

const ping = await step('ping', 'ping', {}, v => v.connected === true);
if (!ping) { summary(); process.exit(); }

await step('screenshot', 'screenshot', { scale: 0.25 }, () => true, () => 'image');
if (tools.some(t => t.name === 'reload_bridge')) await step('reload_bridge', 'reload_bridge', {}, v => v.reloaded);
await step('get_pushed_events', 'get_pushed_events', {}, v => typeof v.latest === 'number', v => `latest=${v.latest}`);

// ---- gameplay sequence (map 23, player at (19,12) after goto-explore) ----
const st = await step('get_state', 'get_state', {}, v => v.state === 'EXPLORE' || `state ${v.state} (run goto-explore.js first)`,
  v => `${v.state} map=${v.map?.id} player=${JSON.stringify(v.player)} allowed=${v.allowed_actions}`);
const logStart = st?.seq ?? 0;

await step('map_grid', 'map_grid', {}, v => Array.isArray(v.rows) && v.rows.some(r => r.includes('@')),
  v => `origin=${JSON.stringify(v.origin)}\n` + v.rows.map(r => '       ' + r).join('\n'));
await step('list_events', 'list_events', { radius: 8 }, v => Array.isArray(v) && v.length > 0,
  v => v.slice(0, 6).map(e => `${e.id}:${e.name}@${e.x},${e.y}`).join(' '));
await step('describe_event 9', 'describe_event', { id: 9 }, v => Array.isArray(v.lines),
  v => `${v.name} page=${v.page} lines=${v.lines.length}`);
await step('list_items', 'list_items', {}, v => Array.isArray(v), v => `${v.length} items`);
await step('get_switches named', 'get_switches', {}, v => Array.isArray(v) && v.length > 0, v => `${v.length} named switches`);
await step('get_variables ids', 'get_variables', { ids: [21, 22, 23] }, v => Array.isArray(v) && v.length === 3,
  v => JSON.stringify(v));

const w = await step('walk up 1', 'walk', { direction: 'up', steps: 1 }, v => v.moved >= 1 || `moved=${v.moved} stop=${v.stop}`,
  v => `moved=${v.moved} path=${JSON.stringify(v.path)} stop=${v.stop} facing=${JSON.stringify(v.state?.facing)}`);
await step('face up', 'face', { direction: 'up' }, v => !!v.state, v => `facing=${JSON.stringify(v.state?.facing)}`);
const it = await step('interact', 'interact', {}, v => v.started === true || 'started=false',
  v => `started=${v.started} eventId=${v.eventId} state=${v.state?.state}`);

if (it?.started) {
  let s = it.state, texts = [], n = 0, ok = true;
  while (s?.state !== 'EXPLORE' && n < 25) {
    const tool = s?.state === 'CHOICE' ? 'choose' : (s?.allowed_actions || []).includes('advance') ? 'advance' : 'wait';
    const args = tool === 'choose' ? { index: s.message.choices[0].index } : tool === 'wait' ? { timeout_ms: 5000 } : {};
    const r = await client.callTool({ name: tool, arguments: args });
    if (r.isError) { ok = false; report('FAIL', `advance loop (${tool})`, short(r.content[0].text)); break; }
    const v = JSON.parse(r.content[0].text);
    s = v.state && typeof v.state === 'object' ? v.state : v;
    if (s?.message?.text) texts.push(s.message.text);
    n++;
  }
  if (ok) report(s?.state === 'EXPLORE' ? 'PASS' : 'FAIL', 'advance until EXPLORE',
    `${n} calls, final=${s?.state}, text: ${short(texts.join(' / '), 200)}`);
} else report('SKIP', 'advance until EXPLORE', 'interact did not start an event');

await step('wait (idle)', 'wait', { timeout_ms: 2000 }, v => v.ok === true, v => `ok=${v.ok} waited=${v.waitedMs} ${v.state?.state}`);
await step('get_log', 'get_log', { since: logStart, limit: 50 }, v => Array.isArray(v.entries) && v.entries.length > 0,
  v => `latest=${v.latest} types=${[...new Set(v.entries.map(e => e.type))].join(',')}`);

// Error paths: bad args are rejected by schema; action in wrong state → INVALID_STATE (not a crash).
{
  const r = await client.callTool({ name: 'walk', arguments: { direction: 'north', steps: 1 } });
  report(r.isError ? 'PASS' : 'FAIL', 'walk bad direction rejected', short(r.content[0].text, 100));
}
summary();
await client.close();

function summary() {
  const c = s => results.filter(r => r.status === s).length;
  console.log(`\nSUMMARY: ${c('PASS')} PASS, ${c('FAIL')} FAIL, ${c('SKIP')} SKIP`);
  const bad = results.filter(r => r.status !== 'PASS').map(r => `${r.status} ${r.name}`);
  if (bad.length) console.log('  ' + bad.join('\n  '));
  process.exitCode = c('FAIL') ? 1 : 0;
}
