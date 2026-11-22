// Backend readiness report for the get_capabilities tool.
//
// `ping` answers "is anything there" and throws when the game is down. This report instead
// names the exact layer that is missing (CDP unreachable, no page target, bridge absent,
// bridge stale) and returns it as data, so a human or a model can act on it without parsing
// error text. Like every other tool it connects first, which may inject the current bridge
// into a remote game; the report describes the state after that connect.
import { bridgeBundle } from './bridge.js';
import { FAIR_PLAY_HIDDEN, registeredTools } from './state-contract.js';

// Target discovery gets a short budget. The in-page probe gets a long one: the first call
// also pays for connecting and injecting the bridge into a remote game.
const PROBE_MS = 3000;
const PAGE_PROBE_MS = 20000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms)),
  ]);
}

export async function getCapabilities({ cdp, dev = false, fairPlay = false, transcript = null }) {
  const env = process.env;
  const report = {
    server: { name: 'pmgt', node: process.version },
    cdp: { host: cdp.host, port: cdp.port, reachable: false, target: null },
    bridge: { loaded: false, version: null, parts: [], local_hash: null, page_hash: null },
    game: { scene: null, state: null, profile: null },
    modes: {
      dev,
      fair_play: fairPlay,
      budget: env.PMGT_BUDGET === '1',
      autopause: env.PMGT_AUTOPAUSE === '1',
      hud: env.PMGT_HUD === '1',
      view_radius: Number(env.PMGT_VIEW_RADIUS || 0),
      transcript: !!transcript && !transcript.disabled,
    },
    tools: {
      registered: registeredTools({ dev, fairPlay }),
      hidden_by_fair_play: fairPlay ? [...FAIR_PLAY_HIDDEN] : [],
    },
    status: 'cdp_unreachable',
  };

  try { report.bridge.local_hash = (await bridgeBundle()).hash; } catch { /* game/ missing: report null */ }

  let targets;
  try {
    targets = await withTimeout(cdp.listTargets(), PROBE_MS);
    report.cdp.reachable = true;
  } catch (e) {
    report.cdp.error = e.message;
    return report;
  }
  // The endpoint answered, but it might not be a game (wrong port, another service).
  // Treat a malformed target list as a missing target, never as a thrown error: this
  // tool exists to report broken setups as data.
  if (!Array.isArray(targets)) {
    report.status = 'target_not_found';
    report.cdp.error = 'target list is not an array';
    return report;
  }
  const page = targets.find(t => t && t.type === 'page' && typeof t.url === 'string' && t.url.endsWith(cdp.targetSuffix));
  if (!page) {
    report.status = 'target_not_found';
    report.cdp.targets = targets.map(t => t?.url).filter(u => typeof u === 'string');
    return report;
  }
  report.cdp.target = page.url;

  try {
    const probe = await withTimeout(cdp.evaluate(`({
      scene: (typeof SceneManager !== 'undefined' && SceneManager._scene) ? SceneManager._scene.constructor.name : null,
      loaded: !!window.__ai,
      version: window.__ai ? (window.__ai.version || null) : null,
      parts: window.__ai ? (window.__ai.parts || []) : [],
      hash: window.__AI_BRIDGE_HASH || (window.__ai ? 'disk' : null),
      state: (() => { try { return window.__ai.currentState(); } catch (e) { return null; } })(),
      profile: (window.__ai && window.__ai.PROFILE) ? window.__ai.PROFILE.name : null
    })`, { timeoutMs: PAGE_PROBE_MS }), PAGE_PROBE_MS + 5000);
    report.game.scene = probe.scene;
    report.game.state = probe.state;
    report.game.profile = probe.profile;
    report.bridge.loaded = !!probe.loaded;
    report.bridge.version = probe.version;
    report.bridge.parts = probe.parts || [];
    report.bridge.page_hash = probe.hash;
  } catch (e) {
    report.status = 'bridge_missing';
    report.bridge.error = e.message;
    return report;
  }

  if (!report.bridge.loaded) report.status = 'bridge_missing';
  else if (report.bridge.local_hash && report.bridge.page_hash !== report.bridge.local_hash) report.status = 'bridge_stale';
  else report.status = 'ready';
  return report;
}
