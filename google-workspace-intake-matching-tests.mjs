import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGoogleWorkspaceMatchingPreview, sanitizedGoogleWorkspaceMatchingPreview } from "./google-workspace-intake-matching.mjs";
import { runGoogleWorkspaceMatchingPreview } from "./scripts/google-workspace-intake-match-preview.mjs";

function fixture() {
  return {
    sourceRecords: {}, intakeItems: {}, showRegistry: {}, flexDocumentRegistry: {},
    matchCandidates: {}, candidateFacts: {}, proposedUpdates: {}, connectorCursors: {}, connectorContinuations: {},
  };
}

function addShow(db, id, name, { aliases = [], client = null, venue = null, date = null } = {}) {
  db.showRegistry[id] = {
    id, name, aliases, normalizedAliases: [], operationalIdentity: { client, venue },
    flex: { plannedStartDate: date },
  };
}

function addIntake(db, id, text, options = {}) {
  const sourceId = `source-${id}`;
  db.sourceRecords[sourceId] = {
    id: sourceId,
    sourceType: options.sourceType || "drive",
    normalizedText: text,
    payload: { name: options.name || text, description: options.description || "", mimeType: options.mimeType || "application/pdf" },
    ...(options.source || {}),
  };
  db.intakeItems[id] = {
    id, sourceRecordId: sourceId, status: options.status || "routed", summary: options.summary || text,
    flexDocumentRefs: options.flexDocumentRefs || [],
    ...(options.intake || {}),
  };
  return { sourceId, intake: db.intakeItems[id] };
}

function candidatesFor(result, intakeItemId) {
  return result.privateProjection.candidates.filter(candidate => candidate.intakeItemId === intakeItemId);
}

{
  const db = fixture();
  addShow(db, "show-a", "North Star");
  addShow(db, "show-b", "South Star");
  db.flexDocumentRegistry.doc = { elementId: "verified-element", showIds: ["show-a"] };
  addIntake(db, "i-flex", "general evidence", { flexDocumentRefs: [{ elementId: "verified-element" }] });
  addIntake(db, "i-canonical", "general evidence", { intake: { canonicalShowId: "show-b" } });
  const result = buildGoogleWorkspaceMatchingPreview(db);
  assert.equal(candidatesFor(result, "i-flex")[0].confidence, "high", "verified FLEX references are strongest evidence");
  assert.equal(candidatesFor(result, "i-canonical")[0].confidence, "high", "explicit canonical references are strongest evidence");
}

{
  const db = fixture();
  addShow(db, "show-a", "Orbit Live", { aliases: ["Orbit Tour"] });
  addShow(db, "show-b", "Harbor Night");
  addIntake(db, "i-title", "Production notes for ORBIT---TOUR load in", { name: "production brief", description: "" });
  const result = buildGoogleWorkspaceMatchingPreview(db);
  const candidate = candidatesFor(result, "i-title")[0];
  assert.equal(result.report.matches.unique, 1);
  assert.equal(candidate.confidence, "medium");
  assert(candidate.facts.some(fact => fact.category === "normalized_title_or_alias"));
}

{
  const db = fixture();
  addShow(db, "show-a", "Shared Name");
  addShow(db, "show-b", "Shared Name");
  addIntake(db, "i-ambiguous", "Shared Name production plan");
  const result = buildGoogleWorkspaceMatchingPreview(db);
  assert.equal(result.report.matches.ambiguous, 1);
  assert.equal(candidatesFor(result, "i-ambiguous").length, 2);
  assert(candidatesFor(result, "i-ambiguous").every(candidate => candidate.confidence === "low"));
}

{
  const db = fixture();
  addShow(db, "show-a", "Quiet Signal", { client: "Client Alpha", venue: "Venue West", date: "2026-09-01" });
  addShow(db, "show-b", "Other Show", { client: "Quiet Signal Client", venue: "Quiet Signal Hall", date: "2026-10-01" });
  addIntake(db, "i-metadata", "File: Quiet Signal", { name: "Quiet Signal", mimeType: "image/png" });
  addIntake(db, "i-support-only", "Client Alpha Venue West 2026-09-01", { name: "brief" });
  addIntake(db, "i-conflict", "Quiet Signal 2026-10-01 Quiet Signal Client", { name: "brief", description: "substantial extracted production evidence follows here" });
  const result = buildGoogleWorkspaceMatchingPreview(db);
  assert.equal(candidatesFor(result, "i-metadata")[0].confidence, "low", "weak metadata-only title evidence is conservative");
  assert.equal(candidatesFor(result, "i-support-only").length, 0, "date, client and venue cannot independently create candidates");
  assert.equal(candidatesFor(result, "i-conflict").length, 1, "conflicting support does not override an unambiguous title");
  assert.notEqual(candidatesFor(result, "i-conflict")[0].confidence, "high");
}

{
  const db = fixture();
  addShow(db, "show-a", "Matched Show");
  addIntake(db, "i-matched", "Matched Show", { intake: { matchedShowId: "show-a" } });
  const old = addIntake(db, "i-old", "Matched Show");
  addIntake(db, "i-current", "unrelated", { source: { supersedesSourceRecordId: old.sourceId } });
  addIntake(db, "i-malformed", "", { source: { normalizedText: null } });
  const result = buildGoogleWorkspaceMatchingPreview(db);
  assert.equal(result.report.exclusionsByReason.already_authoritatively_matched, 1);
  assert.equal(result.report.exclusionsByReason.superseded_or_noncurrent, 1);
  assert.equal(result.report.exclusionsByReason.malformed_or_orphaned, 1);
  assert.equal(candidatesFor(result, "i-matched").length, 0);
  assert.equal(candidatesFor(result, "i-old").length, 0);
}

{
  const db = fixture();
  addShow(db, "show-a", "Stable Show", { aliases: ["Stable Alias"] });
  addIntake(db, "i-2", "Stable Alias detailed extracted content that is long enough to be content bearing", { name: "brief" });
  addIntake(db, "i-1", "Stable Show detailed extracted content that is long enough to be content bearing", { name: "brief" });
  const snapshot = JSON.stringify(db);
  const first = buildGoogleWorkspaceMatchingPreview(db);
  const second = buildGoogleWorkspaceMatchingPreview(db);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "stable input produces byte-equivalent ordered output");
  assert.deepEqual(first.privateProjection.candidates.map(item => item.id), second.privateProjection.candidates.map(item => item.id));
  assert.deepEqual(first.privateProjection.facts.map(item => item.id), second.privateProjection.facts.map(item => item.id));
  assert.equal(JSON.stringify(db), snapshot, "preview does not mutate supplied objects");
  assert.equal(first.report.collisionChecks.candidateIdCollisions, 0);
  assert.equal(first.report.collisionChecks.candidateFactIdCollisions, 0);
}

{
  const empty = sanitizedGoogleWorkspaceMatchingPreview(fixture());
  assert.equal(empty.cohort.total, 0);
  assert.equal(empty.projections.matchCandidates, 0);
  const db = fixture();
  addShow(db, "show-a", "Mixed Show");
  addIntake(db, "google", "Mixed Show");
  addIntake(db, "nongoogle", "Mixed Show", { sourceType: "slack" });
  assert.equal(sanitizedGoogleWorkspaceMatchingPreview(db).cohort.total, 1, "mixed cohorts include only Google Workspace evidence");
}

{
  const db = fixture();
  addShow(db, "show-a", "Bounded Show");
  for (let index = 0; index < 1200; index += 1) addIntake(db, `item-${index}`, index % 2 ? "no signal" : "Bounded Show");
  assert.equal(sanitizedGoogleWorkspaceMatchingPreview(db, { maxItems: 1200 }).cohort.total, 1200);
  assert.throws(() => sanitizedGoogleWorkspaceMatchingPreview(db, { maxItems: 1199 }), /preview_bound_exceeded/);
}

{
  const db = fixture();
  addShow(db, "secret-show-id", "Highly Secret Show Alias");
  addIntake(db, "secret-intake-id", "Highly Secret Show Alias private source text", {
    source: { externalId: "secret-provider-id", sourceUrl: "https://forbidden.invalid/private" },
  });
  const serialized = JSON.stringify(sanitizedGoogleWorkspaceMatchingPreview(db));
  for (const prohibited of ["secret-show-id", "secret-intake-id", "Highly Secret", "private source text", "secret-provider-id", "forbidden.invalid"]) {
    assert.equal(serialized.includes(prohibited), false, `sanitized aggregate excludes ${prohibited}`);
  }
  for (const prohibitedKey of ["name", "alias", "externalId", "sourceUrl", "query", "cursor", "token", "rawScore"]) {
    assert.equal(new RegExp(`\\"${prohibitedKey}\\"`, "i").test(serialized), false, `sanitized aggregate excludes ${prohibitedKey}`);
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network method invoked"); };
  const db = fixture();
  Object.defineProperty(db, "save", { enumerable: false, value: () => { throw new Error("persistence method invoked"); } });
  assert.doesNotThrow(() => sanitizedGoogleWorkspaceMatchingPreview(db));
  globalThis.fetch = originalFetch;
}

{
  const directory = await mkdtemp(path.join(os.tmpdir(), "cue-gw-match-preview-"));
  try {
    const datastorePath = path.join(directory, "fixture.json");
    const db = fixture();
    addShow(db, "show-a", "CLI Fixture Show");
    addIntake(db, "cli-item", "CLI Fixture Show");
    await writeFile(datastorePath, JSON.stringify(db));
    const result = await runGoogleWorkspaceMatchingPreview({ datastorePath });
    assert.equal(result.ok, true);
    assert.equal(result.checksumBefore, result.checksumAfter);
    assert.equal(result.datastoreUnchanged, true);
    assert.equal(result.collectionCountsUnchanged, true);
    assert.equal(result.cursorContinuationProposalStateUnchanged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log("google-workspace-intake-matching tests passed");
