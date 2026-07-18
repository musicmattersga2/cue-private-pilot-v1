import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  adaptActiveShowIndexRowToIntakeRecord,
  adaptDriveFileToIntakeRecord,
  adaptEmailMessageToIntakeRecord,
  buildActiveShowIndexBatch,
  extractFlexDocumentRefs,
} from "./cue-intake-evidence-adapters.mjs";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";

const quote = {
  documentNumber: "26-1790",
  elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
  documentType: "quote",
  role: "primary_show_quote",
  verified: true,
};

const mentions = extractFlexDocumentRefs(
  "Use pull sheet 26-0836, but the show quote is 26-1790.",
  { verifiedFlexDocuments: [quote], source: "test" }
);
assert.equal(mentions.length, 2);
assert.equal(mentions[0].documentType, "pull_sheet", "document mentions retain their source type");
assert.equal(mentions[0].verified, false, "an unknown pull sheet number remains unverified");
assert.equal(mentions[1].documentType, "quote");
assert.equal(mentions[1].verified, true, "a unique known FLEX quote may be verified");

const email = adaptEmailMessageToIntakeRecord({
  id: "gmail-message-1",
  threadId: "gmail-thread-1",
  historyId: "101",
  subject: "LiteFlair trucking update",
  html: "<p>Please use quote <strong>26-1790</strong>.</p><p>We need another truck.</p>",
  from: { email: "pm@example.com" },
  to: ["ops@example.com"],
  labelIds: ["INBOX", "IMPORTANT"],
  internalDate: "1784000000000",
  attachments: [{ attachmentId: "a-1", filename: "schedule.pdf", mimeType: "application/pdf", size: 1200 }],
  showNameHint: "LiteFlair Shoot",
}, { verifiedFlexDocuments: [quote] });
assert.equal(email.sourceType, "email");
assert.equal(email.externalParentId, "gmail-thread-1");
assert.equal(email.category, "trucking");
assert.equal(email.flexDocumentRefs[0].verified, true);
assert.deepEqual(email.permissionsMetadata.labels, ["INBOX", "IMPORTANT"]);
assert.equal(email.payload.attachments[0].name, "schedule.pdf");
assert(!email.normalizedText.includes("<strong>"), "HTML email bodies are reduced to readable evidence text");

const drive = adaptDriveFileToIntakeRecord({
  id: "drive-file-1",
  name: "Warehouse opening checklist",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-07-14T01:00:00Z",
  headRevisionId: "rev-1",
  webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
  extractedText: "Dock two opens at 8am.",
  shared: true,
  visibility: "domain",
}, {});
assert.equal(drive.sourceType, "drive");
assert.equal(drive.requiresShowMatch, false, "general Drive evidence routes without inventing a show match");
assert.equal(drive.permissionsMetadata.visibility, "domain");

const activeRow = {
  showId: "liteflair-shoot",
  showName: "LiteFlair Shoot",
  aliases: ["LiteFlair"],
  client: "LiteFlair",
  venue: "Studio A",
  rowNumber: 17,
  updatedAt: "2026-07-14T01:05:00Z",
  keyDocs: "Primary quote 26-1790",
  primaryFlexDocument: quote,
  activeShowsIndex: { projectManager: "BG", truckingStatus: "Needs review" },
};
const activeRecord = adaptActiveShowIndexRowToIntakeRecord(activeRow, {
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});
assert.equal(activeRecord.connectorName, "active-show-index");
assert.equal(activeRecord.canonicalShowId, "liteflair-shoot");
assert.equal(activeRecord.intakeMetadata.identityAuthority, true);

const activeRowWithVerifiedFlex = {
  ...activeRow,
  row: { show: "LiteFlair Shoot", client: "LiteFlair", quote: "26-1790" },
  flexDocuments: [quote],
  flex: {
    status: "Verified",
    primary: quote,
    documents: [{ ...quote, status: "Verified", message: null }],
    lastPullAt: "2026-07-18T12:40:00.000Z",
  },
};
const activeRowWithSkippedFlex = {
  ...activeRowWithVerifiedFlex,
  flex: {
    status: "Partial",
    primary: null,
    documents: [{
      documentNumber: "26-1790",
      documentType: "quote",
      role: "primary_show_quote",
      status: "Skipped",
      skipReason: "flex_http_429",
      message: "FLEX request failed: 429 Too Many Requests.",
    }],
    lastPullAt: "2026-07-18T12:42:57.000Z",
  },
};
const verifiedEvidenceRecord = adaptActiveShowIndexRowToIntakeRecord(activeRowWithVerifiedFlex, {
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});
const skippedEvidenceRecord = adaptActiveShowIndexRowToIntakeRecord(activeRowWithSkippedFlex, {
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});
assert.deepEqual(
  skippedEvidenceRecord.flexDocumentRefs,
  verifiedEvidenceRecord.flexDocumentRefs,
  "transient FLEX failures never rewrite authoritative Active Show Index evidence references",
);

const batch = buildActiveShowIndexBatch([activeRow], {
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});
assert.equal(batch.shows[0].id, "liteflair-shoot");
assert.equal(batch.shows[0].activeShowsIndex.projectManager, "BG", "the full operational index row feeds canonical show metadata");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-evidence-adapters-"));
const store = createCueFoundationStore({ filePath: path.join(dir, "foundation.json") });
await store.syncCanonicalShowRegistry(batch.shows, {
  source: "active-show-index",
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});

const activeIngest = await store.ingestSourceRecords(batch.records, {
  sourceType: "drive",
  connectorName: "active-show-index",
  cursorAfter: "sheet-revision-1",
  startedAt: "2026-07-14T01:10:00Z",
});
assert.equal(activeIngest.matched, 1, "Active Show Index rows establish existing canonical show identity");

const volatileFlexStore = createCueFoundationStore({ filePath: path.join(dir, "volatile-flex-foundation.json") });
await volatileFlexStore.syncCanonicalShowRegistry(batch.shows, {
  source: "active-show-index",
  sheetId: "sheet-active-shows",
  sheetName: "Active Shows",
});
const verifiedFlexIngest = await volatileFlexStore.ingestSourceRecords([verifiedEvidenceRecord], {
  sourceType: "drive",
  connectorName: "active-show-index",
  startedAt: "2026-07-18T12:40:00.000Z",
});
const skippedFlexIngest = await volatileFlexStore.ingestSourceRecords([skippedEvidenceRecord], {
  sourceType: "drive",
  connectorName: "active-show-index",
  startedAt: "2026-07-18T12:43:00.000Z",
});
const volatileFlexDb = await volatileFlexStore.read();
assert.equal(verifiedFlexIngest.intakeCreated, 1);
assert.equal(skippedFlexIngest.deduplicated, 1, "a transient FLEX skip reuses the existing Active Show Index Source Record");
assert.equal(skippedFlexIngest.intakeCreated, 0, "a transient FLEX skip does not churn Intake identity");
assert.equal(Object.keys(volatileFlexDb.intakeItems).length, 1, "repeated sheet evidence retains one Intake item");

const foundation = await store.read();
const verifiedFlexDocuments = Object.values(foundation.flexDocumentRegistry);
const matchedEmail = adaptEmailMessageToIntakeRecord({
  id: "gmail-message-2",
  historyId: "201",
  subject: "LiteFlair truck",
  text: "Quote 26-1790 needs another box truck.",
}, { verifiedFlexDocuments });
const emailIngest = await store.ingestSourceRecords([matchedEmail], {
  sourceType: "email",
  connectorName: "gmail-operational-intake",
  startedAt: "2026-07-14T01:11:00Z",
});
assert.equal(emailIngest.matched, 1, "Email reuses a verified FLEX-to-show mapping without name guessing");

const ambiguousDrive = adaptDriveFileToIntakeRecord({
  id: "drive-file-2",
  version: "1",
  name: "LiteFlair notes",
  extractedText: "Possible extra equipment.",
  showNameHint: "LiteFlair Shoot",
}, {});
const generalDrive = adaptDriveFileToIntakeRecord({
  id: "drive-file-3",
  version: "1",
  name: "Warehouse checklist",
  extractedText: "Dock two opens at 8am.",
}, {});
const driveIngest = await store.ingestSourceRecords([ambiguousDrive, generalDrive], {
  sourceType: "drive",
  connectorName: "google-drive-operational-intake",
  startedAt: "2026-07-14T01:12:00Z",
});
assert.equal(driveIngest.needsMatch, 1, "a Drive show-name hint remains a reviewable hint");
assert.equal(driveIngest.routed, 1, "company evidence without a show reference routes outside the match queue");

const revisedEmail = adaptEmailMessageToIntakeRecord({
  id: "gmail-message-2",
  historyId: "202",
  subject: "LiteFlair truck - resolved",
  text: "Quote 26-1790 now has a box truck assigned.",
}, { verifiedFlexDocuments });
const revisionIngest = await store.ingestSourceRecords([revisedEmail], {
  sourceType: "email",
  connectorName: "gmail-operational-intake",
  startedAt: "2026-07-14T01:13:00Z",
});
assert.equal(revisionIngest.superseded, 1);
assert.equal(revisionIngest.intakeSuperseded, 1, "a revised message closes its prior active Intake revision");

const all = await store.read();
const emailSources = Object.values(all.sourceRecords).filter(record => record.externalId === "gmail-message-2");
assert.equal(emailSources.length, 2, "immutable Source Record history is retained");
const emailIntake = Object.values(all.intakeItems).filter(item => emailSources.some(source => source.id === item.sourceRecordId));
assert.equal(emailIntake.filter(item => item.status === "superseded").length, 1);
assert.equal(emailIntake.filter(item => item.status === "matched").length, 1);
assert.equal((await store.listIntakeItems()).some(item => item.status === "superseded"), false, "default Intake queries hide historical revisions");
assert.equal((await store.listIntakeItems({ includeSuperseded: true })).some(item => item.status === "superseded"), true);

const summary = await store.getSummary();
assert.equal(summary.intakeTotal, 4, "summary metrics count only current Intake revisions");

console.log(JSON.stringify({
  ok: true,
  activeIngest,
  emailIngest,
  driveIngest,
  revisionIngest,
  summary,
}, null, 2));
