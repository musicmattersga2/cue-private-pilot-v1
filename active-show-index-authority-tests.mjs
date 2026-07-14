import assert from "node:assert/strict";
import {
  activeShowIndexRowsToObjects,
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
