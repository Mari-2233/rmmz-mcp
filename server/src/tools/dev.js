// Dev-only tools (registered only when PMGT_MCP_DEV=1). Never enable for the AI player in the demo.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { ok, recorded, safe } from '../util.js';
import { bridgeBundle } from '../bridge.js';

export const BRIDGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../game/ai-bridge.js');

export function register({ server, cdp, transcript = null }) {
  // Dev tools bypass fair play by design, so they matter most in the transcript.
  server.registerTool('eval_js', {
    title: 'Evaluate JS (dev)',
    description: 'DEV ONLY: evaluate a JavaScript expression in the game page and return its JSON value.',
    inputSchema: { expression: z.string().describe('JS expression; promises are awaited') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, recorded(transcript, 'eval_js', safe(async ({ expression }) => ok({ value: await cdp.evaluate(expression) ?? null }))));

  server.registerTool('reload_bridge', {
    title: 'Reload bridge (dev)',
    description: 'DEV ONLY: re-evaluate mcp-mod/game/ai-bridge.js in the running game without restarting it.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, recorded(transcript, 'reload_bridge', safe(async () => {
    await cdp.evaluate(`(0, eval)(${JSON.stringify((await bridgeBundle()).code)}); true`);
    const version = await cdp.evaluate('window.__ai && window.__ai.version');
    return ok({ reloaded: true, version });
  })));
}
