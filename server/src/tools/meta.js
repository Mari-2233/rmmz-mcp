// Diagnostics about the server and its backends. Kept apart from game tools because it must
// keep working exactly when the game side does not.
import { ok, recorded, safe } from '../util.js';
import { getCapabilities } from '../capabilities.js';

export function register(ctx) {
  const { server, transcript = null } = ctx;
  server.registerTool('get_capabilities', {
    title: 'Capabilities',
    description: 'CDP/bridge/mode status. May inject the bridge on connect.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, recorded(transcript, 'get_capabilities', safe(async () => ok(await getCapabilities(ctx)))));
}
