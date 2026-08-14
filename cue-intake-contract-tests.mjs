import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CUE_SOURCE_TYPES,
  normalizeConnectorRecord,
  sourceAuthority,
} from "./cue-intake-contract.mjs";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";

assert.deepEqual(CUE_SOURCE_TYPES, [
  "flex", "slack", "email", "drive", "motive", "cue_staffing",
  "cue_trucking", "cue_warehouse", "manual", "system",
], "connector contract mirrors the production source-type enum");
assert.equal(sourceAuthority("flex").identityAuthority, true, "FLEX is an identity authority");
assert.equal(sourceAuthority("drive", "active-show-index").identityAuthority, true, "Active Show Index is an identity authority");
assert.equal(sourceAuthority("slack").identityAuthority, false, "Slack is evidence, not identity authority");

const normalized = normalizeConnectorRecord({
  sourceType: "email",
  externalId: "thread-1:message-1",
  normalizedText: "LiteFlair needs another truck.",
  payload: { subject: "LiteFlair update" },
});
const normalizedAgain = normalizeConnectorRecord({
  sourceType: "email",
  externalId: "thread-1:message-1",
  normalizedText: "LiteFlair needs another truck.",
  payload: { subject: "LiteFlair update" },
});
assert.equal(normalized.sourceRecord.contentHash, normalizedAgain.sourceRecord.contentHash, "content hashing is deterministic");
assert.equal(normalized.sourceRecord.id, normalizedAgain.sourceRecord.id, "source record identity is deterministic");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-intake-contract-"));
const store = createCueFoundationStore({ filePath: path.join(dir, "foundation.json") });
await store.syncCanonicalShowRegistry([{
  id: "liteflair-shoot",
  name: "LiteFlair Shoot",
  aliases: ["LiteFlair"],
  activeShowsIndex: { client: "LiteFlair", keyDocs: "26-1790" },
  flex: {
    status: "Verified",
    primary: {
      documentNumber: "26-1790",
      elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
      documentType: "quote",
      role: "primary_show_quote",
    },
  },
}, {
  id: "state-farm-motors-frost-florida",
  name: "State Farm Motors Frost Florida",
  activeShowsIndex: { client: "State Farm" },
  flex: { status: "Missing", documents: [] },
}], { source: "test-active-show-index" });

const first = await store.ingestSourceRecords([{
  sourceType: "email",
  externalId: "mail-1",
  externalRevisionId: "1",
  normalizedText: "LiteFlair needs another truck.",
  summary: "LiteFlair needs another truck.",
  category: "trucking",
  showNameHint: "LiteFlair Shoot",
}], {
  connectorName: "gmail-operational-intake",
  connectorVersion: "1.0.0",
  cursorBefore: "mail-0",
  cursorAfter: "mail-1",
  startedAt: "2026-07-13T01:00:00.000Z",
});
assert.equal(first.created, 1);
assert.equal(first.needsMatch, 1, "a name hint alone never silently attaches a show");
assert.equal(first.connectorRun.status, "completed");
assert.equal((await store.getConnectorCursor("gmail-operational-intake")).cursor, "mail-1", "connector cursor is durable");

const duplicate = await store.ingestSourceRecords([{
  sourceType: "email",
  externalId: "mail-1",
  externalRevisionId: "1",
  normalizedText: "LiteFlair needs another truck.",
  summary: "LiteFlair needs another truck.",
  category: "trucking",
  showNameHint: "LiteFlair Shoot",
}], { connectorName: "gmail-operational-intake", startedAt: "2026-07-13T01:01:00.000Z" });
assert.equal(duplicate.deduplicated, 1, "exact connector replay is idempotent");

const revision = await store.ingestSourceRecords([{
  sourceType: "email",
  externalId: "mail-1",
  externalRevisionId: "2",
  normalizedText: "LiteFlair now needs two trucks.",
  summary: "LiteFlair now needs two trucks.",
  category: "trucking",
  showNameHint: "LiteFlair Shoot",
}], { connectorName: "gmail-operational-intake", startedAt: "2026-07-13T01:02:00.000Z" });
assert.equal(revision.superseded, 1, "changed source content creates an immutable superseding revision");

const matrix = await store.ingestSourceRecords([{
  sourceType: "drive",
  connectorName: "active-show-index",
  externalId: "sheet-row-liteflair",
  normalizedText: "Active Show Index row for LiteFlair.",
  canonicalShowId: "liteflair-shoot",
  category: "operations",
}, {
  sourceType: "flex",
  connectorName: "flex-show-hierarchy",
  externalId: "flex-quote-26-1790",
  normalizedText: "FLEX hierarchy for LiteFlair.",
  flexDocumentRefs: [{ documentNumber: "26-1790", elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00", documentType: "quote", role: "primary_show_quote", verified: true }],
}, {
  sourceType: "motive",
  externalId: "dispatch-42",
  normalizedText: "Truck 5301 dispatched to LiteFlair.",
  category: "trucking",
  flexDocumentRefs: [{ documentNumber: "26-1790", elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00", documentType: "quote", verified: true }],
}, {
  sourceType: "cue_staffing",
  externalId: "staffing-assignment-7",
  normalizedText: "Lighting lead assigned.",
  canonicalShowId: "liteflair-shoot",
  category: "staffing",
  proposedUpdates: [{ updateType: "staffing.assignment", value: { role: "lighting_lead" } }],
}, {
  sourceType: "cue_trucking",
  externalId: "trucking-run-7",
  normalizedText: "Box truck assigned.",
  canonicalShowId: "liteflair-shoot",
  category: "trucking",
}, {
  sourceType: "cue_warehouse",
  externalId: "warehouse-general-2",
  normalizedText: "Dock two is open.",
  category: "warehouse",
  requiresShowMatch: false,
}, {
  sourceType: "slack",
  externalId: "CLOG:123.456",
  normalizedText: "I added two hazers to LiteFlair.",
  showNameHint: "LiteFlair Shoot",
  category: "equipment",
}], {
  connectorName: "contract-matrix",
  connectorVersion: "1.0.0",
  startedAt: "2026-07-13T01:03:00.000Z",
});
assert.equal(matrix.created, 7);
assert.equal(matrix.matched, 5, "authoritative show IDs and verified FLEX hierarchy attach deterministically");
assert.equal(matrix.routed, 1, "non-show-scoped native events route without forced matching");
assert.equal(matrix.needsMatch, 1, "Slack name evidence remains in the human match queue");

const db = await store.read();
const changedEmail = Object.values(db.sourceRecords).find(record => record.externalId === "mail-1" && record.externalRevisionId === "2");
assert(changedEmail.supersedesSourceRecordId, "new revision points to the immutable prior Source Record");
const motiveIntake = Object.values(db.intakeItems).find(item => db.sourceRecords[item.sourceRecordId]?.sourceType === "motive");
assert.equal(motiveIntake.matchedShowId, "liteflair-shoot", "Motive can reuse a verified FLEX identity mapping");
const slackIntake = Object.values(db.intakeItems).find(item => db.sourceRecords[item.sourceRecordId]?.externalId === "CLOG:123.456");
assert.equal(slackIntake.status, "needs_match", "Slack cannot establish identity from a name alone");
assert.equal(slackIntake.matchedShowId, null);
assert.equal(Object.keys(db.proposedUpdates).length, 1, "connector proposals share the same proposed-update collection");
assert.equal(
  Object.keys(db.readiness).length,
  0,
  "connector evidence and uncertain matches never mutate Show Readiness before an authorized decision or authoritative lifecycle event"
);

const legacySlackStore = createCueFoundationStore({ filePath: path.join(dir, "legacy-slack.json") });
await legacySlackStore.syncSlackSnapshot({ messages: {
  "CLOG:999.1": {
    messageKey: "CLOG:999.1",
    channelId: "CLOG",
    channelName: "logistics",
    userId: "U1",
    authorName: "Jordan",
    text: "LiteFlair may need another truck.",
    contentHash: "legacy-slack-hash",
    timestampIso: "2026-07-13T01:04:00.000Z",
    ingestedAt: "2026-07-13T01:04:01.000Z",
    operationalClassification: { categories: ["trucking"], status: "at_risk", summary: "LiteFlair may need another truck." },
    extractedEntities: { quotes: [], trucks: [] },
    matches: [],
  },
} });
const legacySlackDb = await legacySlackStore.read();
const legacySlackSource = Object.values(legacySlackDb.sourceRecords)[0];
assert.equal(legacySlackSource.connectorName, "slack-operational-signals", "existing Slack sync now emits the shared Source Record contract");
assert.equal(legacySlackSource.authority.identityAuthority, false);

console.log(JSON.stringify({
  ok: true,
  connectorMatrix: matrix,
  sourceRecordCount: Object.keys(db.sourceRecords).length,
  intakeCount: Object.keys(db.intakeItems).length,
}, null, 2));
