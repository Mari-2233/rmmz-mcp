// Generic Chrome DevTools Protocol client for the NW.js game page.
// - Discovers the game page target (url ends with "index.html"; --test mode also exposes a DevTools page).
// - Lazily connects, auto-reconnects after the game restarts / page reloads.
// - Helpers: evaluate(), callBridge() for window.__ai.*, screenshot(), bindings for game → server push.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export class CdpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class CdpClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 9333, targetSuffix = 'index.html', timeoutMs = 15000 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.targetSuffix = targetSuffix;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.target = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.bindings = new Set();
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async listTargets() {
    let res;
    try {
      res = await fetch(`http://${this.host}:${this.port}/json`);
    } catch (e) {
      throw new CdpError('GAME_NOT_RUNNING',
        `Cannot reach CDP at ${this.host}:${this.port}. Start the game with: ./run-linux.sh --debug-port ${this.port}`);
    }
    return res.json();
  }

  async findTarget() {
    const targets = await this.listTargets();
    const page = targets.find(t => t.type === 'page' && t.url.endsWith(this.targetSuffix));
    if (!page) throw new CdpError('TARGET_NOT_FOUND', `No page target ending with "${this.targetSuffix}"`, targets.map(t => t.url));
    return page;
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const target = await this.findTarget();
      const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      this.ws = ws;
      this.target = target;
      ws.on('message', data => this.#onMessage(data));
      ws.on('close', () => this.#onClose());
      ws.on('error', err => this.emit('error', err));
      await this.send('Runtime.enable');
      await this.send('Page.enable');
      for (const name of this.bindings) await this.send('Runtime.addBinding', { name });
      this.emit('connected', target);
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  close() {
    if (this.ws) this.ws.close();
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError('CDP_ERROR', msg.error.message, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled') {
      let payload = msg.params.payload;
      try { payload = JSON.parse(payload); } catch { /* keep raw string */ }
      this.emit('binding', msg.params.name, payload);
    }
    this.emit('event', msg.method, msg.params);
  }

  #onClose() {
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError('DISCONNECTED', 'CDP connection closed'));
    }
    this.pending.clear();
    this.emit('disconnected');
  }

  async send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.connected) await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError('TIMEOUT', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Evaluate an expression in the game page; returns the JSON value. Throws CdpError('JS_EXCEPTION') on page errors.
  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    }, { timeoutMs });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new CdpError('JS_EXCEPTION', d.exception?.description || d.text, d);
    }
    return r.result.value;
  }

  // Call window.__ai[method](...args). Args are JSON-serialized: never interpolate raw strings into code.
  async callBridge(method, args = [], opts) {
    if (!/^[A-Za-z_$][\w$]*$/.test(method)) throw new CdpError('BAD_METHOD', `Invalid bridge method name: ${method}`);
    const expr = `(async () => {
      if (!window.__ai) throw new Error('BRIDGE_NOT_LOADED');
      if (typeof window.__ai[${JSON.stringify(method)}] !== 'function') throw new Error('BRIDGE_NO_METHOD: ' + ${JSON.stringify(method)});
      return await window.__ai[${JSON.stringify(method)}](...${JSON.stringify(args)});
    })()`;
    return this.evaluate(expr, opts);
  }

  // Register a binding the page can call: window[name](JSON.stringify(payload)) → 'binding' event here.
  async addBinding(name) {
    this.bindings.add(name);
    if (this.connected) await this.send('Runtime.addBinding', { name });
  }

  // Returns base64 image data. scale < 1 shrinks the capture (full res is 2560x1600 on HiDPI).
  async screenshot({ format = 'jpeg', quality = 70, scale = 0.5 } = {}) {
    const metrics = await this.evaluate('({w: window.innerWidth, h: window.innerHeight})');
    const params = { format, clip: { x: 0, y: 0, width: metrics.w, height: metrics.h, scale } };
    if (format === 'jpeg') params.quality = quality;
    const r = await this.send('Page.captureScreenshot', params);
    return { data: r.data, mimeType: `image/${format}` };
  }
}
