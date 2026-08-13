import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";
import { createGoogleWorkspaceIntakeSync } from "./google-workspace-intake-sync.mjs";

const config = {
  gmail: { connectorName: "gmail-operational-intake" },
  drive: { connectorName: "google-drive-operational-intake" },
};

function temporaryStore(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    store: createCueFoundationStore({ filePath: path.join(directory, "foundation.json") }),
  };
}

const fixture = temporaryStore("cue-google-workspace-sync-");
try {
  const calls = [];
  const sync = createGoogleWorkspaceIntakeSync({
    config,
    store: fixture.store,
    connectors: {
      pullGmail: async ({ cursorBefore }) => {
        calls.push({ kind: "gmail", cursorBefore });
        return {
          status: "completed",
          cursorBefore,
          cursorAfter: "2026-08-13T12:00:00.000Z",
          messages: [{
            id: "fixture-message-1",
            threadId: "fixture-thread-1",
            historyId: "1",
            subject: "Fixture operations note",
            textPlain: "Synthetic fixture evidence only.",
            internalDate: "1786622400000",
          }],
        };
      },
      pullDrive: async ({ cursorBefore }) => {
        calls.push({ kind: "drive", cursorBefore });
        return {
          status: "partial",
          cursorBefore,
          cursorAfter: "2026-08-13T12:01:00.000Z",
          files: [{
            id: "fixture-drive-file-1",
            version: "1",
            name: "Fixture production note.txt",
            mimeType: "text/plain",
            modifiedTime: "2026-08-13T12:01:00.000Z",
            extractedText: "Synthetic Drive fixture evidence only.",
          }],
          skippedFiles: [{ name: "fixture-unsupported.bin", reason: "unsupported_content_type" }],
          errors: [],
          metadata: { recursive: true },
        };
      },
    },
  });

  const result = await sync.runPoll();
  assert.equal(result.ok, false, "a partial source prevents a fully successful poll");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.partialStages, ["drive"]);
  assert.deepEqual(result.failedStages, []);
  assert.deepEqual(calls, [
    { kind: "gmail", cursorBefore: null },
    { kind: "drive", cursorBefore: null },
  ], "each source receives only its persisted cursor");

  const database = await fixture.store.read();
  assert.equal(Object.keys(database.sourceRecords).length, 2, "fixture records are written only to the temporary store");
  assert.equal(database.connectorCursors[config.gmail.connectorName].cursor, "2026-08-13T12:00:00.000Z");
  assert.equal(database.connectorCursors[config.drive.connectorName].cursor, "2026-08-13T12:01:00.000Z");
  assert.equal(result.stages[0].status, "completed");
  assert.equal(result.stages[1].status, "partial");
} finally {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

const statusFixture = temporaryStore("cue-google-workspace-status-");
try {
  const sync = createGoogleWorkspaceIntakeSync({
    config,
    store: statusFixture.store,
    connectors: {
      pullGmail: async ({ cursorBefore }) => ({
        status: "skipped",
        reason: "connector_disabled",
        cursorBefore,
        cursorAfter: cursorBefore,
        messages: [],
        errors: [],
      }),
      pullDrive: async ({ cursorBefore }) => ({
        status: "failed",
        reason: "fixture_failure",
        cursorBefore,
        cursorAfter: cursorBefore,
        files: [],
        errors: [{ message: "Synthetic fixture failure." }],
      }),
    },
  });

  const result = await sync.runPoll();
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.skippedStages, ["gmail"]);
  assert.deepEqual(result.failedStages, ["drive"]);
  const runs = Object.values((await statusFixture.store.read()).connectorRuns);
  assert.equal(runs.length, 2, "skipped and failed fixture pulls are checkpointed");
  assert.deepEqual(runs.map(run => run.status).sort(), ["failed", "skipped"]);
} finally {
  fs.rmSync(statusFixture.directory, { recursive: true, force: true });
}

const concurrencyFixture = temporaryStore("cue-google-workspace-concurrency-");
try {
  let gmailPullCount = 0;
  let releaseGmail;
  const gmailGate = new Promise(resolve => { releaseGmail = resolve; });
  const sync = createGoogleWorkspaceIntakeSync({
    config,
    store: concurrencyFixture.store,
    connectors: {
      pullGmail: async ({ cursorBefore }) => {
        gmailPullCount += 1;
        await gmailGate;
        return {
          status: "completed",
          cursorBefore,
          cursorAfter: "2026-08-13T13:00:00.000Z",
          messages: [],
        };
      },
      pullDrive: async ({ cursorBefore }) => ({
        status: "completed",
        cursorBefore,
        cursorAfter: "2026-08-13T13:00:00.000Z",
        files: [],
      }),
    },
  });

  const first = sync.runPoll();
  const second = sync.runPoll();
  releaseGmail();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(gmailPullCount, 1, "overlapping poll requests share one orchestration run");
  assert.deepEqual(secondResult, firstResult);

  await sync.runPoll();
  assert.equal(gmailPullCount, 2, "the in-flight guard resets after completion");
} finally {
  fs.rmSync(concurrencyFixture.directory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  fixtureDatastores: 3,
  liveServicesContacted: false,
  protectedDatastoreUsed: false,
}, null, 2));
