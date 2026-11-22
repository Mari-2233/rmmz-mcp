// A fake NW.js debug endpoint: just enough Chrome DevTools Protocol for the real MCP server.
//
// Serves GET /json (target discovery) and a WebSocket that answers Runtime.evaluate by running
// the expression in a vm context whose window.__ai is the fake bridge (fake-game.js). Seed it
// with the real bundle hash and part names so ensureBridge sees a current bridge and injects
// nothing. Test support only; nothing here ships in the game or starts on its own.
import { createServer } from 'node:http';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { createFakeBridge } from './fake-game.js';

// 1x1 JPEG, forwarded untouched by the screenshot tool.
const TINY_JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';

export async function startFakeGame({ bridgeHash = null, parts = [] } = {}) {
  const bridge = createFakeBridge();
  bridge.parts = parts;

  class SceneMap {}
  Object.defineProperty(SceneMap, 'name', { value: 'Scene_Map' });
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 1280, innerHeight: 720 };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__ai = bridge;
  sandbox.__AI_BRIDGE_HASH = bridgeHash;
  sandbox.Scene_Map = SceneMap;
  sandbox.SceneManager = { _scene: new SceneMap() };
  sandbox.Graphics = { frameCount: 1000 };
  sandbox.__aiNotify = () => {};
  vm.createContext(sandbox);

  async function evaluate(expression) {
    try {
      let value = vm.runInContext(expression, sandbox, { timeout: 5000 });
      if (value && typeof value.then === 'function') value = await value;
      if (value === undefined) return { result: { type: 'undefined' } };
      return { result: { type: typeof value, value: JSON.parse(JSON.stringify(value)) } };
    } catch (e) {
      return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: String(e.stack || e) } } };
    }
  }

  let port = 0;
  const http = createServer((req, res) => {
    if (req.url === '/json' || req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{
        type: 'page',
        url: 'file:///fake-game/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fake-1`,
      }]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', ws => {
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id === undefined) return;
      const reply = obj => ws.send(JSON.stringify({ id: msg.id, ...obj }));
      try {
        if (msg.method === 'Runtime.evaluate') reply({ result: await evaluate(msg.params?.expression || '') });
        else if (msg.method === 'Page.captureScreenshot') reply({ result: { data: TINY_JPEG } });
        else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') reply({ result: { identifier: 'fake-script-1' } });
        else reply({ result: {} });
      } catch (e) {
        reply({ error: { code: -32000, message: String(e.message || e) } });
      }
    });
  });

  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  port = http.address().port;

  return {
    port,
    bridge,
    close: () => new Promise(resolve => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => http.close(() => resolve()));
    }),
  };
}
