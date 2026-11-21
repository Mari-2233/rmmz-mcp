// 35-describe (B-query, B10): describeEvent(id[, page]) — decompile a map event page into readable pseudo-code.
// Names come from $dataSystem / $dataItems / $dataCommonEvents / $dataMapInfos. Common events are NOT expanded.

const MAX_LINES = 200;
const strip = s => (ai.stripCodes ? ai.stripCodes(s) : String(s == null ? '' : s));
const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const q = s => JSON.stringify(cut(strip(s), 160));

function nm(arr, id) { const v = arr && arr[id]; return v && typeof v === 'object' ? (v.name || '') : (v || ''); }
const swName = id => `Switch ${id}${nm($dataSystem.switches, id) ? ' ' + nm($dataSystem.switches, id) : ''}`;
const varName = id => `Var ${id}${nm($dataSystem.variables, id) ? ' ' + nm($dataSystem.variables, id) : ''}`;
const itemName = id => `item ${id}${nm($dataItems, id) ? ' ' + strip(nm($dataItems, id)) : ''}`;
const ceName = id => `CommonEvent ${id}${nm($dataCommonEvents, id) ? ' ' + nm($dataCommonEvents, id) : ''}`;
const mapName = id => `Map ${id}${nm($dataMapInfos, id) ? ' ' + nm($dataMapInfos, id) : ''}`;
const DIRS = { 0: 'keep', 2: 'down', 4: 'left', 6: 'right', 8: 'up' };
const OPS = ['==', '>=', '<=', '>', '<', '!='];
const ASSIGN = ['=', '+=', '-=', '*=', '/=', '%='];

// Pocket Mirror stores dialogue in VisuMZ_5_LanguageProcessor files: code "File.name" -> {text, speakerName}.
function langMessage(code) {
  const out = { text: `[message ${code}]`, speaker: '' };
  try {
    const LM = window.LanguageManager;
    const [file, name] = String(code).split('.');
    const d = LM && LM._data && LM._data[LM._language];
    const m = d && d.text && d.text[file] && d.text[file][name];
    if (m) {
      out.text = strip(String(m.text || '').replace(/\r?\n/g, ' / '));
      out.speaker = strip(m.speakerName || '');
    } else out.text = `[message ${code} (not loaded)]`;
  } catch (e) { /* keep placeholder */ }
  return out;
}
ai.langMessage = langMessage;

function charName(id) {
  if (id < 0) return 'Player';
  if (id === 0) return 'ThisEvent';
  const ev = window.$gameMap && $gameMap.event(id);
  const n = ev && ev.event() ? ev.event().name : '';
  return `Event ${id}${n ? ' ' + n : ''}`;
}

function pageConditions(page, mapId, eventId) {
  const c = page.conditions || {};
  const out = [];
  const on = b => (b ? 'ON' : 'OFF');
  if (c.switch1Valid) out.push({ text: `${swName(c.switch1Id)} is ON`, met: !!$gameSwitches.value(c.switch1Id) });
  if (c.switch2Valid) out.push({ text: `${swName(c.switch2Id)} is ON`, met: !!$gameSwitches.value(c.switch2Id) });
  if (c.variableValid) {
    const v = $gameVariables.value(c.variableId);
    out.push({ text: `${varName(c.variableId)} >= ${c.variableValue} (now ${v})`, met: v >= c.variableValue });
  }
  if (c.selfSwitchValid) {
    const v = !!$gameSelfSwitches.value([mapId, eventId, c.selfSwitchCh]);
    out.push({ text: `SelfSwitch ${c.selfSwitchCh} is ON (now ${on(v)})`, met: v });
  }
  if (c.itemValid) out.push({ text: `Has ${itemName(c.itemId)}`, met: $gameParty.hasItem($dataItems[c.itemId]) });
  if (c.actorValid) {
    const a = $gameActors.actor(c.actorId);
    out.push({ text: `Actor ${c.actorId} ${nm($dataActors, c.actorId)} in party`, met: !!(a && $gameParty.members().includes(a)) });
  }
  return out;
}

function condText(p) {
  switch (p[0]) {
    case 0: return `${swName(p[1])} is ${p[2] === 0 ? 'ON' : 'OFF'}`;
    case 1: return `${varName(p[1])} ${OPS[p[4]] || '?'} ${p[2] === 0 ? p[3] : varName(p[3])}`;
    case 2: return `SelfSwitch ${p[1]} is ${p[2] === 0 ? 'ON' : 'OFF'}`;
    case 3: return `Timer ${p[2] === 0 ? '>=' : '<='} ${p[1]}s`;
    case 4: return `Actor ${p[1]} ${nm($dataActors, p[1])} check type ${p[2]} ${p[3] != null ? p[3] : ''}`.trim();
    case 6: return `${charName(p[1])} is facing ${DIRS[p[2]] || p[2]}`;
    case 7: return `Gold ${['>=', '<=', '<'][p[2]] || '?'} ${p[1]}`;
    case 8: return `Has ${itemName(p[1])}`;
    case 9: return `Has weapon ${p[1]} ${nm($dataWeapons, p[1])}`;
    case 10: return `Has armor ${p[1]} ${nm($dataArmors, p[1])}`;
    case 11: return `Button ${p[1]} pressed`;
    case 12: return `Script(${cut(p[1], 120)})`;
    case 13: return `Vehicle ${p[1]} driven`;
    default: return `cond type ${p[0]} ${cut(JSON.stringify(p.slice(1)), 60)}`;
  }
}

function operand122(p) {
  switch (p[3]) {
    case 0: return String(p[4]);
    case 1: return varName(p[4]);
    case 2: return `random(${p[4]}..${p[5]})`;
    case 3: return `gameData(${p[4]},${p[5]},${p[6]})`;
    case 4: return `script(${cut(p[4], 100)})`;
    default: return '?';
  }
}

// Decompile a command list into lines.
function decompile(list) {
  const lines = [];
  let truncated = false;
  const push = (indent, s) => {
    if (lines.length >= MAX_LINES) { truncated = true; return; }
    lines.push('  '.repeat(Math.max(0, indent)) + cut(s, 240));
  };
  for (let i = 0; i < list.length; i++) {
    const c = list[i], p = c.parameters || [], ind = c.indent || 0;
    switch (c.code) {
      case 0: break; // end of block: indentation shows it
      case 101: {
        const speaker = strip(p[4]) || (p[0] ? `face ${p[0]}:${p[1]}` : '');
        const text = [];
        while (list[i + 1] && list[i + 1].code === 401) text.push(strip(list[++i].parameters[0]));
        push(ind, `Text${speaker ? '(' + speaker + ')' : ''}: ${JSON.stringify(cut(text.join(' / '), 300))}`);
        break;
      }
      case 401: push(ind, `Text: ${q(p[0])}`); break;
      case 102: push(ind, `Choice [${(p[0] || []).map(s => JSON.stringify(strip(s))).join(', ')}]${p[1] >= 0 ? ' cancel=' + p[1] : ''}`); break;
      case 402: push(ind, `When #${p[0]} ${q(p[1])}:`); break;
      case 403: push(ind, 'When Cancel:'); break;
      case 404: push(ind, 'End choice'); break;
      case 103: push(ind, `NumberInput -> ${varName(p[0])} (${p[1]} digits)`); break;
      case 104: push(ind, `SelectItem -> ${varName(p[0])}`); break;
      case 105: case 405: push(ind, `ScrollText: ${q(p[0] != null && typeof p[0] === 'string' ? p[0] : '')}`); break;
      case 108: {
        const t = [strip(p[0])];
        while (list[i + 1] && list[i + 1].code === 408) t.push(strip(list[++i].parameters[0]));
        push(ind, `// ${cut(t.join(' | '), 200)}`);
        break;
      }
      case 408: push(ind, `// ${cut(p[0], 200)}`); break;
      case 111: push(ind, `If ${condText(p)}:`); break;
      case 411: push(ind, 'Else:'); break;
      case 412: push(ind, 'End if'); break;
      case 112: push(ind, 'Loop:'); break;
      case 413: push(ind, 'Repeat'); break;
      case 113: push(ind, 'Break loop'); break;
      case 115: push(ind, 'Exit event'); break;
      case 117: push(ind, `Call ${ceName(p[0])}`); break;
      case 118: push(ind, `Label ${p[0]}`); break;
      case 119: push(ind, `Jump to label ${p[0]}`); break;
      case 121: {
        const rng = p[0] === p[1] ? swName(p[0]) : `Switches ${p[0]}..${p[1]}`;
        push(ind, `Set ${rng} = ${p[2] === 0 ? 'ON' : 'OFF'}`);
        break;
      }
      case 122: {
        const rng = p[0] === p[1] ? varName(p[0]) : `Vars ${p[0]}..${p[1]}`;
        push(ind, `Set ${rng} ${ASSIGN[p[2]] || '?='} ${operand122(p)}`);
        break;
      }
      case 123: push(ind, `Set SelfSwitch ${p[0]} = ${p[1] === 0 ? 'ON' : 'OFF'}`); break;
      case 124: push(ind, `Timer ${p[0] === 0 ? 'start ' + p[1] + 's' : 'stop'}`); break;
      case 125: push(ind, `Gold ${p[0] === 0 ? '+' : '-'}${p[1] === 0 ? p[2] : varName(p[2])}`); break;
      case 126: push(ind, `${p[1] === 0 ? 'Gain' : 'Lose'} ${itemName(p[0])} x${p[2] === 0 ? p[3] : varName(p[3])}`); break;
      case 129: push(ind, `Party ${p[1] === 0 ? 'add' : 'remove'} actor ${p[0]} ${nm($dataActors, p[0])}`); break;
      case 201: {
        const dest = p[0] === 0 ? `${mapName(p[1])} (${p[2]},${p[3]})` : `map=${varName(p[1])} x=${varName(p[2])} y=${varName(p[3])}`;
        push(ind, `Transfer to ${dest}${p[4] ? ' facing ' + (DIRS[p[4]] || p[4]) : ''}`);
        break;
      }
      case 203: push(ind, `SetEventLocation ${charName(p[0])} ${p[1] === 0 ? `(${p[2]},${p[3]})` : p[1] === 1 ? `(${varName(p[2])},${varName(p[3])})` : `swap with ${charName(p[2])}`}`); break;
      case 204: push(ind, `ScrollMap dir ${DIRS[p[0]] || p[0]} x${p[1]}`); break;
      case 205: {
        const r = p[1] || {}, n = (r.list || []).length - 1;
        push(ind, `MoveRoute ${charName(p[0])}: ${n} step(s)${r.wait ? ' (wait)' : ''}${r.repeat ? ' (repeat)' : ''}`);
        break;
      }
      case 505: break;
      case 211: push(ind, `Transparency ${p[0] === 0 ? 'ON' : 'OFF'}`); break;
      case 212: push(ind, `Animation ${p[1]} on ${charName(p[0])}`); break;
      case 213: push(ind, `Balloon ${p[1]} on ${charName(p[0])}`); break;
      case 214: push(ind, 'Erase this event'); break;
      case 216: push(ind, `Followers ${p[0] === 0 ? 'show' : 'hide'}`); break;
      case 221: push(ind, 'FadeOut screen'); break;
      case 222: push(ind, 'FadeIn screen'); break;
      case 223: push(ind, `Tint screen ${JSON.stringify(p[0])} ${p[1]}f`); break;
      case 224: push(ind, `Flash screen ${p[1]}f`); break;
      case 225: push(ind, `Shake screen ${p[2]}f`); break;
      case 230: push(ind, `Wait ${p[0]} frames`); break;
      case 231: push(ind, `ShowPicture #${p[0]} ${JSON.stringify(p[1])}`); break;
      case 232: push(ind, `MovePicture #${p[0]} ${p[10] || ''}f`); break;
      case 235: push(ind, `ErasePicture #${p[0]}`); break;
      case 241: push(ind, `PlayBGM ${p[0] && p[0].name}`); break;
      case 242: push(ind, 'FadeOut BGM'); break;
      case 245: push(ind, `PlayBGS ${p[0] && p[0].name}`); break;
      case 249: push(ind, `PlayME ${p[0] && p[0].name}`); break;
      case 250: push(ind, `PlaySE ${p[0] && p[0].name}`); break;
      case 261: push(ind, `PlayMovie ${p[0]}`); break;
      case 301: push(ind, 'Battle'); break;
      case 351: push(ind, 'OpenMenu'); break;
      case 352: push(ind, 'OpenSave'); break;
      case 353: push(ind, 'GameOver'); break;
      case 354: push(ind, 'ReturnToTitle'); break;
      case 355: {
        let s = String(p[0]);
        while (list[i + 1] && list[i + 1].code === 655) s += '\n' + list[++i].parameters[0];
        push(ind, `Script: ${cut(s.replace(/\s*\n\s*/g, '; '), 120)}`);
        break;
      }
      case 655: push(ind, `Script: ${cut(p[0], 120)}`); break;
      case 356: push(ind, `PluginCommand(MV): ${cut(p[0], 120)}`); break;
      case 357: {
        const a = p[3] || {};
        const plugin = String(p[0] || '').split('/').pop();
        if (plugin === 'VisuMZ_5_LanguageProcessor' && p[1] === 'ShowLanguageMessage') {
          const m = langMessage(a['Code:str']);
          push(ind, `Text${m.speaker ? '(' + m.speaker + ')' : ''}: ${JSON.stringify(cut(m.text, 300))}`);
        } else if (plugin === 'VisuMZ_5_LanguageProcessor' && p[1] === 'AddChoice') {
          push(ind, `ChoiceOption ${JSON.stringify(cut(langMessage(a['Code:str']).text, 120))} -> label ${a['Label:str']}`);
        } else if (plugin === 'VisuMZ_5_LanguageProcessor' && p[1] === 'ShowChoices') {
          push(ind, `ShowChoices (options above; picking one jumps to its label)${a['CancelType:num'] != null ? ' cancel=' + a['CancelType:num'] : ''}`);
        } else if (plugin === 'VisuMZ_1_EventsMoveCore' && p[1] === 'SelfSwitchABCD') {
          push(ind, `Set SelfSwitch ${a['Letter:str']} of event ${a['EventId:eval']} (map ${a['MapId:eval']}) = ${a['Value:str']}`);
        } else push(ind, `Plugin ${plugin}.${p[1]} ${cut(JSON.stringify(a), 100)}`);
        break;
      }
      case 657: break;
      default: push(ind, `code ${c.code} ${cut(JSON.stringify(p), 80)}`);
    }
  }
  if (truncated) lines.push(`... (truncated at ${MAX_LINES} lines; list has ${list.length} commands)`);
  return lines;
}
ai.decompileList = decompile;

ai.describeEvent = function (id, pageArg) {
  const sc = window.SceneManager && SceneManager._scene;
  if (!sc || sc.constructor.name !== 'Scene_Map' || !window.$gameMap) throw new Error('INVALID_STATE: describeEvent needs Scene_Map');
  const eid = Number(id);
  if (!Number.isInteger(eid)) throw new Error('BAD_ARGS: id must be an integer');
  const ev = $gameMap.event(eid);
  if (!ev || !ev.event()) throw new Error(`NOT_FOUND: no event ${id} on map ${$gameMap.mapId()}`);
  const data = ev.event();
  const mapId = $gameMap.mapId();
  const cur = typeof ev._pageIndex === 'number' ? ev._pageIndex : -1;
  let page = cur;
  if (pageArg != null) {
    page = Number(pageArg);
    if (!Number.isInteger(page) || page < 0 || page >= data.pages.length) throw new Error(`BAD_ARGS: page must be 0..${data.pages.length - 1}`);
  }
  const pages = data.pages.map((pg, i) => {
    const conds = pageConditions(pg, mapId, eid);
    return {
      index: i, current: i === cur, conditions: conds.map(c => c.text + (c.met ? '' : ' [NOT MET]')),
      allMet: conds.every(c => c.met), trigger: pg.trigger, commands: (pg.list || []).length,
    };
  });
  const out = {
    id: eid, name: data.name || '', x: ev.x, y: ev.y, page, currentPage: cur, erased: !!ev._erased,
    note: cut(data.note || '', 200),
    trigger: page >= 0 ? data.pages[page].trigger : null,
    conditions: page >= 0 ? pageConditions(data.pages[page], mapId, eid).map(c => c.text) : [],
    lines: page >= 0 ? decompile(data.pages[page].list || []) : [],
  };
  if (page < 0) {
    out.why = 'No page is active: the game shows the highest-numbered page whose conditions are all met. Conditions per page are in `pages`.';
    out.pages = pages;
  } else if (data.pages.length > 1) {
    out.pages = pages; // short per-page summary: helps see what will change after a switch flips
  }
  return out;
};
