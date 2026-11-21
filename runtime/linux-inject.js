// 由 Linux 启动器 (PMGT/run-linux.sh) 的覆盖层 manifest 通过 inject_js_start 注入，
// 在游戏任何脚本之前执行。不修改任何游戏文件。
//  1. Steam 未运行时让 greenworks.init() 返回 false 而不是抛异常（游戏本身已处理 false）。
//  2. 大小写不敏感的资源路径：游戏在 Windows 上开发，引用名与磁盘文件名大小写常不一致。
(function () {
  if (typeof require !== 'function') return;
  const Module = require('module');
  const fs = require('fs');
  const path = require('path');

  // ---------- 1. greenworks ----------
  const origLoad = Module._load;
  Module._load = function (request) {
    const m = origLoad.apply(this, arguments);
    if (/greenworks(\.js)?$/.test(request) && m && typeof m.init === 'function' && !m.__guarded) {
      const init = m.init;
      m.init = function () {
        try { return init.apply(this, arguments); }
        catch (e) { console.warn('[linux-inject] Steam 不可用: ' + e.message); return false; }
      };
      m.__guarded = true;
    }
    return m;
  };

  // ---------- 2. 大小写不敏感路径 ----------
  const ROOT = process.cwd(); // run-linux.sh 会先 cd 到覆盖层目录
  const SKIP = new Set(['node_modules', 'lib', 'locales', 'swiftshader', 'save']);
  const exact = new Set();
  const lower = new Map();
  (function walk(dir, rel) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      const r = rel ? rel + '/' + n : n;
      if (!rel && SKIP.has(n)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, n)); } catch (e) { continue; }
      if (st.isDirectory()) walk(path.join(dir, n), r);
      exact.add(r);
      const k = r.toLowerCase();
      if (!lower.has(k)) lower.set(k, r);
    }
  })(ROOT, '');

  const fixed = new Set();
  function fixRel(rel) {
    if (!rel || exact.has(rel)) return null;
    const real = lower.get(rel.toLowerCase());
    if (!real) return null;
    if (!fixed.has(rel)) { fixed.add(rel); console.debug('[linux-inject] 大小写修正: ' + rel + ' -> ' + real); }
    return real;
  }

  function fixUrl(url) {
    if (typeof url !== 'string' || !url || /^(data|blob):/.test(url)) return url;
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return url;
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      const real = fixRel(rel);
      if (!real) return url;
      u.pathname = '/' + real.split('/').map(encodeURIComponent).join('/');
      return u.href;
    } catch (e) { return url; }
  }

  function fixPath(p) {
    if (typeof p !== 'string') return p;
    const abs = path.resolve(p);
    const rel = path.relative(ROOT, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
    const real = fixRel(rel.split(path.sep).join('/'));
    return real ? path.join(ROOT, real) : p;
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const args = Array.prototype.slice.call(arguments);
    args[1] = fixUrl(url);
    return xhrOpen.apply(this, args);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') input = fixUrl(input);
    return origFetch.call(this, input, init);
  };

  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!d || !d.set) continue;
    Object.defineProperty(proto, 'src', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { d.set.call(this, fixUrl(v)); }
    });
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === 'src' || name === 'href') value = fixUrl(value);
    return setAttr.call(this, name, value);
  };

  const OrigFontFace = window.FontFace;
  if (OrigFontFace) {
    window.FontFace = function (family, source, desc) {
      if (typeof source === 'string') {
        source = source.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => 'url(' + q + fixUrl(u) + q + ')');
      }
      return new OrigFontFace(family, source, desc);
    };
    window.FontFace.prototype = OrigFontFace.prototype;
  }

  for (const fn of ['readFileSync', 'readFile', 'existsSync', 'statSync', 'stat', 'readdirSync', 'readdir', 'accessSync', 'access']) {
    const orig = fs[fn];
    if (typeof orig !== 'function') continue;
    fs[fn] = function (p) {
      const args = Array.prototype.slice.call(arguments);
      args[0] = fixPath(p);
      return orig.apply(this, args);
    };
  }

  window.__linuxInject = { fixUrl, fixPath, fixed };

  // ---------- 3. 加载 MCP mod 的游戏侧桥接（如果存在） ----------
  // 覆盖层会把游戏根目录下的 mcp-mod/ 也链接进来。用间接 eval，在 window 全局作用域里执行。
  try {
    const bridge = path.join(ROOT, 'mcp-mod', 'game', 'ai-bridge.js');
    if (fs.existsSync(bridge)) {
      (0, eval)(fs.readFileSync(bridge, 'utf8') + '\n//# sourceURL=ai-bridge.js');
    }
  } catch (e) {
    console.error('[linux-inject] ai-bridge 加载失败', e);
  }
})();
