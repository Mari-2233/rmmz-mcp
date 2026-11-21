#!/usr/bin/env bash
# Install the native-Linux runtime for an RPG Maker MZ game (no Wine).
#   runtime/install.sh /path/to/game
# - copies run-linux.sh into the game folder (game files themselves are never modified)
# - installs linux-inject.js + a stub libsdkencryptedappticket.so into $NWJS_HOME/steamstub
# - links this repo into the game folder as mcp-mod/ so linux-inject.js can load the AI bridge
# NW.js itself is not downloaded: get the SDK build matching the game's Chromium (RMMZ 1.x:
# nwjs-sdk-v0.48.4-linux-x64) from https://dl.nwjs.io/ and unpack it into $NWJS_HOME.
set -euo pipefail
GAME_DIR="$(cd "${1:?usage: install.sh /path/to/game}" && pwd)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NWJS_HOME="${NWJS_HOME:-$HOME/.local/share/nwjs}"
STUB="$NWJS_HOME/steamstub"

[ -f "$GAME_DIR/index.html" ] && [ -d "$GAME_DIR/js" ] || { echo "not an RMMZ game folder: $GAME_DIR" >&2; exit 1; }
mkdir -p "$STUB"
install -m 755 "$REPO/runtime/run-linux.sh" "$GAME_DIR/run-linux.sh"
install -m 644 "$REPO/runtime/linux-inject.js" "$STUB/linux-inject.js"

# The game's greenworks needs libsdkencryptedappticket.so, which isn't shipped for linux64.
# Any library works as a lazy-bound placeholder; use the system libdl.
LIBDL="$(ldconfig -p | awk '/libdl\.so\.2 .*x86-64/{print $NF; exit}')"
[ -n "$LIBDL" ] && ln -sfn "$LIBDL" "$STUB/libsdkencryptedappticket.so"

# linux-inject.js loads <game>/mcp-mod/game/ai-bridge.js
if [ "$(cd "$GAME_DIR/mcp-mod" 2>/dev/null && pwd -P)" != "$(cd "$REPO" && pwd -P)" ]; then
  if [ -e "$GAME_DIR/mcp-mod" ]; then echo "warning: $GAME_DIR/mcp-mod exists and is not this repo; leaving it" >&2
  else ln -s "$REPO" "$GAME_DIR/mcp-mod"; fi
fi

NW="$NWJS_HOME/nwjs-sdk-v0.48.4-linux-x64/nw"
[ -x "$NW" ] || echo "note: NW.js SDK not found at $NW (download from https://dl.nwjs.io/v0.48.4/)"
echo "done. Start the game with: cd \"$GAME_DIR\" && ./run-linux.sh --debug-port 9333"
