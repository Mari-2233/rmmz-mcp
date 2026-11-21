// 30-query (B-query, B4): read-only queries — listEvents, mapGrid, listItems, getVariables, getSwitches.
// All functions are synchronous and return plain JSON objects.

// Strip RPG Maker / VisuMZ text codes: \I[n] \C[n] \V[n] \N[n] \{ \} \. \| \! \> \< \^ and <WordWrap>-style tags.
// VisuMZ_1_MessageCore text macros, e.g. [ukG] -> \c[16]\n[11] (speaker names in Pocket Mirror).
let macros = null;
function getMacros() {
  if (macros) return macros;
  macros = {};
  try {
    const raw = PluginManager.parameters('VisuMZ_1_MessageCore')['TextMacros:arraystruct'];
    for (const s of JSON.parse(raw || '[]')) {
      const m = JSON.parse(s);
      if (m['Match:str']) macros[m['Match:str']] = m['TextStr:str'] || '';
    }
  } catch (e) { /* no macros */ }
  return macros;
}
function resolveCodes(s) {
  let t = String(s);
  const mac = getMacros();
  t = t.replace(/\[([A-Za-z][\w ]*)\]/g, (all, k) => (Object.prototype.hasOwnProperty.call(mac, k) ? mac[k] : all));
  t = t.replace(/\\N\[(\d+)\]/gi, (all, n) => { const a = window.$gameActors && $gameActors.actor(Number(n)); return a ? a.name() : ''; });
  t = t.replace(/\\P\[(\d+)\]/gi, (all, n) => { const a = window.$gameParty && $gameParty.members()[Number(n) - 1]; return a ? a.name() : ''; });
  t = t.replace(/\\V\[(\d+)\]/gi, (all, n) => { try { return String($gameVariables.value(Number(n))); } catch (e) { return ''; } });
  try { if (window.TextManager && TextManager.replaceDatabaseText) t = TextManager.replaceDatabaseText(t); } catch (e) { /* ignore */ }
  return t;
}

function stripCodes(s) {
  if (s == null) return '';
  return resolveCodes(s)
    .replace(/\\[A-Za-z]+\[[^\]]*\]/g, '')
    .replace(/\\[A-Za-z]+<[^>]*>/g, '')
    .replace(/\\[{}.|!><^$]/g, '')
    .replace(/<\/?(WordWrap|br|line break|left|center|right|b|i)>/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
ai.stripCodes = stripCodes;

function requireMap() {
  const sc = window.SceneManager && SceneManager._scene;
  if (!sc || sc.constructor.name !== 'Scene_Map' || !window.$gameMap || !$gameMap.mapId()) {
    throw new Error('INVALID_STATE: map queries need Scene_Map (now ' + (sc ? sc.constructor.name : 'none') + ')');
  }
}

function proximityOf(ev) {
  const t = ev._proximityTriggers;
  if (!Array.isArray(t) || t.length === 0) return undefined;
  return Math.max.apply(null, t.map(Number).filter(n => !isNaN(n)));
}

// Summarize one Game_Event (safe for page -1).
function eventInfo(ev, px, py) {
  const data = ev.event() || {};
  const page = typeof ev._pageIndex === 'number' ? ev._pageIndex : -1;
  const o = {
    id: ev.eventId(), name: data.name || '', x: ev.x, y: ev.y,
    dist: Math.abs(ev.x - px) + Math.abs(ev.y - py),
    page, trigger: page >= 0 ? ev._trigger : null, priority: ev._priorityType,
    through: !!ev.isThrough(),
  };
  if (page >= 0) {
    const cn = ev.characterName && ev.characterName();
    if (cn) o.image = cn + ':' + ev.characterIndex();
    else if (ev._tileId) o.image = 'tile:' + ev._tileId;
    const p = proximityOf(ev);
    if (p !== undefined) o.proximity = p;
    if (ev._shortcut || (ev.isShortcutEvent && ev.isShortcutEvent())) o.shortcut = true;
  }
  return o;
}

ai.listEvents = function ({ radius } = {}) {
  requireMap();
  const px = $gamePlayer.x, py = $gamePlayer.y;
  let out = $gameMap.events().filter(ev => ev && !ev._erased).map(ev => eventInfo(ev, px, py));
  if (radius != null) {
    const r = Number(radius);
    if (isNaN(r) || r < 0) throw new Error('BAD_ARGS: radius must be a non-negative number');
    out = out.filter(e => e.dist <= r);
  }
  out.sort((a, b) => a.dist - b.dist || a.id - b.id);
  return out;
};

// Passability approximation: a tile is walkable if $gameMap.isPassable(x,y,d) for any d (terrain only,
// Tiled-aware).
function tileOpen(x, y) {
  return [2, 4, 6, 8].some(d => { try { return $gameMap.isPassable(x, y, d); } catch (e) { return false; } });
}

ai.mapGrid = function ({ x, y, w, h } = {}) {
  requireMap();
  const W = $gameMap.width(), H = $gameMap.height();
  w = Math.max(1, Math.min(Number(w) || 21, 80));
  h = Math.max(1, Math.min(Number(h) || 15, 60));
  let x0 = x != null ? Number(x) : $gamePlayer.x - Math.floor(w / 2);
  let y0 = y != null ? Number(y) : $gamePlayer.y - Math.floor(h / 2);
  if (isNaN(x0) || isNaN(y0)) throw new Error('BAD_ARGS: x/y must be numbers');
  // Clip to map bounds.
  let x1 = Math.min(W, x0 + w), y1 = Math.min(H, y0 + h);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  const cells = {};
  for (const ev of $gameMap.events()) {
    if (!ev || ev._erased || ev._pageIndex < 0) continue;
    const k = ev.x + ',' + ev.y;
    const blocking = ev._priorityType === 1 && !ev.isThrough();
    if (blocking) cells[k] = 'E';
    else if (!cells[k]) cells[k] = 'e';
  }
  const rows = [];
  for (let yy = y0; yy < y1; yy++) {
    let row = '';
    for (let xx = x0; xx < x1; xx++) {
      if (xx === $gamePlayer.x && yy === $gamePlayer.y) row += '@';
      else if (cells[xx + ',' + yy]) row += cells[xx + ',' + yy];
      else row += tileOpen(xx, yy) ? '.' : '#';
    }
    rows.push(row);
  }
  return {
    origin: { x: x0, y: y0 }, size: { w: x1 - x0, h: y1 - y0 }, map: { w: W, h: H },
    player: { x: $gamePlayer.x, y: $gamePlayer.y },
    rows,
    legend: { '@': 'player', E: 'event that blocks (same level as player)', e: 'other active event',
      '#': 'not enterable', '.': 'walkable terrain' , note: 'rows[0] is y=origin.y; column 0 is x=origin.x' },
  };
};

ai.listItems = function () {
  if (!window.$gameParty) throw new Error('INVALID_STATE: no game loaded');
  return $gameParty.items().map(it => ({
    id: it.id, name: stripCodes(it.name), description: stripCodes(it.description), count: $gameParty.numItems(it),
  }));
};

function pickIds(names, args, label) {
  args = args || {};
  if (args.named) {
    const out = [];
    for (let i = 1; i < names.length; i++) if (names[i] && String(names[i]).trim()) out.push(i);
    return out;
  }
  const ids = args.ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`BAD_ARGS: ${label} needs {ids:[...]} or {named:true}`);
  if (ids.length > 200) throw new Error('BAD_ARGS: at most 200 ids');
  return ids.map(n => {
    const i = Number(n);
    if (!Number.isInteger(i) || i < 1 || i >= names.length) throw new Error(`BAD_ARGS: ${label} id ${n} out of range 1..${names.length - 1}`);
    return i;
  });
}

ai.getVariables = function (args) {
  if (!window.$gameVariables || !window.$dataSystem) throw new Error('INVALID_STATE: no game loaded');
  const names = $dataSystem.variables;
  return pickIds(names, args, 'getVariables').map(id => {
    let value;
    try { value = $gameVariables.value(id); } catch (e) { value = null; }
    if (value !== null && typeof value === 'object') { try { value = JSON.parse(JSON.stringify(value)); } catch (e) { value = String(value); } }
    return { id, name: names[id] || '', value };
  });
};

ai.getSwitches = function (args) {
  if (!window.$gameSwitches || !window.$dataSystem) throw new Error('INVALID_STATE: no game loaded');
  const names = $dataSystem.switches;
  return pickIds(names, args, 'getSwitches').map(id => {
    let value;
    try { value = !!$gameSwitches.value(id); } catch (e) { value = null; }
    return { id, name: names[id] || '', value };
  });
};
