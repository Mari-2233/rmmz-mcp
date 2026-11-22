// Generic tools: connection check, screenshot, pushed-event log.
import { z } from 'zod';
import { ok, recorded, safe } from '../util.js';
import { FAIR_PLAY_HIDDEN } from '../state-contract.js';

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

export function register({ server, cdp, events, fairPlay = false, transcript = null }) {
  server.registerTool('ping', {
    title: 'Ping game',
    description: 'Check the connection to the running game and whether the in-game bridge (window.__ai) is loaded.',
    annotations: READ,
  }, recorded(transcript, 'ping', safe(async () => {
    const info = await cdp.evaluate(`({
      scene: (typeof SceneManager !== 'undefined' && SceneManager._scene) ? SceneManager._scene.constructor.name : null,
      bridge: window.__ai ? (window.__ai.version || 'unknown') : null,
      frame: (typeof Graphics !== 'undefined') ? Graphics.frameCount : null
    })`);
    return ok({ connected: true, target: cdp.target?.url, ...info });
  })));

  // Human-only views: not registered at all under PMGT_FAIR_PLAY=1.
  if (!(fairPlay && FAIR_PLAY_HIDDEN.includes('screenshot'))) {
    server.registerTool('screenshot', {
      title: 'Screenshot',
      description: 'Capture the current game screen.',
      inputSchema: {
        scale: z.number().min(0.1).max(1).optional().describe('Resize factor (default 0.5)'),
        quality: z.number().int().min(10).max(100).optional().describe('JPEG quality (default 70)'),
      },
      annotations: READ,
    }, recorded(transcript, 'screenshot', safe(async ({ scale, quality }) => {
      const img = await cdp.screenshot({ scale, quality });
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }] };
    })));
  }

  if (!(fairPlay && FAIR_PLAY_HIDDEN.includes('get_pushed_events'))) {
    server.registerTool('get_pushed_events', {
      title: 'Pushed events',
      description: 'Events pushed by the game bridge (window.__aiNotify) since a sequence number.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('Return events with seq greater than this (default 0)'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { ...READ, openWorldHint: false }, // reads server memory, never the game
    }, recorded(transcript, 'get_pushed_events', safe(async ({ since = 0, limit = 100 }) => ok({ latest: events.seq, events: events.since(since, limit) }))));
  }
}
