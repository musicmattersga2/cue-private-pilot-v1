import assert from "node:assert/strict";
import {
  createGoogleWorkspaceIntakeConnectors,
  readGoogleWorkspaceConfig,
} from "./google-workspace-intake-connectors.mjs";

const invalid = readGoogleWorkspaceConfig({
  CUE_GOOGLE_WORKSPACE_ENABLED: "true",
  CUE_GMAIL_ENABLED: "true",
  CUE_DRIVE_ENABLED: "true",
  CUE_GOOGLE_OAUTH_CLIENT_ID: "client",
  CUE_GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  CUE_GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
});
assert.equal(invalid.configured, false);
assert.equal(invalid.errors.length, 2, "both live sources require bounded retrieval constraints");

const env = {
  CUE_GOOGLE_WORKSPACE_ENABLED: "true",
  CUE_GMAIL_ENABLED: "true",
  CUE_DRIVE_ENABLED: "true",
  CUE_GOOGLE_OAUTH_CLIENT_ID: "client-do-not-leak",
  CUE_GOOGLE_OAUTH_CLIENT_SECRET: "secret-do-not-leak",
  CUE_GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-do-not-leak",
  CUE_GMAIL_QUERY: "label:CUE newer_than:30d",
  CUE_GMAIL_MAX_MESSAGES: "2",
  CUE_DRIVE_FOLDER_IDS: "folder-one",
  CUE_DRIVE_RECURSIVE: "true",
  CUE_DRIVE_MAX_FOLDER_DEPTH: "4",
  CUE_DRIVE_MAX_FOLDERS: "20",
  CUE_DRIVE_MAX_FILES: "3",
  CUE_GOOGLE_CURSOR_OVERLAP_SECONDS: "60",
};
const calls = [];
const json = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
const fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "access-token", expires_in: 3600 });
  if (url.includes("gmail.googleapis.com") && url.includes("/messages?") ) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
  if (url.endsWith("/messages/m1?format=full")) return json({
    id: "m1", threadId: "t1", historyId: "10", internalDate: "1784304000000", snippet: "Moonchild 26-1846",
    labelIds: ["CUE"], payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Moonchild" }], body: { data: Buffer.from("Quote 26-1846").toString("base64url") } },
  });
  if (url.endsWith("/messages/m2?format=full")) return { ok: false, status: 503, json: async () => ({}) };
  if (url.includes("www.googleapis.com/drive/v3/files?") ) {
    const query = new URL(url).searchParams.get("q");
    if (query.includes("mimeType = 'application/vnd.google-apps.folder'") && query.includes("'folder-one' in parents")) {
      return json({ files: [{ id: "nested-show", name: "Moonchild", mimeType: "application/vnd.google-apps.folder", parents: ["folder-one"] }] });
    }
    if (query.includes("mimeType = 'application/vnd.google-apps.folder'")) return json({ files: [] });
    return json({ files: [
      { id: "d1", name: "LiteFlair.txt", mimeType: "text/plain", modifiedTime: "2026-07-18T10:00:00.000Z", version: "1" },
      { id: "d2", name: "Binary.pdf", mimeType: "application/pdf", modifiedTime: "2026-07-18T10:01:00.000Z", version: "2" },
    ] });
  }
  if (url.includes("/drive/v3/files/d1?alt=media")) return { ok: true, status: 200, text: async () => "LiteFlair quote 26-1790", json: async () => ({}) };
  throw new Error(`Unexpected request: ${url}`);
};

const connectors = createGoogleWorkspaceIntakeConnectors({ env, fetch });
const gmail = await connectors.pullGmail({ cursorBefore: "2026-07-18T09:00:00.000Z" });
assert.equal(gmail.status, "partial");
assert.equal(gmail.messages.length, 1);
assert.equal(gmail.errors.length, 1);
assert.equal(gmail.messages[0].textPlain, "Quote 26-1846");
const gmailList = calls.find(call => call.url.includes("gmail.googleapis.com") && call.url.includes("/messages?"));
assert.match(new URL(gmailList.url).searchParams.get("q"), /after:1784365140/, "Gmail cursor overlaps by one minute");

const drive = await connectors.pullDrive({ cursorBefore: "2026-07-18T09:30:00.000Z" });
assert.equal(drive.status, "partial");
assert.equal(drive.files.length, 2, "unsupported binary files still contribute safe metadata");
assert.equal(drive.skippedFiles.length, 1);
assert.equal(drive.files[0].extractedText, "LiteFlair quote 26-1790");
const driveLists = calls.filter(call => call.url.includes("drive/v3/files?"));
const driveList = driveLists.find(call => !new URL(call.url).searchParams.get("q").includes("mimeType = 'application/vnd.google-apps.folder'"));
assert.match(new URL(driveList.url).searchParams.get("q"), /'folder-one' in parents/);
assert.match(new URL(driveList.url).searchParams.get("q"), /'nested-show' in parents/, "recursive roots include discovered show folders");
assert.match(new URL(driveList.url).searchParams.get("q"), /mimeType != 'application\/vnd\.google-apps\.folder'/, "folder metadata does not consume the file limit");
assert.match(new URL(driveList.url).searchParams.get("q"), /modifiedTime > '2026-07-18T09:29:00.000Z'/);
assert.equal(drive.metadata.recursive, true);

const serialized = JSON.stringify({ gmail, drive });
assert.doesNotMatch(serialized, /client-do-not-leak|secret-do-not-leak|refresh-do-not-leak|access-token/);

console.log(JSON.stringify({
  ok: true,
  gmail: { status: gmail.status, messages: gmail.messages.length, errors: gmail.errors.length },
  drive: { status: drive.status, files: drive.files.length, skipped: drive.skippedFiles.length },
  secretSafe: true,
}, null, 2));
