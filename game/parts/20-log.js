// 20-log (A-state): event log ring buffer (§3.5, B3). Owned by A-state.
// Buffer lives on window so seq stays monotonic across hot reloads; hooks use util.wrap keys so
// reloading never stacks wrappers.

const MAX = 500;
const DEDUPE_FRAMES = 30;
const B = (window.__aiLogBuf = window.__aiLogBuf || { seq: 0, entries: [], last: {} });
const ignoreVars = () => ai.PROFILE.logIgnoreVars || [];

const frame = () => (window.Graphics ? Graphics.frameCount : 0);

function short(v) {
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return v ?? null;
  try { const s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 120) + '…' : JSON.parse(s); } catch (e) { return String(v); }
}

function push(type, data, dedupeKey) {
  const f = frame();
  if (dedupeKey) {
    const prev = B.last[dedupeKey];
    if (prev && f - prev.frame <= DEDUPE_FRAMES) {
      const i = B.entries.indexOf(prev.entry);
      if (i >= 0) {
        B.entries.splice(i, 1);
        if (prev.entry.data && 'old' in prev.entry.data && 'old' in data) data.old = prev.entry.data.old;
      }
    }
  }
  const entry = { seq: ++B.seq, frame: f, type, data };
  B.entries.push(entry);
  if (B.entries.length > MAX) B.entries.splice(0, B.entries.length - MAX);
  if (dedupeKey) B.last[dedupeKey] = { frame: f, entry };
  util.notify(type, data);
  return entry.seq;
}

ai._log = {
  push: (type, data) => push(type, data),
  latest: () => B.seq,
  clear: () => { B.entries.length = 0; B.last = {}; },
};

ai.getLog = function (since = 0, types = null, limit = 100) {
  const s = Number(since) || 0;
  const ts = types ? [].concat(types) : null;
  const lim = Math.max(1, Math.min(Number(limit) || 100, MAX));
  let out = B.entries.filter(e => e.seq > s && (!ts || ts.includes(e.type)));
  if (out.length > lim) out = out.slice(out.length - lim); // keep the newest
  return { latest: B.seq, entries: out };
};

// ---------- hooks ----------
const stripCodes = t => (typeof t === 'string'
  ? t.replace(/<br>/gi, '\n').replace(/\x1bWrapBreak\[\d*\]/g, ' ').replace(/\\[A-Za-z]+\[[^\]]*\]/g, '').replace(/\\[A-Za-z]+<[^>]*>/g, '')
    .replace(/\\[{}$.|!><^\\]/g, '').replace(/<\/?[A-Za-z][A-Za-z0-9 _:,\-]*>/g, '').replace(/\x1b/g, '')
  : t);
const clean = t => (ai.cleanText ? ai.cleanText(t) : stripCodes(t));
const evName = id => { try { const e = id > 0 && $gameMap.event(id); return e ? e.event().name : null; } catch (x) { return null; } };

util.ready(() => {
  util.wrap(Scene_Map.prototype, 'onMapLoaded', orig => function () {
    const r = orig.apply(this, arguments);
    try { const id = $gameMap.mapId(); push('map', { id, name: ($dataMapInfos[id] && $dataMapInfos[id].name) || null }); } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Scene_Map.onMapLoaded');

  util.wrap(Window_Message.prototype, 'startMessage', orig => function () {
    let text = null, speaker = null;
    try { text = clean($gameMessage.allText()); speaker = ($gameMessage.speakerName && $gameMessage.speakerName()) || null; } catch (e) { /* ignore */ }
    const r = orig.apply(this, arguments);
    if (text !== null) push('message', { text, speaker: speaker ? clean(speaker) || null : null });
    return r;
  }, '20-log:Window_Message.startMessage');

  util.wrap(Game_Interpreter.prototype, 'setupChoices', orig => function (params) {
    const r = orig.apply(this, arguments);
    try { push('choice', { choices: (params[0] || []).map(clean), cancel: params[1], default: params[2], eventId: this._eventId }); } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Interpreter.setupChoices');

  util.wrap(Game_Interpreter.prototype, 'setup', orig => function (list, eventId) {
    const r = orig.apply(this, arguments);
    try {
      if (window.$gameMap && this === $gameMap._interpreter) {
        this.__aiEvt = eventId || 0;
        push('event_start', { eventId: eventId || 0, name: evName(eventId) });
      }
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Interpreter.setup');

  util.wrap(Game_Interpreter.prototype, 'terminate', orig => function () {
    const r = orig.apply(this, arguments);
    try {
      if (this.__aiEvt != null && window.$gameMap && this === $gameMap._interpreter) {
        const id = this.__aiEvt; this.__aiEvt = null;
        push('event_end', { eventId: id, name: evName(id) });
      }
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Interpreter.terminate');

  util.wrap(Game_Switches.prototype, 'setValue', orig => function (id, value) {
    let old; try { old = this.value(id); } catch (e) { /* ignore */ }
    const r = orig.apply(this, arguments);
    try {
      const name = $dataSystem && $dataSystem.switches[id];
      const nv = this.value(id);
      if (name && old !== nv) push('switch', { id, name, old: !!old, new: !!nv }, 'switch:' + id);
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Switches.setValue');

  util.wrap(Game_Variables.prototype, 'setValue', orig => function (id, value) {
    let old; try { old = this.value(id); } catch (e) { /* ignore */ }
    const r = orig.apply(this, arguments);
    try {
      const name = $dataSystem && $dataSystem.variables[id];
      if (name && !ignoreVars().includes(id)) {
        const nv = this.value(id);
        if (old !== nv && JSON.stringify(old) !== JSON.stringify(nv)) push('variable', { id, name, old: short(old), new: short(nv) }, 'variable:' + id);
      }
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Variables.setValue');

  util.wrap(Game_SelfSwitches.prototype, 'setValue', orig => function (key, value) {
    let old; try { old = this.value(key); } catch (e) { /* ignore */ }
    const r = orig.apply(this, arguments);
    try {
      const nv = this.value(key);
      if (!!old !== !!nv) { const k = [].concat(key).join(','); push('self_switch', { key: k, value: !!nv }, 'self_switch:' + k); }
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_SelfSwitches.setValue');

  util.wrap(Game_Party.prototype, 'gainItem', orig => function (item, amount) {
    let before = 0; try { before = item ? this.numItems(item) : 0; } catch (e) { /* ignore */ }
    const r = orig.apply(this, arguments);
    try {
      if (item) {
        const total = this.numItems(item);
        const kind = DataManager.isItem(item) ? 'item' : DataManager.isWeapon(item) ? 'weapon' : DataManager.isArmor(item) ? 'armor' : 'other';
        if (total !== before) push('item', { id: item.id, name: item.name, kind, delta: total - before, total });
      }
    } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Party.gainItem');

  util.wrap(Game_Player.prototype, 'reserveTransfer', orig => function (mapId, x, y, d, fadeType) {
    const r = orig.apply(this, arguments);
    try { push('transfer', { mapId, x, y, d: d ?? null, name: ($dataMapInfos[mapId] && $dataMapInfos[mapId].name) || null }); } catch (e) { /* ignore */ }
    return r;
  }, '20-log:Game_Player.reserveTransfer');

  if (window.Video && typeof Video.play === 'function') {
    util.wrap(Video, 'play', orig => function (src) {
      const r = orig.apply(this, arguments);
      try { push('video', { src: String(src) }); } catch (e) { /* ignore */ }
      return r;
    }, '20-log:Video.play');
  }
});
