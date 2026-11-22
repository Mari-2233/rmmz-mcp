// 65-vision (lead): limit what the AI can see to a radius around the screen centre, like a screen.
// Off until ai.vision.set(radius) — the MCP server sets it from PMGT_VIEW_RADIUS.
// The radius is measured from the SCREEN CENTRE (what the player sees), not the player.
// - list_events: events within the radius (Chebyshev) plus events seen before on this map
//   (memory), marked in_view; ordered in-view first, unchecked first, near -> far from screen centre.
// - map_grid: tiles outside the radius are '?'.
// - approach(event_id): only events seen at least once.
// Path-finding inside approach still uses the full map ("roughly remembers the way").
const V = (window.__aiVision = window.__aiVision || { radius: 0, seen: {} }); // seen: mapId -> [eventIds]

// Event information is centred on the SCREEN (camera), not the player; path-finding stays on the player.
function screenCenter() {
  return { x: $gameMap.displayX() + $gameMap.screenTileX() / 2 - 0.5, y: $gameMap.displayY() + $gameMap.screenTileY() / 2 - 0.5 };
}
const screenDist = (x, y) => { const c = screenCenter(); return Math.max(Math.abs(x - c.x), Math.abs(y - c.y)); };
const inView = (x, y) => screenDist(x, y) <= V.radius;
function seenSet() { const m = $gameMap.mapId(); return (V.seen[m] = V.seen[m] || []); }
function look() {
  if (!V.radius || !window.$gameMap || !$gameMap.mapId()) return;
  const s = seenSet();
  for (const e of $gameMap.events()) if (e && !e._erased && inView(e.x, e.y) && !s.includes(e.eventId())) s.push(e.eventId());
}

ai.vision = {
  set(radius) { V.radius = Math.max(0, Math.round(Number(radius) || 0)); look(); return { radius: V.radius }; },
  reset() { V.seen = {}; return true; },
};

util.ready(() => {
  // Seeing happens as you walk.
  util.wrap(Game_Player.prototype, 'increaseSteps', orig => function () {
    const r = orig.apply(this, arguments);
    try { look(); } catch (e) { /* ignore */ }
    return r;
  }, '65-vision:Game_Player.increaseSteps');
  util.wrap(DataManager, 'setupNewGame', orig => function () { V.seen = {}; return orig.apply(this, arguments); }, '65-vision:DataManager.setupNewGame');
});

if (ai.listEvents && !ai.listEvents.__vision) {
  const base = ai.listEvents;
  ai.listEvents = function (...a) {
    const list = base.apply(this, a);
    if (!V.radius) return list;
    look();
    const s = seenSet();
    // In view first, then remembered; inside each group unchecked first; then near -> far from screen centre.
    return list.filter(e => s.includes(e.id))
      .map(e => Object.assign(e, { in_view: inView(e.x, e.y), screen_dist: Math.round(screenDist(e.x, e.y) * 10) / 10 }))
      .sort((a, b) => (b.in_view - a.in_view) || ((a.checked > 0) - (b.checked > 0)) || (a.screen_dist - b.screen_dist));
  };
  ai.listEvents.__vision = true;
}

if (ai.mapGrid && !ai.mapGrid.__vision) {
  const base = ai.mapGrid;
  ai.mapGrid = function (...a) {
    const g = base.apply(this, a);
    if (!V.radius || !g || !g.rows) return g;
    g.rows = g.rows.map((row, i) => row.split('').map((c, j) => (inView(g.origin.x + j, g.origin.y + i) ? c : '?')).join(''));
    g.legend = Object.assign({}, g.legend, { '?': `out of sight (view radius ${V.radius})` });
    return g;
  };
  ai.mapGrid.__vision = true;
}

if (ai.approach && !ai.approach.__vision) {
  const base = ai.approach;
  ai.approach = function (target, ...rest) {
    if (V.radius && target && target.eventId != null) {
      look();
      if (!seenSet().includes(Number(target.eventId))) throw new Error(`NOT_FOUND: you haven't seen event ${target.eventId} yet (view radius ${V.radius})`);
    }
    return base.call(this, target, ...rest);
  };
  ai.approach.__vision = true;
}
