#!/usr/bin/env bash
# Dev helper: start / stop an isolated game instance on its own CDP port.
#   scripts/game.sh start 9334     # own --user-data-dir, waits until CDP + bridge answer
#   scripts/game.sh stop 9334
# Saves are shared (PMGT/save): never save the game from an agent.
set -e
cmd="$1"; port="${2:?port}"
GAME_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
UD="${XDG_RUNTIME_DIR:-/tmp}/pmgt-ud-$port"
case "$cmd" in
  start)
    if curl -s "localhost:$port/json" >/dev/null; then echo "already running on $port"; exit 0; fi
    # run-linux.sh rebuilds a shared overlay dir: serialize launches.
    exec 9>"${XDG_RUNTIME_DIR:-/tmp}/pmgt-launch-v3.lock"; flock -w 90 9 || { echo "launch lock busy" >&2; exit 1; }
    # exec 9>&- first: nothing that outlives this script may hold the lock fd, or later starts block forever.
    # Background-throttling flags: hidden/occluded windows otherwise drop to ~3 fps.
    (exec 9>&-; cd "$GAME_DIR" || exit 1; nohup ./run-linux.sh --debug-port "$port" --user-data-dir="$UD" \
      --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --ai-dev-clock \
      >"$UD.log" 2>&1 &)
    for i in $(seq 60); do
      sleep 1
      if PMGT_CDP_PORT=$port node "$(dirname "$0")/eval.js" 'window.__ai && __ai.version' >/dev/null 2>&1; then
        sleep 2; echo "started on $port (log $UD.log)"; exit 0; fi
    done
    echo "timeout starting on $port, see $UD.log" >&2; exit 1 ;;
  stop)
    # Kill every process of this instance (main, zygotes, renderers, utilities): they all carry its
    # unique --user-data-dir. Killing only the main process leaves orphan renderers burning CPU.
    # Only nw processes (main is .../nw, children are /proc/self/exe): never shells mentioning the dir.
    pids=$(pgrep -f -- "^([^ ]*/nw|/proc/self/exe) .*--user-data-dir=$UD( |$)" || true)
    if [ -n "$pids" ]; then kill $pids 2>/dev/null; sleep 1; kill -9 $pids 2>/dev/null; echo "stopped $port"; else echo "not running on $port"; fi ;;
  *) echo "usage: game.sh start|stop PORT" >&2; exit 2 ;;
esac
