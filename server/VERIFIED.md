# Verified play toolkit

This file covers the checks and records around play: what runs offline in CI, how to ask the
server what state its backends are in, how fair play is enforced on the server, and how a
session can be recorded so claims about it can be checked later. None of it adds gameplay
powers. Gameplay is unchanged when the new variables are unset. The tool list gains one
diagnostics tool, and all tools gain complete MCP annotations.

## Offline tests and CI

`cd server && npm test` runs the suite under `server/test/` with no game, no NW.js and no
network. `.github/workflows/tests.yml` runs it on every push and pull request (Node 18, 20
and 22), plus the mirror task suite against the fake game. The test script lists its files
by name on purpose. Bare test discovery would also pick up the live-game scripts
`server/scripts/test-*.js`, which need a running game.

- `test/state-contract.test.js` executes the game-side state tables and compares them with
  `server/src/state-contract.js` (see below). It also captures the real tool registrations in
  every mode and checks them against the contract, checks that no forbidden tool
  (`set_switch`, `set_variable`, `teleport`, `start_event`, `skip_video`) is ever registered,
  and checks that every game part still compiles.
- `test/util.test.js` and `test/transcript.test.js` cover the pure helpers: error mapping,
  snapshot compaction, bundle determinism, transcript chaining, tamper detection and secret
  redaction.
- `test/integration.test.js` spawns the real MCP server over stdio and plays the mirror task
  against a fake game (`test/fake-cdp.js`, `test/fake-game.js`): a minimal Chrome DevTools
  Protocol endpoint whose `window.__ai` is a small in-memory fixture. It also exercises fair
  play mode, transcript recording and the game-down report end to end.

Passing against the fake game proves the server, the CDP client and the tool wiring. It does
not prove anything about a real RMMZ title. `scripts/smoke.js` and `scripts/test-*.js` still
cover the live game and still need one running.

## The state contract

`server/src/state-contract.js` mirrors the tables the game uses at runtime: `STATES` and
`ALLOWED` from `game/parts/00-core.js`, `IDLE_STATES` from `game/parts/10-state.js`. The game
side runs inside Chromium 85 and cannot import server modules, so the tables exist twice and
the contract test fails when they drift. It also names the three action tools that are not
state-gated and why (`wait`, `reflect`, `ask_user`), which used to be implicit. To change the
machine, change the game parts first, then mirror the change in the contract and let the test
prove both copies agree.

## get_capabilities

`ping` fails when the game is down. `get_capabilities` instead returns the missing layer as
data: `status` is one of `ready`, `cdp_unreachable`, `target_not_found`, `bridge_missing` or
`bridge_stale`, alongside the CDP target, bridge version and parts, the local and in-page
bridge hashes, the current state and profile, the active modes, and the registered tool list.
Like every tool it connects first, which may inject the current bridge into a remote game.
Connecting applies the usual startup config too, including the budget mode auto-start from
boot screens, so the first diagnostics call has the same side effects as a first `get_state`.
The report describes the state after that connect. A malformed target list from a non-game
endpoint is reported as `target_not_found`, never thrown.

## Fair play on the server (PMGT_FAIR_PLAY=1)

The README recommends hiding `describe_event`, `get_variables`, `get_switches`, `screenshot`
and `get_pushed_events` in the client. That only holds while every client is configured
right. With `PMGT_FAIR_PLAY=1` the server does not register those tools at all, so no client
setting can expose them. The list lives in `FAIR_PLAY_HIDDEN` in `state-contract.js` and
matches the README client filter. Keep the client filter as a second layer if you use one.
Fair play also wins over dev mode. With both variables set, `eval_js` and `reload_bridge`
are not registered, since `eval_js` can read or write anything in the game.

One limit to know: `get_log` stays available in fair play, as in the README filter, and log
entries include named switch and variable changes. The gate matches the README list. It is
not a stronger boundary than that list.

## Session transcripts (PMGT_TRANSCRIPT=<path>)

With `PMGT_TRANSCRIPT` set, each tool call that reaches a handler appends one JSON line:
sequence number, time, tool, redacted arguments (capped, with a hash when truncated), ok or
error code, duration, and the SHA-256 and byte length of the result. Full results are not
stored, so screenshots and dialogue dumps stay out of the file. Each line links to the
previous line's hash, forming a chain. Calls the protocol layer rejects first (unknown
tool, invalid arguments) never reach a handler and are not recorded.

```bash
node scripts/verify-transcript.js session.jsonl
```

Verification recomputes the chain and reports entry, tool and error counts, the head hash,
and the first bad entry when a line was edited or removed. Without a secret key the chain is
tamper-evident, not tamper-proof, since a whole file can be rewritten and re-chained. Pin
the head hash somewhere else (a commit, an issue) to fix a run in place. A transcript also
proves only what the server saw. It shows which fair tools ran and in what order. It does
not prove what the model read elsewhere.

On startup an existing transcript is verified and continued. A broken chain is logged and
the server runs without a transcript rather than refusing to start. `get_capabilities` then
shows `transcript: false`. Write failures during play disable recording with one log line
and never fail a tool call.

## Task suites

`scripts/run-tasks.js` runs a fixed script of tool calls with expectations and reports
rounds and milliseconds per step, so benchmark tasks can be rerun after changes instead of
remeasured by hand:

```bash
cd server
node scripts/run-tasks.js --fake                          # fixture: wiring only
PMGT_CDP_PORT=9334 node scripts/run-tasks.js              # live game, mirror task
node scripts/run-tasks.js tasks/mirror.json --report out.json --ledger results.jsonl
```

`server/tasks/mirror.json` is the README mirror task as data. A suite is a fixed script: it
times tool rounds, not model thinking, so it suits regression checks. Model comparisons
still need a model in the loop (see `scripts/openclaw-play.sh`).
