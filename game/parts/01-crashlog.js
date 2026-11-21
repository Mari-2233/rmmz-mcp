// 01-crashlog (lead): preserve evidence when the game crashes, BEFORE anyone reloads it.
// On SceneManager.catchException / window error, writes a JSON dump to
// ~/.local/share/nwjs/crash/<instance>-<time>.json (outside the game dir and the repo):
// error + stack, scene, map, player, interpreter, recent bridge log, recent goto-explore token,
// and the last 50 console errors. ai.dumpCrash(reason) can also be called manually.
const fs = require('fs'), path = require('path'), os = require('os');
const DIR = path.join(os.homedir(), '.local/share/nwjs/crash');
const argv = (window.nw && nw.App && nw.App.argv) || [];
const ud = (argv.find(a => a.startsWith('--user-data-dir=')) || '').split('/').pop() || 'main';

// Keep recent console errors (they are otherwise lost on reload).
const recentErrors = (window.__aiRecentErrors = window.__aiRecentErrors || []);
if (!window.__aiConsoleErrorWrapped) {
  window.__aiConsoleErrorWrapped = true;
  const orig = console.error.bind(console);
  console.error = function (...a) {
    try {
      recentErrors.push({ t: Date.now(), frame: window.Graphics ? Graphics.frameCount : null,
        msg: a.map(x => (x && x.stack) || String(x)).join(' ').slice(0, 2000) });
      if (recentErrors.length > 50) recentErrors.shift();
    } catch (e) { /* ignore */ }
    return orig(...a);
  };
}

function safe(fn) { try { return fn(); } catch (e) { return `ERR: ${e.message}`; } }

ai.dumpCrash = function (reason, err) {
  const d = {
    reason, at: new Date().toISOString(), instance: ud, bridge: ai.version, parts: ai.parts,
    error: err ? { name: err.name, message: err.message, stack: String(err.stack || '') } : null,
    errorScreen: safe(() => Graphics._errorPrinter && Graphics._errorPrinter.innerText),
    frame: safe(() => Graphics.frameCount),
    scene: safe(() => SceneManager._scene && SceneManager._scene.constructor.name),
    nextScene: safe(() => SceneManager._nextScene && SceneManager._nextScene.constructor.name),
    sceneStarted: safe(() => SceneManager._scene && SceneManager._scene._started),
    map: safe(() => ({ id: $gameMap.mapId(), tileset: $gameMap.tilesetId(), hasTileset: !!$gameMap.tileset() })),
    player: safe(() => ({ x: $gamePlayer.x, y: $gamePlayer.y, transferring: $gamePlayer.isTransferring(), newMap: $gamePlayer._newMapId })),
    interpreter: safe(() => ({ running: $gameMap._interpreter.isRunning(), eventId: $gameMap._interpreter.eventId(), index: $gameMap._interpreter._index })),
    rawState: safe(() => ai.rawState ? ai.rawState() : ai.currentState()),
    gotoExploreRun: window.__gotoExploreRun || null,
    log: safe(() => ai.getLog ? ai.getLog(0, null, 200).entries : null),
    consoleErrors: recentErrors.slice(),
  };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const f = path.join(DIR, `${ud}-${d.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(d, null, 1));
    window.__aiLastCrashFile = f;
    return f;
  } catch (e) { return `ERR: ${e.message}`; }
};

util.ready(() => {
  util.wrap(SceneManager, 'catchException', orig => function (e) {
    try { ai.dumpCrash('catchException', e); } catch (x) { /* never mask the original error */ }
    return orig.apply(this, arguments);
  }, '01-crashlog:SceneManager.catchException');
});
