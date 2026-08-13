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
  assert.equal(drive.status, "partial");
  assert.equal(drive.files.length, 2, "unsupported binary files still contribute safe metadata");
  assert.equal(drive.skippedFiles.length, 1);
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
  assert.equal(resumed.cursorAfter, sweepStart, "the durable cursor advances to the fixed upper bound");
  assert.equal(resumed.metadata.plannedBatches, 7);
  assert.equal(resumed.metadata.attemptedBatches, 6);
  assert.equal(resumed.metadata.completedBatches, 6);
  assert.equal(resumed.metadata.fileTraversalComplete, true);
  assert.equal(privateContinuation(resumed), null, "final traversal clears the continuation");
  const fileQueries = listCalls.map(call => call.query);
  assert.ok(fileQueries.every(query => query.includes("modifiedTime > '2026-07-18T09:29:00.000Z'")));
  assert.ok(fileQueries.every(query => query.includes(`modifiedTime <= '${sweepStart}'`)), "all continuation runs retain the fixed upper bound");
  assert.ok(listCalls.every(call => call.orderBy === "modifiedTime asc,name_natural asc"), "Drive uses the strongest supported stable ordering");
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
  assert.equal(result.files.length, 100);
  assert.equal(result.cursorAfter, upperBound);
  assert.equal(result.metadata.completedBatches, 1);
  assert.equal(result.metadata.paginationRemaining, false);
  assert.equal(result.metadata.fileTraversalComplete, true);
  assert.equal(privateContinuation(result), null);
}

// Equal timestamps are locally tie-broken by a private stable identifier, and post-bound files are deferred by query.
{
  const upperBound = "2026-08-13T16:00:00.000Z";
  let boundedQuery = "";
  const fetch = async input => {
    const url = String(input);
    if (isTokenRequest(url)) return json({ access_token: SECRET_MARKERS[3], expires_in: 3600 });
    if (url.includes("?alt=media")) return { ok: true, status: 200, text: async () => "fixture", json: async () => ({}) };
    boundedQuery = driveQueryFrom(url);
    return json({ files: [
      { ...fixtureFile("stable-b"), name: "same", modifiedTime: upperBound },
      { ...fixtureFile("stable-a"), name: "same", modifiedTime: upperBound },
      { ...fixtureFile("deferred-after-bound"), modifiedTime: "2026-08-13T16:00:00.001Z" },
    ] });
  };
  const result = await driveConnector(fetch, { CUE_DRIVE_RECURSIVE: "false" }, { now: () => upperBound }).pullDrive({ cursorBefore: CURSOR });
  assert.deepEqual(result.files.map(file => file.id), ["stable-a", "stable-b"]);
  assert.match(boundedQuery, new RegExp(`modifiedTime <= '${upperBound}'`));
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
