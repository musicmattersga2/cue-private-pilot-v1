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
function driveConnector(fetch, envOverrides = {}) {
  return createGoogleWorkspaceIntakeConnectors({ env: { ...baseEnv, ...envOverrides }, fetch });
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

console.log(JSON.stringify({
  ok: true,
  folderLimitFailClosed: true,
  exactLimitTerminalTraversal: true,
  failureClassifications: ["folder_listing", "file_listing_initial", "file_listing_pagination", "metadata", "export", "content"],
  failedDriveCursorsHeld: true,
  diagnosticsSecretSafe: true,
}, null, 2));
