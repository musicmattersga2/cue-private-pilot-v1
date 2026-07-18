import assert from "node:assert/strict";
import {
  activeShowIndexRowsToObjects,
  extractActiveShowFlexDocumentRefs,
  extractActiveShowFlexDocumentNumbers,
  mapActiveShowIndexAuthorityRow,
  runSourceFirstIntakeSync,
} from "./active-show-index-authority.mjs";

const headers = [
  "Show / Project",
  "Event Date",
  "Status",
  "Client / Account",
  "FLEX Quote #",
  "FLEX Element ID",
  "Source-of-Truth Status",
  "Owner / PM",
  "Trucking Owner",
  "Active Run Window",
];
const rows = activeShowIndexRowsToObjects([
  ["CUE Active Shows Index"],
  headers,
  [
    "Live Nation Moonchild @ The Fox",
    "2026-07-18",
    "Active",
    "Live Nation",
    "26-1846",
    "85141d01-8008-4d29-8fc2-1749159e35e0",
    "Authoritative",
    "Jon Summers",
    "Aaron",
    "2026-07-17/2026-07-19",
  ],
]);
assert.equal(rows.length, 1);
assert.equal(rows[0].__rowNumber, 3);

const mapped = mapActiveShowIndexAuthorityRow(rows[0], {
  sheetId: "sheet-1",
  sheetName: "Active Shows Index",
});
assert.equal(mapped.id, "live-nation-moonchild-the-fox");
assert.equal(mapped.rowNumber, 3);
assert.equal(mapped.flex.primary.documentNumber, "26-1846");
assert.equal(mapped.flex.primary.documentType, "quote");
assert.equal(mapped.flex.primary.status, "Verified");
assert.equal(mapped.activeShowsIndex.owner, "Jon Summers");
assert.equal(mapped.activeShowsIndex.owners.trucking, "Aaron");
assert.equal(mapped.activeShowsIndex.activeRunWindow, "2026-07-17/2026-07-19");

const multi = mapActiveShowIndexAuthorityRow({
  showproject: "State Farm",
  flexquote: "26-1350; 26-1358",
  flexelementid: "11111111-1111-4111-8111-111111111111; 22222222-2222-4222-8222-222222222222",
  sourceoftruthstatus: "Authoritative",
});
assert.equal(multi.flex.documents.length, 2);
assert.equal(multi.flex.primary, null, "multiple related workstreams must not manufacture a primary quote");
assert.ok(multi.flex.documents.every(document => document.role === "related"));

const typedHierarchy = mapActiveShowIndexAuthorityRow({
  showproject: "Moonchild @ The Fox",
  primaryflexquote: "26-1846",
  primaryflexquoteelementid: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
  flexpullsheet: "26-0836",
  flexpullsheetelementid: "95141d01-8008-4d29-8fc2-1749159e35e0",
  flexmanifest: "26-0740",
  flexmanifestelementid: "33333333-3333-4333-8333-333333333333",
  sourceoftruthstatus: "Authoritative",
});
assert.equal(typedHierarchy.flex.primary.documentNumber, "26-1846", "the explicit primary quote anchors the show hierarchy");
assert.equal(typedHierarchy.flex.documents.find(document => document.documentNumber === "26-0836")?.documentType, "pull_sheet");
assert.equal(typedHierarchy.flex.documents.find(document => document.documentNumber === "26-0740")?.documentType, "manifest");
assert.deepEqual(
  extractActiveShowFlexDocumentNumbers(typedHierarchy),
  ["26-1846", "26-0836", "26-0740"],
  "server enrichment consumes structured Active Show Index FLEX references even when narrative cells omit the numbers"
);
assert.deepEqual(
  extractActiveShowFlexDocumentRefs(typedHierarchy).map(reference => ({
    documentNumber: reference.documentNumber,
    elementId: reference.elementId,
    documentType: reference.documentType,
    role: reference.role,
  })),
  [
    {
      documentNumber: "26-1846",
      elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
      documentType: "quote",
      role: "primary_show_quote",
    },
    {
      documentNumber: "26-0836",
      elementId: "95141d01-8008-4d29-8fc2-1749159e35e0",
      documentType: "pull_sheet",
      role: "related",
    },
    {
      documentNumber: "26-0740",
      elementId: "33333333-3333-4333-8333-333333333333",
      documentType: "manifest",
      role: "related",
    },
  ],
  "structured FLEX references retain their authoritative UUID, type, and hierarchy role"
);

const genericTyped = mapActiveShowIndexAuthorityRow({
  showproject: "Mixed FLEX hierarchy",
  flexdocument: "26-1001; 26-1002",
  flexdocumenttype: "Pull Sheet; Invoice",
  flexdocumentelementid: "44444444-4444-4444-8444-444444444444; 55555555-5555-4555-8555-555555555555",
  sourceoftruthstatus: "Authoritative",
});
assert.deepEqual(genericTyped.flex.documents.map(document => document.documentType), ["pull_sheet", "invoice"]);
assert.equal(genericTyped.flex.primary, null, "typed supporting documents never manufacture a primary quote");

const order = [];
const result = await runSourceFirstIntakeSync({
  discoverFlexQuoteStatuses: async () => {
    order.push("flex-discovery");
    return { ok: true, available: true, observed: 1 };
  },
  flexQuoteStatuses: [{ documentNumber: "26-1846", status: "Confirmed" }],
  observeFlexQuoteStatuses: async () => { order.push("flex-confirmations"); return { triggered: 1 }; },
  loadActiveShowIndex: async () => ({ usedFallback: false, shows: [mapped], source: "live" }),
  prepareActiveShows: async shows => { order.push("prepare"); return shows; },
  syncCanonicalRegistry: async () => { order.push("registry"); return { ok: true }; },
  ingestActiveShowIndex: async () => { order.push("index-evidence"); return { ok: true }; },
  getVerifiedFlexDocuments: async () => { order.push("flex-registry"); return [{ documentNumber: "26-1846" }]; },
  emailMessages: [{ id: "email-1" }],
  ingestEmail: async () => { order.push("email"); return { ok: true }; },
  driveFiles: [{ id: "drive-1" }],
  ingestDrive: async () => { order.push("drive"); return { ok: true }; },
  syncSlack: async () => { order.push("slack"); return { ok: true }; },
});
assert.equal(result.ok, true);
assert.deepEqual(order, ["flex-discovery", "flex-confirmations", "prepare", "registry", "index-evidence", "flex-registry", "email", "drive", "slack"]);

const unavailableDiscovery = await runSourceFirstIntakeSync({
  discoverFlexQuoteStatuses: async () => ({
    ok: true,
    available: false,
    status: "endpoint_not_configured",
  }),
  loadActiveShowIndex: async () => ({ usedFallback: false, shows: [mapped], source: "live" }),
  syncCanonicalRegistry: async () => ({ ok: true }),
  getVerifiedFlexDocuments: async () => [],
});
assert.equal(unavailableDiscovery.ok, true);
assert.equal(unavailableDiscovery.stages[0].name, "flex_quote_discovery");
assert.equal(unavailableDiscovery.stages[0].status, "skipped");
assert.equal(unavailableDiscovery.stages[0].reason, "endpoint_not_configured");
assert.equal(unavailableDiscovery.degraded, false, "an intentionally unconfigured lifecycle feed is not a failed sync");

let registryRanAfterDiscoveryFailure = false;
const failedDiscovery = await runSourceFirstIntakeSync({
  discoverFlexQuoteStatuses: async () => ({
    ok: false,
    available: true,
    status: "endpoint_unavailable",
    errors: [{ message: "FLEX lifecycle feed timed out" }],
  }),
  loadActiveShowIndex: async () => ({ usedFallback: false, shows: [mapped], source: "live" }),
  syncCanonicalRegistry: async () => {
    registryRanAfterDiscoveryFailure = true;
    return { ok: true };
  },
  getVerifiedFlexDocuments: async () => [],
});
assert.equal(failedDiscovery.ok, false, "a configured FLEX lifecycle failure degrades the source-first sync");
assert.equal(failedDiscovery.degraded, true);
assert.deepEqual(failedDiscovery.failedStages, ["flex_quote_discovery"]);
assert.equal(registryRanAfterDiscoveryFailure, true, "other authoritative sources still reconcile during a degraded FLEX discovery run");

let registryCalled = false;
const fallback = await runSourceFirstIntakeSync({
  loadActiveShowIndex: async () => ({ usedFallback: true, shows: [{ id: "mock" }] }),
  syncCanonicalRegistry: async () => { registryCalled = true; },
  getVerifiedFlexDocuments: async () => [],
});
assert.equal(fallback.authoritativeSourceAvailable, false);
assert.equal(registryCalled, false, "fallback rows must never mutate the canonical registry");
assert.equal(fallback.stages[0].reason, "fallback_not_authoritative");

console.log(JSON.stringify({
  ok: true,
  mappedShow: mapped.id,
  primaryQuote: mapped.flex.primary.documentNumber,
  sourceFirstOrder: order,
  failedDiscoveryReported: failedDiscovery.degraded,
  fallbackGuarded: !registryCalled,
}, null, 2));
