# Gameplay evidence adapter

`server/src/evidence.js` is a narrow, offline evidence layer for the existing PMGT-MCP tools. It does not register MCP tools, import the CDP bridge, or add gameplay powers. The existing `walk`/`use_item` calls used by the fixture remain ordinary explicitly invoked game calls.

## Capture boundary

`EvidenceRecorder` accepts caller-supplied callbacks:

- `readState()` supplies the existing `get_state` observation immediately before an action.
- `invokeTool(tool, args)` invokes only an already existing action tool explicitly requested by the caller.
- The post-state comes from that existing tool's returned state. The recorder adds no post-action poll, wait, direct bridge evaluation, or mutation.
- Each receipt records the initial state, the contiguous action list, and one before/action/after/result observation per action. A stale pre-state is rejected before invoking the next action.

The allowlist names existing action tools only. `get_state`, `list_events`, and `pick_item` remain observational/existing inventory capabilities; the recorder does not expose new inventory, quest, switch, variable, teleport, event-start, or video-skip powers. In particular, it deliberately provides no `set_switch`, `set_variable`, `teleport`, `start_event`, or `skip_video` tool.

No MCP tool wiring was necessary for this evidence layer, so game authority is unchanged.

## Artifact rules

- Canonical JSON matches Python `json.dumps(..., ensure_ascii=True, sort_keys=True, separators=(",", ":"))` for representable values, including Unicode code-point key ordering and UTF-16 `\uXXXX` escaping.
- All numeric values must be exactly representable JavaScript safe integers within signed 64-bit range. Floats are prohibited, including a lexical `1.0` or `1e0`; NaN, infinities, duplicate JSON keys, cycles, and array holes fail closed.
- `model_sha256`, `initial_state_sha256`, `actions_sha256`, and `trajectory_sha256` commit to their canonical payload objects. Each evidence check repeats the three transition commitments. The source receipt is bound by its exact raw UTF-8 SHA-256 and by re-derived payload commitments. `artifact_sha256` seals every artifact field except itself.
- A mutation is still checked semantically after an attacker recomputes payload and outer digests. Equal hashes alone are not replay evidence.
- A model replay can support `OBSERVED` and `REPLAYED` source labels only. It must never be reported as `model_proof` or `LIVE_CONFIRMED`.
- `LIVE_CONFIRMED` requires a genuine `live_execution` check and a supporting passing model check on identical commitments, plus a passing negative control. This implementation records live observations but does **not** implement an independent live-execution checker; therefore its model-replay fixtures can never claim live execution.
- Fixture/replay receipts retain `FIXTURE_ONLY` in every check and a no-live limitation. `source_badges` and `admitted_badges` are consumer report fields only and are never embedded in artifacts.

## Fixture CLI

```sh
npm run evidence-fixture -- --revision COMMIT --output /path/to/fixture.json
```

The command emits the `gameplay-evidence/v0.1` artifact directly (not an `{envelope: ...}` wrapper). `--checker-file PATH` optionally pins the checker digest to the exact bytes of a checker artifact; otherwise the exporter uses the digest of its canonical fixture-checker semantic bundle.

The provided positive fixture is entirely synthetic: one existing-tool `walk`, then one `use_item` that starts event 7. It exercises only the SimGrammar `direct-avatar` and `triggered-event-chains` bindings pinned by the shared selection. It does not claim pathfinding completeness, minimality, milestone unlocks, scenario objectives, or game completion. **No live game was run to produce it.**

`fixtureNegativeControls` records rejection of stale pre-state, action substitution, skipped step, trajectory mismatch, false live labeling, and an unsafe integer. Tests additionally mutate and reseal envelopes to prove those failures cannot be hidden by recomputing only the outer digest.

## Verify

```sh
cd server
npm test
```

The `node:test` suite covers canonical encoding/parser boundaries, all six mutation classes, false live-label and badge promotion, exact source and checker commitments, CLI output, recorder callback counts, stale-state rejection before invocation, and absence of added tool registration/CDP calls.
