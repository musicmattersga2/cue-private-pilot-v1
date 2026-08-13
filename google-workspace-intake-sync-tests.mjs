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

function withPrivateContinuation(result, continuation, diagnosticCategory = null) {
  Object.defineProperty(result, Symbol.for("cue.googleWorkspace.driveContinuation"), {
    value: { continuation, diagnosticCategory },
    enumerable: false,
  });
  return result;
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

const resumeFixture = temporaryStore("cue-google-workspace-resume-");
try {
  const durableCursor = "2026-08-13T10:00:00.000Z";
  const sweepUpperBound = "2026-08-13T11:00:00.000Z";
  await resumeFixture.store.checkpointConnectorRun({
    connectorName: config.drive.connectorName,
    sourceType: "drive",
    status: "completed",
    cursorBefore: null,
    cursorAfter: durableCursor,
  });
  let drivePull = 0;
  const driveInputs = [];
  const gmailInputs = [];
  const privateCheckpoint = {
    version: 1,
    connectorName: config.drive.connectorName,
    originalCursor: durableCursor,
    lowerBound: "2026-08-13T09:59:00.000Z",
    upperBound: sweepUpperBound,
    scopeFingerprint: "private-scope-fingerprint",
    folderIds: ["private-folder-reference"],
    batchIndex: 1,
    pageToken: "private-page-token",
  };
  const sync = createGoogleWorkspaceIntakeSync({
    config,
    store: resumeFixture.store,
    connectors: {
      pullGmail: async ({ cursorBefore }) => {
        gmailInputs.push(cursorBefore);
        return {
          status: "completed",
          cursorBefore,
          cursorAfter: sweepUpperBound,
          messages: [{
            id: "private-gmail-id",
            threadId: "private-gmail-thread",
            historyId: "1",
            subject: "private-gmail-name",
            textPlain: "private-gmail-content",
            internalDate: String(Date.parse(sweepUpperBound)),
          }],
          metadata: { received: 1, providerPayload: "must-not-surface" },
        };
      },
      pullDrive: async ({ cursorBefore, continuation }) => {
        driveInputs.push({ cursorBefore, continuation });
        drivePull += 1;
        const common = {
          connectorName: config.drive.connectorName,
          cursorBefore,
          files: [{
            id: "private-drive-id",
            fileId: "private-drive-id",
            version: "1",
            name: "private-drive-name",
            mimeType: "text/plain",
            modifiedTime: "2026-08-13T10:30:00.000Z",
            extractedText: "private-drive-content",
          }],
          skippedFiles: [{ name: "private-skipped-name", reason: "unsupported_content_type", operation: "metadata" }],
          errors: [],
        };
        if (drivePull === 1) return withPrivateContinuation({
          ...common,
          status: "partial",
          reason: "file_limit_reached",
          cursorAfter: cursorBefore,
          metadata: {
            plannedBatches: 7,
            attemptedBatches: 2,
            completedBatches: 1,
            paginationRemaining: true,
            fileTraversalComplete: false,
            fileLimitReached: true,
            fileLimitReason: "file_limit_reached",
            providerPayload: "must-not-surface",
          },
        }, privateCheckpoint);
        assert.deepEqual(continuation, privateCheckpoint, "the next poll receives the protected checkpoint");
        return withPrivateContinuation({
          ...common,
          status: "completed",
          cursorAfter: sweepUpperBound,
          metadata: {
            plannedBatches: 7,
            attemptedBatches: 6,
            completedBatches: 6,
            paginationRemaining: false,
            fileTraversalComplete: true,
            fileLimitReached: false,
          },
        }, null);
      },
    },
  });

  const first = await sync.runPoll();
  assert.equal(first.degraded, true);
  assert.deepEqual(first.partialStages, ["drive"]);
  assert.equal((await resumeFixture.store.getConnectorCursor(config.gmail.connectorName)).cursor, sweepUpperBound, "Gmail progress persists independently");
  assert.equal((await resumeFixture.store.getConnectorCursor(config.drive.connectorName)).cursor, durableCursor, "Drive cursor remains held while resumable");
  assert.deepEqual((await resumeFixture.store.getConnectorState(config.drive.connectorName)).driveSweepContinuation, privateCheckpoint);
  const firstPublic = JSON.stringify(first);
  for (const protectedValue of ["private-folder-reference", "private-page-token", "private-drive-id", "private-drive-name", "private-drive-content", "private-skipped-name", "private-gmail-id", "private-gmail-name", "private-gmail-content", "must-not-surface"]) {
    assert.equal(firstPublic.includes(protectedValue), false, `sanitized poll output leaked ${protectedValue}`);
  }

  const second = await sync.runPoll();
  assert.equal(second.ok, true);
  assert.equal((await resumeFixture.store.getConnectorCursor(config.drive.connectorName)).cursor, sweepUpperBound, "Drive advances once after complete traversal");
  assert.equal((await resumeFixture.store.getConnectorState(config.drive.connectorName)).driveSweepContinuation, undefined, "completed traversal clears private state");
  assert.deepEqual(driveInputs.map(input => input.cursorBefore), [durableCursor, durableCursor]);
  assert.deepEqual(gmailInputs, [null, sweepUpperBound]);
  const database = await resumeFixture.store.read();
  assert.equal(Object.keys(database.sourceRecords).length, 2, "replayed Gmail and Drive records deduplicate");
  assert.equal(Object.keys(database.intakeItems).length, 2, "replayed records do not duplicate Intake items");
  assert.equal(Object.keys(database.proposedUpdates).length, 0, "replayed records do not duplicate proposals");
} finally {
  fs.rmSync(resumeFixture.directory, { recursive: true, force: true });
}

const failureContinuationFixture = temporaryStore("cue-google-workspace-failure-continuation-");
try {
  const checkpoint = {
    version: 1,
    connectorName: config.drive.connectorName,
    originalCursor: null,
    lowerBound: "1970-01-01T00:00:00.000Z",
    upperBound: "2026-08-13T12:00:00.000Z",
    scopeFingerprint: "private-scope",
    folderIds: [],
    batchIndex: 0,
    pageToken: null,
  };
  const sync = createGoogleWorkspaceIntakeSync({
    config,
    store: failureContinuationFixture.store,
    connectors: {
      pullGmail: async ({ cursorBefore }) => ({ status: "skipped", cursorBefore, cursorAfter: cursorBefore, messages: [] }),
      pullDrive: async ({ cursorBefore }) => withPrivateContinuation({
        status: "failed",
        reason: "request_failed",
        cursorBefore,
        cursorAfter: cursorBefore,
        files: [],
        errors: [{ reason: "request_failed", operation: "file_listing_initial", httpStatus: 503, providerPayload: "private-provider-payload" }],
        metadata: { requestFailure: true, fileTraversalComplete: false },
      }, checkpoint),
    },
  });
  const result = await sync.runPoll();
  assert.deepEqual((await failureContinuationFixture.store.getConnectorState(config.drive.connectorName)).driveSweepContinuation, checkpoint, "request failure retains its resumable checkpoint");
  assert.equal(JSON.stringify(result).includes("private-provider-payload"), false);
} finally {
  fs.rmSync(failureContinuationFixture.directory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  fixtureDatastores: 5,
  resumableDriveState: true,
  replayDeduplication: true,
  mixedSourceProgressIsolation: true,
  sanitizedPollResponses: true,
  liveServicesContacted: false,
  protectedDatastoreUsed: false,
}, null, 2));
