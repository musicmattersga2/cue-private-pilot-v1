#!/usr/bin/env node

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  ControlBoardError,
  createControlBoardClientFromEnv,
} from "../control-board-client.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chat: { type: "string" },
    branch: { type: "string" },
    milestone: { type: "string" },
    step: { type: "string" },
    owner: { type: "string" },
    files: { type: "string", multiple: true },
    summary: { type: "string" },
    id: { type: "string" },
    status: { type: "string" },
    notes: { type: "string" },
    "completed-at": { type: "string" },
    "expected-version": { type: "string" },
    "idempotency-key": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const command = positionals[0] || "status";

function usage() {
  return `CUE Control Board client

Commands:
  status
  start --chat <name> --owner <area> [--branch <branch>] [--milestone <id>]
        [--step <id>] [--files <path>]... [--summary <text>]
  step --id <step-id> --status <status> [--notes <text>] [--completed-at <date>]
  focus --step <step-id>
  workstream --id <id> --status <status> [--summary <text>]
  complete --id <id> [--summary <text>]

Mutation options:
  --expected-version <number>
  --idempotency-key <key>

Environment:
  CONTROL_BOARD_URL
  CONTROL_BOARD_SERVICE_ID
  CONTROL_BOARD_SERVICE_SECRET
  CONTROL_BOARD_SITES_TOKEN
  CONTROL_BOARD_AGENT (optional)`;
}

function requireOption(name, label = name) {
  const value = String(values[name] || "").trim();
  if (!value) throw new Error(`--${label} is required for ${command}`);
  return value;
}

function mutationOptions() {
  const expected = values["expected-version"];
  return {
    ...(expected === undefined ? {} : { expectedVersion: Number(expected) }),
    ...(values["idempotency-key"] ? { idempotencyKey: values["idempotency-key"] } : {}),
  };
}

function ownedFiles() {
  return (values.files || []).flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
}

function statusSummary(board) {
  const active = (board.workstreams || []).filter((item) => !["complete", "canceled"].includes(item.status));
  const conflicts = active.map((item) => ({
    id: item.id,
    chatName: item.chatName,
    branch: item.branch,
    stepId: item.stepId,
    ownershipArea: item.ownershipArea,
    files: item.files,
    status: item.status,
    version: item.version,
  }));
  return {
    schemaVersion: board.schemaVersion,
    boardVersion: board.boardVersion,
    currentFocus: board.currentFocus,
    activeWorkstreams: conflicts,
    updatedAt: board.updatedAt,
  };
}

async function main() {
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const client = createControlBoardClientFromEnv(process.env, { agent: process.env.CONTROL_BOARD_AGENT || "CUE/Cursor CLI" });
  let result;
  if (command === "status") {
    result = statusSummary(await client.read());
  } else if (command === "start") {
    result = await client.startWorkstream({
      chatName: requireOption("chat"),
      branch: String(values.branch || "").trim(),
      milestoneId: String(values.milestone || "").trim(),
      stepId: String(values.step || "").trim(),
      ownershipArea: requireOption("owner"),
      files: ownedFiles(),
      summary: String(values.summary || ""),
    }, mutationOptions());
  } else if (command === "step") {
    const change = {
      ...(values.notes === undefined ? {} : { notes: values.notes }),
      ...(values["completed-at"] === undefined ? {} : { completedAt: values["completed-at"] }),
    };
    result = await client.updateStep(requireOption("id"), requireOption("status"), change, mutationOptions());
  } else if (command === "focus") {
    result = await client.setFocus(requireOption("step"), mutationOptions());
  } else if (command === "workstream" || command === "complete") {
    result = await client.updateWorkstream(
      requireOption("id"),
      command === "complete" ? "complete" : requireOption("status"),
      values.summary === undefined ? {} : { summary: values.summary },
      mutationOptions(),
    );
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const detail = error instanceof ControlBoardError
    ? { error: error.message, status: error.status, code: error.code, details: error.body }
    : { error: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(detail, null, 2)}\n`);
  process.exitCode = 1;
});
