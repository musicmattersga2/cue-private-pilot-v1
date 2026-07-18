/**
 * Transport-neutral adapters for evidence sources feeding the shared CUE
 * Intake spine. These functions do not call Gmail, Google Drive, or FLEX;
 * they translate provider payloads after an authorized connector retrieves
 * them.
 */

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined);
  return value === null || value === undefined || value === "" ? [] : [value];
}

function unique(values) {
  return [...new Set(list(values).map(text).filter(Boolean))];
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stripHtml(value) {
  return text(value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const candidate = typeof numeric === "number" && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function documentTypeNear(source, offset = 0) {
  const context = text(source).slice(Math.max(0, offset - 45), offset + 45).toLowerCase();
  if (/pull\s*sheet|pullsheet/.test(context)) return "pull_sheet";
  if (/event\s*folder/.test(context)) return "event_folder";
  if (/purchase\s*order|\blpo\b/.test(context)) return "purchase_order";
  if (/invoice/.test(context)) return "invoice";
  if (/manifest/.test(context)) return "manifest";
  if (/quote/.test(context)) return "quote";
  return "unknown";
}

function verifiedDocumentFor(documentNumber, documentType, documents = []) {
  const matches = list(documents).filter(document =>
    text(document?.documentNumber || document?.number) === documentNumber
    && text(document?.elementId || document?.uuid)
    && document?.verified !== false
  );
  const typed = matches.filter(document =>
    documentType !== "unknown"
    && text(document?.documentType || document?.type).toLowerCase() === documentType
  );
  const candidates = typed.length ? typed : matches;
  return candidates.length === 1 ? candidates[0] : null;
}

export function extractFlexDocumentRefs(value, options = {}) {
  const source = text(value);
  const refs = [];
  const regex = /\b(?:LPO)?\d{2}-\d{4}\b/gi;
  for (const match of source.matchAll(regex)) {
    const documentNumber = match[0].toUpperCase();
    const documentType = documentTypeNear(source, match.index || 0);
    const verified = verifiedDocumentFor(documentNumber, documentType, options.verifiedFlexDocuments);
    refs.push({
      documentNumber,
      elementId: text(verified?.elementId || verified?.uuid) || null,
      documentType: text(verified?.documentType || verified?.type || documentType).toLowerCase(),
      role: text(verified?.role || "mentioned_source").toLowerCase(),
      parentElementId: text(verified?.parentElementId || verified?.parentId) || null,
      flexUrl: text(verified?.flexUrl || verified?.url) || null,
      verified: Boolean(verified),
      source: text(options.source || "evidence_text"),
    });
  }
  return refs.filter((ref, index, all) => index === all.findIndex(candidate =>
    candidate.documentNumber === ref.documentNumber
    && candidate.documentType === ref.documentType
    && candidate.role === ref.role
  ));
}

function operationalShape(input = {}, normalizedText = "") {
  const lower = text(normalizedText).toLowerCase();
  const category = text(input.category || input.domain).toLowerCase()
    || (/staff(?:ing)?|crew|labor/.test(lower) ? "staffing"
      : /truck|trailer|driver|delivery|shipment|pickup|return|logistics/.test(lower) ? "trucking"
        : /warehouse|dock|shop|prep|pack|pull\s*sheet/.test(lower) ? "warehouse"
          : /equipment|cable|truss|steel|shackle|hazer|guardrail|earbud|inventory/.test(lower) ? "equipment"
            : /schedule|date|load\s*in|show\s*start/.test(lower) ? "schedule"
              : "operations");
  const showSpecific = Boolean(
    text(input.canonicalShowId || input.showId || input.candidateShowId || input.showNameHint || input.showName)
    || list(input.flexDocumentRefs || input.flexDocuments).length
    || /\b(?:LPO)?\d{2}-\d{4}\b/i.test(lower)
  );
  const scope = text(input.scope).toLowerCase() || (showSpecific ? "show_specific" : `${category}_operations`);
  const impact = text(input.impact).toLowerCase()
    || (/blocked|critical|cannot|can't/.test(lower) ? "critical"
      : /missing|shortage|short\b|at risk|waiting on|need(?:s|ed)?\b|late\b/.test(lower) ? "material"
        : "minor");
  const urgency = text(input.urgency).toLowerCase()
    || (impact === "critical" || /urgent|asap|eod|today/.test(lower) ? "urgent" : "normal");
  return { category, scope, impact, urgency, showSpecific };
}

function mergeFlexRefs(explicit = [], extracted = []) {
  return [...list(explicit), ...list(extracted)].filter(Boolean).filter((ref, index, all) => {
    const number = text(ref.documentNumber || ref.number);
    const elementId = text(ref.elementId || ref.uuid);
    const type = text(ref.documentType || ref.type || "unknown").toLowerCase();
    const role = text(ref.role || "mentioned_source").toLowerCase();
    return index === all.findIndex(candidate =>
      text(candidate.documentNumber || candidate.number) === number
      && text(candidate.elementId || candidate.uuid) === elementId
      && text(candidate.documentType || candidate.type || "unknown").toLowerCase() === type
      && text(candidate.role || "mentioned_source").toLowerCase() === role
    );
  });
}

function emailBody(message = {}) {
  const direct = message.textPlain ?? message.plainText ?? message.bodyText ?? message.text ?? message.body?.text;
  if (text(direct)) return text(direct);
  const html = message.html ?? message.bodyHtml ?? message.body?.html;
  if (text(html)) return stripHtml(html);
  return text(message.snippet);
}

function attachmentMetadata(attachments = []) {
  return list(attachments).map(attachment => compactObject({
    id: text(attachment?.id || attachment?.attachmentId) || null,
    name: text(attachment?.name || attachment?.filename) || null,
    mimeType: text(attachment?.mimeType || attachment?.contentType) || null,
    size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
    driveFileId: text(attachment?.driveFileId) || null,
  }));
}

export function adaptEmailMessageToIntakeRecord(message = {}, options = {}) {
  const externalId = text(message.externalId || message.messageId || message.id);
  if (!externalId) throw new Error("Email connector messages require id or messageId.");
  const subject = text(message.subject);
  const body = emailBody(message);
  const normalizedText = [subject && `Subject: ${subject}`, body].filter(Boolean).join("\n\n");
  const extractedRefs = extractFlexDocumentRefs(normalizedText, {
    verifiedFlexDocuments: options.verifiedFlexDocuments,
    source: "email",
  });
  const flexDocumentRefs = mergeFlexRefs(message.flexDocumentRefs || message.flexDocuments, extractedRefs);
  const shape = operationalShape({ ...message, flexDocumentRefs }, normalizedText);
  const from = text(message.from?.email || message.from?.address || message.from);
  return {
    sourceType: "email",
    connectorName: text(message.connectorName || options.connectorName || "gmail-operational-intake"),
    connectorVersion: text(message.connectorVersion || options.connectorVersion || "v1"),
    externalId,
    externalParentId: text(message.externalParentId || message.threadId) || null,
    externalRevisionId: text(message.externalRevisionId || message.historyId || message.revisionId || message.updatedAt) || null,
    sourceUrl: text(message.sourceUrl || message.permalink || message.webUrl) || null,
    authorExternalId: text(message.authorExternalId || from) || null,
    observedAt: iso(message.observedAt || message.internalDate || message.date || message.receivedAt),
    effectiveAt: iso(message.effectiveAt || message.date || message.receivedAt),
    normalizedText,
    summary: text(message.summary || subject || message.snippet || body),
    category: shape.category,
    scope: shape.scope,
    urgency: shape.urgency,
    impact: shape.impact,
    canonicalShowId: text(message.canonicalShowId || message.showId || options.canonicalShowId) || null,
    candidateShowId: text(message.candidateShowId || options.candidateShowId) || null,
    showNameHint: text(message.showNameHint || message.showName || options.showNameHint) || null,
    requiresShowMatch: message.requiresShowMatch ?? options.requiresShowMatch ?? shape.showSpecific,
    flexDocumentRefs,
    proposedUpdates: list(message.proposedUpdates),
    permissionsMetadata: compactObject({
      provider: text(options.provider || "gmail"),
      mailbox: text(message.mailbox || options.mailbox) || null,
      labels: unique(message.labelIds || message.labels),
      tenantDomain: text(options.tenantDomain) || null,
      ...(message.permissionsMetadata || {}),
    }),
    payload: compactObject({
      subject,
      from,
      to: unique(message.to),
      cc: unique(message.cc),
      bcc: unique(message.bcc),
      snippet: text(message.snippet) || null,
      attachments: attachmentMetadata(message.attachments),
      providerPayload: message.providerPayload && typeof message.providerPayload === "object" ? message.providerPayload : undefined,
    }),
    intakeMetadata: compactObject({
      evidenceKind: "email_message",
      threadId: text(message.threadId) || null,
      ...(message.intakeMetadata || {}),
    }),
  };
}

function driveText(file = {}) {
  const direct = file.extractedText ?? file.text ?? file.contentText ?? file.documentText;
  if (text(direct)) return text(direct);
  if (text(file.html)) return stripHtml(file.html);
  return "";
}

export function adaptDriveFileToIntakeRecord(file = {}, options = {}) {
  const externalId = text(file.externalId || file.fileId || file.id);
  if (!externalId) throw new Error("Drive connector files require id or fileId.");
  const name = text(file.name || file.title);
  const description = text(file.description);
  const content = driveText(file);
  const normalizedText = [name && `File: ${name}`, description, content].filter(Boolean).join("\n\n");
  const extractedRefs = extractFlexDocumentRefs(normalizedText, {
    verifiedFlexDocuments: options.verifiedFlexDocuments,
    source: "drive",
  });
  const flexDocumentRefs = mergeFlexRefs(file.flexDocumentRefs || file.flexDocuments, extractedRefs);
  const shape = operationalShape({ ...file, flexDocumentRefs }, normalizedText);
  const owner = list(file.owners)[0] || file.owner || {};
  return {
    sourceType: "drive",
    connectorName: text(file.connectorName || options.connectorName || "google-drive-operational-intake"),
    connectorVersion: text(file.connectorVersion || options.connectorVersion || "v1"),
    externalId,
    externalParentId: text(file.externalParentId || list(file.parents)[0]) || null,
    externalRevisionId: text(file.externalRevisionId || file.headRevisionId || file.revisionId || file.version || file.modifiedTime) || null,
    sourceUrl: text(file.sourceUrl || file.webViewLink || file.url) || null,
    authorExternalId: text(file.authorExternalId || file.lastModifyingUser?.emailAddress || owner?.emailAddress || owner?.email || owner) || null,
    observedAt: iso(file.observedAt || file.modifiedTime || file.createdTime),
    effectiveAt: iso(file.effectiveAt || file.modifiedTime || file.createdTime),
    normalizedText,
    summary: text(file.summary || name || description || content),
    category: shape.category,
    scope: shape.scope,
    urgency: shape.urgency,
    impact: shape.impact,
    canonicalShowId: text(file.canonicalShowId || file.showId || options.canonicalShowId) || null,
    candidateShowId: text(file.candidateShowId || options.candidateShowId) || null,
    showNameHint: text(file.showNameHint || file.showName || options.showNameHint) || null,
    requiresShowMatch: file.requiresShowMatch ?? options.requiresShowMatch ?? shape.showSpecific,
    flexDocumentRefs,
    proposedUpdates: list(file.proposedUpdates),
    permissionsMetadata: compactObject({
      provider: "google_drive",
      driveId: text(file.driveId) || null,
      shared: file.shared === true,
      ownedByMe: file.ownedByMe === true,
      visibility: text(file.visibility || options.visibility) || null,
      capabilities: file.capabilities && typeof file.capabilities === "object" ? file.capabilities : {},
      ...(file.permissionsMetadata || {}),
    }),
    payload: compactObject({
      name,
      description,
      mimeType: text(file.mimeType) || null,
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      owners: list(file.owners).map(item => compactObject({
        displayName: text(item?.displayName) || null,
        emailAddress: text(item?.emailAddress || item?.email) || null,
      })),
      starred: file.starred === true,
      trashed: file.trashed === true,
      providerPayload: file.providerPayload && typeof file.providerPayload === "object" ? file.providerPayload : undefined,
    }),
    intakeMetadata: compactObject({
      evidenceKind: "drive_file",
      mimeType: text(file.mimeType) || null,
      ...(file.intakeMetadata || {}),
    }),
  };
}

function activeShowFlexDocuments(row = {}) {
  const explicit = [
    ...list(row.flexDocuments || row.documents),
    ...list(row.flex?.documents),
    row.primaryFlexDocument,
    row.flex?.primary,
  ].filter(Boolean);
  const keyDocs = text(row.keyDocs || row.activeShowsIndex?.keyDocs);
  const extracted = extractFlexDocumentRefs(keyDocs, { source: "active-show-index" });
  return mergeFlexRefs(explicit, extracted);
}

function activeShowIndexEvidenceFlexDocuments(row = {}) {
  // Source Record identity for the Active Show Index must reflect only the
  // authoritative sheet row. Live FLEX enrichment is transient: a later run
  // may verify a document, time out, or receive 429 without the sheet changing.
  // Mapped sheet rows retain their original typed references in these fields
  // even after the server adds row.flex enrichment for registry/readiness use.
  const authoritative = [
    ...list(row.flexDocuments || row.documents),
    row.primaryFlexDocument,
  ].filter(Boolean);
  if (!authoritative.length) return activeShowFlexDocuments(row);
  const keyDocs = text(row.keyDocs || row.activeShowsIndex?.keyDocs);
  const extracted = extractFlexDocumentRefs(keyDocs, { source: "active-show-index" });
  return mergeFlexRefs(authoritative, extracted);
}

export function canonicalShowFromActiveShowIndexRow(row = {}, options = {}) {
  const id = text(row.canonicalShowId || row.showId || row.showKey || row.id);
  const name = text(row.showName || row.name || row.eventName);
  if (!id || !name) throw new Error("Active Show Index rows require a stable showId and showName.");
  const documents = activeShowFlexDocuments(row);
  const primary = row.primaryFlexDocument || row.flex?.primary
    || documents.find(document => text(document.role).toLowerCase() === "primary_show_quote")
    || null;
  return {
    id,
    name,
    aliases: unique(row.aliases),
    client: text(row.client) || null,
    venue: text(row.venue || row.site) || null,
    daysOut: row.daysOut ?? null,
    status: text(row.readinessStatus || row.status) || null,
    readinessStatus: text(row.readinessStatus) || null,
    activeShowsIndex: {
      ...(row.activeShowsIndex || {}),
      client: text(row.client || row.activeShowsIndex?.client) || null,
      venue: text(row.venue || row.site || row.activeShowsIndex?.venue) || null,
      daysOut: row.daysOut ?? row.activeShowsIndex?.daysOut ?? null,
      keyDocs: text(row.keyDocs || row.activeShowsIndex?.keyDocs) || null,
      rowNumber: row.rowNumber ?? null,
    },
    flex: {
      ...(row.flex || {}),
      primary,
      documents,
      status: text(row.flex?.status) || (primary?.elementId ? "Verified" : documents.length ? "Partial" : "Missing"),
    },
    sourceMetadata: compactObject({
      sheetId: text(options.sheetId || row.sheetId) || null,
      sheetName: text(options.sheetName || row.sheetName) || null,
      rowNumber: row.rowNumber ?? null,
    }),
  };
}

export function adaptActiveShowIndexRowToIntakeRecord(row = {}, options = {}) {
  const show = canonicalShowFromActiveShowIndexRow(row, options);
  const sheetId = text(options.sheetId || row.sheetId || "active-show-index");
  const externalId = text(row.externalId) || `${sheetId}:${row.rowNumber ?? show.id}`;
  const flexDocumentRefs = activeShowIndexEvidenceFlexDocuments(row);
  const authoritativePrimary = flexDocumentRefs.find(document =>
    text(document.role).toLowerCase() === "primary_show_quote"
  ) || null;
  const authoritativeShow = canonicalShowFromActiveShowIndexRow({
    ...row,
    flexDocuments: flexDocumentRefs,
    primaryFlexDocument: authoritativePrimary,
    flex: {
      primary: authoritativePrimary,
      documents: flexDocumentRefs,
    },
  }, options);
  const normalizedText = [
    `Active Show Index: ${show.name}`,
    show.client && `Client: ${show.client}`,
    show.venue && `Venue: ${show.venue}`,
    text(row.keyDocs) && `Key documents: ${text(row.keyDocs)}`,
    text(row.notes) && `Notes: ${text(row.notes)}`,
  ].filter(Boolean).join("\n");
  return {
    sourceType: "drive",
    connectorName: "active-show-index",
    connectorVersion: text(options.connectorVersion || "v1"),
    externalId,
    externalParentId: sheetId,
    externalRevisionId: text(row.externalRevisionId || row.revisionId || row.updatedAt || options.revisionId) || null,
    sourceUrl: text(row.sourceUrl || options.sourceUrl) || null,
    authorExternalId: text(row.authorExternalId || row.updatedBy) || null,
    observedAt: iso(row.observedAt || row.updatedAt || options.observedAt),
    normalizedText,
    summary: text(row.summary || `${show.name} Active Show Index row`),
    category: text(row.category || "operations").toLowerCase(),
    scope: "show_specific",
    urgency: text(row.urgency || "normal").toLowerCase(),
    impact: text(row.impact || "minor").toLowerCase(),
    canonicalShowId: show.id,
    showNameHint: show.name,
    requiresShowMatch: true,
    flexDocumentRefs,
    proposedUpdates: list(row.proposedUpdates),
    permissionsMetadata: compactObject({
      provider: "google_sheets",
      sheetId,
      sheetName: text(options.sheetName || row.sheetName) || null,
      visibility: text(options.visibility || row.visibility) || null,
    }),
    payload: {
      row: row.row && typeof row.row === "object" ? row.row : row,
      canonicalShow: authoritativeShow,
    },
    intakeMetadata: {
      evidenceKind: "active_show_index_row",
      identityAuthority: true,
      rowNumber: row.rowNumber ?? null,
    },
  };
}

export function buildActiveShowIndexBatch(rows = [], options = {}) {
  return {
    shows: list(rows).map(row => canonicalShowFromActiveShowIndexRow(row, options)),
    records: list(rows).map(row => adaptActiveShowIndexRowToIntakeRecord(row, options)),
  };
}
