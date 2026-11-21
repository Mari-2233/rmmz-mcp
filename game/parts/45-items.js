// 45-items (C-actions): useItemOn (B8) and pickItem (B9). Game's own item-menu protocol (V12 + _directMenuShortcut).
// Depends on 40-actions (ai.__afterStart).

function snap() {
  try { return ai.getState && ai.currentState() !== 'UNKNOWN' ? ai.getState() : { state: 'UNKNOWN', map: $gameMap.mapId(), player: { x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() } }; } catch (e) { return { state: 'UNKNOWN' }; }
}
function itemArg(itemId) {
  const id = Number(itemId);
  const item = Number.isInteger(id) && $dataItems[id];
  if (!item) throw new Error(`BAD_ARGS: no item ${itemId}`);
  if (!$gameParty.hasItem(item)) throw new Error(`BAD_ARGS: party does not have item ${id} (${item.name})`);
  return item;
}

// Use an item on the shortcut event under / in front of the player (same as Scene_Item "Use" on the map).
ai.useItemOn = async function (itemId) {
  if ($gamePlayer.isMoving()) await util.waitUntil(() => !$gamePlayer.isMoving() && ai.currentState() !== 'MOVING', 1000);
  ai.requireAction('use_item');
  const item = itemArg(itemId);
  const vid = ai.PROFILE.vars.itemId;
  const prev = $gameVariables.value(vid);
  $gameVariables.setValue(vid, item.id);
  $gameTemp._directMenuShortcut = true;
  const started = $gamePlayer.checkShortcutEventTrigger();
  if (!started) {
    $gameSystem.clearShortcutIndex();
    $gameTemp._directMenuShortcut = false;
    $gameVariables.setValue(vid, prev);
  }
  const r = await ai.__afterStart(started);
  r.item = { id: item.id, name: item.name };
  if (!started) {
    const d = $gamePlayer.direction();
    const fx = $gameMap.roundXWithDirection($gamePlayer.x, d), fy = $gameMap.roundYWithDirection($gamePlayer.y, d);
    const below = $gameMap.eventsXy(fx, fy).find(e => e.isShortcutEvent && e.isShortcutEvent() && !e.isNormalPriority());
    r.hint = below
      ? `event ${below.eventId()} (${below.event().name}) accepts items but lies on the floor: step onto (${fx},${fy}) first, then use the item`
      : 'no item-accepting (<shortcutN>) event under or in front of the player';
  }
  return r;
};

// Pick an item while an event's item menu (common event 11 → Scene_Item) is open.
// Mirrors Scene_Item.onItemActionUse while an event is running: V12 = id, _directMenuShortcut = false, then leave the scene.
ai.pickItem = async function (itemId) {
  ai.requireAction('pick_item');
  const sc = SceneManager._scene;
  if (!(window.Scene_Item && sc instanceof Scene_Item)) throw new Error('INVALID_STATE: item menu (Scene_Item) is not open');
  const item = itemArg(itemId);
  const iw = sc._itemWindow;
  const idx = iw && iw._data ? iw._data.indexOf(item) : -1;
  if (idx >= 0 && typeof sc.onItemActionUse === 'function' && typeof sc.startOutroAnimation === 'function') {
    // Drive the real menu: select the item, then the "Use" action (handles the game's special cases).
    iw.select(idx);
    iw.deactivate();
    if (sc._itemActionWindow) sc._itemActionWindow.deactivate();
    sc.onItemActionUse();
  } else {
    $gameVariables.setValue(ai.PROFILE.vars.itemId, item.id);
    $gameTemp._directMenuShortcut = false;
    SceneManager.pop();
  }
  const r = await util.waitUntil(() => SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() && !['TRANSFER', 'SCENE_CHANGING', 'OTHER_SCENE'].includes(ai.currentState()), 5000);
  return { picked: { id: item.id, name: item.name }, returned: r.ok, state: snap() };
};
