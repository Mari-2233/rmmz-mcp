#!/usr/bin/env bash
# Let an OpenClaw agent play the game on its own, round after round, and log how far it gets.
#   scripts/openclaw-play.sh [model] [max_rounds] [port]
# Fair play: OpenClaw only sees normal (non-dev) tools; describe_event / get_variables /
# get_switches are hidden via mcp.servers.pmgt.toolFilter. No cheats, no spoilers.
# The model may remember + restart after a GAME_OVER. Stops on max rounds or 3 rounds without progress (same map + position + log seq).
set -u
MODEL="${1:-cerebras/qwen-3.8-27b}"; ROUNDS="${2:-30}"; PORT="${3:-9333}"
OC="${OC:-$HOME/.openclaw/bin/openclaw}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../agents/notes/E-transcripts/play-$(date +%m%d-%H%M%S)"
mkdir -p "$OUT"; SID="pmgt-play-$(date +%s)"
PROG="$OUT/progress.log"

probe() {
  PMGT_CDP_PORT=$PORT node "$HERE/eval.js" '(()=>{const s=__ai.getState();return {state:s.state,map:s.map&&s.map.id,mapName:s.map&&s.map.name,xy:s.player&&[s.player.x,s.player.y],seq:s.seq,items:$gameParty.items().map(i=>i.name),lastMsg:(__ai.getLog(0,["message"],200).entries.slice(-1)[0]||{}).data}})()' 2>/dev/null | tr -d '\n' | tr -s ' '
}

# HUD clock runs only while a round runs (thinking / tools / writing the reply).
hud() { PMGT_CDP_PORT=$PORT node "$HERE/eval.js" "window.__ai && __ai.hud && __ai.hud.active($1)" >/dev/null 2>&1; }

FIRST="你现在是代打模式：从当前位置开始自己玩《Pocket Mirror ~ GoldenerTraum》，目标是尽可能往前推进剧情、解开谜题。规则：只能用 pmgt 工具正常游玩；不要剧透（不要说出你还没在游戏里看到的内容）。每完成一个小目标（进入新房间、拿到道具、解开谜题）用一句话汇报。卡住时说明卡在哪、试过什么。"
NEXT="继续往前推进。先 get_state 看清现状，再行动。"

echo "model=$MODEL port=$PORT session=$SID start=$(date +%T)" | tee "$PROG"
echo "r0 $(probe)" | tee -a "$PROG"
last=""; same=0
for r in $(seq 1 "$ROUNDS"); do
  msg="$NEXT"; [ "$r" = 1 ] && msg="$FIRST"
  t0=$(date +%s); hud true
  "$OC" agent --model "$MODEL" --json --timeout "${ROUND_TIMEOUT:-1800}" --session-id "$SID" -m "$msg" > "$OUT/r$r.json" 2>/dev/null
  hud false; dt=$(( $(date +%s) - t0 ))
  reply=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=j.result.meta.agentMeta;process.stdout.write(JSON.stringify({turns:m.assistantTurns,calls:m.bridgeCalls&&m.bridgeCalls.call,reply:j.result.payloads.map(p=>p.text).join(" ").replace(/\s+/g," ").slice(0,300)}))}catch(e){process.stdout.write("{\"error\":\"no result\"}")}' "$OUT/r$r.json")
  p=$(probe)
  echo "r$r ${dt}s $reply" | tee -a "$PROG"
  echo "   $p" | tee -a "$PROG"
  # probe output is pretty-printed ("map": 26): allow spaces, or every round looks "unchanged".
  key=$(echo "$p" | grep -oE '"(map|seq)": ?[0-9]+|"xy": ?\[ ?[0-9]+, ?[0-9]+ ?\]' | tr -d ' \n')
  [ -z "$key" ] && key="noprobe-$r"   # can't read the game: don't count it as "no progress"
  if [ "$key" = "$last" ]; then same=$((same+1)); else same=0; fi; last="$key"
  [ $same -ge 3 ] && { echo "no progress for 3 rounds -> stop" | tee -a "$PROG"; break; }
done
echo "end=$(date +%T) out=$OUT" | tee -a "$PROG"
