#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ControlBoardError,
  createControlBoardClientFromEnv,
} from "../control-board-client.mjs";

const INACTIVE_STATUSES = new Set(["complete", "canceled"]);
const WORKSTREAM_STATUSES = new Set([
  "planned",
  "in_progress",
  "blocked",
  "ready_to_merge",
  "complete",
  "canceled",
]);
const STEP_STATUSES = new Set(["not_started", "in_progress", "blocked", "complete"]);

function clean(value) {
  return String(value ?? "").trim();
}

function deterministicKey(prefix, values) {
  const digest = createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function runUrl(environment) {
  const server = clean(environment.GITHUB_SERVER_URL);
  const repository = clean(environment.GITHUB_REPOSITORY);
  const runId = clean(environment.GITHUB_RUN_ID);
  return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

function inferredWorkstreamStatus(eventName, payload) {
  if (eventName === "pull_request" && payload.pull_request?.merged === true) return "complete";
  return "in_progress";
}

export function normalizeGithubEvent(eventName, payload = {}, environment = process.env) {
  const inputs = payload.inputs || {};
  const pullRequest = payload.pull_request || {};
  const branch = clean(
    inputs.branch ||
    environment.CONTROL_BOARD_BRANCH ||
    pullRequest.head?.ref ||
    environment.GITHUB_HEAD_REF ||
    environment.GITHUB_REF_NAME,
  );
  if (!branch) throw new Error("A branch is required to report Control Board progress");

  const requestedWorkstreamStatus = clean(inputs.workstream_status);
  const explicitWorkstreamStatus = requestedWorkstreamStatus === "no_change" ? "" : requestedWorkstreamStatus;
  if (explicitWorkstreamStatus && !WORKSTREAM_STATUSES.has(explicitWorkstreamStatus)) {
    throw new Error(`Unsupported workstream status: ${explicitWorkstreamStatus}`);
  }
  const stepId = clean(inputs.step_id);
  const requestedStepStatus = clean(inputs.step_status);
  const stepStatus = requestedStepStatus === "no_change" ? "" : requestedStepStatus;
  if ((stepId || stepStatus) && (!stepId || !STEP_STATUSES.has(stepStatus))) {
    throw new Error("step_id and a valid step_status must be supplied together");
  }

  const action = clean(payload.action || eventName);
  const sha = clean(pullRequest.head?.sha || payload.after || environment.GITHUB_SHA);
  const repository = clean(payload.repository?.full_name || environment.GITHUB_REPOSITORY);
  const actor = clean(payload.sender?.login || environment.GITHUB_ACTOR);
  const evidenceUrl = clean(pullRequest.html_url || payload.compare || runUrl(environment));
  const runId = clean(environment.GITHUB_RUN_ID || "local");
  const runAttempt = clean(environment.GITHUB_RUN_ATTEMPT || "1");

  return {
    eventName,
    action,
    branch,
    sha,
    repository,
    actor,
    evidenceUrl,
    runId,
    runAttempt,
    workstreamId: clean(inputs.workstream_id),
    workstreamStatus: explicitWorkstreamStatus || inferredWorkstreamStatus(eventName, payload),
    stepId,
    stepStatus,
    stepNotes: clean(inputs.step_notes),
    completedAt: clean(inputs.completed_at),
  };
}

function automationSummary(workstream, event) {
  const existing = clean(workstream.summary).replace(/\n\nAutomation evidence:[\s\S]*$/u, "");
  const details = [
    `${event.eventName}:${event.action}`,
    event.repository && `repository ${event.repository}`,
    `branch ${event.branch}`,
    event.sha && `commit ${event.sha.slice(0, 12)}`,
    event.actor && `actor ${event.actor}`,
    event.evidenceUrl && `evidence ${event.evidenceUrl}`,
    `run ${event.runId}.${event.runAttempt}`,
  ].filter(Boolean).join(" · ");
  return `${existing ? `${existing}\n\n` : ""}Automation evidence: ${details}`.slice(0, 4_000);
}

function activeMatches(board, event) {
  return (board.workstreams || []).filter((workstream) => {
    if (INACTIVE_STATUSES.has(workstream.status)) return false;
    if (event.workstreamId) return workstream.id === event.workstreamId;
    return clean(workstream.branch) === event.branch;
  });
}

export async function reportControlBoardEvent(client, event) {
  let board = await client.read();
  let stepResult;

  if (event.stepId) {
    const previous = board.steps?.[event.stepId] || {};
    const completedAt = event.completedAt || (
      event.stepStatus === "complete" ? new Date().toISOString() : clean(previous.completedAt)
    );
    stepResult = await client.updateStep(event.stepId, event.stepStatus, {
      notes: event.stepNotes || clean(previous.notes),
      completedAt,
    }, {
      expectedVersion: board.boardVersion,
      idempotencyKey: deterministicKey("cue-gh-step", [event, board.boardVersion]),
    });
    board = await client.read();
  }

  const matches = activeMatches(board, event);
  if (matches.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: "No active Control Board workstream matches this branch or workstream ID",
      branch: event.branch,
      boardVersion: board.boardVersion,
      ...(stepResult ? { stepResult } : {}),
    };
  }
  if (matches.length > 1) {
    throw new ControlBoardError("Multiple active workstreams match this branch", {
      code: "ambiguous_workstream",
      body: { branch: event.branch, workstreamIds: matches.map((item) => item.id) },
    });
  }

  const workstream = matches[0];
  const result = await client.updateWorkstream(workstream.id, event.workstreamStatus, {
    summary: automationSummary(workstream, event),
  }, {
    expectedVersion: board.boardVersion,
    idempotencyKey: deterministicKey("cue-gh-workstream", [event, board.boardVersion]),
  });

  return {
    ok: true,
    skipped: false,
    branch: event.branch,
    workstreamId: workstream.id,
    status: event.workstreamStatus,
    boardVersion: result.boardVersion,
    ...(stepResult ? { stepResult } : {}),
  };
}

async function loadPayload(environment) {
  const path = clean(environment.GITHUB_EVENT_PATH);
  if (!path) return {};
  return JSON.parse(await readFile(path, "utf8"));
}

export async function run(environment = process.env, argv = process.argv.slice(2)) {
  const softFail = argv.includes("--soft-fail");
  try {
    const eventName = clean(environment.GITHUB_EVENT_NAME || "workflow_dispatch");
    const event = normalizeGithubEvent(eventName, await loadPayload(environment), environment);
    const client = createControlBoardClientFromEnv(environment, {
      agent: clean(environment.CONTROL_BOARD_AGENT) || "CUE GitHub Actions",
    });
    const result = await reportControlBoardEvent(client, event);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const detail = error instanceof ControlBoardError
      ? { ok: false, error: error.message, status: error.status, code: error.code, details: error.body }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
    const output = `${JSON.stringify(detail, null, 2)}\n`;
    if (softFail) {
      process.stdout.write(output);
      process.stdout.write("Control Board reporting is non-blocking; product work may continue.\n");
      return 0;
    }
    process.stderr.write(output);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await run();
