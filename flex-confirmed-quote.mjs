function text(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeFlexQuoteStatus(value) {
  return text(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isConfirmedFlexQuoteStatus(value, options = {}) {
  const status = normalizeFlexQuoteStatus(value);
  if (!status) return false;
  const configured = (options.confirmedStatuses || [])
    .map(normalizeFlexQuoteStatus)
    .filter(Boolean);
  if (configured.includes(status)) return true;
  return [
    "confirmed",
    "confirmed quote",
    "quote confirmed",
    "confirmation complete",
  ].includes(status);
}

export function normalizeConfirmedQuoteObservation(input = {}, options = {}) {
  const elementId = text(input.elementId || input.quoteElementId).toLowerCase();
  const documentNumber = text(input.documentNumber || input.quoteNumber).toUpperCase();
  const documentType = text(input.documentType || "quote").toLowerCase();
  const status = text(input.status || input.currentStatus || input.workflowStatus);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(elementId)) {
    throw new Error("A valid FLEX quote elementId is required.");
  }
  if (!/^\d{2}-\d{3,6}$/.test(documentNumber)) {
    throw new Error("A valid FLEX quote documentNumber is required.");
  }
  if (documentType !== "quote") {
    throw new Error("Only FLEX quotes can trigger show confirmation.");
  }
  if (!status) throw new Error("A FLEX quote status is required.");

  const observedAt = text(input.observedAt) || options.timestamp || new Date().toISOString();
  const changedAt = text(input.changedAt || input.statusChangedAt) || null;
  return {
    elementId,
    documentNumber,
    documentType: "quote",
    status,
    normalizedStatus: normalizeFlexQuoteStatus(status),
    confirmed: isConfirmedFlexQuoteStatus(status, options),
    observedAt,
    changedAt,
    showName: text(input.showName || input.name) || `FLEX Quote ${documentNumber}`,
    client: text(input.client) || null,
    venue: text(input.venue) || null,
    plannedStartDate: text(input.plannedStartDate) || null,
    plannedEndDate: text(input.plannedEndDate) || null,
    loadInDate: text(input.loadInDate) || null,
    loadOutDate: text(input.loadOutDate) || null,
    projectManager: text(input.projectManager) || null,
    source: text(input.source) || "flex_quote_status",
    sourceEventId: text(input.sourceEventId || input.statusEventId) || null,
    provisionalShowId: text(input.provisionalShowId) || `flex-quote-${slug(documentNumber)}`,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

export function buildProvisionalShowFromConfirmedQuote(observation, previous = {}) {
  const timestamp = observation.changedAt || observation.observedAt;
  const primary = {
    documentNumber: observation.documentNumber,
    elementId: observation.elementId,
    documentType: "quote",
    role: "primary_show_quote",
    name: observation.showName,
    status: "Verified",
    source: observation.source,
    verifiedAt: observation.observedAt,
  };
  return {
    id: observation.provisionalShowId,
    name: observation.showName,
    aliases: [...new Set([observation.showName, ...(previous.aliases || [])].filter(Boolean))],
    normalizedAliases: [...new Set([slug(observation.showName).replace(/-/g, " "), ...(previous.normalizedAliases || [])].filter(Boolean))],
    lifecycle: {
      status: "provisional",
      stage: "awaiting_active_show_index",
      firstSeenAt: previous.lifecycle?.firstSeenAt || timestamp,
      lastSeenAt: observation.observedAt,
      inactiveAt: null,
    },
    operationalIdentity: {
      ...(previous.operationalIdentity || {}),
      source: "flex_confirmed_quote",
      client: observation.client,
      venue: observation.venue,
      status: "Awaiting Active Show Index",
      row: null,
    },
    flex: {
      ...(previous.flex || {}),
      status: "Confirmed",
      hierarchyStatus: "verified",
      primaryShowQuote: primary,
      documents: [
        ...(previous.flex?.documents || []).filter(document => document.elementId !== observation.elementId),
        primary,
      ],
      plannedStartDate: observation.plannedStartDate,
      plannedEndDate: observation.plannedEndDate,
      loadInDate: observation.loadInDate,
      loadOutDate: observation.loadOutDate,
      soldDepartments: previous.flex?.soldDepartments || [],
      lastPullAt: observation.observedAt,
    },
    identityConfidence: "high",
    humanConfirmationRequired: false,
    humanOverrides: previous.humanOverrides || {},
    provenance: {
      ...(previous.provenance || {}),
      flexConfirmation: {
        source: observation.source,
        sourceEventId: observation.sourceEventId,
        status: observation.status,
        changedAt: observation.changedAt,
        observedAt: observation.observedAt,
      },
    },
    updatedAt: observation.observedAt,
  };
}

export function confirmedQuoteMatchesShow(observationOrShow = {}, show = {}) {
  const sourceFlex = observationOrShow.flex || {};
  const sourcePrimary = sourceFlex.primaryShowQuote || observationOrShow;
  const sourceElementId = text(sourcePrimary.elementId).toLowerCase();
  const sourceDocumentNumber = text(sourcePrimary.documentNumber).toUpperCase();
  const candidates = [
    show.flex?.primary,
    show.flex?.primaryShowQuote,
    ...(show.flex?.documents || []),
    ...(show.flexDocuments || []),
  ].filter(Boolean);
  if (sourceElementId && candidates.some(candidate => text(candidate.elementId).toLowerCase() === sourceElementId)) return true;
  return Boolean(sourceDocumentNumber && candidates.some(candidate =>
    text(candidate.documentNumber).toUpperCase() === sourceDocumentNumber
    && text(candidate.documentType || "quote").toLowerCase() === "quote"
  ));
}
