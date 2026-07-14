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
  return unique(text(value).toUpperCase().match(/\b(?:LPO)?\d{2}-\d{4}\b/g) || []);
}

function splitElementIds(value) {
  return unique(text(value).toLowerCase().match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g) || []);
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
  const quoteNumbers = splitDocumentNumbers(cell("FLEX Quote #", "FLEX Quote", "FLEX Document #"));
  const elementIds = splitElementIds(cell("FLEX Element ID", "FLEX Element IDs"));
  const sourceTruthStatus = cell("Source-of-Truth Status");
  const documents = quoteNumbers.map((documentNumber, index) => {
    const elementId = elementIds[index] || (quoteNumbers.length === 1 && elementIds.length === 1 ? elementIds[0] : null);
    const verified = Boolean(elementId && truthStatusAllowsVerification(sourceTruthStatus));
    return {
      documentNumber,
      elementId,
      documentType: "quote",
      role: quoteNumbers.length === 1 ? "primary_show_quote" : "related",
      status: verified ? "Verified" : "Unverified",
      verified,
      source: "active_show_index",
    };
  });
  const primary = documents.length === 1 && documents[0].elementId ? documents[0] : null;
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
      documentNumbers: quoteNumbers,
    },
    activeShowsIndex,
    row,
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
    const registry = await options.syncCanonicalRegistry(preparedShows, source);
    stages.push({ name: "active_show_index", status: "completed", count: preparedShows.length, registry });
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
  return {
    ok: failedStages.length === 0,
    degraded: failedStages.length > 0,
    sourceFirst: true,
    authoritativeSourceAvailable: !source?.usedFallback,
    failedStages: failedStages.map(stage => stage.name),
    stages,
  };
}
