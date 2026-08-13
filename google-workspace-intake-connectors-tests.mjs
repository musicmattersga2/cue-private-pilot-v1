import assert from "node:assert/strict";
import {
  createGoogleWorkspaceIntakeConnectors,
  readGoogleWorkspaceConfig,
} from "./google-workspace-intake-connectors.mjs";

const CURSOR = "2026-07-18T09:30:00.000Z";
const SECRET_MARKERS = [
  "client-do-not-leak",
  "secret-do-not-leak",
  "refresh-do-not-leak",
  "access-token-do-not-leak",
  "folder-id-do-not-leak",
  "file-id-do-not-leak",
  "file-name-do-not-leak",
  "query-do-not-leak",
  "provider-payload-do-not-leak",
];

const baseEnv = {
  CUE_GOOGLE_WORKSPACE_ENABLED: "true",
  CUE_GMAIL_ENABLED: "false",
  CUE_DRIVE_ENABLED: "true",
  CUE_GOOGLE_OAUTH_CLIENT_ID: SECRET_MARKERS[0],
  CUE_GOOGLE_OAUTH_CLIENT_SECRET: SECRET_MARKERS[1],
  CUE_GOOGLE_OAUTH_REFRESH_TOKEN: SECRET_MARKERS[2],
  CUE_DRIVE_FOLDER_IDS: SECRET_MARKERS[4],
  CUE_DRIVE_RECURSIVE: "true",
  CUE_DRIVE_MAX_FOLDER_DEPTH: "8",
  CUE_DRIVE_MAX_FOLDERS: "500",
  CUE_DRIVE_MAX_FILES: "100",
  CUE_GOOGLE_CURSOR_OVERLAP_SECONDS: "60",
};

const json = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
const failure = (status, payload = SECRET_MARKERS[8]) => ({
  ok: false,
  status,
  json: async () => ({ error: payload }),
  text: async () => payload,
});
const isTokenRequest = url => url.includes("oauth2.googleapis.com/token");
const driveQueryFrom = url => new URL(url).searchParams.get("q") || "";
const isFolderListing = url => driveQueryFrom(url).includes("mimeType = 'application/vnd.google-apps.folder'");
const diagnosticsOf = result => ({
  reason: result.reason,
  errors: result.errors,
  skippedFiles: result.skippedFiles,
  metadata: result.metadata,
});
function assertCursorHeld(result, label) {
  assert.equal(result.cursorAfter, CURSOR, `${label} must not advance the Drive cursor`);
}
function assertSecretSafe(result, label) {
  const serialized = JSON.stringify(diagnosticsOf(result));
  for (const marker of SECRET_MARKERS) assert.doesNotMatch(serialized, new RegExp(marker), `${label} leaked protected diagnostics`);
  assert.doesNotMatch(serialized, /(?:access|refresh)[_-]?token|authorization|bearer|parents|modifiedTime\s*>/i, `${label} serialized a credential, identifier, or query`);
}
function driveConnector(fetch, envOverrides = {}, options = {}) {
  return createGoogleWorkspaceIntakeConnectors({ env: { ...baseEnv, ...envOverrides }, fetch, ...options });
}

const privateContinuation = result => result[Symbol.for("cue.googleWorkspace.driveContinuation")]?.continuation || null;
const fixtureFile = (id, modifiedTime = "2026-08-13T12:00:00.000Z") => ({
  id,
  name: `fixture-${id}.txt`,
  mimeType: "text/plain",
  modifiedTime,
  version: "1",
});

const DRIVE_PROVIDER_ORDER = "modifiedTime asc";
const DRIVE_SUPPORTED_ORDER_KEYS = new Set([
  "createdTime", "folder", "modifiedByMeTime", "modifiedTime", "name", "name_natural",
  "quotaBytesUsed", "recency", "sharedWithMeTime", "starred", "viewedByMeTime",
]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function assertSupportedDriveOrdering(orderBy) {
  const terms = String(orderBy || "").split(",").map(term => term.trim()).filter(Boolean);
  assert.ok(terms.length > 0, "provider ordering contains at least one key");
  for (const term of terms) {
    const match = term.match(/^(\S+)(?:\s+(asc|desc))?$/);
    assert.ok(match, "provider ordering uses a key with an optional supported direction");
    assert.ok(DRIVE_SUPPORTED_ORDER_KEYS.has(match[1]), `provider ordering key ${match[1]} is documented by Drive`);
  }
}
function assertProductionDriveOrdering(orderBy) {
  assertSupportedDriveOrdering(orderBy);
  assert.equal(orderBy, DRIVE_PROVIDER_ORDER, "production provider ordering remains modification-time ascending only");
  assert.doesNotMatch(orderBy, /\bid\b/i, "private identifiers must remain local ordering tie-breakers");
}
function assertBalancedDriveQuery(query) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of query) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    assert.ok(depth >= 0, "Drive query closes a group before it opens one");
  }
  assert.equal(quoted, false, "Drive query has an unterminated quoted literal");
  assert.equal(escaped, false, "Drive query has an unterminated escape");
  assert.equal(depth, 0, "Drive query grouping is balanced");
}
function assertSupportedDriveFileListRequest(input, options = {}) {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") || "";
  const orderBy = url.searchParams.get("orderBy");
  assertProductionDriveOrdering(orderBy);
  assertBalancedDriveQuery(query);
  const operators = [...query.matchAll(/\s(!=|<=|>=|=|<|>)\s/g)].map(match => match[1]);
  assert.ok(operators.length > 0, "Drive query contains recognized comparison operators");
  assert.ok(operators.every(operator => ["=", "!=", "<", "<=", ">", ">="].includes(operator)), "Drive query uses only allowed comparison operators");
  const timeLiterals = [...query.matchAll(/modifiedTime\s(?:>|<=)\s'([^']+)'/g)].map(match => match[1]);
  assert.equal(timeLiterals.length, options.expectedTimeBounds ?? 2, "file query has the expected fixed time bounds");
  assert.ok(timeLiterals.every(value => RFC3339.test(value) && !Number.isNaN(Date.parse(value))), "time bounds are canonical RFC 3339 values");
  assert.match(query, /\([^()]+' in parents(?: or '[^()]+' in parents)*\)/, "parent alternatives remain grouped");
  assert.ok((query.match(/ in parents/g) || []).length <= 20, "a file query contains no more than 20 parents");
  assert.ok(Number(url.searchParams.get("pageSize")) <= Number(options.remainingCapacity ?? 100), "page size does not exceed remaining global capacity");
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  for (const unintended of ["corpora", "driveId", "spaces"]) assert.equal(url.searchParams.has(unintended), false, `${unintended} is not added implicitly`);
  if (options.privateFileId) {
    assert.doesNotMatch(query, new RegExp(options.privateFileId), "private file identifiers never enter the query");
    assert.doesNotMatch(orderBy, new RegExp(options.privateFileId), "private file identifiers never enter provider ordering");
  }
  return { query, orderBy };
}

const invalid = readGoogleWorkspaceConfig({
  CUE_GOOGLE_WORKSPACE_ENABLED: "true",
  CUE_GMAIL_ENABLED: "true",
  CUE_DRIVE_ENABLED: "true",
  CUE_GOOGLE_OAUTH_CLIENT_ID: "configured-client",
  CUE_GOOGLE_OAUTH_CLIENT_SECRET: "configured-secret",
  CUE_GOOGLE_OAUTH_REFRESH_TOKEN: "configured-refresh",
});
assert.equal(invalid.configured, false);
assert.equal(invalid.errors.length, 2, "both live sources require bounded retrieval constraints");

// Strictly validate the generated file-list request without trusting a permissive fetch mock.
{
  const privateFileId = "private-local-tie-break-id";
  let fileListUrl = null;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("?alt=media")) return { ok: true, status: 200, text: async () => "fixture", json: async () => ({}) };
    fileListUrl = url;
    return json({ files: [fixtureFile(privateFileId)] });
  };
  const connector = driveConnector(fetch, {
    CUE_DRIVE_FOLDER_IDS: "parent'quoted",
    CUE_DRIVE_RECURSIVE: "false",
    CUE_DRIVE_MAX_FILES: "100",
  }, { now: () => "2026-08-13T12:30:00.000Z" });
  const result = await connector.pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "completed");
  assert.equal(result.completionDisposition, "completed");
  const validated = assertSupportedDriveFileListRequest(fileListUrl, { remainingCapacity: 100, privateFileId });
  assert.match(validated.query, /parent\\'quoted/, "quoted parent literals are escaped without breaking query grammar");
  const fields = new URL(fileListUrl).searchParams.get("fields") || "";
  for (const requiredField of ["id", "name", "mimeType", "modifiedTime", "parents"]) assert.match(fields, new RegExp(`\\b${requiredField}\\b`));

  const documentedSecondary = new URL(fileListUrl);
  documentedSecondary.searchParams.set("orderBy", "modifiedTime asc,name_natural asc");
  assert.doesNotThrow(
    () => assertSupportedDriveOrdering(documentedSecondary.searchParams.get("orderBy")),
    "Drive documents name_natural as a supported provider ordering key",
  );
  assert.throws(
    () => assertProductionDriveOrdering(documentedSecondary.searchParams.get("orderBy")),
    /production provider ordering remains modification-time ascending only/,
    "official provider support is validated separately from the narrower production ordering contract",
  );
}

// A cursorless sweep keeps its epoch sentinel private and resumes without serializing it.
{
  const upperBound = "2026-08-13T12:45:00.000Z";
  let failInitialRequest = true;
  const fileListUrls = [];
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    fileListUrls.push(url);
    return failInitialRequest ? failure(400) : json({ files: [] });
  };
  const connector = driveConnector(fetch, {
    CUE_DRIVE_RECURSIVE: "false",
    CUE_DRIVE_QUERY: "mimeType = 'text/plain'",
  }, { now: () => upperBound });

  const failed = await connector.pullDrive({ cursorBefore: null });
  const checkpoint = privateContinuation(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.cursorBefore, null);
  assert.equal(failed.cursorAfter, null, "a cursorless initial-list failure cannot create a durable cursor");
  assert.ok(checkpoint, "the cursorless failure retains a retry-safe private continuation");
  assert.equal(checkpoint.originalCursor, null);
  assert.equal(checkpoint.lowerBound, "1969-12-31T23:59:00.000Z", "the existing overlap-adjusted epoch sentinel remains private state");
  assert.equal(checkpoint.upperBound, upperBound);
  assert.equal(checkpoint.batchIndex, 0);
  assert.equal(checkpoint.pageToken, null);
  const checkpointBeforeResume = JSON.stringify(checkpoint);
  const failedRequest = assertSupportedDriveFileListRequest(fileListUrls[0], {
    remainingCapacity: 100,
    expectedTimeBounds: 1,
  });
  assert.doesNotMatch(failedRequest.query, /modifiedTime\s*>/, "cursorless requests omit the epoch lower-bound predicate");
  assert.match(failedRequest.query, new RegExp(`modifiedTime <= '${upperBound}'`), "cursorless requests retain the fixed upper bound");
  assertSecretSafe(failed, "cursorless initial-list failure");

  failInitialRequest = false;
  const resumed = await connector.pullDrive({ cursorBefore: null, continuation: checkpoint });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.metadata.continuationDiagnostic, null, "the existing epoch-sentinel continuation remains compatible");
  assert.equal(resumed.cursorBefore, null);
  assert.equal(resumed.cursorAfter, upperBound, "the durable cursor appears only after the full resumed sweep completes");
  assert.equal(privateContinuation(resumed), null);
  assert.equal(JSON.stringify(checkpoint), checkpointBeforeResume, "resuming does not mutate the saved fingerprint, bounds, inventory, or position");
  const resumedRequest = assertSupportedDriveFileListRequest(fileListUrls[1], {
    remainingCapacity: 100,
    expectedTimeBounds: 1,
  });
  assert.doesNotMatch(resumedRequest.query, /modifiedTime\s*>/, "the compatible retry still omits the private epoch sentinel");
  assert.match(resumedRequest.query, new RegExp(`modifiedTime <= '${upperBound}'`), "the compatible retry reuses the original fixed upper bound");
}

// Existing mixed Gmail/Drive fixture behavior remains intact and offline.
{
  const calls = [];
  const env = {
    ...baseEnv,
    CUE_GMAIL_ENABLED: "true",
    CUE_GMAIL_QUERY: "label:CUE newer_than:30d",
    CUE_GMAIL_MAX_MESSAGES: "2",
    CUE_DRIVE_MAX_FOLDER_DEPTH: "4",
    CUE_DRIVE_MAX_FOLDERS: "20",
    CUE_DRIVE_MAX_FILES: "3",
  };
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (url.endsWith("/messages/m1?format=full")) return json({
      id: "m1", threadId: "t1", historyId: "10", internalDate: "1784304000000", snippet: "fixture snippet",
      labelIds: ["CUE"], payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "fixture subject" }], body: { data: Buffer.from("fixture body").toString("base64url") } },
    });
    if (url.endsWith("/messages/m2?format=full")) return failure(503);
    if (url.includes("www.googleapis.com/drive/v3/files?")) {
      const query = driveQueryFrom(url);
      if (isFolderListing(url) && query.includes(`'${SECRET_MARKERS[4]}' in parents`)) {
        return json({ files: [{ id: "nested-folder", mimeType: "application/vnd.google-apps.folder", parents: [SECRET_MARKERS[4]] }] });
      }
      if (isFolderListing(url)) return json({ files: [] });
      return json({ files: [
        { id: "text-file", name: "fixture.txt", mimeType: "text/plain", modifiedTime: "2026-07-18T10:00:00.000Z", version: "1" },
        { id: "binary-file", name: "fixture.pdf", mimeType: "application/pdf", modifiedTime: "2026-07-18T10:01:00.000Z", version: "2" },
      ] });
    }
    if (url.includes("/drive/v3/files/text-file?alt=media")) return { ok: true, status: 200, text: async () => "fixture text", json: async () => ({}) };
    throw new Error("Unexpected fixture request");
  };

  const connectors = createGoogleWorkspaceIntakeConnectors({ env, fetch });
  const gmail = await connectors.pullGmail({ cursorBefore: "2026-07-18T09:00:00.000Z" });
  assert.equal(gmail.status, "partial");
  assert.equal(gmail.messages.length, 1);
  assert.equal(gmail.errors.length, 1);
  assert.equal(gmail.messages[0].textPlain, "fixture body");
  const gmailList = calls.find(call => call.url.includes("gmail.googleapis.com") && call.url.includes("/messages?"));
  assert.match(driveQueryFrom(gmailList.url), /after:1784365140/, "Gmail cursor overlaps by one minute");

  const drive = await connectors.pullDrive({ cursorBefore: CURSOR });
  assert.equal(drive.status, "completed");
  assert.equal(drive.completionDisposition, "completed_with_skips");
  assert.equal(drive.files.length, 2, "unsupported binary files still contribute safe metadata");
  assert.equal(drive.skippedFiles.length, 1);
  assert.notEqual(drive.cursorAfter, CURSOR, "completed metadata-only handling advances the durable cursor");
  assert.equal(privateContinuation(drive), null, "completed metadata-only handling clears private continuation state");
  assert.equal(drive.files[0].extractedText, "fixture text");
  const driveLists = calls.filter(call => call.url.includes("drive/v3/files?"));
  const driveList = driveLists.find(call => !isFolderListing(call.url));
  assert.match(driveQueryFrom(driveList.url), new RegExp(`'${SECRET_MARKERS[4]}' in parents`));
  assert.match(driveQueryFrom(driveList.url), /'nested-folder' in parents/, "recursive roots include discovered folders");
  assert.match(driveQueryFrom(driveList.url), /mimeType != 'application\/vnd\.google-apps\.folder'/, "folder metadata does not consume the file limit");
  assert.match(driveQueryFrom(driveList.url), /modifiedTime > '2026-07-18T09:29:00.000Z'/);
  assert.equal(drive.metadata.recursive, true);
  assertSecretSafe(gmail, "Gmail failure");
  assertSecretSafe(drive, "Drive skip");
}

// A 500-folder cap with additional pagination fails closed before any file listing.
{
  let fileListings = 0;
  const folders = Array.from({ length: 499 }, (_, index) => ({
    id: `folder-${index}`,
    mimeType: "application/vnd.google-apps.folder",
    parents: [SECRET_MARKERS[4]],
  }));
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (isFolderListing(url)) return json({ files: folders, nextPageToken: "more-folders-exist" });
    fileListings += 1;
    return json({ files: [] });
  };
  const result = await driveConnector(fetch).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "incomplete_folder_traversal");
  assert.equal(result.completionDisposition, "failed");
  assert.deepEqual(result.errors, [{ reason: "incomplete_folder_traversal", operation: "folder_listing" }]);
  assert.equal(fileListings, 0, "file listing must not start after incomplete traversal");
  assertCursorHeld(result, "folder limit");
  assertSecretSafe(result, "folder limit");
}

// Exactly 500 known folders with no remaining frontier is complete, not a false limit failure.
{
  let fileListings = 0;
  const folders = Array.from({ length: 499 }, (_, index) => ({
    id: `terminal-${index}`,
    mimeType: "application/vnd.google-apps.folder",
    parents: [SECRET_MARKERS[4]],
  }));
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (isFolderListing(url)) return json({ files: folders });
    fileListings += 1;
    return json({ files: [] });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_MAX_FOLDER_DEPTH: "1" }).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "completed");
  assert.equal(result.completionDisposition, "completed");
  assert.equal(result.metadata.folderCount, 500);
  assert.equal(result.metadata.folderTraversalComplete, true);
  assert.ok(fileListings > 0, "file listing starts only after complete traversal");
  assert.notEqual(result.cursorAfter, CURSOR, "a successful zero-result Drive pull may advance its cursor");
}

// Folder listing request failures are incomplete traversal and fail before file listing.
{
  let fileListings = 0;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (isFolderListing(url)) return failure(503);
    fileListings += 1;
    return json({ files: [] });
  };
  const result = await driveConnector(fetch).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "failed");
  assert.equal(result.completionDisposition, "failed");
  assert.equal(result.reason, "incomplete_folder_traversal");
  assert.deepEqual(result.errors, [{ reason: "request_failed", operation: "folder_listing", httpStatus: 503 }]);
  assert.equal(fileListings, 0);
  assertCursorHeld(result, "folder listing failure");
  assertSecretSafe(result, "folder listing failure");
}

// Initial and paginated file-list requests are classified separately.
for (const pagination of [false, true]) {
  let fileListPage = 0;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (isFolderListing(url)) throw new Error("recursive traversal should be disabled");
    fileListPage += 1;
    if (pagination && fileListPage === 1) return json({ files: [], nextPageToken: "opaque-page-token" });
    return failure(pagination ? 504 : 502);
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "failed");
  assert.equal(result.completionDisposition, "failed");
  assert.deepEqual(result.errors, [{
    reason: "request_failed",
    operation: pagination ? "file_listing_pagination" : "file_listing_initial",
    httpStatus: pagination ? 504 : 502,
  }]);
  assertCursorHeld(result, pagination ? "file-list pagination failure" : "initial file-list failure");
  assertSecretSafe(result, pagination ? "file-list pagination failure" : "initial file-list failure");
}

// Malformed metadata, export failures, and content failures remain distinct and cursor-safe.
{
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("/export?")) return failure(403);
    if (url.includes("?alt=media")) return failure(429);
    return json({ files: [
      { id: "malformed-file", mimeType: "text/plain" },
      { id: "export-file", name: SECRET_MARKERS[6], mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-07-18T10:00:00.000Z" },
      { id: SECRET_MARKERS[5], name: SECRET_MARKERS[6], mimeType: "text/plain", modifiedTime: "2026-07-18T10:01:00.000Z" },
    ] });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "failed");
  assert.equal(result.completionDisposition, "failed");
  assert.deepEqual(result.errors, [
    { reason: "invalid_metadata", operation: "metadata" },
    { reason: "request_failed", operation: "export", httpStatus: 403 },
    { reason: "request_failed", operation: "content", httpStatus: 429 },
  ]);
  assertCursorHeld(result, "metadata/export/content failures");
  assertSecretSafe(result, "metadata/export/content failures");
}

// A seven-batch sweep capped in batch two persists a private checkpoint and resumes there.
{
  const sweepStart = "2026-08-13T14:00:00.000Z";
  const folders = Array.from({ length: 140 }, (_, index) => `private-folder-${String(index).padStart(3, "0")}`);
  const listCalls = [];
  let continuationRun = false;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("?alt=media")) return { ok: true, status: 200, text: async () => "fixture", json: async () => ({}) };
    const parsed = new URL(url);
    const query = parsed.searchParams.get("q") || "";
    const pageToken = parsed.searchParams.get("pageToken");
    listCalls.push({ query, pageToken, orderBy: parsed.searchParams.get("orderBy") });
    const batch = folders.findIndex(id => query.includes(`'${id}' in parents`));
    const batchIndex = Math.floor(Math.max(0, batch) / 20);
    if (!continuationRun && batchIndex === 0) {
      return json({ files: Array.from({ length: 60 }, (_, index) => fixtureFile(`batch-0-${index}`)) });
    }
    if (!continuationRun && batchIndex === 1) {
      return json({ files: Array.from({ length: 40 }, (_, index) => fixtureFile(`batch-1-${index}`)), nextPageToken: "private-next-page" });
    }
    if (continuationRun && batchIndex === 1) {
      assert.equal(pageToken, "private-next-page", "retry resumes the saved page in batch two");
      return json({ files: [fixtureFile("batch-1-resumed")] });
    }
    return json({ files: [] });
  };
  const connector = driveConnector(fetch, {
    CUE_DRIVE_FOLDER_IDS: folders.join(","),
    CUE_DRIVE_RECURSIVE: "false",
    CUE_DRIVE_MAX_FILES: "100",
  }, { now: () => new Date(sweepStart) });

  const first = await connector.pullDrive({ cursorBefore: CURSOR });
  const checkpoint = privateContinuation(first);
  assert.equal(first.status, "partial");
  assert.equal(first.completionDisposition, "file_limit_reached");
  assert.equal(first.reason, "file_limit_reached");
  assert.equal(first.cursorAfter, CURSOR);
  assert.equal(first.metadata.plannedBatches, 7);
  assert.equal(first.metadata.attemptedBatches, 2);
  assert.equal(first.metadata.completedBatches, 1);
  assert.equal(first.metadata.paginationRemaining, true);
  assert.equal(first.metadata.fileTraversalComplete, false);
  assert.equal(first.metadata.fileLimitReason, "file_limit_reached");
  assert.ok(checkpoint, "the continuation remains private but available to orchestration");
  assert.equal(checkpoint.batchIndex, 1);
  assert.equal(checkpoint.upperBound, sweepStart);
  assert.equal(checkpoint.lowerBound, "2026-07-18T09:29:00.000Z");
  assert.equal(JSON.stringify(first).includes("private-next-page"), false, "API serialization omits page tokens");
  assert.equal(JSON.stringify(first).includes("private-folder"), false, "API serialization omits folder identifiers");

  continuationRun = true;
  const resumed = await connector.pullDrive({ cursorBefore: CURSOR, continuation: checkpoint });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.completionDisposition, "completed");
  assert.equal(resumed.cursorAfter, sweepStart, "the durable cursor advances to the fixed upper bound");
  assert.equal(resumed.metadata.plannedBatches, 7);
  assert.equal(resumed.metadata.attemptedBatches, 6);
  assert.equal(resumed.metadata.completedBatches, 6);
  assert.equal(resumed.metadata.fileTraversalComplete, true);
  assert.equal(privateContinuation(resumed), null, "final traversal clears the continuation");
  const fileQueries = listCalls.map(call => call.query);
  assert.ok(fileQueries.every(query => query.includes("modifiedTime > '2026-07-18T09:29:00.000Z'")));
  assert.ok(fileQueries.every(query => query.includes(`modifiedTime <= '${sweepStart}'`)), "all continuation runs retain the fixed upper bound");
  assert.ok(listCalls.every(call => call.orderBy === DRIVE_PROVIDER_ORDER), "Drive provider ordering uses only modification time ascending");
}

// Exactly 100 files is complete when the sole page and every batch are exhausted.
{
  const upperBound = "2026-08-13T15:00:00.000Z";
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("?alt=media")) return { ok: true, status: 200, text: async () => "fixture", json: async () => ({}) };
    return json({ files: Array.from({ length: 100 }, (_, index) => fixtureFile(`terminal-${index}`)) });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => upperBound }).pullDrive({ cursorBefore: CURSOR });
  assert.equal(result.status, "completed");
  assert.equal(result.completionDisposition, "completed");
  assert.equal(result.files.length, 100);
  assert.equal(result.cursorAfter, upperBound);
  assert.equal(result.metadata.completedBatches, 1);
  assert.equal(result.metadata.paginationRemaining, false);
  assert.equal(result.metadata.fileTraversalComplete, true);
  assert.equal(privateContinuation(result), null);
}

// Provider ordering and deterministic local modification-time/title/private-ID sorting remain separate.
{
  const upperBound = "2026-08-13T16:00:00.000Z";
  let fileListUrl = "";
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("?alt=media")) return { ok: true, status: 200, text: async () => "fixture", json: async () => ({}) };
    fileListUrl = url;
    return json({ files: [
      { ...fixtureFile("later-title"), name: "zeta", modifiedTime: "2026-08-13T15:59:00.000Z" },
      { ...fixtureFile("stable-b"), name: "same", modifiedTime: "2026-08-13T15:58:00.000Z" },
      { ...fixtureFile("stable-a"), name: "same", modifiedTime: "2026-08-13T15:58:00.000Z" },
      { ...fixtureFile("earlier-title"), name: "omega", modifiedTime: "2026-08-13T15:57:00.000Z" },
      { ...fixtureFile("deferred-after-bound"), modifiedTime: "2026-08-13T16:00:00.001Z" },
    ] });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => upperBound }).pullDrive({ cursorBefore: CURSOR });
  assert.deepEqual(result.files.map(file => file.id), ["earlier-title", "stable-a", "stable-b", "later-title"]);
  const validated = assertSupportedDriveFileListRequest(fileListUrl, { remainingCapacity: 100, privateFileId: "stable-a" });
  assert.match(validated.query, new RegExp(`modifiedTime <= '${upperBound}'`));
}

// Initial and pagination failures retain resumable private checkpoints without advancing the cursor.
for (const pagination of [false, true]) {
  let page = 0;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    page += 1;
    if (pagination && page === 1) return json({ files: [], nextPageToken: "failure-page-token" });
    return failure(503);
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => "2026-08-13T17:00:00.000Z" }).pullDrive({ cursorBefore: CURSOR });
  const checkpoint = privateContinuation(result);
  assertCursorHeld(result, pagination ? "pagination continuation" : "initial continuation");
  assert.ok(checkpoint);
  assert.equal(checkpoint.batchIndex, 0);
  assert.equal(checkpoint.pageToken, pagination ? "failure-page-token" : null);
  assert.equal(result.metadata.requestFailure, true);
  assert.equal(result.metadata.fileTraversalComplete, false);
  assert.equal(JSON.stringify(result).includes("failure-page-token"), false);
}

// The exact initial-list failure checkpoint resumes batch one under its original fixed bounds.
{
  const upperBound = "2026-08-13T17:30:00.000Z";
  let failInitialRequest = true;
  let resumedRequest = null;
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (failInitialRequest) return failure(400);
    resumedRequest = url;
    return json({ files: [] });
  };
  const connector = driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => upperBound });
  const failed = await connector.pullDrive({ cursorBefore: CURSOR });
  const checkpoint = privateContinuation(failed);
  assert.equal(failed.status, "failed");
  assertCursorHeld(failed, "initial batch-one failure");
  assert.equal(checkpoint.batchIndex, 0);
  assert.equal(checkpoint.pageToken, null);
  const originalLowerBound = checkpoint.lowerBound;
  const originalUpperBound = checkpoint.upperBound;

  failInitialRequest = false;
  const resumed = await connector.pullDrive({ cursorBefore: CURSOR, continuation: checkpoint });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.cursorAfter, originalUpperBound, "cursor advances only after the resumed sweep completes");
  assert.equal(privateContinuation(resumed), null);
  const validated = assertSupportedDriveFileListRequest(resumedRequest, { remainingCapacity: 100 });
  assert.match(validated.query, new RegExp(`modifiedTime > '${originalLowerBound}'`));
  assert.match(validated.query, new RegExp(`modifiedTime <= '${originalUpperBound}'`));
}

// Invalid continuation is discarded and replaced by a fresh bounded sweep from the durable cursor.
{
  let query = "";
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    query = driveQueryFrom(url);
    return json({ files: [] });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => "2026-08-13T18:00:00.000Z" }).pullDrive({
    cursorBefore: CURSOR,
    continuation: { version: 0, originalCursor: CURSOR, folderIds: [] },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.metadata.continuationDiagnostic, "invalid_continuation");
  assert.match(query, /modifiedTime > '2026-07-18T09:29:00.000Z'/);
  assert.match(query, /modifiedTime <= '2026-08-13T18:00:00.000Z'/);
}

console.log(JSON.stringify({
  ok: true,
  folderLimitFailClosed: true,
  exactLimitTerminalTraversal: true,
  failureClassifications: ["folder_listing", "file_listing_initial", "file_listing_pagination", "metadata", "export", "content"],
  failedDriveCursorsHeld: true,
  resumableDriveSweeps: true,
  fixedSweepBounds: true,
  deterministicDriveOrdering: true,
  diagnosticsSecretSafe: true,
}, null, 2));
