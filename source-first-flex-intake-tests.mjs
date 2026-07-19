import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";
import {
  FLEX_CONFIRMED_STATUS_ID,
  FLEX_PEACHTREE_CORNERS_LOCATION_ID,
  runFlexConfirmedQuoteSnapshot,
} from "./flex-confirmed-quote-snapshot.mjs";

const moonchildElementId = "11111111-1111-4111-8111-111111111111";
const liteflairElementId = "22222222-2222-4222-8222-222222222222";
const confirmedAt = "2026-07-15T12:00:00.000Z";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-source-first-flex-"));
const store = createCueFoundationStore({ filePath: path.join(dir, "foundation.json") });
let connectorState = null;

const quotes = [
  {
    id: moonchildElementId,
    name: "Live Nation Moonchild @ The Fox",
    documentNumber: "26-1846",
    clientCompany: "Live Nation",
    calcStartDate: "2026-07-20T12:00:00.000Z",
    calcEndDate: "2026-07-21T12:00:00.000Z",
    statusId: { id: FLEX_CONFIRMED_STATUS_ID, name: "Confirmed" },
    locationId: { id: FLEX_PEACHTREE_CORNERS_LOCATION_ID, name: "Peachtree Corners" },
  },
  {
    id: liteflairElementId,
    name: "LiteFlair Shoot",
    documentNumber: "26-1790",
    clientCompany: "LiteFlair",
    calcStartDate: "2026-07-22T12:00:00.000Z",
    calcEndDate: "2026-07-23T12:00:00.000Z",
    statusId: { id: FLEX_CONFIRMED_STATUS_ID, name: "Confirmed" },
    locationId: { id: FLEX_PEACHTREE_CORNERS_LOCATION_ID, name: "Peachtree Corners" },
  },
];

const snapshot = await runFlexConfirmedQuoteSnapshot({
  now: confirmedAt,
  fetchConfirmedPage: async () => ({
    content: quotes,
    number: 0,
    totalPages: 1,
    totalElements: quotes.length,
    last: true,
  }),
  fetchStatusHistory: async elementId => [{
    id: `confirmed-${elementId}`,
    changedOn: confirmedAt,
    changedByUserId: "operations-manager",
    changedByUserName: "Operations Manager",
    previousStatusId: "inquiry",
    previousStatusName: "Inquiry",
    newStatusId: FLEX_CONFIRMED_STATUS_ID,
    newStatusName: "Confirmed",
  }],
  observe: observation => store.observeFlexQuoteStatus(observation),
  getState: async () => connectorState,
  saveState: async (_connectorName, nextState) => { connectorState = nextState; },
  checkpoint: async () => {},
});

assert.equal(snapshot.ok, true);
assert.equal(snapshot.observations.length, 2, "both current confirmed quotes enter the shared Intake spine");

let db = await store.read();
assert.equal(Object.values(db.sourceRecords).filter(record => record.sourceType === "flex").length, 2);
assert.equal(Object.keys(db.intakeItems).length, 2);
assert.equal(Object.keys(db.readiness).length, 2);
assert.ok(Object.values(db.intakeItems).every(item => item.status === "matched"));

const registrySync = await store.syncCanonicalShowRegistry([
  {
    id: "live-nation-moonchild-the-fox",
    name: "Live Nation Moonchild @ The Fox",
    activeShowsIndex: { client: "Live Nation", owner: "Jon Summers" },
    readinessStatus: "Active",
    flex: {
      status: "Verified",
      primary: {
        documentNumber: "26-1846",
        elementId: moonchildElementId,
        documentType: "quote",
        role: "primary_show_quote",
        status: "Verified",
      },
      documents: [],
    },
  },
  {
    id: "liteflair-shoot",
    name: "LiteFlair Shoot",
    activeShowsIndex: { client: "LiteFlair", owner: "Project Manager" },
    readinessStatus: "Active",
    flex: {
      status: "Verified",
      primary: {
        documentNumber: "26-1790",
        elementId: liteflairElementId,
        documentType: "quote",
        role: "primary_show_quote",
        status: "Verified",
      },
      documents: [],
    },
  },
], { source: "active_show_index", timestamp: "2026-07-15T12:05:00.000Z" });

assert.equal(registrySync.reconciled, 2);
db = await store.read();
for (const [showId, quoteNumber] of [
  ["live-nation-moonchild-the-fox", "26-1846"],
  ["liteflair-shoot", "26-1790"],
]) {
  assert.equal(db.showRegistry[showId].flex.primaryShowQuote.documentNumber, quoteNumber);
  assert.equal(db.readiness[showId].milestoneRollup.quote_confirmed.status, "ready");
  assert.equal(db.readiness[showId].milestoneRollup.active_show_index.status, "ready");
  const intake = Object.values(db.intakeItems).find(item => item.primaryFlexDocumentNumber === quoteNumber);
  assert.equal(intake.matchedShowId, showId);
  assert.equal(intake.status, "matched");
}

console.log(JSON.stringify({
  ok: true,
  connector: snapshot.connectorName,
  observedQuotes: quotes.map(quote => quote.documentNumber),
  reconciledShows: ["live-nation-moonchild-the-fox", "liteflair-shoot"],
}, null, 2));
