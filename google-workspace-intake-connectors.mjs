import crypto from "node:crypto";

const GMAIL_CONNECTOR = "gmail-operational-intake";
const DRIVE_CONNECTOR = "google-drive-operational-intake";
const PRIVATE_DRIVE_CONTINUATION = Symbol.for("cue.googleWorkspace.driveContinuation");
const DRIVE_CONTINUATION_VERSION = 1;
const DRIVE_FOLDER_BATCH_SIZE = 20;
const DRIVE_CONTINUATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function text(value) { return String(value ?? "").trim(); }
function number(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}
function enabled(value) { return /^(1|true|yes|on)$/i.test(text(value)); }
function csv(value) { return text(value).split(",").map(item => item.trim()).filter(Boolean); }
function requestDiagnostic(error, operation) {
  const diagnostic = {
    reason: error?.name === "AbortError" ? "request_timeout" : "request_failed",
    operation,
  };
  const status = Number(error?.status || error?.statusCode || 0);
  if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.httpStatus = status;
  return diagnostic;
}
function iso(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function overlapCursor(cursor, seconds) {
  const date = new Date(cursor || 0);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() - seconds * 1000).toISOString();
}
function decodeBase64Url(value) {
  if (!value) return "";
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function headerMap(headers = []) {
  return Object.fromEntries(headers.map(header => [text(header?.name).toLowerCase(), text(header?.value)]));
}
function gmailParts(payload = {}, output = { text: [], html: [], attachments: [] }) {
  const mimeType = text(payload.mimeType).toLowerCase();
  const data = payload?.body?.data;
  if (data && mimeType === "text/plain") output.text.push(decodeBase64Url(data));
  else if (data && mimeType === "text/html") output.html.push(decodeBase64Url(data));
  if (payload?.filename || payload?.body?.attachmentId) {
    output.attachments.push({
      attachmentId: payload?.body?.attachmentId || null,
      filename: payload?.filename || null,
      mimeType: payload?.mimeType || null,
      size: payload?.body?.size ?? null,
    });
  }
  for (const part of payload.parts || []) gmailParts(part, output);
  return output;
}

export function readGoogleWorkspaceConfig(env = process.env) {
  const workspaceEnabled = enabled(env.CUE_GOOGLE_WORKSPACE_ENABLED);
  const gmailEnabled = workspaceEnabled && enabled(env.CUE_GMAIL_ENABLED);
  const driveEnabled = workspaceEnabled && enabled(env.CUE_DRIVE_ENABLED);
  const config = {
    workspaceEnabled,
    gmail: {
      enabled: gmailEnabled,
      connectorName: GMAIL_CONNECTOR,
      userId: text(env.CUE_GMAIL_USER_ID || "me"),
      query: text(env.CUE_GMAIL_QUERY),
      maxMessages: number(env.CUE_GMAIL_MAX_MESSAGES, 100, 1, 500),
    },
    drive: {
      enabled: driveEnabled,
      connectorName: DRIVE_CONNECTOR,
      folderIds: csv(env.CUE_DRIVE_FOLDER_IDS),
      recursive: enabled(env.CUE_DRIVE_RECURSIVE),
      maxFolderDepth: number(env.CUE_DRIVE_MAX_FOLDER_DEPTH, 8, 0, 20),
      maxFolders: number(env.CUE_DRIVE_MAX_FOLDERS, 500, 1, 5000),
      query: text(env.CUE_DRIVE_QUERY),
      maxFiles: number(env.CUE_DRIVE_MAX_FILES, 100, 1, 1000),
      maxContentBytes: number(env.CUE_DRIVE_MAX_CONTENT_BYTES, 1_000_000, 1_000, 10_000_000),
    },
    oauth: {
      clientId: text(env.CUE_GOOGLE_OAUTH_CLIENT_ID),
      clientSecret: text(env.CUE_GOOGLE_OAUTH_CLIENT_SECRET),
      refreshToken: text(env.CUE_GOOGLE_OAUTH_REFRESH_TOKEN),
    },
    cursorOverlapSeconds: number(env.CUE_GOOGLE_CURSOR_OVERLAP_SECONDS, 60, 0, 3600),
    requestTimeoutMs: number(env.CUE_GOOGLE_REQUEST_TIMEOUT_MS, 30_000, 1_000, 120_000),
    syncIntervalMinutes: number(env.CUE_GOOGLE_SYNC_INTERVAL_MINUTES, 0, 0, 1440),
  };
  const errors = [];
  if ((gmailEnabled || driveEnabled) && (!config.oauth.clientId || !config.oauth.clientSecret || !config.oauth.refreshToken)) {
    errors.push("Google OAuth client ID, client secret, and refresh token are required when a connector is enabled.");
  }
  if (gmailEnabled && !config.gmail.query) errors.push("CUE_GMAIL_QUERY is required to keep Gmail retrieval bounded.");
  if (driveEnabled && !config.drive.query && !config.drive.folderIds.length) {
    errors.push("CUE_DRIVE_QUERY or CUE_DRIVE_FOLDER_IDS is required to keep Drive retrieval bounded.");
  }
  const oauthConfigured = Boolean(config.oauth.clientId && config.oauth.clientSecret && config.oauth.refreshToken);
  config.gmail.configured = gmailEnabled && oauthConfigured && Boolean(config.gmail.query);
  config.drive.configured = driveEnabled && oauthConfigured && Boolean(config.drive.query || config.drive.folderIds.length);
  return { ...config, configured: config.gmail.configured || config.drive.configured, errors };
}

export function createGoogleWorkspaceIntakeConnectors(options = {}) {
  const config = options.config || readGoogleWorkspaceConfig(options.env);
  const fetchImpl = options.fetch || globalThis.fetch;
  let cachedToken = null;
  let tokenExpiresAt = 0;
  const currentTime = options.now || (() => new Date());

  function nowIso() {
    const value = currentTime();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("Google Workspace connector clock is invalid.");
    return date.toISOString();
  }

  function driveScopeFingerprint() {
    return crypto.createHash("sha256").update(JSON.stringify({
      roots: [...config.drive.folderIds].sort(),
      recursive: config.drive.recursive,
      maxFolderDepth: config.drive.maxFolderDepth,
      maxFolders: config.drive.maxFolders,
      query: config.drive.query,
      overlapSeconds: config.cursorOverlapSeconds,
    })).digest("hex");
  }

  function attachDriveContinuation(result, continuation, diagnosticCategory = null) {
    Object.defineProperty(result, PRIVATE_DRIVE_CONTINUATION, {
      value: { continuation, diagnosticCategory },
      enumerable: false,
    });
    return result;
  }

  function continuationDiagnostic(continuation, cursorBefore, startedAt) {
    if (!continuation || typeof continuation !== "object") return "invalid_continuation";
    if (continuation.version !== DRIVE_CONTINUATION_VERSION
      || continuation.connectorName !== DRIVE_CONNECTOR) return "invalid_continuation";
    if (continuation.originalCursor !== cursorBefore
      || continuation.scopeFingerprint !== driveScopeFingerprint()) return "incompatible_continuation";
    const lowerBound = iso(continuation.lowerBound);
    const upperBound = iso(continuation.upperBound);
    const age = new Date(startedAt).getTime() - new Date(upperBound || 0).getTime();
    if (!lowerBound || !upperBound || lowerBound !== continuation.lowerBound || upperBound !== continuation.upperBound
      || new Date(lowerBound).getTime() > new Date(upperBound).getTime()) return "invalid_continuation";
    if (age < -5 * 60 * 1000 || age > DRIVE_CONTINUATION_MAX_AGE_MS) return "stale_continuation";
    if (!Array.isArray(continuation.folderIds)
      || continuation.folderIds.some(id => !text(id))
      || new Set(continuation.folderIds).size !== continuation.folderIds.length
      || continuation.folderIds.join("\n") !== [...continuation.folderIds].sort().join("\n")) return "invalid_continuation";
    const plannedBatches = Math.max(1, Math.ceil(continuation.folderIds.length / DRIVE_FOLDER_BATCH_SIZE));
    if (!Number.isInteger(continuation.batchIndex)
      || continuation.batchIndex < 0
      || continuation.batchIndex >= plannedBatches
      || !(continuation.pageToken === null || typeof continuation.pageToken === "string")) return "invalid_continuation";
    return null;
  }

  async function request(url, init = {}, responseType = "json") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const error = new Error("Google Workspace request failed.");
        error.status = response.status;
        throw error;
      }
      if (responseType === "text") return response.text();
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    const body = new URLSearchParams({
      client_id: config.oauth.clientId,
      client_secret: config.oauth.clientSecret,
      refresh_token: config.oauth.refreshToken,
      grant_type: "refresh_token",
    });
    const result = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!result?.access_token) throw new Error("Google OAuth did not return an access token.");
    cachedToken = result.access_token;
    tokenExpiresAt = Date.now() + number(result.expires_in, 3600, 60) * 1000;
    return cachedToken;
  }

  async function authorized(url, responseType = "json") {
    const token = await accessToken();
    return request(url, { headers: { Authorization: `Bearer ${token}` } }, responseType);
  }

  async function pullGmail(input = {}) {
    const cursorBefore = input.cursorBefore || null;
    if (!config.gmail.enabled) return { status: "skipped", reason: "not_enabled", connectorName: GMAIL_CONNECTOR, cursorBefore, cursorAfter: cursorBefore, messages: [], errors: [] };
    if (!config.gmail.configured) return { status: "skipped", reason: "not_configured", connectorName: GMAIL_CONNECTOR, cursorBefore, cursorAfter: cursorBefore, messages: [], errors: [] };
    const startedAt = nowIso();
    const after = overlapCursor(cursorBefore, config.cursorOverlapSeconds);
    const query = [config.gmail.query, after && `after:${Math.floor(new Date(after).getTime() / 1000)}`].filter(Boolean).join(" ");
    const messages = [];
    const errors = [];
    let pageToken = null;
    try {
      do {
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(config.gmail.userId)}/messages`);
        url.searchParams.set("q", query);
        url.searchParams.set("maxResults", String(Math.min(500, config.gmail.maxMessages - messages.length)));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await authorized(url);
        for (const item of page.messages || []) {
          if (messages.length >= config.gmail.maxMessages) break;
          try {
            const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(config.gmail.userId)}/messages/${encodeURIComponent(item.id)}`);
            detailUrl.searchParams.set("format", "full");
            const detail = await authorized(detailUrl);
            const headers = headerMap(detail?.payload?.headers);
            const parts = gmailParts(detail?.payload || {});
            messages.push({
              id: detail.id,
              messageId: detail.id,
              threadId: detail.threadId,
              historyId: detail.historyId,
              internalDate: detail.internalDate,
              subject: headers.subject,
              from: headers.from,
              to: headers.to ? [headers.to] : [],
              cc: headers.cc ? [headers.cc] : [],
              date: headers.date,
              textPlain: parts.text.join("\n\n"),
              html: parts.html.join("\n\n"),
              snippet: detail.snippet,
              labelIds: detail.labelIds || [],
              attachments: parts.attachments,
              sourceUrl: `https://mail.google.com/mail/u/0/#all/${detail.id}`,
            });
          } catch (error) {
            errors.push(requestDiagnostic(error, "message_detail"));
          }
        }
        pageToken = messages.length < config.gmail.maxMessages ? page.nextPageToken || null : null;
      } while (pageToken);
    } catch (error) {
      errors.push(requestDiagnostic(error, "message_listing"));
    }
    const timestamps = messages.map(message => iso(Number(message.internalDate))).filter(Boolean).sort();
    return {
      connectorName: GMAIL_CONNECTOR,
      status: errors.length ? (messages.length ? "partial" : "failed") : "completed",
      cursorBefore,
      cursorAfter: errors.length ? cursorBefore : timestamps.at(-1) || startedAt,
      messages,
      errors,
      metadata: { received: messages.length, skipped: errors.length },
    };
  }

  function driveQuery(lowerBound, upperBound, folderIds = config.drive.folderIds, originalCursor = null) {
    const clauses = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
    if (folderIds.length) clauses.push(`(${folderIds.map(id => `'${id.replace(/'/g, "\\'")}' in parents`).join(" or ")})`);
    if (config.drive.query) clauses.push(`(${config.drive.query})`);
    if (originalCursor && lowerBound) clauses.push(`modifiedTime > '${lowerBound}'`);
    clauses.push(`modifiedTime <= '${upperBound}'`);
    return clauses.join(" and ");
  }

  function folderQuery(folderIds) {
    const parents = folderIds.map(id => `'${id.replace(/'/g, "\\'")}' in parents`).join(" or ");
    return `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${parents})`;
  }

  async function driveList(query, pageSize, pageToken = null) {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", query);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", "modifiedTime asc");
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,description,modifiedTime,createdTime,version,headRevisionId,webViewLink,parents,driveId,owners,shared,ownedByMe,size,trashed,lastModifyingUser)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return authorized(url);
  }

  async function discoverDriveFolders() {
    const roots = [...new Set(config.drive.folderIds)].sort();
    if (!config.drive.recursive || !roots.length || config.drive.maxFolderDepth === 0) {
      return { complete: true, folderIds: roots, errors: [] };
    }
    const seen = new Set(roots);
    let frontier = roots.map(id => ({ id, depth: 0 }));
    while (frontier.length && seen.size < config.drive.maxFolders) {
      const next = [];
      for (let offset = 0; offset < frontier.length && seen.size < config.drive.maxFolders; offset += 20) {
        const batch = frontier.slice(offset, offset + DRIVE_FOLDER_BATCH_SIZE);
        let pageToken = null;
        try {
          do {
            const page = await driveList(folderQuery(batch.map(item => item.id)), Math.min(1000, config.drive.maxFolders - seen.size), pageToken);
            const orderedFolders = [...(page.files || [])].sort((left, right) =>
              text(left?.modifiedTime).localeCompare(text(right?.modifiedTime))
              || text(left?.name).localeCompare(text(right?.name))
              || text(left?.id).localeCompare(text(right?.id)));
            for (const folder of orderedFolders) {
              const parentDepths = batch.filter(parent => (folder.parents || []).includes(parent.id)).map(parent => parent.depth);
              const depth = (parentDepths.length ? Math.min(...parentDepths) : batch[0].depth) + 1;
              if (depth <= config.drive.maxFolderDepth && !seen.has(folder.id)) {
                seen.add(folder.id);
                next.push({ id: folder.id, depth });
                if (seen.size >= config.drive.maxFolders) break;
              }
            }
            if (seen.size >= config.drive.maxFolders && page.nextPageToken) {
              return {
                complete: false,
                folderIds: [...seen],
                errors: [{ reason: "incomplete_folder_traversal", operation: "folder_listing" }],
              };
            }
            pageToken = page.nextPageToken || null;
          } while (pageToken);
        } catch (error) {
          return { complete: false, folderIds: [...seen], errors: [requestDiagnostic(error, "folder_listing")] };
        }
      }
      frontier = next.filter(item => item.depth < config.drive.maxFolderDepth)
        .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
    }
    if (frontier.length) {
      return {
        complete: false,
        folderIds: [...seen],
        errors: [{ reason: "incomplete_folder_traversal", operation: "folder_listing" }],
      };
    }
    return { complete: true, folderIds: [...seen].sort(), errors: [] };
  }

  function driveContentOperation(file) {
    const mime = text(file?.mimeType).toLowerCase();
    return mime === "application/vnd.google-apps.document"
      || mime === "application/vnd.google-apps.spreadsheet"
      || mime === "application/vnd.google-apps.presentation"
      ? "export"
      : "content";
  }

  async function driveContent(file) {
    const mime = text(file.mimeType).toLowerCase();
    const exportMime = mime === "application/vnd.google-apps.document" ? "text/plain"
      : mime === "application/vnd.google-apps.spreadsheet" ? "text/csv"
        : mime === "application/vnd.google-apps.presentation" ? "text/plain" : null;
    let url;
    if (exportMime) {
      url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`);
      url.searchParams.set("mimeType", exportMime);
    } else if (/^(text\/|application\/(json|xml|csv))/.test(mime)) {
      url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
      url.searchParams.set("alt", "media");
    } else {
      return { skipped: true, reason: "unsupported_content_type", text: "" };
    }
    const content = await authorized(url, "text");
    return { skipped: false, text: String(content).slice(0, config.drive.maxContentBytes) };
  }

  async function pullDrive(input = {}) {
    const cursorBefore = input.cursorBefore || null;
    if (!config.drive.enabled) return { status: "skipped", reason: "not_enabled", connectorName: DRIVE_CONNECTOR, cursorBefore, cursorAfter: cursorBefore, files: [], skippedFiles: [], errors: [] };
    if (!config.drive.configured) return { status: "skipped", reason: "not_configured", connectorName: DRIVE_CONNECTOR, cursorBefore, cursorAfter: cursorBefore, files: [], skippedFiles: [], errors: [] };
    const startedAt = nowIso();
    const files = [];
    const skippedFiles = [];
    const errors = [];
    let continuation = input.continuation || null;
    let continuationCategory = null;
    if (continuation) {
      continuationCategory = continuationDiagnostic(continuation, cursorBefore, startedAt);
      if (continuationCategory) continuation = null;
    }

    let sweep = continuation;
    if (!sweep) {
      const discovery = await discoverDriveFolders();
      if (!discovery.complete) {
        return attachDriveContinuation({
          connectorName: DRIVE_CONNECTOR,
          status: "failed",
          completionDisposition: "failed",
          reason: "incomplete_folder_traversal",
          cursorBefore,
          cursorAfter: cursorBefore,
          files,
          skippedFiles,
          errors: discovery.errors,
          metadata: {
            recursive: config.drive.recursive,
            folderTraversalComplete: false,
            plannedBatches: 0,
            attemptedBatches: 0,
            completedBatches: 0,
            paginationRemaining: false,
            fileTraversalComplete: false,
            fileLimitReached: false,
            fileLimitReason: null,
            requestFailure: discovery.errors.some(error => /request_(?:failed|timeout)/.test(error.reason)),
            continuationDiagnostic: continuationCategory,
            received: 0,
            skipped: 0,
            failed: discovery.errors.length,
          },
        }, null, continuationCategory);
      }
      const upperBound = startedAt;
      const lowerBound = overlapCursor(cursorBefore, config.cursorOverlapSeconds) || new Date(0).toISOString();
      sweep = {
        version: DRIVE_CONTINUATION_VERSION,
        connectorName: DRIVE_CONNECTOR,
        originalCursor: cursorBefore,
        lowerBound,
        upperBound,
        scopeFingerprint: driveScopeFingerprint(),
        folderIds: [...new Set(discovery.folderIds)].sort(),
        batchIndex: 0,
        pageToken: null,
      };
    }

    const batches = sweep.folderIds.length
      ? Array.from({ length: Math.ceil(sweep.folderIds.length / DRIVE_FOLDER_BATCH_SIZE) }, (_, index) => sweep.folderIds.slice(index * DRIVE_FOLDER_BATCH_SIZE, index * DRIVE_FOLDER_BATCH_SIZE + DRIVE_FOLDER_BATCH_SIZE))
      : [[]];
    const seenFiles = new Set();
    let attemptedBatches = 0;
    let completedBatches = 0;
    let paginationRemaining = false;
    let fileTraversalComplete = true;
    let fileLimitReached = false;
    let requestFailure = false;
    let nextContinuation = null;
    fileBatches: for (let batchIndex = sweep.batchIndex; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      attemptedBatches += 1;
      const query = driveQuery(sweep.lowerBound, sweep.upperBound, batch, sweep.originalCursor);
      let pageToken = batchIndex === sweep.batchIndex ? sweep.pageToken : null;
      do {
        const requestedPageToken = pageToken;
        let page;
        try {
          page = await driveList(query, Math.min(1000, config.drive.maxFiles - files.length), pageToken);
        } catch (error) {
          errors.push(requestDiagnostic(error, pageToken ? "file_listing_pagination" : "file_listing_initial"));
          requestFailure = true;
          fileTraversalComplete = false;
          paginationRemaining = Boolean(pageToken);
          nextContinuation = { ...sweep, batchIndex, pageToken: requestedPageToken };
          break fileBatches;
        }
        const orderedFiles = [...(page.files || [])].sort((left, right) =>
          text(left?.modifiedTime).localeCompare(text(right?.modifiedTime))
          || text(left?.name).localeCompare(text(right?.name))
          || text(left?.id).localeCompare(text(right?.id)));
        for (const file of orderedFiles) {
          if (files.length >= config.drive.maxFiles || seenFiles.has(file?.id)) continue;
          if (!text(file?.id) || !text(file?.mimeType) || !text(file?.modifiedTime) || !iso(file.modifiedTime)) {
            errors.push({ reason: "invalid_metadata", operation: "metadata" });
            continue;
          }
          if (new Date(file.modifiedTime).getTime() > new Date(sweep.upperBound).getTime()) continue;
          seenFiles.add(file.id);
          try {
            const content = await driveContent(file);
            if (content.skipped) skippedFiles.push({ reason: content.reason, operation: "metadata" });
            files.push({ ...file, fileId: file.id, extractedText: content.text, externalRevisionId: file.headRevisionId || file.version || file.modifiedTime });
          } catch (error) {
            errors.push(requestDiagnostic(error, driveContentOperation(file)));
          }
        }
        const providerNextPageToken = page.nextPageToken || null;
        if (files.length >= config.drive.maxFiles) {
          if (providerNextPageToken) {
            nextContinuation = { ...sweep, batchIndex, pageToken: providerNextPageToken };
            paginationRemaining = true;
          } else if (batchIndex + 1 < batches.length) {
            nextContinuation = { ...sweep, batchIndex: batchIndex + 1, pageToken: null };
            completedBatches += 1;
          }
          if (nextContinuation) {
            fileLimitReached = true;
            fileTraversalComplete = false;
            break fileBatches;
          }
        }
        pageToken = providerNextPageToken;
        paginationRemaining = Boolean(pageToken);
      } while (pageToken);
      completedBatches += 1;
      paginationRemaining = false;
    }
    const result = {
      connectorName: DRIVE_CONNECTOR,
      status: fileLimitReached ? "partial"
        : errors.length ? (files.length ? "partial" : "failed")
          : "completed",
      completionDisposition: fileLimitReached ? "file_limit_reached"
        : errors.length ? "failed"
          : skippedFiles.length ? "completed_with_skips" : "completed",
      ...(fileLimitReached ? { reason: "file_limit_reached" }
        : errors.length && !files.length ? { reason: errors[0].reason } : {}),
      cursorBefore,
      cursorAfter: fileTraversalComplete && !errors.length ? sweep.upperBound : cursorBefore,
      files,
      skippedFiles,
      errors,
      metadata: {
        recursive: config.drive.recursive,
        folderTraversalComplete: true,
        folderCount: sweep.folderIds.length,
        queryBatchCount: batches.length,
        plannedBatches: batches.length,
        attemptedBatches,
        completedBatches,
        paginationRemaining,
        fileTraversalComplete,
        fileLimitReached,
        fileLimitReason: fileLimitReached ? "file_limit_reached" : null,
        requestFailure,
        continuationDiagnostic: continuationCategory,
        sweepLowerBound: sweep.lowerBound,
        sweepUpperBound: sweep.upperBound,
        received: files.length,
        skipped: skippedFiles.length,
        failed: errors.length,
      },
    };
    return attachDriveContinuation(result, nextContinuation, continuationCategory);
  }

  return { config, pullGmail, pullDrive };
}

export { GMAIL_CONNECTOR, DRIVE_CONNECTOR };
