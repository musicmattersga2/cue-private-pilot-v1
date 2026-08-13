import {
  adaptDriveFileToIntakeRecord,
  adaptEmailMessageToIntakeRecord,
} from "./cue-intake-evidence-adapters.mjs";

const CONNECTOR_VERSION = "google-workspace-v1";
const SOURCE_KINDS = ["gmail", "drive"];

function sourceTypeFor(kind) {
  return kind === "gmail" ? "email" : "drive";
}

function sourceItems(kind, source = {}) {
  return kind === "gmail" ? source.messages : source.files;
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
    const result = kind === "gmail"
      ? await connectors.pullGmail({ cursorBefore })
      : await connectors.pullDrive({ cursorBefore });

    if (["skipped", "failed"].includes(result.status)) {
      await store.checkpointConnectorRun({
        connectorName: connector.connectorName,
        connectorVersion: CONNECTOR_VERSION,
        sourceType: sourceTypeFor(kind),
        status: result.status,
        cursorBefore: result.cursorBefore,
        cursorAfter: result.cursorAfter,
        errors: result.errors || [],
        counts: { received: 0, skipped: result.errors?.length || 0 },
        metadata: { reason: result.reason || null, ...(result.metadata || {}) },
      });
    }
    return result;
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
        errors: source.errors || [],
        counts: {
          received: 0,
          skipped: source.skippedFiles?.length || 0,
          failed: source.errors?.length || 0,
        },
        metadata: source.metadata || {},
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
      errors: source.errors || [],
      metadata: { ...(source.metadata || {}), skippedFiles: source.skippedFiles || [] },
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
            connector: source,
          });
          continue;
        }
        const result = await ingestSource(
          kind,
          sourceItems(kind, source) || [],
          verifiedFlexDocuments,
          source,
        );
        stages.push({
          name: kind,
          status: source.status === "partial" || result?.ok === false ? "partial" : "completed",
          connector: source,
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
