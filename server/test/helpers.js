// Shared harness: spawn the real MCP server over stdio, pointed at a fake (or real) game.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeBundle } from '../src/bridge.js';
import { startFakeGame } from './fake-cdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = path.join(HERE, '../src/index.js');

export async function connectMcp(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { PATH: process.env.PATH, ...env },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'pmgt-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// Start the fake game seeded as a current bridge, so the server injects nothing.
export async function startSeededFake() {
  const dir = path.join(HERE, '../../game/parts');
  const parts = readdirSync(dir).filter(n => /^\d\d-.*\.js$/.test(n)).sort();
  const { hash } = await bridgeBundle();
  return startFakeGame({ bridgeHash: hash, parts });
}

export function parseResult(result) {
  const text = result.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { result, value: parseResult(result) };
}
