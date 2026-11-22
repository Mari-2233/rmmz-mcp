// Tool registry. Each module exports register(ctx) where ctx = { server, cdp, events, dev, fairPlay, transcript }.
// Add game tools in ./game.js (written during the competition window).
import * as base from './base.js';
import * as dev from './dev.js';
import * as game from './game.js';
import * as meta from './meta.js';

export function registerAll(ctx) {
  base.register(ctx);
  meta.register(ctx);
  game.register(ctx);
  // Fair play wins over dev mode (see registeredTools in state-contract.js).
  if (ctx.dev && !ctx.fairPlay) dev.register(ctx);
}
