import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleRelayRequest, relayConfigFromEnv } from "./relay.mjs";
import { createServer } from "./server.mjs";

const SITES_AUTH = "Bearer sites-bypass-token-for-tests";
const SERVICE_AUTH = "Bearer chatgpt-mcp.service-secret-that-is-long-enough";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function config(overrides = {}) {
  return relayConfigFromEnv({
    CONTROL_BOARD_UPSTREAM_URL: "https://board.example.chatgpt.site/api/control-board",
    RELAY_SERVICE_ID: "chatgpt-mcp",
    RELAY_SITES_AUTH_SHA256: digest(SITES_AUTH),
    ...overrides,
  });
}

function request(path = "/api/control-board", options = {}) {
  return new Request(`https://relay.example.com${path}`, {
    method: options.method || "GET",
    headers: {
      authorization: SERVICE_AUTH,
      "oai-sites-authorization": SITES_AUTH,
      "x-cue-agent": "ChatGPT test actor",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

test("health is public and reveals no configuration", async () => {
  const response = await handleRelayRequest(request("/health"), config(), async () => assert.fail("no upstream call"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", service: "cue-control-board-relay" });
});

test("missing or incorrect relay authentication is rejected", async () => {
  const missing = await handleRelayRequest(new Request("https://relay.example.com/api/control-board"), config());
  assert.equal(missing.status, 401);

  const wrong = await handleRelayRequest(request("/api/control-board", {
    headers: { "oai-sites-authorization": "Bearer wrong-token" },
  }), config());
  assert.equal(wrong.status, 401);
});

test("spoofed service identity is rejected", async () => {
  const response = await handleRelayRequest(request("/api/control-board", {
    headers: { authorization: "Bearer cursor.service-secret-that-is-long-enough" },
  }), config());
  assert.equal(response.status, 401);
});

test("authenticated GET forwards only the canonical security and audit headers", async () => {
  let call;
  const response = await handleRelayRequest(request(), config(), async (url, init) => {
    call = { url, init };
    return Response.json({ boardVersion: 18, currentFocus: "intake-schema" });
  });
  assert.equal(response.status, 200);
  assert.equal(call.url, "https://board.example.chatgpt.site/api/control-board");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.authorization, SERVICE_AUTH);
  assert.equal(call.init.headers["oai-sites-authorization"], SITES_AUTH);
  assert.equal(call.init.headers["x-cue-agent"], "ChatGPT test actor");
  assert.equal(call.init.headers["x-cue-relay"], "render-v1");
  assert.equal(call.init.headers.cookie, undefined);
  assert.deepEqual(await response.json(), { boardVersion: 18, currentFocus: "intake-schema" });
});

test("authenticated POST forwards the exact JSON mutation", async () => {
  const body = JSON.stringify({ action: "set_focus", stepId: "intake-schema", expectedVersion: 18, idempotencyKey: "test-key-0001" });
  let forwarded;
  const response = await handleRelayRequest(request("/api/control-board", { method: "POST", body }), config(), async (_url, init) => {
    forwarded = init.body;
    return Response.json({ ok: true, boardVersion: 19 });
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded, body);
  assert.deepEqual(await response.json(), { ok: true, boardVersion: 19 });
});

test("invalid routes, methods, media types, and bodies are rejected", async () => {
  assert.equal((await handleRelayRequest(request("/other"), config())).status, 404);
  assert.equal((await handleRelayRequest(request("/api/control-board", { method: "PUT" }), config())).status, 405);
  assert.equal((await handleRelayRequest(request("/api/control-board", {
    method: "POST", body: "{}", headers: { "content-type": "text/plain" },
  }), config())).status, 415);
  assert.equal((await handleRelayRequest(request("/api/control-board", {
    method: "POST", body: "not-json",
  }), config())).status, 400);
});

test("oversized payloads are rejected before the upstream call", async () => {
  const response = await handleRelayRequest(request("/api/control-board", {
    method: "POST", body: JSON.stringify({ value: "x".repeat(40) }),
  }), config({ RELAY_MAX_BODY_BYTES: "16" }), async () => assert.fail("no upstream call"));
  assert.equal(response.status, 413);
});

test("upstream JSON statuses pass through and non-JSON responses are contained", async () => {
  const conflict = await handleRelayRequest(request(), config(), async () => Response.json({ code: "conflict" }, { status: 409 }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { code: "conflict" });

  const html = await handleRelayRequest(request(), config(), async () => new Response("<html>private</html>", {
    status: 522, headers: { "content-type": "text/html" },
  }));
  assert.equal(html.status, 502);
  assert.deepEqual(await html.json(), {
    error: "The canonical Control Board returned a non-JSON response",
    code: "upstream_non_json",
    upstreamStatus: 522,
  });
});

test("network failures return a safe JSON error without leaking details", async () => {
  const response = await handleRelayRequest(request(), config(), async () => {
    throw new Error("secret internal network detail");
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, "upstream_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /secret internal/);
});

test("the Node service exposes the public health endpoint", async (t) => {
  const server = createServer({
    CONTROL_BOARD_UPSTREAM_URL: "https://board.example.chatgpt.site/api/control-board",
    RELAY_SERVICE_ID: "chatgpt-mcp",
    RELAY_SITES_AUTH_SHA256: digest(SITES_AUTH),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", service: "cue-control-board-relay" });
});
