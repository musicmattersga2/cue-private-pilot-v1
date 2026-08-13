import {
  adaptDriveFileToIntakeRecord,
  adaptEmailMessageToIntakeRecord,
} from "./cue-intake-evidence-adapters.mjs";

const CONNECTOR_VERSION = "google-workspace-v1";
const SOURCE_KINDS = ["gmail", "drive"];
const PRIVATE_DRIVE_CONTINUATION = Symbol.for("cue.googleWorkspace.driveContinuation");
const SAFE_METADATA_KEYS = new Set([
  "recursive", "folderTraversalComplete", "folderCount", "queryBatchCount",
  "plannedBatches", "attemptedBatches", "completedBatches", "paginationRemaining",
  "fileTraversalComplete", "fileLimitReached", "fileLimitReason", "requestFailure", "continuationDiagnostic",
  "sweepLowerBound", "sweepUpperBound", "received", "skipped", "failed",
]);

function sourceTypeFor(kind) {
  return kind === "gmail" ? "email" : "drive";
}

function sourceItems(kind, source = {}) {
  return kind === "gmail" ? source.messages : source.files;
}

function safeDiagnostics(errors = []) {
  return errors.map(error => ({
    reason: String(error?.reason || "request_failed"),
    operation: String(error?.operation || "connector_request"),
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  }));
}

function safeMetadata(metadata = {}) {
  return Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    SAFE_METADATA_KEYS.has(key)
    && (value === null || ["string", "number", "boolean"].includes(typeof value))));
}

function publicConnectorResult(source = {}) {
  return {
    connectorName: source.connectorName || null,
    status: source.status || "failed",
    reason: source.reason || null,
    cursorBefore: source.cursorBefore ?? null,
    cursorAfter: source.cursorAfter ?? source.cursorBefore ?? null,
    errors: safeDiagnostics(source.errors || []),
    metadata: safeMetadata(source.metadata || {}),
  };
}

export function createGoogleWorkspaceIntakeSync(options = {}) {
  const { config, connectors, store } = options;
  const adaptEmail = options.adaptEmailMessageToIntakeRecord || adaptEmailMessageToIntakeRecord;
  const adaptDrive = options.adaptDriveFileToIntakeRecord || adaptDriveFileToIntakeRecord;
  let syncInFlight = null;

  if (!config?.gmail || !config?.drive) {
    throw new Error("Google Workspace sync requires Gmail and Drive configuration.");
  }
  if (typeof connectors?.pullGmail !== "function" || typeof connectors?.pullDrive !== "function") {
    throw new Error("Google Workspace sync requires Gmail and Drive connectors.");
  }
  if (
    typeof store?.read !== "function"
    || typeof store?.getConnectorCursor !== "function"
    || typeof store?.getConnectorState !== "function"
    || typeof store?.saveConnectorState !== "function"
    || typeof store?.checkpointConnectorRun !== "function"
    || typeof store?.ingestSourceRecords !== "function"
  ) {
    throw new Error("Google Workspace sync requires a Foundation store.");
  }

  function connectorFor(kind) {
    return kind === "gmail" ? config.gmail : config.drive;
  }

  async function connectorCursor(kind) {
    const record = await store.getConnectorCursor(connectorFor(kind).connectorName);
    return record?.cursor ?? null;
  }

  async function pullSource(kind) {
    const connector = connectorFor(kind);
    const cursorBefore = await connectorCursor(kind);
    const continuationState = kind === "drive"
      ? await store.getConnectorState(connector.connectorName)
      : null;
    const result = kind === "gmail"
      ? await connectors.pullGmail({ cursorBefore })
      : await connectors.pullDrive({
        cursorBefore,
        continuation: continuationState?.driveSweepContinuation || null,
      });

    if (["skipped", "failed"].includes(result.status)) {
      await store.checkpointConnectorRun({
        connectorName: connector.connectorName,
        connectorVersion: CONNECTOR_VERSION,
        sourceType: sourceTypeFor(kind),
        status: result.status,
        cursorBefore: result.cursorBefore,
        cursorAfter: result.cursorAfter,
        errors: safeDiagnostics(result.errors || []),
        counts: { received: 0, skipped: result.errors?.length || 0 },
        metadata: { reason: result.reason || null, ...safeMetadata(result.metadata || {}) },
      });
      if (kind === "drive") await persistDriveContinuation(result, continuationState);
    }
    return result;
  }

  async function persistDriveContinuation(source, previousState = null) {
    if (!Object.prototype.hasOwnProperty.call(source, PRIVATE_DRIVE_CONTINUATION)) return;
    const privateState = source[PRIVATE_DRIVE_CONTINUATION] || {};
    const nextState = { ...(previousState || {}) };
    delete nextState.connectorName;
    delete nextState.updatedAt;
    if (privateState.continuation) nextState.driveSweepContinuation = privateState.continuation;
    else delete nextState.driveSweepContinuation;
    if (privateState.diagnosticCategory) nextState.driveContinuationDiagnostic = privateState.diagnosticCategory;
    else delete nextState.driveContinuationDiagnostic;
    await store.saveConnectorState(config.drive.connectorName, nextState);
  }

  async function ingestSource(kind, items, verifiedFlexDocuments, source = {}) {
    const connector = connectorFor(kind);
    if (!items.length) {
      return store.checkpointConnectorRun({
        connectorName: connector.connectorName,
        connectorVersion: CONNECTOR_VERSION,
        sourceType: sourceTypeFor(kind),
        status: source.status === "partial" ? "partial" : "completed",
        cursorBefore: source.cursorBefore,
        cursorAfter: source.cursorAfter,
        errors: safeDiagnostics(source.errors || []),
        counts: {
          received: 0,
          skipped: source.skippedFiles?.length || 0,
          failed: source.errors?.length || 0,
        },
        metadata: safeMetadata(source.metadata || {}),
      });
    }

    const records = items.map(item => kind === "gmail"
      ? adaptEmail(item, {
        connectorName: connector.connectorName,
        connectorVersion: CONNECTOR_VERSION,
        verifiedFlexDocuments,
      })
      : adaptDrive(item, {
        connectorName: connector.connectorName,
        connectorVersion: CONNECTOR_VERSION,
        verifiedFlexDocuments,
      }));

    return store.ingestSourceRecords(records, {
      sourceType: sourceTypeFor(kind),
      connectorName: connector.connectorName,
      connectorVersion: CONNECTOR_VERSION,
      cursorBefore: source.cursorBefore ?? null,
      cursorAfter: source.cursorAfter ?? source.cursorBefore ?? null,
      status: source.status,
      errors: safeDiagnostics(source.errors || []),
      metadata: {
        ...safeMetadata(source.metadata || {}),
        skippedFiles: (source.skippedFiles || []).map(item => ({
          reason: String(item?.reason || "skipped"),
          operation: String(item?.operation || "metadata"),
        })),
      },
    });
  }

  async function performPoll() {
    const foundation = await store.read();
    const verifiedFlexDocuments = Object.values(foundation.flexDocumentRegistry || {});
    const stages = [];

    for (const kind of SOURCE_KINDS) {
      try {
        const source = await pullSource(kind);
        if (["skipped", "failed"].includes(source.status)) {
          stages.push({
            name: kind,
            status: source.status,
            reason: source.reason || "connector_failed",
            connector: publicConnectorResult(source),
          });
          continue;
        }
        const result = await ingestSource(
          kind,
          sourceItems(kind, source) || [],
          verifiedFlexDocuments,
          source,
        );
        if (kind === "drive") {
          const previousState = await store.getConnectorState(config.drive.connectorName);
          await persistDriveContinuation(source, previousState);
        }
        stages.push({
          name: kind,
          status: source.status === "partial" || result?.ok === false ? "partial" : "completed",
          connector: publicConnectorResult(source),
          result,
        });
      } catch {
        stages.push({
          name: kind,
          status: "failed",
          reason: "connector_failed",
          errors: [{ message: `${kind} connector failed.` }],
        });
      }
    }

    return {
      ok: stages.every(stage => ["completed", "skipped"].includes(stage.status)),
      degraded: stages.some(stage => ["partial", "failed"].includes(stage.status)),
      stages,
      failedStages: stages.filter(stage => stage.status === "failed").map(stage => stage.name),
      partialStages: stages.filter(stage => stage.status === "partial").map(stage => stage.name),
      skippedStages: stages.filter(stage => stage.status === "skipped").map(stage => stage.name),
    };
  }

  async function runPoll() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = performPoll();
    try {
      return await syncInFlight;
    } finally {
      syncInFlight = null;
    }
  }

  return { runPoll };
}
