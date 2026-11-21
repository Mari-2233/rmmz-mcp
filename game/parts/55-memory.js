// 55-memory (lead): exploration memory the player would have anyway — which events on this map
// were already checked (started by the player), so the model doesn't re-check the same objects
// and knows what is left to try. Built from the bridge log (event_start entries), no game data peeking.
const checked = (window.__aiChecked = window.__aiChecked || {}); // mapId -> {eventId: count}

util.ready(() => {
  // A new game starts with no memory.
  util.wrap(DataManager, 'setupNewGame', orig => function () {
    for (const k of Object.keys(checked)) delete checked[k];
    return orig.apply(this, arguments);
  }, '55-memory:DataManager.setupNewGame');
  util.wrap(Game_Map.prototype, 'setupStartingMapEvent', orig => function () {
    const r = orig.apply(this, arguments);
    try {
      const id = this._interpreter && this._interpreter.eventId();
      const ev = id > 0 && this.event(id);
      // Only player-started events (action button / touch), not autorun or parallel ones.
      if (r && ev && ev._trigger <= 2) { const m = (checked[this.mapId()] = checked[this.mapId()] || {}); m[id] = (m[id] || 0) + 1; }
    } catch (e) { /* ignore */ }
    return r;
  }, '55-memory:Game_Map.setupStartingMapEvent');
});

if (ai.listEvents && !ai.listEvents.__withChecked) {
  const base = ai.listEvents;
  ai.listEvents = function (...a) {
    const list = base.apply(this, a);
    const m = checked[$gameMap.mapId()] || {};
    for (const e of list) e.checked = m[e.id] || 0;
    return list;
  };
  ai.listEvents.__withChecked = true;
}
