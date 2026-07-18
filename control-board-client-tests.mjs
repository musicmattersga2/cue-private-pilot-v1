import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlBoardClient,
  ControlBoardError,
  controlBoardConfigFromEnv,
} from "./control-board-client.mjs";
import {
  normalizeGithubEvent,
  reportControlBoardEvent,
} from "./scripts/control-board-event.mjs";

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

test("GitHub OIDC configuration does not require reusable Board credentials", () => {
  const config = controlBoardConfigFromEnv({
    CONTROL_BOARD_URL: "https://connector.test/github-control-board",
    CONTROL_BOARD_GITHUB_OIDC_AUDIENCE: "https://connector.test/github-actions",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/oidc?api-version=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
  });
  assert.equal(config.oidcAudience, "https://connector.test/github-actions");
  assert.equal(config.serviceSecret, undefined);
});

test("GitHub OIDC client exchanges the runner token and omits the Sites credential", async () => {
  const calls = [];
  const oidcClient = new ControlBoardClient({
    baseUrl: "https://connector.test/github-control-board",
    oidcAudience: "https://connector.test/github-actions",
    oidcRequestUrl: "https://github.test/oidc?api-version=1",
    oidcRequestToken: "runner-request-token",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://github.test/oidc")) return Response.json({ value: "signed-oidc-token" });
      return Response.json({ boardVersion: 31, workstreams: [] });
    },
  });
  await oidcClient.read();
  assert.match(calls[0].url, /audience=https%3A%2F%2Fconnector.test%2Fgithub-actions/);
  assert.equal(calls[0].init.headers.authorization, "Bearer runner-request-token");
  assert.equal(calls[1].init.headers.authorization, "Bearer signed-oidc-token");
  assert.equal(calls[1].init.headers["oai-sites-authorization"], undefined);
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

test("requests are time-bounded when the Control Board does not respond", async () => {
  const fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const stalled = new ControlBoardClient({
    baseUrl: "https://control-board.example.test/",
    serviceId: "cursor",
    serviceSecret: "application-secret",
    sitesToken: "sites-dispatch-secret",
    fetch,
    maxAttempts: 1,
    requestTimeoutMs: 250,
  });
  await assert.rejects(
    () => stalled.read(),
    (error) => error instanceof ControlBoardError && error.code === "network_error",
  );
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

test("GitHub event normalization uses the pull request head branch", () => {
  const event = normalizeGithubEvent("pull_request", {
    action: "synchronize",
    pull_request: {
      head: { ref: "feature/control-board-client", sha: "abcdef1234567890" },
      html_url: "https://github.example.test/pull/7",
      merged: false,
    },
    repository: { full_name: "musicmattersga2/cue-private-pilot-v1" },
    sender: { login: "developer" },
  }, { GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "2" });
  assert.equal(event.branch, "feature/control-board-client");
  assert.equal(event.workstreamStatus, "in_progress");
  assert.equal(event.runId, "99");
});

test("manual dispatch no-change choices do not create accidental updates", () => {
  const event = normalizeGithubEvent("workflow_dispatch", {
    inputs: {
      branch: "feature/control-board-client",
      workstream_status: "no_change",
      step_status: "no_change",
    },
  }, { GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(event.workstreamStatus, "in_progress");
  assert.equal(event.stepId, "");
  assert.equal(event.stepStatus, "");
});

test("automatic event updates only the active workstream matching the branch", async () => {
  const mock = mockFetch([
    jsonResponse({
      boardVersion: 30,
      workstreams: [
        { id: "ws-intake", branch: "feature/cue-foundation-slack-readiness", status: "in_progress", summary: "Intake" },
        { id: "ws-board", branch: "feature/control-board-client", status: "in_progress", summary: "Automation intent" },
      ],
    }),
    jsonResponse({ ok: true, boardVersion: 31 }),
  ]);
  const result = await reportControlBoardEvent(client(mock), {
    eventName: "push",
    action: "push",
    branch: "feature/control-board-client",
    sha: "1234567890abcdef",
    repository: "musicmattersga2/cue-private-pilot-v1",
    actor: "developer",
    evidenceUrl: "https://github.example.test/compare/1...2",
    runId: "101",
    runAttempt: "1",
    workstreamId: "",
    workstreamStatus: "in_progress",
    stepId: "",
  });
  assert.equal(result.workstreamId, "ws-board");
  const payload = JSON.parse(mock.calls[1].init.body);
  assert.equal(payload.action, "update_workstream");
  assert.equal(payload.id, "ws-board");
  assert.match(payload.summary, /Automation intent/);
  assert.match(payload.summary, /commit 1234567890ab/);
  assert.match(payload.idempotencyKey, /^cue-gh-workstream-/);
});

test("unmatched branches skip safely without a mutation", async () => {
  const mock = mockFetch([jsonResponse({ boardVersion: 30, workstreams: [] })]);
  const result = await reportControlBoardEvent(client(mock), {
    eventName: "push",
    action: "push",
    branch: "feature/unregistered",
    runId: "102",
    runAttempt: "1",
    workstreamStatus: "in_progress",
    workstreamId: "",
    stepId: "",
  });
  assert.equal(result.skipped, true);
  assert.equal(mock.calls.length, 1);
});

test("a merged pull request completes its exact branch workstream", async () => {
  const mock = mockFetch([
    jsonResponse({
      boardVersion: 40,
      workstreams: [{ id: "ws-board", branch: "feature/control-board-client", status: "ready_to_merge", summary: "Ready" }],
    }),
    jsonResponse({ ok: true, boardVersion: 41 }),
  ]);
  const event = normalizeGithubEvent("pull_request", {
    action: "closed",
    pull_request: { merged: true, head: { ref: "feature/control-board-client", sha: "abc123" } },
  }, { GITHUB_RUN_ID: "103", GITHUB_RUN_ATTEMPT: "1" });
  await reportControlBoardEvent(client(mock), event);
  const payload = JSON.parse(mock.calls[1].init.body);
  assert.equal(payload.status, "complete");
});
