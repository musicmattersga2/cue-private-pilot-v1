function text(value) {
  return String(value ?? "").trim();
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function normalizeActiveShowIndexHeader(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function activeShowIndexCell(row = {}, names = []) {
  for (const name of names) {
    const value = row[normalizeActiveShowIndexHeader(name)];
    if (text(value)) return text(value);
  }
  return "";
}

export function activeShowIndexRowsToObjects(csvRows = []) {
  if (!Array.isArray(csvRows) || csvRows.length < 2) return [];
  const headerRowIndex = csvRows.findIndex(row =>
    row.some(cell => /show\s*\/\s*project|event date|technical coverage|risk/i.test(text(cell)))
  );
  if (headerRowIndex < 0) return [];
  const headers = csvRows[headerRowIndex].map(text);
  return csvRows.slice(headerRowIndex + 1).map((row, index) => {
    const object = { __rowNumber: headerRowIndex + index + 2 };
    headers.forEach((header, cellIndex) => {
      const key = normalizeActiveShowIndexHeader(header);
      if (key) object[key] = row[cellIndex] || "";
    });
    return object;
  }).filter(row => activeShowIndexCell(row, ["Show / Project", "Show", "Project"]));
}

function splitDocumentNumbers(value) {
  return unique(text(value).toUpperCase().match(/\b(?:LPO)?\d{2}-\d{3,6}\b/g) || []);
}

function splitElementIds(value) {
  return unique(text(value).toLowerCase().match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g) || []);
}

function normalizedDocumentType(value, fallback = "unknown") {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/pull_?sheet|pullsheet/.test(normalized)) return "pull_sheet";
  if (/manifest/.test(normalized)) return "manifest";
  if (/purchase_?order|(^|_)lpo($|_)/.test(normalized)) return "purchase_order";
  if (/invoice/.test(normalized)) return "invoice";
  if (/event_?folder/.test(normalized)) return "event_folder";
  if (/quote/.test(normalized)) return "quote";
  return fallback;
}

function typedDocumentColumns(row = {}, sourceTruthStatus = "") {
  const groups = [
    {
      numberNames: ["Primary FLEX Quote #", "Primary FLEX Quote", "FLEX Primary Quote #"],
      elementNames: ["Primary FLEX Quote Element ID", "FLEX Primary Quote Element ID"],
      documentType: "quote",
      role: "primary_show_quote",
    },
    {
      numberNames: ["FLEX Quote #", "FLEX Quote"],
      elementNames: ["FLEX Quote Element ID", "FLEX Quote Element IDs", "FLEX Element ID", "FLEX Element IDs"],
      documentType: "quote",
      role: "related",
    },
    {
      numberNames: ["FLEX Pull Sheet #", "FLEX Pull Sheet", "FLEX Pull Sheets"],
      elementNames: ["FLEX Pull Sheet Element ID", "FLEX Pull Sheet Element IDs"],
      documentType: "pull_sheet",
      role: "related",
    },
    {
      numberNames: ["FLEX Manifest #", "FLEX Manifest", "FLEX Manifests"],
      elementNames: ["FLEX Manifest Element ID", "FLEX Manifest Element IDs"],
      documentType: "manifest",
      role: "related",
    },
    {
      numberNames: ["FLEX Purchase Order #", "FLEX Purchase Order", "FLEX LPO #", "FLEX LPO"],
      elementNames: ["FLEX Purchase Order Element ID", "FLEX LPO Element ID"],
      documentType: "purchase_order",
      role: "related",
    },
    {
      numberNames: ["FLEX Invoice #", "FLEX Invoice"],
      elementNames: ["FLEX Invoice Element ID", "FLEX Invoice Element IDs"],
      documentType: "invoice",
      role: "related",
    },
    {
      numberNames: ["FLEX Event Folder #", "FLEX Event Folder"],
      elementNames: ["FLEX Event Folder Element ID"],
      documentType: "event_folder",
      role: "related",
    },
  ];
  const documents = [];
  for (const group of groups) {
    const numbers = splitDocumentNumbers(activeShowIndexCell(row, group.numberNames));
    const elementIds = splitElementIds(activeShowIndexCell(row, group.elementNames));
    numbers.forEach((documentNumber, index) => {
      const elementId = elementIds[index] || (numbers.length === 1 && elementIds.length === 1 ? elementIds[0] : null);
      const verified = Boolean(elementId && truthStatusAllowsVerification(sourceTruthStatus));
      documents.push({
        documentNumber,
        elementId,
        documentType: group.documentType,
        role: group.role,
        status: verified ? "Verified" : "Unverified",
        verified,
        source: "active_show_index",
      });
    });
  }

  const genericNumbers = splitDocumentNumbers(activeShowIndexCell(row, ["FLEX Document #", "FLEX Document", "FLEX Documents"]));
  const genericIds = splitElementIds(activeShowIndexCell(row, ["FLEX Document Element ID", "FLEX Document Element IDs"]));
  const genericTypes = text(activeShowIndexCell(row, ["FLEX Document Type", "FLEX Document Types"]))
    .split(/[;,|]/)
    .map(value => normalizedDocumentType(value));
  genericNumbers.forEach((documentNumber, index) => {
    const elementId = genericIds[index] || (genericNumbers.length === 1 && genericIds.length === 1 ? genericIds[0] : null);
    const verified = Boolean(elementId && truthStatusAllowsVerification(sourceTruthStatus));
    documents.push({
      documentNumber,
      elementId,
      documentType: genericTypes[index] || (genericTypes.length === 1 ? genericTypes[0] : "unknown"),
      role: "related",
      status: verified ? "Verified" : "Unverified",
      verified,
      source: "active_show_index",
    });
  });

  const byIdentity = new Map();
  for (const document of documents) {
    const key = document.elementId || `${document.documentNumber}:${document.documentType}`;
    const previous = byIdentity.get(key);
    byIdentity.set(key, previous
      ? {
          ...previous,
          ...document,
          elementId: document.elementId || previous.elementId,
          role: previous.role === "primary_show_quote" || document.role === "primary_show_quote" ? "primary_show_quote" : "related",
        }
      : document);
  }
  return [...byIdentity.values()];
}

function slug(value) {
  return text(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "active-show";
}

function truthStatusAllowsVerification(value) {
  const normalized = text(value).toLowerCase();
  return !/(not authoritative|unverified|rejected|superseded|do not use)/.test(normalized);
}

export function mapActiveShowIndexAuthorityRow(row = {}, options = {}) {
  const cell = (...names) => activeShowIndexCell(row, names);
  const name = cell("Show / Project", "Show", "Project");
  if (!name) throw new Error("Active Show Index row is missing Show / Project.");
  const sourceTruthStatus = cell("Source-of-Truth Status");
  const documents = typedDocumentColumns(row, sourceTruthStatus);
  const quotes = documents.filter(document => document.documentType === "quote");
  const explicitPrimary = quotes.find(document => document.role === "primary_show_quote" && document.elementId) || null;
  const primary = explicitPrimary || (quotes.length === 1 && quotes[0].elementId ? { ...quotes[0], role: "primary_show_quote" } : null);
  if (primary) {
    const index = documents.findIndex(document => document.documentNumber === primary.documentNumber && document.documentType === "quote");
    if (index >= 0) documents[index] = primary;
  }
  const documentNumbers = unique(documents.map(document => document.documentNumber));
  const eventDate = cell("Event Date");
  const daysOut = cell("Days Out");
  const status = cell("Status");
  const client = cell("Client / Account", "Client", "Account");
  const venue = cell("Venue / Site", "Venue", "Site");
  const keyDocs = cell("Key Docs / Subfolders Found", "Key Docs");
  const technicalCoverage = cell("Technical Coverage");
  const risk = cell("Risk / Missing Items", "Risk", "Missing Items");
  const priority = cell("Priority") || "Medium";
  const lastMapped = cell("Last Mapped");
  const rowNumber = Number(row.__rowNumber || row.rowNumber || 0) || null;
  const activeShowsIndex = {
    eventDate: eventDate || null,
    daysOut: daysOut || null,
    client: client || null,
    venue: venue || null,
    showFolder: cell("Show Folder") || null,
    keyDocs: keyDocs || null,
    technicalCoverage: technicalCoverage || null,
    risk: risk || null,
    lastMapped: lastMapped || null,
    slackSignal: cell("Slack Signal") || null,
    sourceTruthStatus: sourceTruthStatus || null,
    rowHealth: cell("Row Health / Sanity Status") || null,
    owner: cell("Owner / PM") || null,
    owners: {
      audio: cell("Audio Owner") || null,
      lighting: cell("Lighting Owner") || null,
      video: cell("Video Owner") || null,
      rigging: cell("Rigging Owner") || null,
      trucking: cell("Trucking Owner") || null,
      warehouse: cell("Warehouse Owner") || null,
    },
    reviewedBy: cell("Reviewed By") || null,
    reviewedTimestamp: cell("Reviewed Timestamp") || null,
    signalCategory: cell("Signal Category") || null,
    publishedPackageCandidate: cell("Published Package Candidate") || null,
    supersedesWorkingSource: cell("Supersedes Working Source?") || null,
    nextUnresolvedRun: cell("Next Unresolved Run") || null,
    activeRunWindow: cell("Active Run Window") || null,
    rowNumber,
  };
  return {
    id: slug(name),
    canonicalShowId: slug(name),
    showId: slug(name),
    name,
    showName: name,
    rowNumber,
    sheetId: options.sheetId || null,
    sheetName: options.sheetName || null,
    client: client || null,
    venue: venue || null,
    daysOut: daysOut || null,
    keyDocs: keyDocs || null,
    timing: [eventDate, daysOut ? `${daysOut} days out` : ""].filter(Boolean).join(" / "),
    priority,
    readinessStatus: status || "Active",
    changeSignal: lastMapped ? `Active Shows Index - last mapped ${lastMapped}` : "Active Shows Index",
    topIssue: risk || "No risk/missing-items note mapped in Active Shows Index.",
    nextAction: risk || "Review the authoritative Active Shows Index row and confirm readiness.",
    flexSignal: [keyDocs, technicalCoverage, risk].filter(Boolean).join(" "),
    trucking: risk || technicalCoverage || "No trucking note mapped in Active Shows Index row.",
    flexDocuments: documents,
    primaryFlexDocument: primary,
    flex: {
      status: primary ? "Verified" : documents.some(document => document.elementId) ? "Partial" : "Missing",
      primary,
      documents,
      documentNumbers,
    },
    activeShowsIndex,
    row,
  };
}

export function extractActiveShowFlexDocumentRefs(show = {}) {
  const primaryCandidates = [
    show?.flex?.primary,
    show?.primaryFlexDocument,
  ].filter(Boolean);
  const candidates = [
    ...primaryCandidates,
    ...(show?.flexDocuments || []),
    ...(show?.flex?.documents || []),
    ...(show?.flex?.childQuotes || []),
    show?.flex?.eventFolder,
    show?.flex?.documentNumber || show?.flex?.elementId
      ? {
          documentNumber: show?.flex?.documentNumber,
          elementId: show?.flex?.elementId,
          documentType: show?.flex?.documentType || show?.flex?.matchType,
          status: show?.flex?.status,
        }
      : null,
  ].filter(Boolean);
  const primaryObjects = new Set(primaryCandidates);
  const byIdentity = new Map();

  for (const candidate of candidates) {
    const documentNumber = splitDocumentNumbers(candidate?.documentNumber || candidate?.number || "")[0] || null;
    const elementId = splitElementIds(candidate?.elementId || candidate?.id || "")[0] || null;
    if (!documentNumber && !elementId) continue;
    const role = candidate?.role === "primary_show_quote" || primaryObjects.has(candidate)
      ? "primary_show_quote"
      : candidate?.role || "related";
    const documentType = normalizedDocumentType(
      candidate?.documentType || candidate?.type || candidate?.definitionName,
      role === "primary_show_quote" ? "quote" : "unknown"
    );
    const reference = {
      documentNumber,
      elementId,
      documentType,
      role,
      parentElementId: splitElementIds(candidate?.parentElementId || candidate?.parentId || "")[0] || null,
      status: text(candidate?.status) || null,
      verified: candidate?.verified === true || text(candidate?.status).toLowerCase() === "verified",
      source: text(candidate?.source) || "active_show_index",
    };
    const key = elementId || `${documentNumber}:${documentType}`;
    const previous = byIdentity.get(key);
    byIdentity.set(key, previous
      ? {
          ...previous,
          ...reference,
          documentNumber: reference.documentNumber || previous.documentNumber,
          elementId: reference.elementId || previous.elementId,
          documentType: reference.documentType !== "unknown" ? reference.documentType : previous.documentType,
          role: previous.role === "primary_show_quote" || reference.role === "primary_show_quote"
            ? "primary_show_quote"
            : reference.role,
          parentElementId: reference.parentElementId || previous.parentElementId,
          verified: previous.verified || reference.verified,
        }
      : reference);
  }

  return [...byIdentity.values()];
}

export function extractActiveShowFlexDocumentNumbers(show = {}) {
  const references = extractActiveShowFlexDocumentRefs(show);
  const structured = [
    ...references.map(reference => reference.documentNumber),
    show?.flex?.documentNumber,
    show?.flex?.primary?.documentNumber,
    show?.primaryFlexDocument?.documentNumber,
    ...(show?.flex?.documentNumbers || []),
    ...(show?.flexDocuments || []).map(document => document?.documentNumber),
    ...(show?.flex?.documents || []).map(document => document?.documentNumber),
    ...(show?.flex?.childQuotes || []).map(document => document?.documentNumber),
  ];
  const narrative = [
    show.id,
    show.name,
    show.timing,
    show.priority,
    show.readinessStatus,
    show.changeSignal,
    show.topIssue,
    show.nextAction,
    show.flexSignal,
    show.trucking,
  ].filter(Boolean).join(" ");
  return unique([
    ...structured,
    ...splitDocumentNumbers(narrative),
  ]);
}

export function summarizeActiveShowFlexEnrichment(shows = []) {
  const documents = shows.flatMap(show => (show?.flex?.documents || []).map(document => ({
    showId: show.id || show.canonicalShowId || show.showId || null,
    showName: show.name || show.showName || null,
    documentNumber: document?.documentNumber || null,
    elementId: document?.elementId || null,
    status: document?.status || "Unknown",
    reason: document?.skipReason || null,
    message: document?.message || null,
  })));
  const skippedDocuments = documents.filter(document => document.status === "Skipped");
  const errorDocuments = documents.filter(document => document.status === "Error");
  return {
    shows: shows.length,
    verifiedShows: shows.filter(show => show?.flex?.status === "Verified").length,
    partialShows: shows.filter(show => show?.flex?.status === "Partial").length,
    missingShows: shows.filter(show => show?.flex?.status === "Missing").length,
    errorShows: shows.filter(show => show?.flex?.status === "Error").length,
    documents: documents.length,
    verifiedDocuments: documents.filter(document => document.status === "Verified").length,
    skippedDocuments,
    errorDocuments,
  };
}

export async function runSourceFirstIntakeSync(options = {}) {
  const stages = [];
  if (options.discoverFlexQuoteStatuses) {
    const result = await options.discoverFlexQuoteStatuses();
    stages.push({
      name: "flex_quote_discovery",
      status: result?.available === false ? "skipped" : result?.ok === false ? "failed" : "completed",
      reason: result?.available === false ? result.status : null,
      result,
    });
  }
  if (options.flexQuoteStatuses?.length && options.observeFlexQuoteStatuses) {
    const result = await options.observeFlexQuoteStatuses(options.flexQuoteStatuses);
    stages.push({ name: "flex_quote_confirmations", status: "completed", result });
  }
  const source = await options.loadActiveShowIndex();
  if (source?.usedFallback) {
    stages.push({ name: "active_show_index", status: "skipped", reason: "fallback_not_authoritative" });
  } else {
    const preparedShows = options.prepareActiveShows
      ? await options.prepareActiveShows(source.shows || [])
      : source.shows || [];
    const flexEnrichment = summarizeActiveShowFlexEnrichment(preparedShows);
    const registry = await options.syncCanonicalRegistry(preparedShows, source);
    const enrichmentPartial = flexEnrichment.skippedDocuments.length > 0 || flexEnrichment.errorDocuments.length > 0;
    stages.push({
      name: "active_show_index",
      status: enrichmentPartial ? "partial" : "completed",
      count: preparedShows.length,
      registry,
      flexEnrichment,
    });
    if (options.ingestActiveShowIndex) {
      const intake = await options.ingestActiveShowIndex(preparedShows, source);
      stages.push({ name: "active_show_index_evidence", status: "completed", intake });
    }
  }
  const verifiedFlexDocuments = options.getVerifiedFlexDocuments
    ? await options.getVerifiedFlexDocuments()
    : [];
  if (options.emailMessages?.length && options.ingestEmail) {
    const result = await options.ingestEmail(options.emailMessages, verifiedFlexDocuments);
    stages.push({ name: "email", status: "completed", result });
  }
  if (options.driveFiles?.length && options.ingestDrive) {
    const result = await options.ingestDrive(options.driveFiles, verifiedFlexDocuments);
    stages.push({ name: "drive", status: "completed", result });
  }
  if (options.syncSlack) {
    const result = await options.syncSlack();
    stages.push({ name: "slack", status: "completed", result });
  }
  const failedStages = stages.filter(stage => stage.status === "failed");
  const partialStages = stages.filter(stage => stage.status === "partial");
  return {
    ok: failedStages.length === 0 && partialStages.length === 0,
    degraded: failedStages.length > 0 || partialStages.length > 0,
    sourceFirst: true,
    authoritativeSourceAvailable: !source?.usedFallback,
    failedStages: failedStages.map(stage => stage.name),
    partialStages: partialStages.map(stage => stage.name),
    stages,
  };
}
