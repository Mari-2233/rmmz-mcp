#!/usr/bin/env node
// MCP server (stdio) for Pocket Mirror ~ GoldenerTraum.
// Env:
//   PMGT_CDP_HOST (default 127.0.0.1)  PMGT_CDP_PORT (default 9333)
//   PMGT_MCP_DEV=1  → also register dev-only tools (eval_js, reload_bridge)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CdpClient } from './cdp.js';
import { EventLog } from './events.js';
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
cdp.on('disconnected', () => log('CDP disconnected (will reconnect on next call)'));
cdp.on('error', e => log('CDP error:', e.message));

const INSTRUCTIONS = [
  "Play/observe Pocket Mirror ~ GoldenerTraum (RPG Maker MZ) through these tools.",
  "",
  "RULES",
  "1. Start with get_state. Call only action tools listed in allowed_actions; read tools work any time.",
  "2. Actions return the new state; don't call get_state after them or poll it: use wait.",
  "3. Coordinates: x grows right, y grows down. up = y-1, down = y+1.",
  "",
  "STATES",
  "EXPLORE: approach, walk, face, interact, use_item.",
  "DIALOGUE / CUTSCENE: read_dialogue (reads everything at once) or advance.",
  "CHOICE: choose(index) with index from message.choices[].index.",
  "TRANSFER / VIDEO / MOVING / FORCED_MOVE / BLOCKED / SCENE_CHANGING: wait.",
  "OTHER_SCENE: Scene_Item -> pick_item; else wait or tell the user.",
  "GAME_OVER: stop and tell the user.",
  "",
  "EXPLORING (each call is slow: prefer fewer, bigger calls)",
  "- list_events, then approach(event_id): walks there, faces it, interacts and returns the dialogue in ONE call. Use walk/face/interact only for fine control.",
  "- map_grid shows walls: '#' blocked, '.' floor, '@' you, 'E' solid event.",
  "- walk/approach may stop early ('blocked', 'state_changed'): read the state and react.",
  "- Events with shortcut:true accept an item: face them and use_item(item_id) (ids from list_items).",
  "- get_log shows what happened recently. Dialogue can contain the solution: read it.",
  "",
  "WHEN STUCK",
  "- list_events marks checked:N for events you already examined; try unchecked ones first.",
  "- trigger 1 events (doors, teleports) start when you walk onto them: approach them.",
  "- Re-check objects after getting an item or when something changed.",
  "- The text state has everything; no need to look at the screen.",
  "",
  "NO SPOILERS",
  "- If describe_event is available: it reveals hidden scripts; use it only for your own reasoning, never tell the user content they haven't seen in game.",
  "",
  "MODES",
  "- Hint mode (user asks for hints): give clues step by step; don't play for them.",
  "- Play mode: act autonomously, report briefly after each milestone (room, item, puzzle); stop at GAME_OVER.",
].join('\n');
// OpenClaw keeps only the first 2000 characters of server instructions.
if (INSTRUCTIONS.length > 2000) throw new Error(`instructions too long: ${INSTRUCTIONS.length}`);

const server = new McpServer(
  { name: 'pmgt', version: '0.0.0' },
  { instructions: INSTRUCTIONS },
);

const ctx = { server, cdp, events, dev: process.env.PMGT_MCP_DEV === '1' };
registerAll(ctx);

await server.connect(new StdioServerTransport());
log(`ready (CDP ${cdp.host}:${cdp.port}, dev=${ctx.dev})`);

const shutdown = () => { cdp.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
