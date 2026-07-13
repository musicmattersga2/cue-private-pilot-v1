# CUE Control Board Render Relay

This service is a stateless transport bridge between the Auth0-protected ChatGPT
MCP gateway and the private canonical Intake Spine Control Board API.

It does not store Control Board state or credentials. It authenticates the
gateway by comparing the SHA-256 digest of the incoming
`OAI-Sites-Authorization` header with a configured digest, enforces the
`chatgpt-mcp` service identity, and forwards the original credentials over TLS
to the single allowlisted Control Board endpoint.

## Routes

- `GET /health` — unauthenticated readiness check.
- `GET /api/control-board` — authenticated canonical board read.
- `POST /api/control-board` — authenticated canonical board mutation.

All other paths and methods are rejected. Request bodies are limited to 256 KiB
by default. Headers, credentials, request bodies, and upstream responses are
never logged.

## Environment

- `CONTROL_BOARD_UPSTREAM_URL` — exact canonical API URL ending in
  `/api/control-board` on the approved `.chatgpt.site` host.
- `RELAY_SITES_AUTH_SHA256` — lowercase SHA-256 hex digest of the complete
  `Bearer ...` value sent in `OAI-Sites-Authorization`.
- `RELAY_SERVICE_ID` — expected service identity; defaults to `chatgpt-mcp`.
- `RELAY_MAX_BODY_BYTES` — optional request limit; defaults to 262144.
- `RELAY_UPSTREAM_TIMEOUT_MS` — optional timeout; defaults to 12000.

The raw Sites bypass token and Control Board service secret remain only in the
MCP gateway. Do not add them to Render.

## Local verification

```bash
cd relay
npm ci
npm test
```
