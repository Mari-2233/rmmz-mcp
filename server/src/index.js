#!/usr/bin/env node
// MCP server (stdio) for Pocket Mirror ~ GoldenerTraum.
// Env:
//   PMGT_CDP_HOST (default 127.0.0.1)  PMGT_CDP_PORT (default 9333)
//   PMGT_MCP_DEV=1  → also register dev-only tools (eval_js, reload_bridge)
//   PMGT_FAIR_PLAY=1  → do not register spoiler/human-only tools (see state-contract.js)
//   PMGT_TRANSCRIPT=<path>  → append a hash-chained record of tool calls (see transcript.js)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureBridge, applyConfig } from './bridge.js';
import { CdpClient } from './cdp.js';
import { EventLog } from './events.js';
import { Transcript } from './transcript.js';
import { log } from './util.js';
import { registerAll } from './tools/index.js';

const cdp = new CdpClient({
  host: process.env.PMGT_CDP_HOST || '127.0.0.1',
  port: Number(process.env.PMGT_CDP_PORT || 9333),
});
const events = new EventLog(1000);

// Game → server push channel: page calls window.__aiNotify(JSON.stringify(payload)).
await cdp.addBinding('__aiNotify');
cdp.on('binding', (name, payload) => { if (name === '__aiNotify') events.push(payload); });
cdp.on('connected', t => log('CDP connected:', t.url));
// Remote games (Windows) have no linux-inject.js: ship the bridge over CDP before the first call.
cdp.onConnect = async () => {
  const r = await ensureBridge(cdp);
  if (r) log(`bridge ${r} over CDP`);
  await applyConfig(cdp);
};
cdp.on('hookError', e => log('bridge inject failed:', e.message));
cdp.on('disconnected', () => log('CDP disconnected (will reconnect on next call)'));
cdp.on('error', e => log('CDP error:', e.message));

const INSTRUCTIONS = [
  "Play/observe Pocket Mirror ~ GoldenerTraum (RPG Maker MZ) through these tools.",
  "",
  "RULES",
  "1. Start with get_state. Call only action tools listed in allowed_actions; read tools work any time.",
  "2. Actions return the new state; don't call get_state after them or poll it: use wait.",
  "3. Coordinates: x grows right, y grows down. up = y-1, down = y+1.",
  "4. The game is paused while you think; it only runs during actions. walk/approach sprint by default.",
  "",
  "STATES",
  "EXPLORE: approach, walk, face, interact, use_item.",
  "DIALOGUE / CUTSCENE: read_dialogue (reads everything at once) or advance.",
  "CHOICE: choose(index) with index from message.choices[].index.",
  "TRANSFER / VIDEO / MOVING / FORCED_MOVE / BLOCKED / SCENE_CHANGING: wait.",
  "OTHER_SCENE: Scene_Item -> pick_item; else wait or tell the user.",
  "GAME_OVER: remember(lesson) what killed you, then restart. get_state.memory holds lessons from past runs: use them to skip what you already know.",
  "",
  "EXPLORING",
  "- list_events, then approach(event_id): walks there, faces it, interacts and returns the dialogue in ONE call.",
  "- map_grid: '#' wall, '.' floor, '@' you, 'E' solid event. trigger 1 events (doors) start when you step on them.",
  "- Events with shortcut:true accept an item: face them and use_item(item_id).",
  "- Dialogue holds the clues. Think before acting: what does the game want here?",
  "",
  "BUDGET (if present, always the last field of a result)",
  "- interact costs 1, use_item 2; new dialogue/items/rooms make it free. Repeating things wastes it.",
  "- Empty: only reflect (clues, hypothesis, one concrete plan). Off-plan actions cost double.",
  "- Stuck: leave the room to look elsewhere, or ask_user.",
  "",
  "NO SPOILERS",
  "- If describe_event is available: it reveals hidden scripts; use it only for your own reasoning, never tell the user content they haven't seen in game.",
  "",
  "MODES",
  "- Hint mode (user asks for hints): give clues step by step; don't play for them.",
  "- Play mode: act autonomously, report briefly after each milestone (room, item, puzzle); after a GAME_OVER, remember + restart.",
].join('\n');
// OpenClaw keeps only the first 2000 characters of server instructions.
if (INSTRUCTIONS.length > 2000) throw new Error(`instructions too long: ${INSTRUCTIONS.length}`);

const server = new McpServer(
  { name: 'pmgt', version: '0.0.0' },
  { instructions: INSTRUCTIONS },
);

// A broken transcript chain is reported and the server runs without one: an optional log
// must never stop the game from being playable. get_capabilities shows transcript: false.
let transcript = null;
if (process.env.PMGT_TRANSCRIPT) {
  try { transcript = new Transcript(process.env.PMGT_TRANSCRIPT); }
  catch (e) { log('transcript disabled:', e.message); }
}

const ctx = {
  server, cdp, events, transcript,
  dev: process.env.PMGT_MCP_DEV === '1',
  fairPlay: process.env.PMGT_FAIR_PLAY === '1',
};
if (ctx.dev && ctx.fairPlay) log('PMGT_FAIR_PLAY=1 wins over PMGT_MCP_DEV=1: dev tools not registered');
registerAll(ctx);

await server.connect(new StdioServerTransport());
log(`ready (CDP ${cdp.host}:${cdp.port}, dev=${ctx.dev}, fairPlay=${ctx.fairPlay}, transcript=${!!transcript})`);

const shutdown = () => { transcript?.close(); cdp.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
