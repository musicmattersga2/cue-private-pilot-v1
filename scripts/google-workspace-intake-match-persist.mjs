import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCueFoundationStore } from "../cue-foundation-store.mjs";
import { buildGoogleWorkspaceMatchingPreview, GOOGLE_WORKSPACE_MATCHER_VERSION } from "../google-workspace-intake-matching.mjs";

function checksum(bytes) { return createHash("sha256").update(bytes).digest("hex").toUpperCase(); }
function counts(db) {
  return Object.fromEntries(Object.entries(db).filter(([, value]) => value && typeof value === "object")
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : Object.keys(value).length]));
}
function protectedState(db) {
  return JSON.stringify({
    connectorRuns: db.connectorRuns || {}, connectorCursors: db.connectorCursors || {}, connectorState: db.connectorState || {},
    connectorContinuations: db.connectorContinuations || {}, sourceRecords: db.sourceRecords || {}, intakeItems: db.intakeItems || {},
    proposedUpdates: db.proposedUpdates || {}, decisionCards: db.decisionCards || {}, decisions: db.decisions || {},
    events: db.events || {}, showState: db.showState || {}, readiness: db.readiness || {}, learnedAliases: db.learnedAliases || {},
    learnedFlexLinks: db.learnedFlexLinks || {}, showRegistry: db.showRegistry || {}, flexDocumentRegistry: db.flexDocumentRegistry || {},
  });
}

export function parsePersistArguments(argv) {
  const result = { minimumConfidence: "medium", apply: false };
  const valued = new Set(["--source", "--expected-sha256", "--minimum-confidence", "--datastore"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--apply") {
      if (seen.has(option)) throw new Error("duplicate_option");
      seen.add(option); result.apply = true; continue;
    }
    if (!valued.has(option) || seen.has(option) || index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new Error("invalid_option");
    seen.add(option); const value = argv[++index];
    if (option === "--source") result.provider = value;
    if (option === "--expected-sha256") result.expectedSha256 = value;
    if (option === "--minimum-confidence") result.minimumConfidence = value;
    if (option === "--datastore") result.datastorePath = value;
  }
  if (!result.provider || !result.expectedSha256) throw new Error("required_option_missing");
  if (!new Set(["drive", "gmail"]).has(result.provider)) throw new Error("invalid_provider");
  if (!new Set(["low", "medium", "high"]).has(result.minimumConfidence)) throw new Error("invalid_confidence_threshold");
  if (!/^[A-Fa-f0-9]{64}$/.test(result.expectedSha256)) throw new Error("invalid_expected_checksum");
  return result;
}

export async function runGoogleWorkspaceMatchPersistence(options) {
  const datastorePath = path.resolve(options.datastorePath || path.join(process.cwd(), "data", "cue-foundation-v1.json"));
  const beforeBytes = await readFile(datastorePath);
  const beforeHash = checksum(beforeBytes);
  const before = JSON.parse(beforeBytes.toString("utf8"));
  const beforeCounts = counts(before);
  const beforeProtected = protectedState(before);
  const preview = buildGoogleWorkspaceMatchingPreview(before);
  const candidates = preview.privateProjection.candidates.filter(candidate => candidate.provider === options.provider);
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const projection = {
    candidates,
    facts: preview.privateProjection.facts.filter(fact => candidateIds.has(fact.candidateId)),
  };
  const store = createCueFoundationStore({ filePath: datastorePath });
  const result = await store.persistGoogleWorkspaceReviewCandidates({
    provider: options.provider,
    expectedSha256: options.expectedSha256,
    matcherVersion: GOOGLE_WORKSPACE_MATCHER_VERSION,
    minimumConfidence: options.minimumConfidence || "medium",
    apply: options.apply === true,
    projection,
  });
  const afterBytes = await readFile(datastorePath);
  const afterHash = checksum(afterBytes);
  const after = JSON.parse(afterBytes.toString("utf8"));
  const dryRunUnchanged = options.apply === true || beforeHash === afterHash;
  if (!dryRunUnchanged) throw new Error("dry_run_changed_datastore");
  const protectedCollectionsUnchanged = beforeProtected === protectedState(after);
  if (!protectedCollectionsUnchanged) throw new Error("persistence_boundary_violation");
  return {
    ok: true,
    mode: options.apply === true ? "apply" : "dry_run",
    ...result,
    checksumBefore: beforeHash,
    checksumAfter: afterHash,
    checksumUnchanged: beforeHash === afterHash,
    collectionCountsUnchanged: JSON.stringify(beforeCounts) === JSON.stringify(counts(after)),
    protectedCollectionsUnchanged,
    externalProviderRequests: 0,
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const options = parsePersistArguments(process.argv.slice(2));
    const result = await runGoogleWorkspaceMatchPersistence(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || "persistence_failed") })}\n`);
    process.exitCode = 1;
  }
}
