# CUE / Cursor Control Board client

This client connects trusted CUE code and Cursor commands to the hardened Intake Spine Control
Board API. It does not contain credentials and does not bypass Control Board conflicts.

## Required environment

Configure these values in the calling system's protected secret store:

```text
CONTROL_BOARD_URL=https://cue-intake-spine-control-board.aaronsoriero619.chatgpt.site
CONTROL_BOARD_SERVICE_ID=cursor
CONTROL_BOARD_SERVICE_SECRET=<client-specific application secret>
CONTROL_BOARD_SITES_TOKEN=<private Sites dispatch credential>
CONTROL_BOARD_AGENT=Cursor · feature/control-board-client
```

Use `CONTROL_BOARD_SERVICE_ID=cue-server` for the CUE server. Cursor and CUE must not share an
application secret. Never place either raw secret in source, a Cursor command, a prompt, or the
Control Board itself.

## Commands

Read current focus, version, and active workstreams:

```bash
npm run board:status
```

Register ownership before editing:

```bash
npm run board:start -- \
  --chat "CUE Control Board client" \
  --branch "feature/control-board-client" \
  --milestone "contracts" \
  --step "api-versioning" \
  --owner "Control Board clients" \
  --files "control-board-client.mjs" \
  --files "scripts/control-board.mjs" \
  --summary "Shared authenticated client for Cursor and CUE code"
```

Update a step. Major milestone completion is derived automatically from its step states:

```bash
npm run board:step -- \
  --id "api-versioning" \
  --status "complete" \
  --notes "Authenticated client and acceptance tests completed"
```

Close a workstream:

```bash
npm run board:complete -- --id "<workstream-id>" --summary "Completed and verified"
```

Every mutation first reads the latest `boardVersion` unless an explicit `--expected-version` is
provided. A `409` is surfaced for human or agent reconciliation; the client never blindly
overwrites newer shared state. Network and temporary server retries reuse the same idempotency key.

For `step`, omitting `--notes` or `--completed-at` preserves the current canonical value. If an
explicit version is supplied, provide both fields because that mode deliberately avoids the
protective read.

## Programmatic use

```js
import { createControlBoardClientFromEnv } from "./control-board-client.mjs";

const board = createControlBoardClientFromEnv();
await board.updateStep("api-versioning", "complete", {
  notes: "CUE server integration verified",
});
```
