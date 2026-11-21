#!/usr/bin/env bash
# 在 Linux 上用原生 NW.js (v0.48.4 SDK，与游戏原版 Chromium 85 一致) 运行本 RMMZ 游戏，不使用 Wine。
# 不修改任何游戏文件：启动时在 $OVERLAY 下生成一个“覆盖层”目录，
# 其中所有条目都是指向游戏目录的符号链接，只有 package.json 是 Linux 专用的。
#
# 用法: ./run-linux.sh [--test] [--debug-port N]
#   --test           RMMZ 测试模式：F8 打开 DevTools，F9 开关/变量调试
#   --debug-port N   开启 Chrome 远程调试端口（可用 chrome://inspect 连接）
#   其它参数原样传给 NW.js（如 --enable-logging=stderr 把 console 输出到终端）
set -e
GAME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NWJS_HOME="${NWJS_HOME:-$HOME/.local/share/nwjs}"
NW="${NW:-$NWJS_HOME/nwjs-sdk-v0.48.4-linux-x64/nw}"
STUB="$NWJS_HOME/steamstub"
OVERLAY="$NWJS_HOME/pmgt-app"

[ -x "$NW" ] || { echo "找不到 NW.js: $NW" >&2; exit 1; }

# --- 覆盖层：链接所有游戏文件（package.json 除外） ---
mkdir -p "$OVERLAY"
# Never delete-then-relink: other running instances read through these links (a launch used to
# leave the overlay half-empty for a moment, so running games got 404s). Replace in place with
# ln -sfn and only drop links whose target is gone.
find "$OVERLAY" -maxdepth 1 -xtype l -delete
for f in "$GAME_DIR"/* "$GAME_DIR"/.[!.]*; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  [ "$name" = "package.json" ] && continue
  # A regular file here was written by the game at runtime (e.g. "Last Error.txt" from a crash):
  # keep it as evidence instead of failing the launch.
  if [ -e "$OVERLAY/$name" ] && [ ! -L "$OVERLAY/$name" ]; then
    mkdir -p "$NWJS_HOME/crash"
    mv "$OVERLAY/$name" "$NWJS_HOME/crash/overlay-$(date +%Y%m%d-%H%M%S)-$$-$name" 2>/dev/null || true
  fi
  ln -sfn "$f" "$OVERLAY/$name"
done
ln -sf "$STUB/linux-inject.js" "$OVERLAY/linux-inject.js"

# 与原 package.json 相同，但去掉 --disable-devtools 并注入 linux-inject.js
cat > "$OVERLAY/package.json" <<'JSON'
{
    "name": "rmmz-game",
    "main": "index.html",
    "inject_js_start": "linux-inject.js",
    "chromium-args": "--force-color-profile=srgb --ignore-gpu-blacklist --in-process-gpu --limit-fps=60",
    "window": {
        "title": "Pocket Mirror ~ GoldenerTraum",
        "width": 1280,
        "height": 720,
        "position": "center",
        "icon": "icon/icon.png"
    }
}
JSON

# --- 原生库 ---
# greenworks 的 RPATH 指向 lib/，那里的 libsteam_api.so 是 32 位，所以优先用 lib/linux64；
# 游戏没有附带 64 位 libsdkencryptedappticket.so，$STUB 里放了一个占位符号链接。
export LD_LIBRARY_PATH="$GAME_DIR/lib/linux64:$STUB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# NW.js 0.48 不支持原生 Wayland，改走 XWayland
export GDK_BACKEND=x11

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --test) ARGS+=(test) ;;
    --debug-port) ARGS+=("--remote-debugging-port=$2"); shift ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

cd "$OVERLAY"
exec "$NW" "$OVERLAY" "${ARGS[@]}"
