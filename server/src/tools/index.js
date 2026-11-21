// Tool registry. Each module exports register(ctx) where ctx = { server, cdp, events, dev }.
// Add game tools in ./game.js (written during the competition window).
import * as base from './base.js';
import * as dev from './dev.js';
import * as game from './game.js';

export function registerAll(ctx) {
  base.register(ctx);
  game.register(ctx);
  if (ctx.dev) dev.register(ctx);
}
