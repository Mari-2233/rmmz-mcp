// 70-hud (lead): progress overlay for demos/recording. A DOM panel above the game canvas
// (pointer-events: none, never touches game state). Off until ai.hud.show(true) — the MCP server
// turns it on with PMGT_HUD=1. The server reports each tool call and the model's think time
// (gap between a tool result and the next call), which shows inference speed.
// The clock counts only active time: the model thinking, tools running, the model writing its
// reply. Between agent rounds / while waiting for the user it stands still: the runner calls
// ai.hud.active(false) when a round ends; the next tool call (or active(true)) starts it again.
// active(false, reason) shows the reason next to the clock. Idle time inside a think gap (between
// a tool result and the next call) is taken out of that think time.
const H = (window.__aiHud = window.__aiHud || {
  on: false, label: '', start: 0, calls: 0, lastTool: '', lastThinkMs: null, thinks: [], lastCallAt: 0,
});
if (H.activeMs == null) { H.activeMs = 0; H.activeSince = null; }
if (H.idleInGap == null) { H.idleInGap = 0; H.idleSince = null; H.idleReason = ''; }
const elapsed = () => H.activeMs + (H.activeSince ? Date.now() - H.activeSince : 0);
const idleNow = () => H.idleInGap + (H.idleSince ? Date.now() - H.idleSince : 0);
function setActive(on, reason = '') {
  const now = Date.now();
  if (on && !H.activeSince) {
    H.activeSince = now;
    if (H.idleSince) { H.idleInGap += now - H.idleSince; H.idleSince = null; }
    H.idleReason = '';
  } else if (!on) {
    if (H.activeSince) { H.activeMs += now - H.activeSince; H.activeSince = null; H.idleSince = now; }
    H.idleReason = reason;
  }
}

function el() {
  let d = document.getElementById('ai-hud');
  if (!d) {
    d = document.createElement('div');
    d.id = 'ai-hud';
    d.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;pointer-events:none;' +
      'width:340px;padding:10px 12px;border-radius:10px;background:rgba(12,12,20,.78);color:#eee;' +
      'font:13px/1.45 system-ui,"Segoe UI","Noto Sans CJK SC",sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.5);';
    document.body.appendChild(d);
  }
  return d;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = ms => (ms == null ? '–' : ms < 10000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 1000) + 's');
function clock(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function render() {
  const d = el();
  if (!H.on) { d.style.display = 'none'; return; }
  d.style.display = 'block';
  let s = {};
  try { s = ai.getState(); } catch (e) { /* not on a map yet */ }
  const b = s.budget || {};
  const B = window.__aiBudget || {};
  const items = window.$gameParty ? $gameParty.items().length : 0;
  const map = s.map ? String(s.map.name || '').replace(/^[-✧\s]+/, '') : (s.scene || '');
  const pct = b.max ? Math.max(0, Math.min(100, Math.round(100 * b.left / b.max))) : 0;
  const barColor = b.phase === 'think' ? '#e0a030' : b.phase === 'stuck' ? '#d04040' : '#4caf50';
  const sinceCall = H.lastCallAt ? Date.now() - H.lastCallAt - idleNow() : null;
  const thinking = !!H.activeSince && sinceCall != null && sinceCall > 1500 && s.state !== 'TRANSFER';
  const avg = H.thinks.length ? H.thinks.reduce((a, c) => a + c, 0) / H.thinks.length : null;
  const last = B.last || {};
  const note = (B.notes && B.notes.length) ? B.notes[B.notes.length - 1].text.replace(/^\[map \d+\]\s*/, '') : '';
  d.innerHTML =
    `<div style="font-weight:700;font-size:14px;margin-bottom:4px">🎮 ${esc(H.label || 'AI player')}</div>` +
    `<div>📍 ${esc(map)} · <b>${esc(s.state || '')}</b>${s.paused ? ' · <span style="color:#8cf">⏸ paused</span>' : ''}</div>` +
    (b.max ? `<div style="margin:4px 0">💰 budget ${b.left}/${b.max} ${b.phase !== 'ok' ? '· <b>' + esc(b.phase) + '</b>' : ''}` +
      `<div style="height:6px;background:#333;border-radius:3px;margin-top:2px"><div style="height:6px;width:${pct}%;background:${barColor};border-radius:3px"></div></div></div>` : '') +
    `<div>🧰 items ${items} · 🗺 rooms ${(B.visited || []).length} · 🔧 calls ${H.calls} · ⏱ ${clock(elapsed())}${H.activeSince ? '' : H.idleReason ? ` <span style="color:#f88">⏸ ${esc(H.idleReason)}</span>` : ' 💤'}</div>` +
    `<div>⚡ think ${fmt(H.lastThinkMs)} (avg ${fmt(avg)})${thinking ? ` · <span style="color:#ffd54f">thinking… ${fmt(sinceCall)}</span>` : ''}</div>` +
    (H.lastTool ? `<div style="color:#9cf">▶ ${esc(H.lastTool)}${last.note ? ' — ' + esc(last.note) : ''}</div>` : '') +
    (note ? `<div style="margin-top:4px;color:#ccc;font-style:italic">💭 ${esc(note.slice(0, 140))}</div>` : '');
}

let tick = 0;
// A timer, not a frame hook: the HUD keeps updating while the game is paused for the model.
if (window.__aiHudTimer) clearInterval(window.__aiHudTimer);
window.__aiHudTimer = setInterval(() => { if (H.on) { try { render(); } catch (e) { /* ignore */ } } }, 250);

ai.hud = {
  show(on = true, label) {
    H.on = !!on;
    if (label != null) H.label = String(label);
    if (on && !H.start) H.start = Date.now();
    render();
    return { on: H.on, label: H.label };
  },
  // Called by the MCP server after each tool call: name and the model's think time before it.
  tool(name, thinkMs) {
    if (!H.start) H.start = Date.now();
    setActive(true);
    // Think time = the gap since the last result minus idle time in it (e.g. between rounds).
    const idle = H.idleInGap; H.idleInGap = 0;
    H.calls++; H.lastTool = name; H.lastCallAt = Date.now();
    if (typeof thinkMs === 'number' && thinkMs >= 0 && thinkMs < 600000) {
      const t = Math.max(0, thinkMs - idle);
      H.lastThinkMs = t; H.thinks.push(t); if (H.thinks.length > 50) H.thinks.shift();
    }
    if (H.on) render();
    return true;
  },
  // Runner: a round started (true) / ended (false), with an optional reason shown while stopped.
  active(on = true, reason = '') { setActive(!!on, String(reason || '')); if (H.on) render(); return { active: !!H.activeSince, elapsed_s: Math.round(elapsed() / 1000) }; },
  reset() { H.activeMs = 0; H.activeSince = null; H.idleInGap = 0; H.idleSince = null; H.idleReason = ''; H.start = Date.now(); H.calls = 0; H.thinks = []; H.lastThinkMs = null; H.lastTool = ''; return true; },
};
