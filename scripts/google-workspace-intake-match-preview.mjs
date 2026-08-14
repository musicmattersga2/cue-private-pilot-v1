import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedGoogleWorkspaceMatchingPreview } from "../google-workspace-intake-matching.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}
function collectionCounts(db) {
  const result = {};
  for (const [key, value] of Object.entries(db)) {
    if (Array.isArray(value)) result[key] = value.length;
    else if (value && typeof value === "object") result[key] = Object.keys(value).length;
  }
  return result;
}

function stateFingerprint(db) {
  return createHash("sha256").update(JSON.stringify({
    connectorCursors: db.connectorCursors || null,
    connectorContinuations: db.connectorContinuations || null,
    proposedUpdates: db.proposedUpdates || null,
  })).digest("hex");
}

async function readOnly(pathname) {
  const handle = await open(pathname, "r");
  try { return await handle.readFile(); } finally { await handle.close(); }
}

export async function runGoogleWorkspaceMatchingPreview({ datastorePath } = {}) {
  const target = path.resolve(datastorePath || path.join(process.cwd(), "data", "cue-foundation-v1.json"));
  const beforeBytes = await readOnly(target);
  const beforeHash = sha256(beforeBytes);
  const before = JSON.parse(beforeBytes.toString("utf8"));
  const beforeCounts = collectionCounts(before);
  const beforeState = stateFingerprint(before);
  const preview = sanitizedGoogleWorkspaceMatchingPreview(before);
  const afterBytes = await readOnly(target);
  const afterHash = sha256(afterBytes);
  const after = JSON.parse(afterBytes.toString("utf8"));
  const unchanged = beforeHash === afterHash;
  const countsUnchanged = JSON.stringify(beforeCounts) === JSON.stringify(collectionCounts(after));
  const stateUnchanged = beforeState === stateFingerprint(after);
  if (!unchanged || !countsUnchanged || !stateUnchanged) throw new Error("datastore_changed_during_preview");
  return {
    ok: true,
    checksumBefore: beforeHash,
    checksumAfter: afterHash,
    datastoreUnchanged: unchanged,
    collectionCountsUnchanged: countsUnchanged,
    cursorContinuationProposalStateUnchanged: stateUnchanged,
    ...preview,
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const argument = process.argv.indexOf("--datastore");
  const datastorePath = argument >= 0 ? process.argv[argument + 1] : undefined;
  runGoogleWorkspaceMatchingPreview({ datastorePath })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || "preview_failed") })}\n`);
      process.exitCode = 1;
    });
}
