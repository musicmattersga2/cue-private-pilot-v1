import crypto from "crypto";

export const CUE_SOURCE_TYPES = Object.freeze([
  "flex",
  "slack",
  "email",
  "drive",
  "motive",
  "cue_staffing",
  "cue_trucking",
  "cue_warehouse",
  "manual",
  "system",
]);

const SOURCE_TYPE_SET = new Set(CUE_SOURCE_TYPES);

const DEFAULT_AUTHORITY = Object.freeze({
  flex: { tier: "identity_authority", identityAuthority: true, rank: 100 },
  drive: { tier: "evidence", identityAuthority: false, rank: 55 },
  cue_staffing: { tier: "native_module", identityAuthority: false, rank: 80 },
  cue_trucking: { tier: "native_module", identityAuthority: false, rank: 80 },
  cue_warehouse: { tier: "native_module", identityAuthority: false, rank: 80 },
  motive: { tier: "native_module", identityAuthority: false, rank: 75 },
  email: { tier: "evidence", identityAuthority: false, rank: 50 },
  slack: { tier: "evidence", identityAuthority: false, rank: 40 },
  manual: { tier: "human_authority", identityAuthority: true, rank: 100 },
  system: { tier: "system", identityAuthority: false, rank: 90 },
});

function text(value) {
  return String(value ?? "").trim();
}

function iso(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordId(sourceType, externalId, contentHash) {
  return `src_${hash(`${sourceType}:${externalId}:${contentHash}`).slice(0, 24)}`;
}

export function normalizeFlexDocumentRef(input = {}) {
  const documentNumber = text(input.documentNumber || input.number) || null;
  const elementId = text(input.elementId || input.uuid) || null;
  if (!documentNumber && !elementId) return null;
  return {
    documentNumber,
    elementId,
    documentType: text(input.documentType || input.type || "unknown").toLowerCase(),
    role: text(input.role || "mentioned_source").toLowerCase(),
    parentElementId: text(input.parentElementId || input.parentId) || null,
    flexUrl: text(input.flexUrl || input.url) || null,
    verified: input.verified === true || text(input.status).toLowerCase() === "verified",
    source: text(input.source || "connector"),
  };
}

export function sourceAuthority(sourceType, connectorName = "") {
  const normalizedSource = text(sourceType).toLowerCase();
  const normalizedConnector = text(connectorName).toLowerCase();
  if (normalizedSource === "drive" && normalizedConnector === "active-show-index") {
    return { tier: "identity_authority", identityAuthority: true, rank: 95 };
  }
  return { ...(DEFAULT_AUTHORITY[normalizedSource] || { tier: "evidence", identityAuthority: false, rank: 0 }) };
}

/**
 * Convert any connector output to the immutable CUE Source Record contract.
 * Connectors may supply identity hints, but only the foundation store decides
 * whether those hints are authoritative enough to attach to a show.
 */
export function normalizeConnectorRecord(input = {}, options = {}) {
  const sourceType = text(input.sourceType || options.sourceType).toLowerCase();
  if (!SOURCE_TYPE_SET.has(sourceType)) {
    throw new Error(`Unsupported CUE source type: ${sourceType || "(missing)"}.`);
  }
  const externalId = text(input.externalId);
  if (!externalId) throw new Error("Connector records require externalId.");
  const connectorName = text(input.connectorName || options.connectorName || sourceType);
  const connectorVersion = text(input.connectorVersion || options.connectorVersion || "v1");
  const normalizedText = text(input.normalizedText ?? input.text ?? input.summary);
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const flexDocumentRefs = (input.flexDocumentRefs || input.flexDocuments || [])
    .map(normalizeFlexDocumentRef)
    .filter(Boolean);
  const contentHash = text(input.contentHash) || hash(stable({
    normalizedText,
    payload,
    externalRevisionId: input.externalRevisionId || null,
    flexDocumentRefs,
  }));
  const authority = sourceAuthority(sourceType, connectorName);
  const ingestedAt = iso(input.ingestedAt, options.timestamp || new Date().toISOString());
  const observedAt = iso(input.observedAt, ingestedAt);
  const sourceRecord = {
    id: recordId(sourceType, externalId, contentHash),
    sourceType,
    externalId,
    externalParentId: text(input.externalParentId) || null,
    externalRevisionId: text(input.externalRevisionId) || null,
    sourceUrl: text(input.sourceUrl) || null,
    authorExternalId: text(input.authorExternalId) || null,
    observedAt,
    effectiveAt: iso(input.effectiveAt, observedAt),
    ingestedAt,
    contentHash,
    normalizedText,
    connectorName,
    connectorVersion,
    schemaVersion: Number(input.schemaVersion || options.schemaVersion || 1),
    authority,
    permissionsMetadata: input.permissionsMetadata && typeof input.permissionsMetadata === "object"
      ? input.permissionsMetadata
      : {},
    payload,
  };
  return {
    sourceRecord,
    intake: {
      category: text(input.category || input.domain || "operations").toLowerCase(),
      scope: text(input.scope || "show_specific").toLowerCase(),
      urgency: text(input.urgency || "normal").toLowerCase(),
      impact: text(input.impact || "minor").toLowerCase(),
      summary: text(input.summary || normalizedText),
      canonicalShowId: text(input.canonicalShowId || input.showId) || null,
      candidateShowId: text(input.candidateShowId) || null,
      showNameHint: text(input.showNameHint || input.showName) || null,
      requiresShowMatch: input.requiresShowMatch !== false,
      flexDocumentRefs,
      proposedUpdates: Array.isArray(input.proposedUpdates) ? input.proposedUpdates : [],
      metadata: input.intakeMetadata && typeof input.intakeMetadata === "object"
        ? input.intakeMetadata
        : {},
    },
  };
}

export function connectorRunId(connectorName, startedAt, cursor = null) {
  return `run_${hash(`${connectorName}:${startedAt}:${cursor || ""}`).slice(0, 24)}`;
}

export function uniqueStrings(values) {
  return unique((values || []).map(text));
}
