// 66-lessons (lead): memory that survives death, like a player who remembers how they died.
// Only lesson TEXT written by the model lives across runs (localStorage) — never map or game
// state (that would be a save, not a memory). Everything else resets when the game restarts.
//   ai.remember(text)  GAME_OVER only; stores one lesson (max 20 kept, 300 chars each)
//   ai.lessons()       the stored lessons
//   ai.__newGame()     used by the server's restart tool after a page reload: through the
//                      splash / language screens to the title, then a fresh new game
const KEY = 'pmgt-ai-lessons';
function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-20))); } catch (e) { /* ignore */ } }

ai.lessons = () => load();
ai.forgetLessons = () => { save([]); return true; }; // for humans/dev; not exposed as a tool

ai.remember = function (text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (ai.currentState() !== 'GAME_OVER') throw new Error('INVALID_STATE: remember is only for lessons after a GAME_OVER');
  if (t.length < 10) throw new Error('BAD_ARGS: write what happened and what to do differently');
  const list = load();
  list.push({ run: list.length + 1, lesson: t.slice(0, 300), at: new Date().toISOString() });
  save(list);
  return { remembered: t.slice(0, 300), lessons: list.length };
};

// Lessons from earlier runs ride along in the snapshot (AI play mode only).
if (ai.getState && !ai.getState.__lessons) {
  const base = ai.getState;
  ai.getState = function () {
    const s = base.apply(this, arguments);
    if (window.__aiBudget && window.__aiBudget.enabled) {
      const l = load();
      if (l.length) s.memory = l.slice(-5).map(x => x.lesson);
    }
    return s;
  };
  ai.getState.__lessons = true;
}

// Boot screens (splash, language, title) are the machine starting, not play: pass them and start
// a new game. One run at a time (token); a newer call supersedes an older one.
ai.__newGame = async function (timeoutMs = 120000) {
  const token = Math.random(); window.__aiNewGameRun = token; window.__aiBooting = true;
  const mine = () => window.__aiNewGameRun === token;
  const t0 = Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Press Z (the game's confirm key) like a person: a real keydown/keyup on the document, which both
  // the engine's Input and the splash screen's "press any key to skip" listener see.
  const key = type => document.dispatchEvent(new KeyboardEvent(type, { key: 'z', code: 'KeyZ', keyCode: 90, which: 90, bubbles: true }));
  const press = async () => { key('keydown'); await sleep(80); key('keyup'); };
  for (;;) {
    if (!mine()) return { superseded: true };
    if (Date.now() - t0 > timeoutMs) window.__aiBooting = false;
    if (Date.now() - t0 > timeoutMs) throw new Error('TIMEOUT: did not reach the title screen');
    const sc = SceneManager._scene, n = sc && sc.constructor.name;
    if (n === 'Scene_Map') { window.__aiBooting = false; return { started: true, already: true, ms: Date.now() - t0 }; }
    if (n === 'Scene_Title' && sc._started && !SceneManager.isSceneChanging()) break;
    // The splash screen's opening movie is skipped by any key, like a player would.
    if (!SceneManager.isSceneChanging()) await press();
    await sleep(200);
  }
  DataManager.setupNewGame();
  SceneManager.goto(Scene_Map);
  await util.waitUntil(() => SceneManager._scene instanceof Scene_Map, 10000);
  if (mine()) window.__aiBooting = false;
  return { started: true, ms: Date.now() - t0 };
};

// While the boot screens are being passed, report BOOT (not OTHER_SCENE): `wait` keeps waiting
// and no action is offered.
for (const name of ['currentState', 'rawState']) {
  const base = ai[name];
  if (!base || base.__boot) continue;
  ai[name] = function () {
    if (window.__aiBooting) {
      if (window.SceneManager && SceneManager._scene instanceof Scene_Map) window.__aiBooting = false;
      else return 'BOOT';
    }
    return base.apply(this, arguments);
  };
  ai[name].__boot = true;
}
