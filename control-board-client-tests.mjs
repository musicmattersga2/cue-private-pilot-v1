import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlBoardClient,
  ControlBoardError,
  controlBoardConfigFromEnv,
} from "./control-board-client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Unexpected request");
    return typeof next === "function" ? next(url, init) : next;
  };
  return { fetch, calls };
}

function client(mock, options = {}) {
  return new ControlBoardClient({
    baseUrl: "https://control-board.example.test/",
    serviceId: "cursor",
    serviceSecret: "application-secret",
    sitesToken: "sites-dispatch-secret",
    agent: "Cursor integration test",
    fetch: mock.fetch,
    retryDelayMs: 0,
    ...options,
  });
}

test("environment configuration requires both application and Sites credentials", () => {
  assert.throws(() => controlBoardConfigFromEnv({ CONTROL_BOARD_URL: "https://board.test" }), /CONTROL_BOARD_SERVICE_ID/);
  const config = controlBoardConfigFromEnv({
    CONTROL_BOARD_URL: "https://board.test",
    CONTROL_BOARD_SERVICE_ID: "cue-server",
    CONTROL_BOARD_SERVICE_SECRET: "app-secret",
    CONTROL_BOARD_SITES_TOKEN: "dispatch-secret",
  });
  assert.equal(config.serviceId, "cue-server");
});

test("read sends both authentication layers without placing credentials in the URL", async () => {
  const mock = mockFetch([jsonResponse({ schemaVersion: 3, boardVersion: 7, workstreams: [] })]);
  const result = await client(mock).read();
  assert.equal(result.boardVersion, 7);
  assert.equal(mock.calls[0].url, "https://control-board.example.test/api/control-board");
  assert.equal(mock.calls[0].init.headers.authorization, "Bearer cursor.application-secret");
  assert.equal(mock.calls[0].init.headers["oai-sites-authorization"], "Bearer sites-dispatch-secret");
  assert.equal(mock.calls[0].init.headers["x-cue-agent"], "Cursor integration test");
});

test("mutation reads the canonical version and sends an idempotency key", async () => {
  const mock = mockFetch([
    jsonResponse({ boardVersion: 11, steps: { "api-versioning": { notes: "Prior notes", completedAt: "2026-07-12" } } }),
    jsonResponse({ ok: true, boardVersion: 12, target: { id: "api-versioning", version: 2 } }),
  ]);
  const result = await client(mock).updateStep("api-versioning", "complete", { notes: "Verified" }, { idempotencyKey: "cursor-step-update-0001" });
  assert.equal(result.boardVersion, 12);
  const payload = JSON.parse(mock.calls[1].init.body);
  assert.equal(payload.action, "update_step");
  assert.equal(payload.expectedVersion, 11);
  assert.equal(payload.idempotencyKey, "cursor-step-update-0001");
  assert.equal(payload.notes, "Verified");
  assert.equal(payload.completedAt, "2026-07-12");
});

test("step status update preserves omitted notes and completion metadata", async () => {
  const mock = mockFetch([
    jsonResponse({
      boardVersion: 14,
      steps: { "api-versioning": { status: "in_progress", notes: "Do not erase", completedAt: "2026-07-13" } },
    }),
    jsonResponse({ ok: true, boardVersion: 15 }),
  ]);
  await client(mock).updateStep("api-versioning", "complete", {}, { idempotencyKey: "preserve-step-0001" });
  const payload = JSON.parse(mock.calls[1].init.body);
  assert.equal(payload.expectedVersion, 14);
  assert.equal(payload.notes, "Do not erase");
  assert.equal(payload.completedAt, "2026-07-13");
});

test("explicit step version requires a complete replacement payload", async () => {
  const mock = mockFetch([]);
  await assert.rejects(
    () => client(mock).updateStep("api-versioning", "complete", { notes: "Known" }, {
      expectedVersion: 14,
      idempotencyKey: "explicit-step-0001",
    }),
    /notes and completedAt are required/,
  );
  assert.equal(mock.calls.length, 0);
});

test("retryable failure reuses the exact request body and idempotency key", async () => {
  const mock = mockFetch([
    jsonResponse({ boardVersion: 3 }),
    jsonResponse({ error: "temporary" }, 503),
    jsonResponse({ ok: true, boardVersion: 4, id: "ws-1" }, 201),
  ]);
  const result = await client(mock).startWorkstream({
    chatName: "Cursor test",
    ownershipArea: "Control Board client",
    branch: "feature/control-board-client",
    files: ["control-board-client.mjs"],
  }, { idempotencyKey: "retry-workstream-0001" });
  assert.equal(result.id, "ws-1");
  assert.equal(mock.calls[1].init.body, mock.calls[2].init.body);
});

test("409 conflict is surfaced without automatic overwrite or retry", async () => {
  const mock = mockFetch([
    jsonResponse({ boardVersion: 8 }),
    jsonResponse({ error: "Control Board version is stale", code: "stale_version", currentVersion: 9 }, 409),
  ]);
  await assert.rejects(
    () => client(mock).setFocus("api-versioning", { idempotencyKey: "stale-focus-0001" }),
    (error) => error instanceof ControlBoardError && error.status === 409 && error.code === "stale_version",
  );
  assert.equal(mock.calls.length, 2);
});

test("explicit expectedVersion avoids an extra read", async () => {
  const mock = mockFetch([jsonResponse({ ok: true, boardVersion: 5 })]);
  await client(mock).updateWorkstream("ws-1", "complete", {}, {
    expectedVersion: 4,
    idempotencyKey: "complete-workstream-0001",
  });
  assert.equal(mock.calls.length, 1);
  const payload = JSON.parse(mock.calls[0].init.body);
  assert.equal(payload.expectedVersion, 4);
  assert.equal(payload.action, "update_workstream");
});
