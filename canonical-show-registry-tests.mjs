import assert from "assert";
import {
  buildCanonicalShowRegistry,
  canonicalShowToSlackCandidate,
} from "./canonical-show-registry.mjs";

const timestamp = "2026-07-13T12:00:00.000Z";
const moonchild = {
  id: "live-nation-moonchild-the-fox",
  name: "Live Nation Moonchild @ The Fox",
  activeShowsIndex: { client: "Live Nation", daysOut: 12, keyDocs: "26-0836" },
  readinessStatus: "at_risk",
  flex: {
    status: "Verified",
    primary: {
      documentNumber: "26-1846",
      elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
      documentType: "quote",
      showName: "Live Nation Moonchild @ The Fox",
      status: "Verified",
    },
    documents: [{
      documentNumber: "26-0836",
      elementId: "95141d01-8008-4d29-8fc2-1749159e35e0",
      documentType: "pull_sheet",
      parentElementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
      status: "Verified",
    }],
    soldDepartments: ["Audio"],
  },
};

const first = buildCanonicalShowRegistry([moonchild], {}, {}, { timestamp, sheetName: "Active Shows Index" });
assert.equal(first.summary.active, 1);
assert.equal(first.summary.verified, 1);
const record = first.showRegistry[moonchild.id];
assert.equal(record.flex.primaryShowQuote.documentNumber, "26-1846", "parent quote becomes the canonical show quote");
assert(record.flex.documents.some(document => document.documentNumber === "26-0836" && document.documentType === "pull_sheet"), "pull sheet remains typed supporting evidence");
const candidate = canonicalShowToSlackCandidate(record);
assert.equal(candidate.primaryDocumentNumber, "26-1846");
assert(candidate.documentNumbers.includes("26-0836"));
assert.equal(candidate.source, "canonical_show_registry");

const stale = buildCanonicalShowRegistry([{ ...moonchild, flex: { status: "Error", documents: [] } }], first.showRegistry, first.flexDocumentRegistry, { timestamp: "2026-07-13T13:00:00.000Z" });
assert.equal(stale.showRegistry[moonchild.id].flex.hierarchyStatus, "verified_stale", "temporary FLEX failures preserve the last verified identity");
assert.equal(stale.showRegistry[moonchild.id].flex.primaryShowQuote.documentNumber, "26-1846");

const overriddenShows = structuredClone(first.showRegistry);
overriddenShows[moonchild.id].humanOverrides = {
  primaryShowQuote: {
    documentNumber: "26-1999",
    elementId: "85141d01-8008-4d29-8fc2-1749159e35e0",
    documentType: "quote",
    source: "command_center",
  },
};
const overridden = buildCanonicalShowRegistry([moonchild], overriddenShows, first.flexDocumentRegistry, { timestamp: "2026-07-13T14:00:00.000Z" });
assert.equal(overridden.showRegistry[moonchild.id].flex.primaryShowQuote.documentNumber, "26-1999", "human-confirmed quote outranks automatic refresh");

const inactive = buildCanonicalShowRegistry([], first.showRegistry, first.flexDocumentRegistry, { timestamp: "2026-07-13T15:00:00.000Z" });
assert.equal(inactive.showRegistry[moonchild.id].lifecycle.status, "inactive", "shows leaving the Active Show Index are retained but marked inactive");

const eventFolder = buildCanonicalShowRegistry([{
  id: "country-calling-2026",
  name: "Country Calling 2026",
  flex: {
    status: "Event Folder",
    primary: {
      documentNumber: "26-0021",
      elementId: "881d3614-ee81-4786-a16b-8153cb59d5e3",
      name: "Country Calling 2026",
    },
    documents: [],
  },
}], {}, {}, { timestamp });
assert.equal(eventFolder.showRegistry["country-calling-2026"].flex.primaryShowQuote, null, "an Event Folder is never fabricated into a canonical quote");
assert.equal(eventFolder.showRegistry["country-calling-2026"].humanConfirmationRequired, true, "an Event Folder without an explicit parent quote remains reviewable");

console.log(JSON.stringify({ ok: true, active: first.summary.active, verified: first.summary.verified, documents: first.summary.documents }, null, 2));
