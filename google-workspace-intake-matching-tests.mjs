import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildGoogleWorkspaceMatchingPreview, sanitizedGoogleWorkspaceMatchingPreview } from "./google-workspace-intake-matching.mjs";
import { runGoogleWorkspaceMatchingPreview } from "./scripts/google-workspace-intake-match-preview.mjs";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";
import { parsePersistArguments, runGoogleWorkspaceMatchPersistence } from "./scripts/google-workspace-intake-match-persist.mjs";

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

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex").toUpperCase(); }

async function persistenceFixture(test) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cue-gw-match-persist-"));
  const datastorePath = path.join(directory, "fixture.json");
  const db = fixture();
  Object.assign(db, {
    version: 1,
    connectorRuns: {}, connectorState: {}, proposedUpdates: {}, decisionCards: {}, decisions: {}, events: {},
    showState: {}, readiness: {}, learnedAliases: {}, learnedFlexLinks: {}, showIdRedirects: {},
    flexQuoteStatusObservations: {},
  });
  try { await test({ db, datastorePath }); } finally { await rm(directory, { recursive: true, force: true }); }
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

await persistenceFixture(async ({ db, datastorePath }) => {
  addShow(db, "show-medium", "Medium Signal");
  addShow(db, "show-low", "Low Signal");
  addShow(db, "show-high", "High Signal");
  addShow(db, "show-gmail", "Gmail Signal");
  addIntake(db, "drive-medium", "Medium Signal with substantial extracted production evidence for a bounded review", { name: "brief" });
  addIntake(db, "drive-low", "File: Low Signal", { name: "Low Signal", mimeType: "image/png" });
  addIntake(db, "drive-high", "reference evidence", { intake: { canonicalShowId: "show-high" } });
  addIntake(db, "gmail-medium", "Gmail Signal with substantial extracted production evidence for a bounded review", { sourceType: "email", name: "message" });
  db.matchCandidates.slack = { id: "slack", matcherVersion: "slack-match-v1", provider: "slack", selected: true };
  db.matchCandidates.manual = { id: "manual", selected: true };
  db.matchCandidates.foreign = { id: "foreign", matcherVersion: "future-version", provider: "drive" };
  db.candidateFacts.slackFact = { id: "slackFact", matcherVersion: "slack-match-v1", provider: "slack" };
  db.matchCandidates.staleOwned = { id: "staleOwned", matcherVersion: "google-workspace-review-preview-v1", provider: "drive", reviewOnly: true };
  db.candidateFacts.staleOwnedFact = { id: "staleOwnedFact", matcherVersion: "google-workspace-review-preview-v1", provider: "drive", reviewOnly: true };
  await writeFile(datastorePath, JSON.stringify(db));
  const originalBytes = await readFile(datastorePath);
  const originalHash = hashBytes(originalBytes);
  const original = JSON.parse(originalBytes);
  const originalProtected = Object.fromEntries(Object.entries(original).filter(([key]) => !["matchCandidates", "candidateFacts", "updatedAt"].includes(key)));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network method invoked"); };
  try {
    const dry = await runGoogleWorkspaceMatchPersistence({ provider: "drive", expectedSha256: originalHash, datastorePath });
    assert.equal(dry.mode, "dry_run");
    assert.equal(dry.projected, 2, "medium and future high-confidence Drive candidates are eligible");
    assert.equal(dry.excluded, 1, "low-confidence Drive candidates remain preview-only");
    assert.equal(dry.mutationPerformed, false);
    assert.equal(hashBytes(await readFile(datastorePath)), originalHash, "dry-run never writes");

    const applied = await runGoogleWorkspaceMatchPersistence({ provider: "drive", expectedSha256: originalHash, datastorePath, apply: true });
    assert.equal(applied.projected, 2);
    assert.equal(applied.created, 2);
    assert.equal(applied.retired, 1);
    assert.equal(applied.mutationPerformed, true);
    const appliedBytes = await readFile(datastorePath);
    const appliedDb = JSON.parse(appliedBytes);
    const ownedCandidates = Object.values(appliedDb.matchCandidates).filter(item => item.matcherVersion === "google-workspace-review-preview-v1" && item.provider === "drive");
    assert.equal(ownedCandidates.length, 2);
    assert(ownedCandidates.every(item => item.reviewOnly === true && item.selected === false));
    assert(ownedCandidates.every(item => ["medium", "high"].includes(item.confidence)));
    assert.equal(appliedDb.matchCandidates.slack.id, "slack");
    assert.equal(appliedDb.matchCandidates.manual.id, "manual");
    assert.equal(appliedDb.matchCandidates.foreign.id, "foreign");
    assert.equal(appliedDb.candidateFacts.slackFact.id, "slackFact");
    assert.equal(appliedDb.matchCandidates.staleOwned, undefined);
    assert.equal(appliedDb.candidateFacts.staleOwnedFact, undefined);
    assert.deepEqual(Object.fromEntries(Object.entries(appliedDb).filter(([key]) => !["matchCandidates", "candidateFacts", "updatedAt"].includes(key))), originalProtected,
      "only candidate and candidate-fact collections change");
    const persisted = JSON.stringify({ candidates: ownedCandidates, facts: Object.values(appliedDb.candidateFacts).filter(item => item.provider === "drive") });
    for (const prohibited of ["rawScore", "name", "alias", "filename", "folderName", "owner", "email", "description", "extractedText", "summary", "url", "query", "cursor", "token", "providerPayload"]) {
      assert.equal(new RegExp(`\\"${prohibited}\\"`, "i").test(persisted), false, `persisted review records omit ${prohibited}`);
    }
    assert.equal(persisted.includes("substantial extracted production evidence"), false);
    const appliedHash = hashBytes(appliedBytes);
    const second = await runGoogleWorkspaceMatchPersistence({ provider: "drive", expectedSha256: appliedHash, datastorePath, apply: true });
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 2);
    assert.equal(second.retired, 0);
    assert.equal(second.mutationPerformed, false);
    assert.equal(hashBytes(await readFile(datastorePath)), appliedHash, "idempotent apply is byte-identical and performs no write");

    const gmail = await runGoogleWorkspaceMatchPersistence({ provider: "gmail", expectedSha256: appliedHash, datastorePath });
    assert.equal(gmail.projected, 1, "provider selection isolates Gmail from Drive");
    assert.equal(gmail.mutationPerformed, false);
  } finally { globalThis.fetch = originalFetch; }
});

await persistenceFixture(async ({ db, datastorePath }) => {
  addShow(db, "registered", "Registered Show");
  addIntake(db, "candidate", "Registered Show with substantial extracted evidence for review", { name: "brief" });
  await writeFile(datastorePath, JSON.stringify(db));
  const bytes = await readFile(datastorePath);
  const expectedSha256 = hashBytes(bytes);
  const preview = buildGoogleWorkspaceMatchingPreview(JSON.parse(bytes));
  const store = createCueFoundationStore({ filePath: datastorePath });
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256: "0".repeat(64), matcherVersion: preview.report.matcherVersion, projection: preview.privateProjection }), /stale_datastore_checksum/);
  assert.equal(hashBytes(await readFile(datastorePath)), expectedSha256);
  const malformed = structuredClone(preview.privateProjection);
  malformed.candidates[0].showName = "prohibited";
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256, matcherVersion: preview.report.matcherVersion, projection: malformed }), /malformed_projection/);
  const collided = structuredClone(preview.privateProjection);
  collided.candidates.push(structuredClone(collided.candidates[0]));
  collided.facts.push(...structuredClone(collided.candidates[0].facts));
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256, matcherVersion: preview.report.matcherVersion, projection: collided }), /identity_collision/);
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256, matcherVersion: "unsupported", projection: preview.privateProjection }), /unsupported_matcher_version/);
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "all", expectedSha256, matcherVersion: preview.report.matcherVersion, projection: preview.privateProjection }), /invalid_provider/);
  assert.equal(hashBytes(await readFile(datastorePath)), expectedSha256, "failed validation leaves fixture unchanged");

  const changed = JSON.parse(bytes);
  changed.intakeItems.candidate.matchedShowId = "registered";
  await writeFile(datastorePath, JSON.stringify(changed));
  const changedHash = hashBytes(await readFile(datastorePath));
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256: changedHash, matcherVersion: preview.report.matcherVersion, projection: preview.privateProjection }), /changed_projection_eligibility/);
  assert.equal(hashBytes(await readFile(datastorePath)), changedHash);

  for (const mutate of [
    value => { value.intakeItems.candidate.status = "superseded"; },
    value => { value.sourceRecords["source-candidate"].sourceType = "email"; },
    value => { delete value.showRegistry.registered; },
  ]) {
    const variant = JSON.parse(bytes);
    mutate(variant);
    await writeFile(datastorePath, JSON.stringify(variant));
    const variantHash = hashBytes(await readFile(datastorePath));
    await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256: variantHash, matcherVersion: preview.report.matcherVersion, projection: preview.privateProjection }), /changed_projection_eligibility/);
    assert.equal(hashBytes(await readFile(datastorePath)), variantHash);
  }

  const foreignCollision = JSON.parse(bytes);
  foreignCollision.matchCandidates[preview.privateProjection.candidates[0].id] = { id: preview.privateProjection.candidates[0].id, matcherVersion: "manual", provider: "drive" };
  await writeFile(datastorePath, JSON.stringify(foreignCollision));
  const collisionHash = hashBytes(await readFile(datastorePath));
  await assert.rejects(() => store.persistGoogleWorkspaceReviewCandidates({ provider: "drive", expectedSha256: collisionHash, matcherVersion: preview.report.matcherVersion, projection: preview.privateProjection }), /identity_collision/);
  assert.equal(hashBytes(await readFile(datastorePath)), collisionHash);
});

await persistenceFixture(async ({ db, datastorePath }) => {
  addShow(db, "locked-show", "Locked Show");
  addIntake(db, "locked-item", "Locked Show with substantial extracted production evidence for serialized persistence", { name: "brief" });
  await writeFile(datastorePath, JSON.stringify(db));
  const bytes = await readFile(datastorePath);
  const expectedSha256 = hashBytes(bytes);
  const preview = buildGoogleWorkspaceMatchingPreview(JSON.parse(bytes));
  const store = createCueFoundationStore({ filePath: datastorePath });
  const calls = [1, 2].map(() => store.persistGoogleWorkspaceReviewCandidates({
    provider: "drive", expectedSha256, matcherVersion: preview.report.matcherVersion,
    minimumConfidence: "medium", apply: true, projection: preview.privateProjection,
  }));
  const outcomes = await Promise.allSettled(calls);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected" && /stale_datastore_checksum/.test(item.reason?.message)).length, 1,
    "the expected checksum is rechecked after acquiring the serialized write lock");
});

{
  const hash = "A".repeat(64);
  assert.deepEqual(parsePersistArguments(["--source", "drive", "--expected-sha256", hash]), {
    minimumConfidence: "medium", apply: false, provider: "drive", expectedSha256: hash,
  });
  assert.equal(parsePersistArguments(["--source", "gmail", "--expected-sha256", hash, "--apply"]).apply, true);
  assert.throws(() => parsePersistArguments(["--source", "drive", "--expected-sha256", hash, "--unknown"]), /invalid_option/);
  assert.throws(() => parsePersistArguments(["--source", "drive", "--source", "gmail", "--expected-sha256", hash]), /invalid_option/);
  assert.throws(() => parsePersistArguments(["--expected-sha256", hash]), /required_option_missing/);
  assert.throws(() => parsePersistArguments(["--source", "all", "--expected-sha256", hash]), /invalid_provider/);
}

console.log("google-workspace-intake-matching tests passed");
