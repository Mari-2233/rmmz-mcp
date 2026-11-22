// Build the in-game bridge as one script: parts are shipped inline, so it also works when the game
// runs on another machine (only CDP reaches it). Used for auto-injection and reload_bridge.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game');

export async function bridgeBundle() {
  const dir = path.join(GAME, 'parts');
  const names = (await readdir(dir)).filter(n => /^\d\d-.*\.js$/.test(n)).sort();
  const parts = await Promise.all(names.map(async name => ({ name, code: await readFile(path.join(dir, name), 'utf8') })));
  const bridge = await readFile(path.join(GAME, 'ai-bridge.js'), 'utf8');
  const hash = createHash('sha1').update(bridge).update(JSON.stringify(parts)).digest('hex').slice(0, 12);
  return { hash, code: `window.__AI_BRIDGE_PARTS = ${JSON.stringify(parts)};\n${bridge}\nwindow.__AI_BRIDGE_HASH = ${JSON.stringify(hash)};\n//# sourceURL=ai-bridge.js` };
}

// Inject the bridge if the page doesn't have it (remote game without linux-inject.js).
// Also replaces an older bridge the game loaded from its own disk (e.g. a stale copy on Windows):
// the page's bundle hash must match ours.
export async function ensureBridge(cdp) {
  const b = await bridgeBundle();
  const cur = await cdp.evaluate('window.__ai && window.__ai.parts && window.__ai.parts.length ? (window.__AI_BRIDGE_HASH || "disk") : null');
  if (cur === b.hash) return false;
  await cdp.evaluate(`(0, eval)(${JSON.stringify(b.code)}); true`);
  return cur ? 'replaced' : 'injected';
}
