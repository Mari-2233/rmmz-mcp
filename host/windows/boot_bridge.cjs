// Inject the PMGT AI bridge into a running game over CDP, and normalise the window.
// Usage: node boot_bridge.cjs [port] [overlayDir] [width] [height]
const WebSocket = require('C:/Users/Administrator/Documents/Chat/rmmz-mcp/server/node_modules/ws');
const http = require('http');

const port = process.argv[2] || '9333';
const dir = (process.argv[3] || 'D:/Pocket Mirror - Goldenertraum-pmgt').replace(/\\/g, '/');
const W = parseInt(process.argv[4] || '1296', 10);
const H = parseInt(process.argv[5] || '759', 10);

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let id = 0;
    const send = (m, p) => new Promise(r => {
      const i = ++id;
      const h = x => { const o = JSON.parse(x); if (o.id === i) { ws.off('message', h); r(o); } };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
    ws.on('open', () => resolve({ ws, send }));
    ws.on('error', reject);
  });
}

(async () => {
  let list;
  try { list = await get(`http://127.0.0.1:${port}/json`); }
  catch (e) { console.log('CDP not reachable on ' + port + ': ' + e.message); process.exit(1); }
  const page = list.find(t => t.type === 'page');
  if (!page) { console.log('no page target'); process.exit(1); }

  const { ws, send } = await connect(page.webSocketDebuggerUrl);

  // 1) emit the bridge
  const inject = `(() => { try {
    const fs = require('fs'), path = require('path');
    const dir = ${JSON.stringify(dir)};
    window.__AI_BRIDGE_DIR = path.join(dir, 'mcp-mod', 'game', 'parts');
    (0, eval)(fs.readFileSync(path.join(dir, 'ai-bridge.js'), 'utf8'));
    return 'bridge ' + (window.__ai ? 'v' + window.__ai.version : 'MISSING') +
           ' parts=' + (window.__ai && window.__ai.parts ? window.__ai.parts.length : '-');
  } catch (e) { return 'ERR ' + e.message; } })()`;
  let r = await send('Runtime.evaluate', { expression: inject, returnByValue: true });
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 200));

  // 2) window: never maximised, fixed size, centred
  const fix = `(() => { try {
    const w = nw.Window.get();
    try { w.restore(); } catch (e) {}
    try { w.unmaximize(); } catch (e) {}
    w.resizeTo(${W}, ${H});
    setTimeout(() => { try { w.moveTo(Math.round((screen.availWidth-${W})/2), Math.round((screen.availHeight-${H})/2)); } catch (e) {} }, 150);
    return 'window ' + w.width + 'x' + w.height;
  } catch (e) { return 'window ERR ' + e.message; } })()`;
  r = await send('Runtime.evaluate', { expression: fix, returnByValue: true });
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 200));

  ws.close();
  process.exit(0);
})();
