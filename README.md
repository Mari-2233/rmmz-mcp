# rmmz-mcp — an MCP server that lets a model play RPG Maker MZ

**English** · [中文](README.zh-CN.md)

> **No vision. No screenshots.** The model reads the engine's own state and acts on it.
> It plays the way a person does: it explores, it misreads foreshadowing, it dies.
> It can only act: no teleporting, no granting items, no flipping switches.
> If the game can't do it, neither can the model.

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets an AI
agent **observe** an RPG Maker MZ game's state, **walk** it tile by tile, **interact** with
events, **advance dialogue, make choices and use items** — playing the game instead of
watching it. Built for the **Kimi K3.1 Pro × Cerebras × OpenClaw Hackathon** using
**OpenClaw + Kimi K3.1 Pro on Cerebras**.

Currently developed and tuned against **《Pocket Mirror ~ GoldenerTraum》**.

> 🏁 Hackathon entry: **Kimi K3.1 Pro × Cerebras × OpenClaw Hackathon** · #KimiOnCerebras

> ⚠️ **Disclaimer**
> Development was rushed, so this build is **optimized and tested against Pocket Mirror ~
> GoldenerTraum only**. In theory it should work with any RMMZ game (unverified); other games
> are untested and may need adjustments (see [Porting to another RMMZ game](#porting-to-another-rmmz-game)).
>
> This is an unofficial fan project, not affiliated with the game's developers, publishers, or
> the RPG Maker rights holders. The repository **contains no game files or assets** — buy the
> game yourself.

---

## What it does

```
You: look at the room, walk to the mirror, examine it, read the dialogue.
AI:  get_state → list_events → approach(9)
     I walked to the mirror and examined it… it only said "It's a big mirror."
```

- **State machine** — every frame the game side computes exactly one primary state
  (EXPLORE / DIALOGUE / CHOICE / CUTSCENE / TRANSFER / VIDEO …) plus `allowed_actions`, so one
  query tells the model what it is allowed to do right now.
- **Composite tools save rounds** — `approach(event_id)` runs its own BFS (it does not use the
  game's pathfinder), walks next to the target, turns, interacts and reads the whole dialogue:
  **one call replaces 4–8 rounds**. `read_dialogue()` returns a full dialogue block at once.
- **Exploration memory** — `list_events` marks events already investigated on this map
  (`checked`), which cuts duplicate work.
- **Fair play** — the tools available to the model contain **no** teleport, no item granting,
  no switch/variable writing. Tools that would leak information can be hidden from the model
  (see [Fair play](#fair-play-no-cheating-no-spoilers)).
- **No game files are modified** — the bridge is injected over the Chrome DevTools Protocol;
  on Linux the game runs on native NW.js, **no Wine required**.

### Measured (mirror task: walk from the room centre to the mirror, examine it, read the dialogue)

| Model (via OpenClaw) | Tools | Time | Model rounds | Result |
|---|---|---|---|---|
| Kimi K3.1 Pro @ Cerebras (heavy queue at kickoff) | base tools | 223 s | 9 | ✅ |
| qwen-3.8-27b @ Cerebras | base tools | 28.6 s | 11 | ✅ (read the script and spoiled a hidden branch → fixed) |
| qwen-3.8-27b @ Cerebras | + composite tools, anti-spoiler | 19.2 s | 6 | ✅ |
| deepseek-flash (DeepSeek official API, control) | + composite tools, anti-spoiler | 22.5 s | 7 | ✅ |

> Almost all of the Kimi run was platform queueing (30–60 s per request; generation itself is
> very fast). Will be re-measured after capacity expands. The MCP server itself: ~0.3 s cold
> start, 2–70 ms per call.

## How it works

```
OpenClaw (Kimi K3.1 Pro @ Cerebras) ⇄ (stdio) MCP server [Node 18] ⇄ (CDP) NW.js game page → window.__ai → RMMZ engine
```

- An RMMZ game runs on NW.js (Chromium). Launch the game with `--remote-debugging-port` and the
  MCP server connects to the page over CDP.
- On startup the game loads the bridge `game/ai-bridge.js`, which loads `game/parts/*.js` in
  order and exposes `window.__ai`. MCP tools only call methods on `__ai`; arguments travel as
  JSON.

## Layout

```
game/
  ai-bridge.js        bridge entry: tool functions + ordered loading of parts/
  parts/00-core.js    shared contract: state→action table, per-game PROFILE
  parts/01-crashlog   saves the scene on crash (stack, state, logs)
  parts/05-devclock   dev helper: keeps the game loop running when occluded
  parts/10-state      state machine, snapshot, wait      parts/20-log       event log
  parts/30-query      event/map/item queries             parts/35-describe  event command decompiler
  parts/40-actions    walk/face/interact/advance/choose
  parts/45-items      use_item / pick_item               parts/50-combo     approach / read_dialogue
  parts/55-memory     exploration memory (checked)
server/
  src/                MCP server (index.js, cdp.js, tools/, state-contract.js, transcript.js)
  scripts/            dev scripts: eval, smoke, game.sh, goto-explore, openclaw-play, tests
  test/               offline tests and fake game harness (npm test, no game needed)
  tasks/              scripted task suites (scripts/run-tasks.js)
runtime/              native Linux runtime: run-linux.sh, linux-inject.js, install.sh
```

## Requirements

- Linux (development environment: Ubuntu, running under XWayland on Wayland)
- Node.js ≥ 18 and npm
- A legitimately purchased copy of the game (the Windows files from Steam are fine —
  **no Wine required**)
- [NW.js 0.48.4 SDK](https://dl.nwjs.io/v0.48.4/) (linux-x64, matching the Chromium 85 that
  ships with RMMZ 1.x)
- An MCP-capable AI client: [OpenClaw](https://openclaw.ai) is recommended; Claude Code and
  others work too

## Install and quick start

```bash
# 1. Unpack the NW.js SDK to ~/.local/share/nwjs/nwjs-sdk-v0.48.4-linux-x64/
# 2. Install the native Linux runtime (copies the launcher and injector, links this repo into the game dir)
runtime/install.sh /path/to/game

# 3. Install dependencies
cd server && npm install

# 4. Launch the game (with a debug port)
cd /path/to/game && ./run-linux.sh --debug-port 9333

# 5. Smoke test (second terminal, once a game session is running)
cd server && PMGT_MCP_DEV=1 npm run smoke
```

### Wiring up OpenClaw

`openclaw mcp add` is unavailable while the gateway is running, so write the config directly:

```json5
// openclaw config patch --file pmgt.json5
{ mcp: { servers: { pmgt: {
  command: "node",
  args: ["/path/to/rmmz-mcp/server/src/index.js"],
  env: { PMGT_CDP_PORT: "9333" },
  requestTimeoutMs: 60000,
  // fair play: hide tools that leak information or exist for humans
  toolFilter: { exclude: ["describe_event", "get_variables", "get_switches", "screenshot", "get_pushed_events"] }
} } } }
```

```bash
openclaw agent --model cerebras/moonshotai-kimi-k3.1-pro-trial -m "You are playing Pocket Mirror (via the pmgt MCP tools). Look at the current room, walk to the mirror, and examine it."
server/scripts/openclaw-play.sh cerebras/moonshotai-kimi-k3.1-pro-trial 30 9333   # let the model keep playing by itself, log progress
```

### Wiring up Claude Code

```json
{ "mcpServers": { "pmgt": { "command": "node", "args": ["/path/to/rmmz-mcp/server/src/index.js"], "env": { "PMGT_CDP_PORT": "9333" } } } }
```

| Environment variable | Default | Description |
|---|---|---|
| `PMGT_CDP_HOST` | `127.0.0.1` | Host where the game's debug port lives |
| `PMGT_CDP_PORT` | `9333` | Game debug port |
| `PMGT_MCP_DEV` | `0` | `1` enables developer tools (`eval_js`, `reload_bridge`). **Leave off while the model is playing** |
| `PMGT_BUDGET` | `0` | `1` enables AI play mode: action budget and reflect, system events hidden, saving disabled, death memory and `restart`; if the game is still on the title screen when connecting, it clears the title and starts a new game |
| `PMGT_AUTOPAUSE` | `0` | `1` enables auto-pause: the game only runs while an action tool is executing. While the model thinks, the picture, events, enemies, timers, sound and video are all frozen |
| `PMGT_VIEW_RADIUS` | `0` (unlimited) | Vision radius in tiles, measured from the screen centre: `list_events` only returns events already seen, nearest first, and `map_grid` shows `?` outside it. Pathfinding still uses the whole map |
| `PMGT_BACKGROUND` | `0` | `1` keeps the game running when it loses focus or is minimised (bypasses VisuMZ's RequireFocus) |
| `PMGT_WINDOW` | unchanged | Resize the game window on connect, e.g. `1280x720` |
| `PMGT_HUD` | `0` | `1` overlays a progress panel on the game (map, state, budget, call count, thinking time, clock) |
| `PMGT_HUD_LABEL` | empty | HUD title, e.g. `Kimi K3.1 · OpenClaw` |
| `PMGT_FAIR_PLAY` | `0` | `1` stops the server registering spoiler and human-only tools at all (`describe_event`, `get_variables`, `get_switches`, `screenshot`, `get_pushed_events`), whatever the client allows |
| `PMGT_TRANSCRIPT` | unset | Path of a JSONL file that records each tool call that reaches a handler as a hash-chained entry (redacted arguments, result hashes). Check it with `node server/scripts/verify-transcript.js <file>` |

`server/scripts/openclaw-play.sh` additionally reads: `OC` (openclaw executable, default
`~/.openclaw/bin/openclaw`), `ROUND_TIMEOUT` (seconds per round, default `1800`), `FAIL_WAIT`
(seconds to wait after a server-side failure, default `20`), `MAX_FAILS` (how many consecutive
failures before stopping, default `30`), plus `PMGT_CDP_HOST` above. Rounds that fail on the
server side (rate limited, queue full, timeout, no result returned) are retried — they neither
count as "no progress" nor toward the round limit. The HUD timer only advances during a round
(thinking, tool calls, output) and stands still between rounds.

Recommended demo configuration (game running on another machine):

```json5
env: {
  PMGT_CDP_HOST: "<game machine IP>", PMGT_CDP_PORT: "9334",
  PMGT_BUDGET: "1", PMGT_AUTOPAUSE: "1", PMGT_VIEW_RADIUS: "8",
  PMGT_BACKGROUND: "1", PMGT_HUD: "1", PMGT_HUD_LABEL: "Kimi K3.1 · OpenClaw",
}
```

## MCP tools

| Tool | Description |
|---|---|
| `get_state` | State snapshot: primary state, map, player, events ahead/nearby, dialogue and choices, `allowed_actions` |
| `list_events` / `map_grid` / `list_items` | Map events (including `checked`), passability as ASCII art, inventory |
| `approach` | **One call**: walk next to the event (or coordinate), turn, interact, read the dialogue |
| `read_dialogue` | Advance once and return the whole dialogue block |
| `walk` / `face` / `interact` / `advance` / `choose` / `wait` | Fine-grained control (`walk` / `approach` dash by default; `run:false` walks) |
| `reflect` | When the budget runs out: consolidate clues, state a hypothesis and one concrete plan, recover part of the budget (AI play mode) |
| `ask_user` | Ask the user for help when stuck |
| `remember` / `restart` | After GAME_OVER, record lessons (persisted across runs) and start a new run (AI play mode) |
| `use_item` / `pick_item` | Use an item on an event / choose from an item menu raised by an event (only items actually held) |
| `get_log` | What happened recently (dialogue, items, transfers, state changes) |
| `describe_event` / `get_variables` / `get_switches` | Read event scripts, variables, switches (**spoilers** — hide these for fair play) |
| `ping` / `screenshot` / `get_pushed_events` | Connection check, screenshot (for humans), pushed events |
| `get_capabilities` | Diagnostics: CDP reachable, bridge loaded and current (hashes), modes, registered tools. Reports a down game as data instead of failing |

## Fair play: no cheating, no spoilers

- The tools available to the model contain **no** teleporting, item granting, switch/variable
  writing, or event skipping. Those exist only in test fixtures under `server/scripts/test-*.js`
  and are marked `DEV FIXTURE (cheat)`; every bit of progress in the demo has to come from
  normal play.
- The server instructions (MCP `instructions`) require that `describe_event` output is used only
  for the model's own reasoning — never to tell the user about dialogue or branches they have
  not seen. Hint mode gives clues only, and does not play the game for you.
- Hiding `describe_event`, `get_variables` and `get_switches` on the client is recommended
  (see `toolFilter` above). Stronger: `PMGT_FAIR_PLAY=1` stops the server registering those
  tools (plus `screenshot` and `get_pushed_events`) at all, so the rule holds even when a
  client is misconfigured. With `PMGT_TRANSCRIPT` set, every call is also recorded in a
  hash-chained file that anyone can verify after the run (see `server/VERIFIED.md`).

## Running the game on another Windows machine (remote control)

Keep the MCP server and the AI client on one machine and run the game on another (a Windows box
with a discrete GPU, say); the two only talk over CDP. The bridge is injected by the MCP server
over the network on connect, so nothing else from this repo is needed on the Windows side.

1. On Windows: copy `host/` over and run
   `powershell -ExecutionPolicy Bypass -File host\windows\run-pmgt.ps1 -GameDir "<game dir>"`.
   It kills any running instance, builds or refreshes an overlay (the game directory is not
   modified — a sibling `<game dir>-pmgt` is created, containing only junctions and hard links),
   fixes `index.html` in the overlay, launches the game with DevTools port 9333 and the
   anti-throttling / DPI flags, injects the bridge and sets the window size.
2. To connect from another machine, run once in an **administrator** PowerShell on Windows:
   `host\windows\expose-cdp.ps1 -RemoteIp <IP of the MCP machine>` — it adds a 9334→9333 port
   forward and opens the firewall to that single IP. Undo with `expose-cdp.ps1 -Remove`.
3. On the MCP side set `PMGT_CDP_HOST=<Windows IP>`, `PMGT_CDP_PORT=9334`, plus
   `PMGT_BACKGROUND=1` (keeps the game running unfocused or minimised, bypassing VisuMZ's
   RequireFocus). The MCP server replaces the game's copy of the bridge with the local one on
   connect.

> ⚠️ Any machine that can reach this port can execute arbitrary code inside the game process.
> Use it on trusted LANs only and restrict the source IP.

## Running RMMZ games on Linux (no Wine)

- `runtime/run-linux.sh`: the launcher. It builds an "overlay" directory of symlinks to the game
  files, replacing only `package.json` with its own version (DevTools enabled, injector loaded).
  **The game files themselves are not modified.**
- `runtime/linux-inject.js`: injected before the game scripts and it
  - makes greenworks initialise to false instead of throwing when Steam is not running;
  - makes asset paths **case-insensitive** (games built on Windows are often inconsistent);
  - loads `ai-bridge.js`.
- ⚠️ Never call `location.reload()` on the game page: NW.js will not re-run the injected script
  on refresh and assets will 404. Restart the game instead.

## Porting to another RMMZ game

`ai-bridge.js` has two layers:

- **Core (generic)**: state machine, movement, interaction, choices, dialogue, queries — only
  native RMMZ engine APIs.
- **Profile (per game)**: `ai.PROFILE` in `parts/00-core.js` (switch IDs, item protocol, key
  bindings, …).

To change games, replace or empty `PROFILE`; unsupported features return `UNSUPPORTED`. Things
that may need work: different plugins (choice windows, movement, map plugins), encryption, and
native Steamworks libraries.

## Development

```bash
cd server
npm test                                          # offline tests + fake-game integration (no game needed, also runs in CI)
node scripts/run-tasks.js --fake                  # mirror task suite against the fake game
./scripts/game.sh start 9334                      # launch an isolated game instance (several can run in parallel)
PMGT_CDP_PORT=9334 node scripts/goto-explore.js   # start a new game and advance to the first playable room (~30 s)
PMGT_CDP_PORT=9334 node scripts/eval.js --reload  # hot-reload game/parts (no game restart)
PMGT_CDP_PORT=9334 node scripts/eval.js --bridge getState
PMGT_CDP_PORT=9334 node scripts/test-A-state.js   # per-module acceptance tests (A/B/C)
PMGT_MCP_DEV=1 PMGT_CDP_PORT=9334 npm run smoke   # MCP end-to-end test
./scripts/game.sh stop 9334
```

If the game crashes, `parts/01-crashlog.js` writes the call stack and scene to
`~/.local/share/nwjs/crash/`.

## Credits

Most of the code here was written with Claude Code as an assistant. Claude is not a runtime
dependency — nothing in this repo calls it. The agent loop in the demo runs on Kimi K3.1 Pro
served by Cerebras, through OpenClaw.

## Acknowledgements

- [Model Context Protocol](https://modelcontextprotocol.io) with
  [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk),
  [ws](https://github.com/websockets/ws), [zod](https://github.com/colinhacks/zod)
- [NW.js](https://nwjs.io), [OpenClaw](https://openclaw.ai), [Cerebras](https://cerebras.ai),
  [Moonshot AI (Kimi)](https://www.moonshot.ai)
- RPG Maker MZ engine (© Gotcha Gotcha Games); 《Pocket Mirror ~ GoldenerTraum》 (© the original author)

## License

[MIT](LICENSE) © 2026 Mari-2233
