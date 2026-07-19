function text(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set((values || []).map(text).filter(Boolean))];
}

function normalizedAlias(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function documentKey(document = {}) {
  return text(document.elementId).toLowerCase()
    || `${text(document.documentNumber).toLowerCase()}:${text(document.documentType || "unknown").toLowerCase()}`;
}

function normalizeDocument(document = {}, defaults = {}) {
  const documentNumber = text(document.documentNumber || defaults.documentNumber) || null;
  if (!documentNumber) return null;
  const elementId = text(document.elementId || defaults.elementId) || null;
  const documentType = text(document.documentType || defaults.documentType || "unknown").toLowerCase();
  return {
    documentNumber,
    elementId,
    documentType,
    role: text(document.role || defaults.role || "related"),
    name: text(document.name || document.showName || defaults.name) || null,
    parentElementId: text(document.parentElementId || document.parentId || defaults.parentElementId) || null,
    status: text(document.status || defaults.status || (elementId ? "Verified" : "Unverified")),
    source: text(document.source || defaults.source || "active_shows_flex"),
    verifiedAt: document.verifiedAt || defaults.verifiedAt || null,
  };
}

function documentsFromShow(show = {}) {
  const flex = show.flex || {};
  const primaryType = text(flex.primary?.documentType || (flex.status === "Event Folder" ? "event_folder" : "unknown")).toLowerCase();
  const primary = flex.primary
    ? normalizeDocument(flex.primary, {
        documentNumber: flex.documentNumber,
        elementId: flex.elementId,
        documentType: primaryType,
        role: primaryType === "quote" ? "primary_show_quote" : "related",
        source: "active_shows_primary",
        status: "Verified",
      })
    : null;
  const documents = [
    primary,
    ...(Array.isArray(flex.documents) ? flex.documents : []).map(document => normalizeDocument(document, {
      role: text(document?.documentNumber) === text(primary?.documentNumber) ? "primary_show_quote" : "related",
      source: "active_shows_document",
    })),
    ...(Array.isArray(flex.childQuotes) ? flex.childQuotes : []).map(document => normalizeDocument(document, {
      documentType: "quote",
      role: "related",
      source: "active_shows_child",
      parentElementId: flex.eventFolder?.elementId || null,
    })),
  ].filter(Boolean);

  for (const documentNumber of unique(flex.documentNumbers || show.flexDocumentNumbers || [])) {
    if (!documents.some(document => document.documentNumber === documentNumber)) {
      documents.push(normalizeDocument({ documentNumber }, { source: "active_shows_hint" }));
    }
  }

  const byKey = new Map();
  for (const document of documents) {
    const key = documentKey(document);
    const previous = byKey.get(key);
    byKey.set(key, previous
      ? { ...previous, ...document, elementId: document.elementId || previous.elementId }
      : document);
  }
  return [...byKey.values()];
}

function humanPrimary(previous = {}) {
  const override = previous?.humanOverrides?.primaryShowQuote;
  return override?.documentNumber && override?.elementId
    ? normalizeDocument(override, { documentType: "quote", role: "primary_show_quote", source: "command_center", status: "Verified" })
    : null;
}

function automaticPrimary(show = {}, documents = []) {
  const direct = show?.flex?.primary
    ? normalizeDocument(show.flex.primary, { documentType: "unknown", role: "related", source: "active_shows_primary", status: "Verified" })
    : null;
  if (direct?.elementId && direct.documentType === "quote") return direct;
  return documents.find(document =>
    document.documentType === "quote"
    && document.role === "primary_show_quote"
    && document.elementId
    && document.status === "Verified"
  ) || null;
}

export function canonicalizeShow(show = {}, previous = {}, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const showId = text(show.id || show.showKey || previous.id);
  if (!showId) throw new Error("Canonical shows require a stable show ID.");
  const name = text(show.name || show.showName || previous.name || showId);
  const incomingDocuments = documentsFromShow(show);
  const override = humanPrimary(previous);
  const currentPrimary = override || automaticPrimary(show, incomingDocuments);
  const oldPrimary = previous?.flex?.primaryShowQuote || null;
  const primary = currentPrimary || (oldPrimary?.elementId
    ? { ...oldPrimary, status: "Verified stale", source: oldPrimary.source || "registry_previous", staleSince: oldPrimary.staleSince || timestamp }
    : null);
  const documents = [...incomingDocuments];
  if (primary && !documents.some(document => documentKey(document) === documentKey(primary))) {
    documents.unshift({ ...primary, role: "primary_show_quote" });
  }
  const index = show.activeShowsIndex || {};
  const aliases = unique([
    name,
    ...(previous.aliases || []),
    ...(show.aliases || []),
    index.client,
  ]);
  const hierarchyStatus = primary?.elementId
    ? primary.status === "Verified stale" ? "verified_stale" : "verified"
    : documents.some(document => document.elementId) ? "partial" : "unresolved";

  return {
    id: showId,
    name,
    aliases,
    normalizedAliases: unique(aliases.map(normalizedAlias)),
    lifecycle: {
      status: "active",
      firstSeenAt: previous?.lifecycle?.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      inactiveAt: null,
    },
    operationalIdentity: {
      source: "active_shows_index",
      client: text(index.client || show.client) || null,
      venue: text(show.venue || index.venue) || null,
      daysOut: index.daysOut ?? show.daysOut ?? null,
      status: text(show.readinessStatus || show.status) || null,
      keyDocs: text(index.keyDocs) || null,
      row: index,
    },
    flex: {
      status: text(show?.flex?.status) || (primary ? "Verified" : "Missing"),
      hierarchyStatus,
      primaryShowQuote: primary,
      documents,
      plannedStartDate: show?.flex?.plannedStartDate || primary?.plannedStartDate || null,
      plannedEndDate: show?.flex?.plannedEndDate || primary?.plannedEndDate || null,
      loadInDate: show?.flex?.loadInDate || primary?.loadInDate || null,
      loadOutDate: show?.flex?.loadOutDate || primary?.loadOutDate || null,
      soldDepartments: unique(show?.flex?.soldDepartments || show?.flex?.rollup?.departments || []),
      lastPullAt: show?.flex?.lastPullAt || null,
    },
    identityConfidence: hierarchyStatus === "verified" ? "high" : hierarchyStatus === "verified_stale" ? "high_stale" : hierarchyStatus === "partial" ? "medium" : "unresolved",
    humanConfirmationRequired: !primary?.elementId,
    humanOverrides: previous.humanOverrides || {},
    provenance: {
      ...(previous.provenance || {}),
      activeShowsIndex: {
        ...(previous.provenance?.activeShowsIndex || {}),
        source: options.source || "active_shows_index",
        sheetId: options.sheetId || null,
        sheetName: options.sheetName || null,
        syncedAt: timestamp,
      },
      flex: {
        ...(previous.provenance?.flex || {}),
        syncedAt: timestamp,
        primarySource: primary?.source || null,
      },
    },
    updatedAt: timestamp,
  };
}

export function buildCanonicalShowRegistry(shows = [], existingShows = {}, existingDocuments = {}, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const showRegistry = {};
  const flexDocumentRegistry = { ...(existingDocuments || {}) };
  const seen = new Set();

  for (const show of shows || []) {
    const showId = text(show?.id || show?.showKey);
    if (!showId) continue;
    seen.add(showId);
    const record = canonicalizeShow(show, existingShows?.[showId] || {}, { ...options, timestamp });
    showRegistry[showId] = record;
    for (const document of record.flex.documents) {
      const key = documentKey(document);
      const old = flexDocumentRegistry[key] || {};
      flexDocumentRegistry[key] = {
        ...old,
        ...document,
        key,
        showIds: unique([...(old.showIds || []), showId]),
        lastSeenAt: timestamp,
      };
    }
  }

  for (const [showId, previous] of Object.entries(existingShows || {})) {
    if (seen.has(showId)) continue;
    if (previous?.lifecycle?.status === "provisional") {
      showRegistry[showId] = {
        ...previous,
        lifecycle: {
          ...(previous.lifecycle || {}),
          lastSeenAt: previous?.lifecycle?.lastSeenAt || timestamp,
          inactiveAt: null,
        },
        updatedAt: previous.updatedAt || timestamp,
      };
      continue;
    }
    showRegistry[showId] = {
      ...previous,
      lifecycle: {
        ...(previous.lifecycle || {}),
        status: "inactive",
        inactiveAt: previous?.lifecycle?.inactiveAt || timestamp,
      },
      updatedAt: timestamp,
    };
  }

  return {
    showRegistry,
    flexDocumentRegistry,
    summary: {
      active: Object.values(showRegistry).filter(show => show.lifecycle?.status === "active").length,
      inactive: Object.values(showRegistry).filter(show => show.lifecycle?.status === "inactive").length,
      verified: Object.values(showRegistry).filter(show => ["verified", "verified_stale"].includes(show.flex?.hierarchyStatus)).length,
      needsConfirmation: Object.values(showRegistry).filter(show => show.lifecycle?.status === "active" && show.humanConfirmationRequired).length,
      documents: Object.keys(flexDocumentRegistry).length,
    },
  };
}

export function canonicalShowToSlackCandidate(show = {}) {
  const primary = show?.flex?.primaryShowQuote || null;
  const documents = Array.isArray(show?.flex?.documents) ? show.flex.documents : [];
  const refs = documents.map(document => ({
    documentNumber: document.documentNumber,
    elementId: document.elementId || null,
    documentType: document.documentType || "unknown",
    role: document.role || "related",
    name: document.name || null,
    parentElementId: document.parentElementId || null,
    source: document.source || "canonical_show_registry",
  }));
  return {
    showKey: show.id,
    showName: show.name,
    client: show.operationalIdentity?.client || null,
    venue: show.operationalIdentity?.venue || null,
    aliases: show.aliases || [],
    documentNumbers: unique(refs.map(ref => ref.documentNumber)),
    primaryDocumentNumber: primary?.documentNumber || null,
    elementId: primary?.elementId || null,
    documentRefs: refs,
    quoteElements: refs.filter(ref => ref.documentType === "quote").map(ref => ({ documentNumber: ref.documentNumber, elementId: ref.elementId, documentType: "quote" })),
    plannedStartDate: show.flex?.plannedStartDate || null,
    plannedEndDate: show.flex?.plannedEndDate || null,
    loadInDate: show.flex?.loadInDate || null,
    loadOutDate: show.flex?.loadOutDate || null,
    departments: show.flex?.soldDepartments || [],
    daysOut: show.operationalIdentity?.daysOut ?? null,
    status: show.operationalIdentity?.status || null,
    source: "canonical_show_registry",
    identityConfidence: show.identityConfidence || null,
  };
}
