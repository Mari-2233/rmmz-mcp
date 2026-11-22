# PMGT-MCP — 让 AI 来玩 RPG Maker MZ 的解谜

> **An MCP server that lets a language model play RPG Maker MZ games by reading the engine state directly, not the screen.**
> It plays the way a person does: it explores, it misreads foreshadowing, it dies.
> It can only act: no teleporting, no granting items, no flipping switches.
> If the game can't do it, neither can the model.

一个 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) 服务，让 AI agent **观察** RPG Maker MZ 游戏的状态、**逐格移动**、**与事件交互、推进对白、做出选择、使用道具**，从而辅助（或代替）玩家解谜。比赛中使用 **OpenClaw + Cerebras 上的 Kimi K3.1 Pro**。

目前以 **《Pocket Mirror ~ GoldenerTraum》（黄金镜）** 为目标游戏开发。

> 🏁 参赛作品：**Kimi K3.1 Pro × Cerebras × OpenClaw Hackathon** · #KimiOnCerebras

> ⚠️ **免责声明**
> 由于开发匆忙，目前**仅对《Pocket Mirror ~ GoldenerTraum》（黄金镜）进行了优化和测试**。理论上可以适用于全部 RMMZ 游戏（未验证），但其他游戏未经测试，可能需要调整（见[移植到其他 RMMZ 游戏](#移植到其他-rmmz-游戏)）。
>
> *Disclaimer: Due to rushed development, this project is currently optimized and tested only for Pocket Mirror ~ GoldenerTraum. It should in theory work with any RPG Maker MZ game (unverified), but others are untested.*
>
> 本项目是非官方的粉丝作品，与游戏开发者、发行商及 RPG Maker 的版权方均无关联。仓库**不包含任何游戏文件或素材**，请自行合法购买游戏。

---

## 它能做什么

```
你：观察当前房间，走到镜子前，调查它，读完对白。
AI：get_state → list_events → approach(9)
    我走到镜子前调查了它……只弹出一句 "It's a big mirror."
```

- **状态机**：游戏侧每帧算出唯一的主状态（EXPLORE / DIALOGUE / CHOICE / CUTSCENE / TRANSFER / VIDEO …）和 `allowed_actions`，AI 查询一次就知道"现在能做什么"。
- **组合工具省轮数**：`approach(event_id)` 用自己的 BFS 寻路（不依赖游戏寻路）走到目标旁、转向、交互并读完对白，**一次调用代替 4–8 轮**；`read_dialogue()` 一次读完整段对白。
- **探索记忆**：`list_events` 标出这张地图上已经调查过的事件（`checked`），减少重复。
- **公平游玩**：AI 可用的工具里**没有**传送、给道具、改开关/变量；可以对 AI 隐藏会泄露信息的工具（见[公平性](#公平性不作弊不剧透)）。
- **不修改任何游戏文件**：通过 Chrome DevTools Protocol 注入；Linux 上用原生 NW.js 运行，**不需要 Wine**。

### 实测（镜子任务：从房间中央走到镜子前、调查、读完对白）

| 模型（经 OpenClaw） | 工具 | 用时 | 模型轮数 | 结果 |
|---|---|---|---|---|
| Kimi K3.1 Pro @ Cerebras（开赛时排队严重） | 基础工具 | 223 s | 9 | ✅ |
| qwen-3.8-27b @ Cerebras | 基础工具 | 28.6 s | 11 | ✅（但读脚本并剧透了隐藏分支 → 已修） |
| qwen-3.8-27b @ Cerebras | + 组合工具、防剧透 | 19.2 s | 6 | ✅ |
| deepseek-flash（DeepSeek 官方 API，对照用） | + 组合工具、防剧透 | 22.5 s | 7 | ✅ |

> Kimi 那次的时间几乎全花在平台排队上（单次请求 30–60 s，实际生成极快），扩容后会重测。MCP 服务本身：冷启动约 0.3 s，单次调用 2–70 ms。

## 工作原理

```
OpenClaw (Kimi K3.1 Pro @ Cerebras) ⇄ (stdio) MCP 服务 [Node 18] ⇄ (CDP) NW.js 游戏页面 → window.__ai → RMMZ 引擎
```

- RMMZ 游戏运行在 NW.js（Chromium）上。用 `--remote-debugging-port` 启动游戏，MCP 服务通过 CDP 连接游戏页面。
- 游戏启动时注入桥接脚本 `game/ai-bridge.js`，它按顺序加载 `game/parts/*.js`，提供 `window.__ai`。MCP 工具只调用 `__ai` 的方法，参数以 JSON 传递。

## 目录

```
game/
  ai-bridge.js        桥接入口：工具函数 + 按顺序加载 parts/
  parts/00-core.js    共享契约：状态→动作表、本作 PROFILE
  parts/01-crashlog   崩溃时自动保存现场（调用栈、状态、日志）
  parts/05-devclock   开发用：窗口被遮挡时保持游戏循环
  parts/10-state      状态机、快照、等待        parts/20-log       事件日志
  parts/30-query      事件/地图/道具查询        parts/35-describe  事件指令反编译
  parts/40-actions    walk/face/interact/advance/choose
  parts/45-items      use_item / pick_item       parts/50-combo     approach / read_dialogue
  parts/55-memory     探索记忆（checked）
server/
  src/                MCP 服务（index.js、cdp.js、tools/）
  scripts/            开发脚本：eval、smoke、game.sh、goto-explore、openclaw-play、测试
runtime/              Linux 原生运行：run-linux.sh、linux-inject.js、install.sh
```

## 环境要求

- Linux（开发环境：Ubuntu，Wayland 下通过 XWayland 运行）
- Node.js ≥ 18、npm
- 正版游戏（Steam 版的 Windows 文件即可，**不需要 Wine**）
- [NW.js 0.48.4 SDK](https://dl.nwjs.io/v0.48.4/)（linux-x64，与 RMMZ 1.x 自带的 Chromium 85 一致）
- 支持 MCP 的 AI 客户端：推荐 [OpenClaw](https://openclaw.ai)；也可以用 Claude Code 等

## 安装与快速开始

```bash
# 1. 解压 NW.js SDK 到 ~/.local/share/nwjs/nwjs-sdk-v0.48.4-linux-x64/
# 2. 安装 Linux 运行环境（复制启动器、注入脚本，把本仓库链接进游戏目录）
runtime/install.sh /path/to/game

# 3. 安装依赖
cd server && npm install

# 4. 启动游戏（带调试端口）
cd /path/to/game && ./run-linux.sh --debug-port 9333

# 5. 冒烟测试（另开终端，进入一局游戏后）
cd server && PMGT_MCP_DEV=1 npm run smoke
```

### 接入 OpenClaw

gateway 运行时 `openclaw mcp add` 不可用，可以直接写配置：

```json5
// openclaw config patch --file pmgt.json5
{ mcp: { servers: { pmgt: {
  command: "node",
  args: ["/path/to/mcp-mod/server/src/index.js"],
  env: { PMGT_CDP_PORT: "9333" },
  requestTimeoutMs: 60000,
  // 公平游玩：对 AI 隐藏会泄露信息/给人看的工具
  toolFilter: { exclude: ["describe_event", "get_variables", "get_switches", "screenshot", "get_pushed_events"] }
} } } }
```

```bash
openclaw agent --model cerebras/moonshotai-kimi-k3.1-pro-trial -m "你在玩 Pocket Mirror（通过 pmgt MCP 工具）。观察当前房间，走到镜子前，调查它。"
server/scripts/openclaw-play.sh cerebras/moonshotai-kimi-k3.1-pro-trial 30 9333   # 让 AI 自己一直玩，记录进度
```

### 接入 Claude Code

```json
{ "mcpServers": { "pmgt": { "command": "node", "args": ["/path/to/mcp-mod/server/src/index.js"], "env": { "PMGT_CDP_PORT": "9333" } } } }
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PMGT_CDP_HOST` | `127.0.0.1` | 游戏调试端口所在的主机 |
| `PMGT_CDP_PORT` | `9333` | 游戏调试端口 |
| `PMGT_MCP_DEV` | `0` | 设为 `1` 时开启开发工具（`eval_js`、`reload_bridge`）。**给 AI 玩时不要开启** |
| `PMGT_BUDGET` | `0` | 设为 `1` 进入 AI 游玩模式：行动预算与 reflect、隐藏系统事件、禁止存档、死亡记忆与 `restart`；连接时游戏若还在开机界面，会自动过掉开机画面并开新局 |
| `PMGT_AUTOPAUSE` | `0` | 设为 `1` 时自动暂停：只有动作工具执行期间游戏才运行，模型思考时画面、事件、敌人、计时器、声音、视频全部冻结 |
| `PMGT_VIEW_RADIUS` | `0`（不限） | 视野半径（格，以屏幕中心为准）：`list_events` 只返回看见过的事件、从近到远排序，`map_grid` 视野外显示 `?`；寻路仍按全图 |
| `PMGT_BACKGROUND` | `0` | 设为 `1` 时失去焦点/最小化也继续运行（绕过 VisuMZ 的 RequireFocus） |
| `PMGT_WINDOW` | 不改 | 连接时把游戏窗口设成指定大小，如 `1280x720` |
| `PMGT_HUD` | `0` | 设为 `1` 时在游戏画面上叠加进度面板（地图、状态、预算、调用次数、思考耗时、计时） |
| `PMGT_HUD_LABEL` | 空 | HUD 标题，如 `Kimi K3.1 · OpenClaw` |

`server/scripts/openclaw-play.sh` 另外读取：`OC`（openclaw 可执行文件，默认 `~/.openclaw/bin/openclaw`）、`ROUND_TIMEOUT`（每轮秒数，默认 `1800`）、`FAIL_WAIT`（服务端失败的一轮之后等待的秒数，默认 `20`）、`MAX_FAILS`（连续失败多少轮后停止，默认 `30`），以及上面的 `PMGT_CDP_HOST`。服务端失败的轮次（被限流、排队已满、超时、没有返回结果）会重试，既不算作“没有进展”，也不计入最大轮数。HUD 计时器只在一轮运行期间（思考、工具调用、输出）走动，轮次之间静止。

演示推荐配置（游戏在另一台机器上）：

```json5
env: {
  PMGT_CDP_HOST: "<游戏机器 IP>", PMGT_CDP_PORT: "9334",
  PMGT_BUDGET: "1", PMGT_AUTOPAUSE: "1", PMGT_VIEW_RADIUS: "8",
  PMGT_BACKGROUND: "1", PMGT_HUD: "1", PMGT_HUD_LABEL: "Kimi K3.1 · OpenClaw",
}
```

## MCP 工具

| 工具 | 说明 |
|---|---|
| `get_state` | 状态快照：主状态、地图、玩家、面前/附近事件、对白与选项、`allowed_actions` |
| `list_events` / `map_grid` / `list_items` | 地图事件（含 `checked`）、通行性字符画、道具栏 |
| `approach` | **一次调用**：走到事件（或坐标）旁、转向、交互、读完对白 |
| `read_dialogue` | 一次推进并返回整段对白 |
| `walk` / `face` / `interact` / `advance` / `choose` / `wait` | 细粒度控制（`walk` / `approach` 默认疾跑，`run:false` 改为走路） |
| `reflect` | 预算用尽时整理线索、提出假设和一个具体计划，恢复部分预算（AI 游玩模式） |
| `ask_user` | 卡住时向用户求助 |
| `remember` / `restart` | GAME_OVER 后记下教训（跨局保留）并重开新局（AI 游玩模式） |
| `use_item` / `pick_item` | 对事件使用道具 / 在事件弹出的道具菜单里选择（只能用实际持有的道具） |
| `get_log` | 最近发生的事（对白、道具、切图、状态变化） |
| `describe_event` / `get_variables` / `get_switches` | 读事件脚本、变量、开关（**会剧透**，公平游玩时建议隐藏） |
| `ping` / `screenshot` / `get_pushed_events` | 连接检查、截图（给人看）、推送事件 |

## 公平性：不作弊、不剧透

- AI 可用的工具里**没有**传送、给道具、改开关/变量、跳过事件。这类手段只出现在 `server/scripts/test-*.js` 的测试夹具里，并标注 `DEV FIXTURE (cheat)`；演示中的一切进度都必须是正常游玩得到的。
- 服务说明（MCP `instructions`）要求：`describe_event` 的内容只用于自己推理，绝不能把玩家没见过的对白、分支告诉用户；提示模式只给线索，不代打。
- 推荐在客户端隐藏 `describe_event`、`get_variables`、`get_switches`（见上方 `toolFilter`）。

## 游戏在另一台 Windows 电脑上运行（网络控制）

MCP 服务和 AI 客户端留在一台机器上，游戏在另一台（比如有独显的 Windows）上运行，两者只通过 CDP 通信。桥接代码由 MCP 服务在连接时通过网络注入，Windows 那边不需要本仓库的其他文件。

1. 在 Windows 上：把 `host/` 拷过去，运行 `powershell -ExecutionPolicy Bypass -File host\windows\run-pmgt.ps1 -GameDir "<游戏目录>"`。它会结束已运行的游戏、建立/刷新覆盖层（游戏目录不会被修改，旁边生成 `<游戏目录>-pmgt`，只有联接点和硬链接）、修复覆盖层里的 index.html、带 DevTools 端口 9333 和防后台节流/DPI 参数启动游戏，并注入桥接、设置窗口大小。
2. 需要从另一台机器连接时，在 Windows 的**管理员** PowerShell 里运行一次 `host\windows\expose-cdp.ps1 -RemoteIp <MCP 服务所在机器的 IP>`：添加端口转发 9334→9333，防火墙只放行这一个 IP。用完运行 `expose-cdp.ps1 -Remove` 撤销。
3. 在 MCP 服务这边设置 `PMGT_CDP_HOST=<Windows IP>`、`PMGT_CDP_PORT=9334`，再加 `PMGT_BACKGROUND=1`（失去焦点/最小化时游戏继续运行，绕过 VisuMZ 的 RequireFocus）。MCP 服务连接时会用本机的最新桥接替换游戏里的旧版本。

> ⚠️ 能连上这个端口的机器可以在游戏进程里执行任意代码。只在可信的局域网里使用，并限制来源 IP。

## 在 Linux 上运行 RMMZ 游戏（不用 Wine）

- `runtime/run-linux.sh`：启动器。生成一个"覆盖层"目录，里面全是指向游戏文件的符号链接，只有 `package.json` 换成自己的版本（开启 DevTools、注入脚本）。**游戏文件本身不会被修改。**
- `runtime/linux-inject.js`：在游戏脚本之前注入：
  - Steam 未运行时让 greenworks 初始化返回 false，而不是抛异常；
  - 资源路径**大小写不敏感**修正（Windows 上开发的游戏常常大小写不一致）；
  - 加载 `ai-bridge.js`。
- ⚠️ 不要对游戏页面执行 `location.reload()`：NW.js 刷新时不会重新执行注入脚本，资源会 404。需要时重启游戏。

## 移植到其他 RMMZ 游戏

`ai-bridge.js` 分两层：

- **Core（通用）**：状态机、移动、交互、选项、对白、查询，只依赖 RMMZ 引擎原生 API。
- **Profile（本作专用）**：`parts/00-core.js` 里的 `ai.PROFILE`（开关 ID、道具协议、按键映射等）。

换游戏时替换或清空 `PROFILE`，不支持的功能返回 `UNSUPPORTED`。可能需要调整：插件不同（选项窗口、移动、地图插件）、加密方式、Steamworks 原生库。

## 开发

```bash
cd server
./scripts/game.sh start 9334                      # 启动独立的游戏实例（可多开，互不干扰）
PMGT_CDP_PORT=9334 node scripts/goto-explore.js   # 开新局并推进到第一个可操作的房间（约 30 秒）
PMGT_CDP_PORT=9334 node scripts/eval.js --reload  # 热重载 game/parts（不用重启游戏）
PMGT_CDP_PORT=9334 node scripts/eval.js --bridge getState
PMGT_CDP_PORT=9334 node scripts/test-A-state.js   # 各模块验收测试（A/B/C）
PMGT_MCP_DEV=1 PMGT_CDP_PORT=9334 npm run smoke   # MCP 端到端测试
./scripts/game.sh stop 9334
```

游戏崩溃时，`parts/01-crashlog.js` 会把调用栈和现场写到 `~/.local/share/nwjs/crash/`。

## 致谢与参考

- [Model Context Protocol](https://modelcontextprotocol.io) 与 [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)、[ws](https://github.com/websockets/ws)、[zod](https://github.com/colinhacks/zod)
- [NW.js](https://nwjs.io)、[OpenClaw](https://openclaw.ai)、[Cerebras](https://cerebras.ai)、[Moonshot AI（Kimi）](https://www.moonshot.ai)
- RPG Maker MZ 引擎（© Gotcha Gotcha Games）；《Pocket Mirror ~ GoldenerTraum》（© 原作者）

## 许可证 / License

[MIT](LICENSE) © 2026 Mari-2233
