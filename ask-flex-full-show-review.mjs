/**
 * ASK-FLEX-002 — Cross-Source Show Operational Review
 *
 * Analyzes a whole show across FLEX, Trucking Weekly Runs, and Active Shows Index.
 * Distinct from document_operational_analysis (single FLEX quote).
 */

const MAX_FLEX_QUOTES = 8;
const QUOTE_NUMBER_RE = /\b\d{2}-\d{3,6}\b/g;

const ACTIVE_SHOWS_INDEX_SHEET_ID =
  process.env.ACTIVE_SHOWS_INDEX_SHEET_ID ||
  "1U0rotUCZ2o5gUMkZb5hDfIzALA1SAQOmsVXYJJ9-ajc";

const ACTIVE_SHOWS_INDEX_SHEET_NAME =
  process.env.ACTIVE_SHOWS_INDEX_SHEET_NAME || "Active Shows Index";

const MOCK_ACTIVE_SHOWS = [
  {
    id: "desibels-raleigh",
    name: "Desibels Raleigh",
    timing: "Live / Active Today",
    priority: "High",
    readinessStatus: "RED - Day-of attention",
    changeSignal: "Cyan - trucking/docs improved",
    topIssue:
      "Final day-of checks; confirm V2 patch relationship and show command sheet owner.",
    nextAction:
      "PM to validate final tech package, onsite labor, and day-of execution notes.",
    flexSignal:
      "FLEX match needed from authoritative FLEX engine. Trucking hints: 26-1603; 26-1624.",
    trucking: "Driver/truck mapped. Use trucking only as execution evidence.",
  },
  {
    id: "fifa-final-piedmont",
    name: "FIFA Final Piedmont Park",
    timing: "16 days out",
    priority: "High",
    readinessStatus: "MAGENTA - Needs confirmation",
    changeSignal: "Cyan - new global PDF / coverage improved",
    topIssue:
      "Need to confirm global A001 PDF against ROS, logistics, production grid, LED engineering, and trucking.",
    nextAction: "Pull authoritative FLEX scope and separate each quote/workstream.",
    flexSignal:
      "Ask FLEX should identify official FLEX records; trucking hints include multiple quote numbers.",
    trucking: "Many rows mapped; Info Sent / LPO Sent remain FALSE.",
  },
  {
    id: "sound-haven",
    name: "Sound Haven",
    timing: "27 days out",
    priority: "High",
    readinessStatus: "MAGENTA - Needs follow-up",
    changeSignal: "Cyan - rigging/trucking improved",
    topIssue:
      "Rigging control improved, but PM owner and final tech/labor coverage are unclear.",
    nextAction:
      "Confirm PM owner, final v2.0 tech pack, rigging sign-off, and trucking Info/LPO.",
    flexSignal: "Use Ask FLEX to confirm official FLEX record. Trucking hint: 26-1421.",
    trucking: "Maybe truck rows; load-out NEED DRIVER; Info/LPO FALSE.",
  },
  {
    id: "summer-x-games-nola",
    name: "Summer X Games NOLA",
    timing: "20 days out",
    priority: "High",
    readinessStatus: "MAGENTA - Strong docs, open ops gaps",
    changeSignal: "Cyan - logistics/trucking coverage found",
    topIssue:
      "Strong V2.5 package, but logistics/trucking need validation and Info/LPO are FALSE.",
    nextAction:
      "Pull official FLEX scope and compare audio, lighting, LED/cameras, and maybe truck.",
    flexSignal: "Trucking hints: 26-0714; 26-0715; 26-0716; 26-0717.",
    trucking: "Drivers mapped for main trucks; maybe truck unresolved; Info/LPO FALSE.",
  },
  {
    id: "production-design-associates",
    name: "Production Design Associates",
    timing: "Date check / trucking starts 7/5",
    priority: "High",
    readinessStatus: "RED - Very soon trucking/date conflict",
    changeSignal: "Cyan - trucking found",
    topIssue:
      "Folder date suggests 7/26, but trucking begins 7/5 with load-in 7/6.",
    nextAction:
      "Confirm real event date, Charleston trucking tie-in, folder naming, PM owner, and Info Sent FALSE.",
    flexSignal: "Use Ask FLEX to confirm whether 26-1777 is authoritative FLEX record.",
    trucking: "Runs found on 7/5, 7/6, 7/7. Driver/LPO true; Info Sent FALSE.",
  },
];

const SHOW_OPS_INTENT_PATTERNS = [
  /\bfull\s+operational\s+review\b/i,
  /\bfull\s+show\s+review\b/i,
  /\bfull\s+review\s+of\b/i,
  /\bwhole\s+show\b/i,
  /\bentire\s+show\b/i,
  /\bcross[- ]source\b/i,
  /\boverall\s+show\b/i,
  /\breal\s+operational\s+(?:picture|risks?)\b/i,
  /\bcue\s+operational\s+(?:review|picture)\b/i,
  /\boperational\s+picture\b/i,
  /\bflex\s+and\s+trucking\b/i,
  /\bstaffing\s+and\s+trucking\b/i,
  /\ball\s+related\s+quotes\b/i,
  /\breview\s+flex[, ]+\s*trucking\b/i,
  /\bflex[, ]+\s*trucking[, ]+\s*staffing\b/i,
  /\bacross\s+(?:all\s+)?(?:connected\s+)?sources?\b/i,
  /\bfull\s+show\s+operational\b/i,
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function clampEnum(value, allowed, fallback) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  const match = allowed.find((item) => item.toLowerCase() === lower);
  return match || fallback;
}

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyShowName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "active-show";
}

function extractQuoteNumbersFromText(text) {
  const matches = String(text || "").match(QUOTE_NUMBER_RE) || [];
  return [...new Set(matches.map((item) => item.trim()))];
}

function looksLikeInvoice(match) {
  const type = String(match?.type || "").toLowerCase();
  const name = String(match?.name || match?.rawSearchName || "").toLowerCase();
  if (/\binvoice\b/.test(type)) return true;
  if (/\binvoice\b/.test(name) && !/\bquote\b/.test(name)) return true;
  return false;
}

function looksLikeQuoteForm(match) {
  const type = String(match?.type || "").toLowerCase();
  const name = String(match?.name || match?.rawSearchName || "").toLowerCase();
  if (/\bquote\b/.test(type)) return true;
  if (/\bquote\b/.test(name)) return true;
  if (match?.documentNumber && !looksLikeInvoice(match)) return true;
  return false;
}

function hasAssignedProjectManager(value) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (text === "—" || /^not assigned$/i.test(text)) return false;
  return true;
}

function detectEquipmentFamilies(items) {
  const names = (Array.isArray(items) ? items : [])
    .map((item) => String(item?.name || "").toLowerCase())
    .filter(Boolean);
  const joined = names.join(" | ");

  return [
    /\bled|video\b/i.test(joined) ? "Video / LED" : null,
    /\baudio|speaker|pa|console|mic\b/i.test(joined) ? "Audio" : null,
    /\blight|fixture|lamp\b/i.test(joined) ? "Lighting" : null,
    /\btruss|rigging|motor|hoist\b/i.test(joined) ? "Rigging / Truss" : null,
    /\bpower|distro|feeder|generator\b/i.test(joined) ? "Power" : null,
    /\bcable|snake|fiber\b/i.test(joined) ? "Cable / Infrastructure" : null,
  ].filter(Boolean);
}

function parseCsvRowsLocal(csvText) {
  const rows = [];
  let row = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"' && insideQuotes && next === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      value = "";
      if (row.some((cell) => String(cell || "").trim() !== "")) rows.push(row);
      row = [];
      continue;
    }

    value += char;
  }

  row.push(value);
  if (row.some((cell) => String(cell || "").trim() !== "")) rows.push(row);
  return rows;
}

function normalizeActiveShowsHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getActiveShowsCell(rowObject, names) {
  for (const name of names) {
    const key = normalizeActiveShowsHeader(name);
    if (rowObject[key] != null && String(rowObject[key]).trim() !== "") {
      return String(rowObject[key]).trim();
    }
  }
  return "";
}

function activeShowsIndexRowsToObjects(csvRows) {
  if (!Array.isArray(csvRows) || csvRows.length < 2) return [];

  const headerRowIndex = csvRows.findIndex((row) =>
    row.some((cell) =>
      /show\s*\/\s*project|event date|technical coverage|risk/i.test(String(cell || ""))
    )
  );
  if (headerRowIndex < 0) return [];

  const headers = csvRows[headerRowIndex].map((header) => String(header || "").trim());
  const dataRows = csvRows.slice(headerRowIndex + 1);

  return dataRows
    .map((row) => {
      const object = {};
      headers.forEach((header, index) => {
        const key = normalizeActiveShowsHeader(header);
        if (!key) return;
        object[key] = row[index] || "";
      });
      return object;
    })
    .filter((rowObject) =>
      getActiveShowsCell(rowObject, ["Show / Project", "Show", "Project"])
    );
}

function mapActiveShowsIndexRow(rowObject) {
  const name = getActiveShowsCell(rowObject, ["Show / Project", "Show", "Project"]);
  const eventDate = getActiveShowsCell(rowObject, ["Event Date"]);
  const daysOut = getActiveShowsCell(rowObject, ["Days Out"]);
  const status = getActiveShowsCell(rowObject, ["Status"]);
  const client = getActiveShowsCell(rowObject, ["Client / Account", "Client", "Account"]);
  const keyDocs = getActiveShowsCell(rowObject, ["Key Docs / Subfolders Found", "Key Docs"]);
  const technicalCoverage = getActiveShowsCell(rowObject, ["Technical Coverage"]);
  const risk = getActiveShowsCell(rowObject, ["Risk / Missing Items", "Risk", "Missing Items"]);
  const priority = getActiveShowsCell(rowObject, ["Priority"]);
  const lastMapped = getActiveShowsCell(rowObject, ["Last Mapped"]);

  return {
    id: slugifyShowName(name),
    name,
    timing: [eventDate, daysOut ? `${daysOut} days out` : ""].filter(Boolean).join(" / "),
    priority: priority || "Medium",
    readinessStatus: status || "Active",
    changeSignal: lastMapped ? `Drive Index - last mapped ${lastMapped}` : "Drive Index",
    topIssue: risk || "No risk/missing-items note mapped in Active Shows Index.",
    nextAction: risk || "Review current Active Shows Index row and confirm owner / readiness status.",
    flexSignal: [keyDocs, technicalCoverage, risk].filter(Boolean).join(" "),
    trucking: risk || technicalCoverage || "No trucking note mapped in Active Shows Index row.",
    technicalCoverage: technicalCoverage || null,
    risk: risk || null,
    activeShowsIndex: {
      eventDate: eventDate || null,
      daysOut: daysOut || null,
      client: client || null,
      technicalCoverage: technicalCoverage || null,
      risk: risk || null,
    },
  };
}

async function fetchActiveShowsFromIndexSheet(parseCsvRows) {
  const parse = typeof parseCsvRows === "function" ? parseCsvRows : parseCsvRowsLocal;
  const sheetName = encodeURIComponent(ACTIVE_SHOWS_INDEX_SHEET_NAME);
  const urls = [
    `https://docs.google.com/spreadsheets/d/${ACTIVE_SHOWS_INDEX_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${sheetName}`,
    `https://docs.google.com/spreadsheets/d/${ACTIVE_SHOWS_INDEX_SHEET_ID}/export?format=csv&sheet=${sheetName}`,
  ];

  let lastError = null;

  for (const csvUrl of urls) {
    try {
      const response = await fetch(csvUrl);
      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Active Shows Index CSV request failed: ${response.status} ${response.statusText}`
        );
      }

      if (/<!doctype html>|<html/i.test(text)) {
        throw new Error(
          "Active Shows Index returned HTML instead of CSV. The sheet may not be readable by this server."
        );
      }

      const csvRows = parse(text);
      const rowObjects = activeShowsIndexRowsToObjects(csvRows);
      const shows = rowObjects.map(mapActiveShowsIndexRow);

      if (!shows.length) {
        throw new Error("No parseable Active Shows Index rows found in CSV.");
      }

      return {
        source: "Active Shows Index Google Sheet",
        usedFallback: false,
        sheetId: ACTIVE_SHOWS_INDEX_SHEET_ID,
        sheetName: ACTIVE_SHOWS_INDEX_SHEET_NAME,
        rowCount: shows.length,
        shows,
      };
    } catch (error) {
      lastError = error;
      console.warn("[ASK FLEX FULL SHOW] Active Shows Index warning:", error.message);
    }
  }

  throw lastError || new Error("Unable to fetch Active Shows Index CSV.");
}

async function getActiveShowsRowsWithFallbackInternal(deps = {}) {
  if (typeof deps.getActiveShowsRowsWithFallback === "function") {
    return deps.getActiveShowsRowsWithFallback();
  }

  try {
    return await fetchActiveShowsFromIndexSheet(deps.parseCsvRows);
  } catch (error) {
    console.warn("[ASK FLEX FULL SHOW] Active Shows fallback:", error.message);
    return {
      source: "active-shows-safe-mock",
      usedFallback: true,
      fallbackReason: error.message,
      sheetId: ACTIVE_SHOWS_INDEX_SHEET_ID,
      sheetName: ACTIVE_SHOWS_INDEX_SHEET_NAME,
      rowCount: MOCK_ACTIVE_SHOWS.length,
      shows: MOCK_ACTIVE_SHOWS.map((show) => ({
        ...show,
        technicalCoverage: show.trucking || null,
        risk: show.topIssue || null,
      })),
    };
  }
}

function extractActiveShowDocumentNumbers(show) {
  const textToScan = [
    show?.id,
    show?.name,
    show?.timing,
    show?.priority,
    show?.readinessStatus,
    show?.changeSignal,
    show?.topIssue,
    show?.nextAction,
    show?.flexSignal,
    show?.trucking,
    show?.technicalCoverage,
    show?.risk,
  ]
    .filter(Boolean)
    .join(" ");

  return extractQuoteNumbersFromText(textToScan);
}

function scoreShowNameMatch(queryKey, candidateName, candidateId) {
  const nameKey = normalizeNameKey(candidateName);
  const idKey = normalizeNameKey(String(candidateId || "").replace(/-/g, " "));
  if (!queryKey || !nameKey) return 0;

  if (nameKey === queryKey || idKey === queryKey) return 100;
  if (nameKey.startsWith(queryKey) || queryKey.startsWith(nameKey)) return 90;
  if (nameKey.includes(queryKey) || queryKey.includes(nameKey)) return 75;
  if (idKey.includes(queryKey) || queryKey.includes(idKey)) return 70;

  const queryTokens = queryKey.split(" ").filter(Boolean);
  const nameTokens = new Set(nameKey.split(" ").filter(Boolean));
  const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
  if (overlap && overlap === queryTokens.length) return 65;
  if (overlap >= Math.ceil(queryTokens.length * 0.6)) return 50;
  return 0;
}

function matchActiveShowsByName(shows, showName) {
  const queryKey = normalizeNameKey(showName);
  if (!queryKey) return [];

  return (Array.isArray(shows) ? shows : [])
    .map((show) => ({
      show,
      score: scoreShowNameMatch(queryKey, show?.name, show?.id),
    }))
    .filter((item) => item.score >= 50)
    .sort((a, b) => b.score - a.score);
}

function filterCredibleFlexMatches(matches, showName) {
  const queryKey = normalizeNameKey(showName);
  const list = Array.isArray(matches) ? matches : [];

  const scored = list
    .map((match) => {
      const nameScore = Math.max(
        scoreShowNameMatch(queryKey, match?.name),
        scoreShowNameMatch(queryKey, match?.rawSearchName)
      );
      let score = nameScore;
      if (looksLikeQuoteForm(match)) score += 15;
      if (looksLikeInvoice(match)) score -= 40;
      if (!match?.documentNumber) score -= 20;
      return { match, score };
    })
    .filter((item) => item.score >= 40 && item.match?.documentNumber)
    .sort((a, b) => b.score - a.score);

  const preferred = scored.filter((item) => !looksLikeInvoice(item.match));
  const chosen = preferred.length ? preferred : scored;

  // Strong-match gate: keep only high-confidence name matches.
  const strong = chosen.filter((item) => item.score >= 65);

  const byDoc = new Map();
  for (const item of strong) {
    const doc = String(item.match.documentNumber).trim();
    if (!byDoc.has(doc) || byDoc.get(doc).score < item.score) {
      byDoc.set(doc, item);
    }
  }

  return [...byDoc.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      ...item.match,
      matchScore: item.score,
      matchReason:
        item.score >= 90
          ? `Strong FLEX name match (score ${item.score})`
          : `FLEX name match (score ${item.score})`,
    }));
}

function summarizeFlexDocuments(documents) {
  const docs = Array.isArray(documents) ? documents : [];
  let laborHeadcount = 0;
  let laborPersonDays = 0;
  let transportationLineCount = 0;
  let equipmentLineItemCount = 0;
  const families = new Set();
  const projectManagers = new Set();
  const relatedQuotes = [];

  for (const doc of docs) {
    if (doc.documentNumber) relatedQuotes.push(doc.documentNumber);
    if (hasAssignedProjectManager(doc.projectManager)) {
      projectManagers.add(String(doc.projectManager).trim());
    }

    for (const item of Array.isArray(doc.laborItems) ? doc.laborItems : []) {
      const qty = Number(item?.quantity || 0);
      const timeQty = Number(item?.timeQty || 0);
      laborHeadcount += qty;
      laborPersonDays += qty * timeQty;
    }

    transportationLineCount += Array.isArray(doc.transportationItems)
      ? doc.transportationItems.length
      : Number(doc.counts?.transportationItems || 0);

    const inventory = Array.isArray(doc.inventoryItems) ? doc.inventoryItems : [];
    equipmentLineItemCount += inventory.length || Number(doc.counts?.inventoryItems || 0);
    for (const family of detectEquipmentFamilies(inventory)) {
      families.add(family);
    }
  }

  const combinedCounts = {
    documents: docs.length,
    laborItems: docs.reduce((sum, doc) => sum + Number(doc.counts?.laborItems || doc.laborItems?.length || 0), 0),
    transportationItems: transportationLineCount,
    inventoryItems: equipmentLineItemCount,
    sections: docs.reduce((sum, doc) => sum + Number(doc.counts?.sections || doc.sections?.length || 0), 0),
  };

  const combinedTotals = {
    invoiceTotal: docs.reduce(
      (sum, doc) => sum + Number(doc.totals?.invoiceTotal ?? doc.financials?.invoiceTotal ?? 0),
      0
    ),
  };

  return {
    relatedQuotes: [...new Set(relatedQuotes)],
    laborHeadcount: Math.round(laborHeadcount * 100) / 100,
    laborPersonDays: Math.round(laborPersonDays * 100) / 100,
    transportationLineCount,
    equipmentLineItemCount,
    majorFamilies: [...families],
    projectManagers: [...projectManagers],
    combinedCounts,
    combinedTotals,
  };
}

function estimateFlexScopeComplexity(flexSummary) {
  let score = 0;
  if ((flexSummary.relatedQuotes || []).length >= 3) score += 2;
  else if ((flexSummary.relatedQuotes || []).length >= 2) score += 1;
  if (flexSummary.laborHeadcount >= 12) score += 2;
  else if (flexSummary.laborHeadcount >= 4) score += 1;
  if (flexSummary.transportationLineCount >= 3) score += 2;
  else if (flexSummary.transportationLineCount >= 1) score += 1;
  if (flexSummary.equipmentLineItemCount >= 60) score += 2;
  else if (flexSummary.equipmentLineItemCount >= 25) score += 1;
  if ((flexSummary.majorFamilies || []).length >= 4) score += 1;
  if (score >= 7) return "High";
  if (score >= 3) return "Medium";
  return "Low";
}

function statusRank(status) {
  const map = { clear: 0, review_needed: 1, at_risk: 2, blocked: 3 };
  return map[String(status || "").toLowerCase()] ?? 1;
}

function maxStatus(...statuses) {
  return statuses.reduce((best, current) =>
    statusRank(current) > statusRank(best) ? current : best
  , "clear");
}

function severityForStatus(status) {
  if (status === "blocked") return "critical";
  if (status === "at_risk") return "high";
  if (status === "review_needed") return "medium";
  return "low";
}

function finding({
  status = "review_needed",
  severity = null,
  area,
  finding: findingText,
  evidence,
  sources,
  owner,
  action,
  category = null,
  bucket = null,
}) {
  return {
    category: category || inferFindingCategory(findingText, evidence),
    severity: severity || severityForStatus(status),
    status,
    area,
    finding: findingText,
    evidence,
    sources: Array.isArray(sources) ? sources : [sources].filter(Boolean),
    owner,
    action,
    bucket: bucket || null,
  };
}

function inferFindingCategory(findingText, evidence = "") {
  const text = `${findingText || ""} ${evidence || ""}`.toLowerCase();
  if (/maybe truck/.test(text)) return "trucking_maybe_truck";
  if (/need driver/.test(text)) return "trucking_need_driver";
  if (/info sent/.test(text)) return "trucking_info_sent";
  if (/lpo sent/.test(text)) return "trucking_lpo_sent";
  if (/\btbd\b/.test(text)) return "trucking_tbd";
  if (/share that transportation|references .+ directly|quote-to-trucking|only one .*quote.*match/.test(text)) {
    return "quote_trucking_alignment";
  }
  if (/flex scope appears simple|trucking execution (is more complex|requires attention)/.test(text)) {
    return "flex_vs_trucking_contrast";
  }
  if (/multiple related flex quotes|workstreams are in scope/.test(text)) return "flex_multi_quote";
  if (/no pm is visible|pm visibility/.test(text)) return "pm_visibility";
  if (/venue or schedule|missing dates|venue missing/.test(text)) return "flex_missing_schedule";
  if (/active shows/.test(text)) return "active_shows_context";
  if (/no live staffing|no live warehouse|unavailable live systems|source coverage/.test(text)) {
    return "coverage_gap";
  }
  if (/transportation lines, but no matching weekly runs|weekly runs has trucking rows, but flex shows no transportation/.test(text)) {
    return "flex_trucking_presence_gap";
  }
  return normalizeNameKey(findingText).slice(0, 96) || "other";
}

function dedupeFindingsByCategory(findings) {
  const map = new Map();

  for (const item of Array.isArray(findings) ? findings : []) {
    if (!item || !item.finding) continue;
    const key = item.category || inferFindingCategory(item.finding, item.evidence);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...item,
        category: key,
        evidence: cleanEvidenceText(item.evidence),
        sources: [...new Set(asStringArray(item.sources, 8))],
      });
      continue;
    }

    const mergedSources = [
      ...new Set([
        ...asStringArray(existing.sources, 8),
        ...asStringArray(item.sources, 8),
      ]),
    ];

    map.set(key, {
      ...existing,
      status: maxStatus(existing.status, item.status),
      severity: severityForStatus(maxStatus(existing.status, item.status)),
      // Prefer deterministic evidence; only merge when the first entry had none.
      evidence: existing.evidence || cleanEvidenceText(item.evidence),
      sources: mergedSources,
      action: existing.action || item.action,
      owner: existing.owner || item.owner,
      bucket: existing.bucket || item.bucket,
      // Keep the first (deterministic) finding text for known categories.
      finding: existing.finding,
    });
  }

  return [...map.values()];
}

function cleanEvidenceText(evidence) {
  const parts = String(evidence || "")
    .split(/\s*\|\s*/)
    .map((part) => String(part || "").trim().replace(/\s+/g, " ").replace(/[.;:\s]+$/g, ""))
    .filter(Boolean);

  const unique = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    const subsumedIndex = unique.findIndex((existing) => {
      const existingKey = existing.toLowerCase();
      return existingKey.includes(key) || key.includes(existingKey);
    });
    if (subsumedIndex === -1) {
      unique.push(part);
      continue;
    }
    if (part.length > unique[subsumedIndex].length) {
      unique[subsumedIndex] = part;
    }
  }

  if (!unique.length) return "";
  if (unique.length === 1) return unique[0].endsWith(".") ? unique[0] : `${unique[0]}.`;
  return `${unique.join("; ")}.`;
}

function mergeEvidenceText(...values) {
  return cleanEvidenceText(values.filter(Boolean).join(" | "));
}

function scrubExecutiveAssessment(text, maxSentences = 3) {
  let cleaned = String(text || "")
    .replace(/\boverallStatus is[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, maxSentences)
    .join(" ")
    .trim();
}

function buildCoverageGaps(payload) {
  const gaps = [
    {
      source: "Staffing",
      status: "unavailable",
      note: "No live staffing system connected; FLEX labor lines are proxies only.",
    },
    {
      source: "Warehouse",
      status: "unavailable",
      note: "No live warehouse system connected; FLEX equipment/section signals are proxies only.",
    },
  ];

  if (payload?.trucking?.usedFallback) {
    gaps.push({
      source: "Trucking",
      status: "fallback",
      note: `Weekly Runs used fallback mock${payload.trucking.fallbackReason ? `: ${payload.trucking.fallbackReason}` : ""}.`,
    });
  }
  if (payload?.activeShows?.usedFallback) {
    gaps.push({
      source: "Active Shows",
      status: "fallback",
      note: `Active Shows Index used fallback mock${payload.activeShows.fallbackReason ? `: ${payload.activeShows.fallbackReason}` : ""}.`,
    });
  }
  if (payload?.flex?.sourceStatus === "partial") {
    gaps.push({
      source: "FLEX",
      status: "partial",
      note:
        (payload.flex.warnings || []).slice(0, 2).join(" ") ||
        "Some related FLEX quotes could not be loaded.",
    });
  }

  const seen = new Set();
  return gaps.filter((gap) => {
    const key = `${gap.source}|${gap.status}|${gap.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function partitionOperationalBuckets(findings, payload) {
  const summary = payload?.trucking?.summary || {};
  const matchedQuotes = asStringArray(summary.quoteNumbersMatched, 20);
  const relatedQuotes = asStringArray(payload?.flex?.relatedQuotes, 20);
  const confirmedIssues = [];
  const needsConfirmation = [];
  const crossSourceFindings = [];

  for (const item of dedupeFindingsByCategory(findings)) {
    const category = item.category || inferFindingCategory(item.finding, item.evidence);

    // Coverage / unavailable systems never become confirmed show issues.
    if (category === "coverage_gap") continue;

    // Active Shows contextual notes require verification.
    if (category === "active_shows_context" || item.bucket === "contextual") {
      needsConfirmation.push({
        ...item,
        category,
        status: "review_needed",
        severity: "medium",
        finding: item.finding.startsWith("Verify:")
          ? item.finding
          : `Verify Active Shows note: ${item.finding}`,
      });
      continue;
    }

    // Quote-to-trucking single-match alignment is confirmation, not confirmed issue.
    if (category === "quote_trucking_alignment") {
      const directQuote = matchedQuotes[0] || relatedQuotes[0] || "the matched quote";
      const alignmentFinding = {
        ...item,
        category,
        status: "review_needed",
        finding: `Weekly Runs references ${directQuote} directly. Confirm whether the other related workstreams intentionally share that transportation plan.`,
      };
      needsConfirmation.push(alignmentFinding);
      crossSourceFindings.push(alignmentFinding);
      continue;
    }

    // Maybe Truck with unclear impact stays review_needed / needs confirmation.
    if (category === "trucking_maybe_truck") {
      needsConfirmation.push({
        ...item,
        category,
        status: "review_needed",
        severity: "medium",
        finding:
          Number(summary.maybeTruckRows || 0) > 0
            ? `${summary.maybeTruckRows} Maybe Truck row(s) remain unresolved — confirm whether the unresolved Maybe Truck movements are required.`
            : item.finding,
      });
      crossSourceFindings.push({
        ...item,
        category,
        status: "review_needed",
        severity: "medium",
      });
      continue;
    }

    // Admin incompleteness and TBD are review_needed findings + confirmation.
    if (
      category === "trucking_info_sent" ||
      category === "trucking_lpo_sent" ||
      category === "trucking_tbd" ||
      category === "pm_visibility" ||
      category === "flex_multi_quote" ||
      category === "flex_missing_schedule" ||
      category === "flex_trucking_presence_gap" ||
      category === "flex_vs_trucking_contrast"
    ) {
      crossSourceFindings.push({
        ...item,
        category,
        status: item.status === "blocked" || item.status === "at_risk" ? "review_needed" : item.status,
        severity: "medium",
      });
      needsConfirmation.push(item);
      continue;
    }

    // NEED DRIVER and other at_risk/blocked from live trucking are confirmed.
    if (item.status === "at_risk" || item.status === "blocked" || category === "trucking_need_driver") {
      confirmedIssues.push({
        ...item,
        category,
        status: category === "trucking_need_driver" ? "at_risk" : item.status,
      });
      crossSourceFindings.push({
        ...item,
        category,
        status: category === "trucking_need_driver" ? "at_risk" : item.status,
      });
      continue;
    }

    crossSourceFindings.push({ ...item, category });
    if (item.status === "review_needed") needsConfirmation.push(item);
  }

  const uniqueByCategory = (list) => dedupeFindingsByCategory(list);
  const FINDING_PRIORITY = {
    trucking_need_driver: 100,
    quote_trucking_alignment: 90,
    trucking_maybe_truck: 85,
    flex_vs_trucking_contrast: 80,
    flex_trucking_presence_gap: 75,
    trucking_info_sent: 70,
    trucking_lpo_sent: 69,
    trucking_tbd: 68,
    flex_missing_schedule: 60,
    flex_multi_quote: 55,
    pm_visibility: 50,
    active_shows_context: 40,
    warehouse_detail_gap: 35,
  };

  const rankedFindings = uniqueByCategory(crossSourceFindings).sort((a, b) => {
    const aPri = FINDING_PRIORITY[a.category] || 10;
    const bPri = FINDING_PRIORITY[b.category] || 10;
    if (aPri !== bPri) return bPri - aPri;
    return String(a.finding || "").localeCompare(String(b.finding || ""));
  });

  return {
    crossSourceFindings: rankedFindings.slice(0, 6),
    confirmedIssues: uniqueByCategory(confirmedIssues),
    needsConfirmation: uniqueByCategory(needsConfirmation).slice(0, 6),
    coverageGaps: buildCoverageGaps(payload),
  };
}

function buildStatusReason(overallStatus, payload, buckets) {
  const summary = payload?.trucking?.summary || {};
  const confirmed = buckets.confirmedIssues || [];
  const needs = buckets.needsConfirmation || [];

  if (overallStatus === "blocked" && confirmed.length) {
    return `overallStatus is blocked because of confirmed blocker(s): ${confirmed.map((item) => item.finding).join("; ")}`;
  }
  if (overallStatus === "at_risk") {
    if (Number(summary.needDriverRows || 0) > 0) {
      return `overallStatus is at_risk because Weekly Runs contains ${summary.needDriverRows} NEED DRIVER row(s).`;
    }
    if (confirmed.length) {
      return `overallStatus is at_risk because of confirmed execution issue(s): ${confirmed.map((item) => item.finding).join("; ")}`;
    }
  }
  if (overallStatus === "review_needed") {
    const drivers = [];
    if (Number(summary.maybeTruckRows || 0) > 0) drivers.push("unresolved Maybe Truck row(s)");
    if (Number(summary.infoSentFalse || 0) > 0) drivers.push("incomplete Info Sent");
    if (Number(summary.lpoSentFalse || 0) > 0) drivers.push("incomplete LPO Sent");
    if (Number(summary.tbdRows || 0) > 0) drivers.push("TBD timing/equipment fields");
    if (!drivers.length && needs.length) {
      drivers.push(needs[0].finding);
    }
    return `overallStatus is review_needed because ${drivers.join(", ") || "connected sources require confirmation"}.`;
  }
  return "overallStatus is clear because connected sources do not currently show material execution exceptions.";
}

function prioritizeActions(buckets, payload) {
  const actions = [];
  for (const item of buckets.confirmedIssues || []) {
    if (item.action) actions.push(item.action);
  }
  for (const item of buckets.needsConfirmation || []) {
    if (item.action) actions.push(item.action);
  }
  for (const action of asStringArray(payload?.trucking?.summary?.actions, 4)) {
    actions.push(action);
  }
  return [...new Set(actions)].slice(0, 5);
}

export function isShowOperationalAnalysisQuestion(question) {
  const text = String(question || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();

  // Quote-only operational review without show-level language stays on document path.
  const hasQuoteNumber = QUOTE_NUMBER_RE.test(text);
  QUOTE_NUMBER_RE.lastIndex = 0;

  const hasShowLevelLanguage = SHOW_OPS_INTENT_PATTERNS.some((pattern) =>
    pattern.test(text)
  );

  if (!hasShowLevelLanguage) {
    // Soft patterns that still imply full-show when no quote number is present.
    if (
      !hasQuoteNumber &&
      (/\bfull\s+review\b/i.test(lower) ||
        /\bshow\s+review\b/i.test(lower) ||
        /\boperational\s+risks?\b/i.test(lower) ||
        /\breview\s+flex\b/i.test(lower))
    ) {
      // "full review of Sound Haven" / "show review of X" without quote #
      if (/\bof\b/i.test(lower) || /\bfor\b/i.test(lower)) {
        return true;
      }
    }
    return false;
  }

  return true;
}

export function extractShowNameForFullReview(question) {
  let text = String(question || "").trim();

  text = text.replace(QUOTE_NUMBER_RE, " ");

  const removePatterns = [
    /\bgive\b/gi,
    /\bme\b/gi,
    /\ba\b/gi,
    /\ban\b/gi,
    /\bthe\b/gi,
    /\bof\b/gi,
    /\bfor\b/gi,
    /\bon\b/gi,
    /\bin\b/gi,
    /\bto\b/gi,
    /\bwhat\b/gi,
    /\bwhat's\b/gi,
    /\bare\b/gi,
    /\bis\b/gi,
    /\bfull\b/gi,
    /\bwhole\b/gi,
    /\bentire\b/gi,
    /\bcross[- ]source\b/gi,
    /\boverall\b/gi,
    /\breal\b/gi,
    /\boperational\b/gi,
    /\boperations?\b/gi,
    /\breview\b/gi,
    /\banalysis\b/gi,
    /\banalyze\b/gi,
    /\bpicture\b/gi,
    /\brisks?\b/gi,
    /\bcue\b/gi,
    /\bflex\b/gi,
    /\btrucking\b/gi,
    /\bstaffing\b/gi,
    /\bwarehouse\b/gi,
    /\band\b/gi,
    /\ball\b/gi,
    /\brelated\b/gi,
    /\bquotes?\b/gi,
    /\bdocuments?\b/gi,
    /\bshow\b/gi,
    /\bjob\b/gi,
    /\bsources?\b/gi,
    /\bconnected\b/gi,
    /\bacross\b/gi,
    /\bplease\b/gi,
    /\btell\b/gi,
    /\babout\b/gi,
  ];

  for (const pattern of removePatterns) {
    text = text.replace(pattern, " ");
  }

  return text
    .replace(/[?!.:,;()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveFullShowContext(question, deps = {}) {
  const showNameQuery = extractShowNameForFullReview(question);

  if (!showNameQuery) {
    return {
      ok: false,
      needsClarification: true,
      answer:
        "I need a show name for a full operational review, like “Give me a full operational review of Sound Haven.”",
    };
  }

  const activeShowsSource = await getActiveShowsRowsWithFallbackInternal(deps);
  const activeMatches = matchActiveShowsByName(activeShowsSource.shows, showNameQuery);

  // Ambiguous Active Shows: multiple high-scoring, materially different names.
  const topActive = activeMatches[0];
  const ambiguousActive = activeMatches.filter(
    (item) =>
      item.score >= 75 &&
      normalizeNameKey(item.show?.name) !== normalizeNameKey(topActive?.show?.name)
  );

  if (ambiguousActive.length && topActive && topActive.score < 90) {
    return {
      ok: false,
      needsSelection: true,
      showNameQuery,
      answer: `I found multiple Active Shows matches for “${showNameQuery}”. Choose the correct show.`,
      matches: activeMatches.slice(0, 8).map((item, index) => ({
        index: index + 1,
        name: item.show?.name || null,
        id: item.show?.id || null,
        readinessStatus: item.show?.readinessStatus || null,
        priority: item.show?.priority || null,
        score: item.score,
      })),
    };
  }

  let flexSearch = { matches: [], query: showNameQuery };
  try {
    if (typeof deps.searchFlexQuotes === "function") {
      flexSearch = await deps.searchFlexQuotes(showNameQuery, {
        limit: 15,
        enrichLimit: 25,
        filters: { quoteOnly: true },
      });
    }
  } catch (error) {
    console.warn("[ASK FLEX FULL SHOW] FLEX search failed:", error.message);
  }

  const credibleFlexMatches = filterCredibleFlexMatches(flexSearch.matches, showNameQuery);

  // Ambiguous FLEX-only: multiple materially different show names, no Active Shows hit.
  if (!topActive && credibleFlexMatches.length >= 2) {
    const distinctNames = [
      ...new Set(
        credibleFlexMatches
          .map((match) => normalizeNameKey(match.name))
          .filter(Boolean)
      ),
    ];
    if (distinctNames.length >= 2) {
      const nameGroups = distinctNames.map((nameKey) => {
        const group = credibleFlexMatches.filter(
          (match) => normalizeNameKey(match.name) === nameKey
        );
        return {
          name: group[0]?.name || nameKey,
          score: scoreShowNameMatch(normalizeNameKey(showNameQuery), group[0]?.name),
          matches: group,
        };
      });
      const best = Math.max(...nameGroups.map((g) => g.score));
      const contenders = nameGroups.filter((g) => g.score >= best - 10 && g.score >= 50);
      if (contenders.length >= 2 && best < 90) {
        return {
          ok: false,
          needsSelection: true,
          showNameQuery,
          answer: `I found multiple FLEX shows matching “${showNameQuery}”. Choose the correct show.`,
          matches: contenders.slice(0, 8).map((group, index) => ({
            index: index + 1,
            name: group.name,
            documentNumber: group.matches[0]?.documentNumber || null,
            client: group.matches[0]?.client || null,
            score: group.score,
          })),
        };
      }
    }
  }

  const matchedActiveShow = topActive?.show || null;
  const resolvedShowName =
    matchedActiveShow?.name ||
    credibleFlexMatches[0]?.name ||
    showNameQuery;

  const activeShowQuotes = matchedActiveShow
    ? extractActiveShowDocumentNumbers(matchedActiveShow)
    : [];

  const currentYearPrefix = String(new Date().getFullYear()).slice(-2); // e.g. "26"

  function quoteRecencyRank(documentNumber) {
    const year = String(documentNumber || "").split("-")[0];
    if (year === currentYearPrefix) return 0;
    const yearNum = Number(year);
    const currentNum = Number(currentYearPrefix);
    if (Number.isFinite(yearNum) && Number.isFinite(currentNum)) {
      return Math.abs(currentNum - yearNum);
    }
    return 50;
  }

  // Prefer Active Shows hints, then current-year FLEX matches, then older matches.
  const orderedQuotes = [];
  const pushQuote = (documentNumber) => {
    const doc = String(documentNumber || "").trim();
    if (doc && !orderedQuotes.includes(doc)) orderedQuotes.push(doc);
  };

  for (const quote of activeShowQuotes) pushQuote(quote);

  const flexMatchByDoc = new Map(
    credibleFlexMatches.map((match) => [String(match.documentNumber || "").trim(), match])
  );

  const flexSorted = [...credibleFlexMatches].sort((a, b) => {
    const aDoc = String(a.documentNumber || "");
    const bDoc = String(b.documentNumber || "");
    const aActive = activeShowQuotes.includes(aDoc) ? 0 : 1;
    const bActive = activeShowQuotes.includes(bDoc) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const aRecency = quoteRecencyRank(aDoc);
    const bRecency = quoteRecencyRank(bDoc);
    if (aRecency !== bRecency) return aRecency - bRecency;
    return Number(b.matchScore || 0) - Number(a.matchScore || 0);
  });

  for (const match of flexSorted) pushQuote(match.documentNumber);

  // Keep current-year quotes; only keep older-year quotes when Active Shows explicitly hinted them.
  const cappedQuotes = [];
  for (const quote of orderedQuotes) {
    const isActiveHint = activeShowQuotes.includes(quote);
    const isCurrentYear = quoteRecencyRank(quote) === 0;
    if (!isActiveHint && !isCurrentYear) continue;
    // Require strong FLEX match unless Active Shows explicitly hinted the quote.
    if (!isActiveHint) {
      const flexMatch = flexMatchByDoc.get(quote);
      if (!flexMatch || Number(flexMatch.matchScore || 0) < 65) continue;
    }
    cappedQuotes.push(quote);
    if (cappedQuotes.length >= MAX_FLEX_QUOTES) break;
  }
  const flexDocuments = [];
  const flexWarnings = [];

  for (const documentNumber of cappedQuotes) {
    try {
      const quoteLookup =
        typeof deps.findFlexQuoteByDocumentNumber === "function"
          ? await deps.findFlexQuoteByDocumentNumber(documentNumber)
          : { found: false };

      if (!quoteLookup?.found || !quoteLookup?.elementId) {
        flexWarnings.push(`No FLEX quote found for ${documentNumber}.`);
        continue;
      }

      const intake = await deps.fetchFlexShowIntake(quoteLookup.elementId);
      const detail = deps.buildFlexDocumentDetail(intake);
      const showContext = detail?.showContext || {};
      const flexMatch = flexMatchByDoc.get(documentNumber);
      const matchReason = activeShowQuotes.includes(documentNumber)
        ? "Active Shows Index quote hint"
        : flexMatch?.matchReason || "FLEX name match";

      flexDocuments.push({
        documentNumber:
          showContext.documentNumber || documentNumber || quoteLookup.documentNumber || null,
        elementId: quoteLookup.elementId,
        showName: showContext.showName || quoteLookup.name || null,
        client: showContext.client || null,
        venue: showContext.venue || null,
        projectManager: showContext.projectManager || null,
        plannedStartDate: showContext.plannedStartDate || null,
        plannedEndDate: showContext.plannedEndDate || null,
        loadInDate: showContext.loadInDate || null,
        showStartDate: showContext.showStartDate || null,
        loadOutDate: showContext.loadOutDate || null,
        matchReason,
        matchScore: flexMatch?.matchScore ?? (activeShowQuotes.includes(documentNumber) ? 100 : null),
        sections: Array.isArray(detail?.sections)
          ? detail.sections.map((section) => ({
              name: section.name ?? null,
              category: section.category ?? null,
              total: section.total ?? null,
              itemCount: section.itemCount ?? null,
            }))
          : [],
        counts: detail?.counts || {},
        totals: {
          ...(detail?.summary?.totals || {}),
          invoiceTotal: detail?.summary?.financials?.invoiceTotal ?? null,
        },
        financials: detail?.summary?.financials || {},
        laborItems: Array.isArray(detail?.laborItems) ? detail.laborItems : [],
        transportationItems: Array.isArray(detail?.transportationItems)
          ? detail.transportationItems
          : [],
        inventoryItems: Array.isArray(detail?.inventoryItems) ? detail.inventoryItems : [],
        type: quoteLookup.type || null,
      });
    } catch (error) {
      flexWarnings.push(`Failed to load FLEX detail for ${documentNumber}: ${error.message}`);
    }
  }

  const flexQuoteNumbers = flexDocuments
    .map((doc) => doc.documentNumber)
    .filter(Boolean);

  // Also include Active Shows hints even if FLEX detail fetch failed.
  const truckingQuoteNumbers = [
    ...new Set([...flexQuoteNumbers, ...activeShowQuotes, ...cappedQuotes]),
  ];

  let truckingResult = {
    source: "unavailable",
    safeRows: [],
    usedFallback: false,
  };

  try {
    if (typeof deps.matchTruckingRowsWithFallback === "function") {
      truckingResult = await deps.matchTruckingRowsWithFallback({
        showId: matchedActiveShow?.id || slugifyShowName(resolvedShowName),
        showName: resolvedShowName,
        quoteNumbers: truckingQuoteNumbers,
      });
    }
  } catch (error) {
    flexWarnings.push(`Trucking match failed: ${error.message}`);
  }

  // Pull any additional quote numbers discovered only in trucking rows.
  for (const row of Array.isArray(truckingResult.safeRows) ? truckingResult.safeRows : []) {
    if (row?.quote) truckingQuoteNumbers.push(String(row.quote).trim());
  }

  const truckingSummary =
    typeof deps.summarizeTruckingRows === "function"
      ? deps.summarizeTruckingRows(truckingResult.safeRows, truckingQuoteNumbers)
      : {
          rowsFound: Array.isArray(truckingResult.safeRows) ? truckingResult.safeRows.length : 0,
          findings: [],
          actions: [],
          status: "unknown",
        };

  const comparison =
    typeof deps.buildFlexVsTruckingComparison === "function"
      ? deps.buildFlexVsTruckingComparison({
          quoteNumbers: flexQuoteNumbers.length ? flexQuoteNumbers : truckingQuoteNumbers,
          truckingSummary,
        })
      : null;

  if (!flexDocuments.length && !matchedActiveShow && !(truckingSummary.rowsFound > 0)) {
    return {
      ok: false,
      found: false,
      showNameQuery,
      answer: `I could not resolve “${showNameQuery}” across FLEX, Active Shows, or trucking.`,
    };
  }

  let slackSignals = null;
  try {
    if (typeof deps.getSlackSignalsForShow === "function") {
      slackSignals = await deps.getSlackSignalsForShow({
        showKey: matchedActiveShow?.id || slugifyShowName(resolvedShowName),
        showName: resolvedShowName,
        documentNumbers: flexQuoteNumbers,
        client:
          matchedActiveShow?.activeShowsIndex?.client ||
          flexDocuments.find((d) => d.client)?.client ||
          null,
        venue: flexDocuments.find((d) => d.venue)?.venue || null,
      });
    }
  } catch (error) {
    console.warn(
      "[CUE ASK FLEX SLACK] Signal lookup failed; continuing without Slack.",
      error?.message || error
    );
    slackSignals = {
      sourceStatus: "unavailable",
      lastSyncAt: null,
      matchedSignals: [],
      unresolvedCount: 0,
      atRiskCount: 0,
      blockedCount: 0,
      resolvedCount: 0,
      needsReviewCount: 0,
      warning: "Slack operational signals unavailable for this review.",
    };
  }

  return {
    ok: true,
    found: true,
    question,
    showNameQuery,
    resolvedShow: {
      name: resolvedShowName,
      id: matchedActiveShow?.id || slugifyShowName(resolvedShowName),
      aliases: [
        ...new Set(
          [showNameQuery, matchedActiveShow?.name, ...flexDocuments.map((d) => d.showName)]
            .filter(Boolean)
            .map((name) => String(name).trim())
        ),
      ],
      client:
        matchedActiveShow?.activeShowsIndex?.client ||
        flexDocuments.find((d) => d.client)?.client ||
        null,
      venue: flexDocuments.find((d) => d.venue)?.venue || null,
      fromActiveShows: Boolean(matchedActiveShow),
      matchScore: topActive?.score || null,
    },
    flexDocuments,
    flexWarnings,
    truckingResult,
    truckingSummary,
    comparison,
    activeShowResult: {
      source: activeShowsSource.source,
      usedFallback: Boolean(activeShowsSource.usedFallback),
      fallbackReason: activeShowsSource.fallbackReason || null,
      matchedShow: matchedActiveShow,
    },
    slackSignals,
  };
}

export function buildFullShowOperationalPayload({
  question,
  resolvedShow,
  flexDocuments,
  truckingResult,
  truckingSummary,
  comparison,
  activeShowResult,
  flexWarnings = [],
  slackSignals = null,
}) {
  const flexSummary = summarizeFlexDocuments(flexDocuments);
  const matched = activeShowResult?.matchedShow || null;
  const unavailableSources = [];

  const flexSourceStatus = flexDocuments.length
    ? "connected"
    : flexWarnings.length
      ? "partial"
      : "unavailable";

  if (flexSourceStatus === "unavailable") {
    unavailableSources.push("FLEX");
  }

  const truckingSourceStatus = !truckingResult
    ? "unavailable"
    : truckingResult.usedFallback
      ? "fallback"
      : Array.isArray(truckingResult.safeRows) && truckingResult.safeRows.length
        ? "connected"
        : "partial";

  if (truckingSourceStatus === "unavailable") {
    unavailableSources.push("Trucking");
  }

  const activeSourceStatus = !activeShowResult
    ? "unavailable"
    : activeShowResult.usedFallback
      ? matched
        ? "fallback"
        : "fallback"
      : matched
        ? "connected"
        : "partial";

  if (!matched) {
    // Not unavailable if we searched — mark as partial via sourceCoverage later.
  }

  // Staffing / warehouse have no dedicated live systems in v0.
  unavailableSources.push("Staffing system");
  unavailableSources.push("Warehouse system");

  const projectManagers = [...flexSummary.projectManagers];
  if (matched?.topIssue && /pm/i.test(matched.topIssue) && !projectManagers.length) {
    // keep empty — visibility comes from FLEX
  }

  const showDates = {
    plannedStartDate: flexDocuments.find((d) => d.plannedStartDate)?.plannedStartDate || null,
    plannedEndDate: flexDocuments.find((d) => d.plannedEndDate)?.plannedEndDate || null,
    loadInDate: flexDocuments.find((d) => d.loadInDate)?.loadInDate || null,
    showStartDate: flexDocuments.find((d) => d.showStartDate)?.showStartDate || null,
    loadOutDate: flexDocuments.find((d) => d.loadOutDate)?.loadOutDate || null,
  };

  return {
    question: String(question || ""),
    scope: "full_show",
    show: {
      name: resolvedShow?.name || null,
      aliases: resolvedShow?.aliases || [],
      client: resolvedShow?.client || null,
      venue: resolvedShow?.venue || null,
      plannedStartDate: showDates.plannedStartDate,
      plannedEndDate: showDates.plannedEndDate,
      loadInDate: showDates.loadInDate,
      showStartDate: showDates.showStartDate,
      loadOutDate: showDates.loadOutDate,
      projectManagers,
      operationalOwners: [
        ...projectManagers.map((pm) => `PM: ${pm}`),
        "Brian Kee / Trucking Coordinator",
        "Staffing Coordinator",
      ],
    },
    flex: {
      sourceStatus: flexSourceStatus,
      documents: (Array.isArray(flexDocuments) ? flexDocuments : []).map((doc) => ({
        documentNumber: doc.documentNumber || null,
        elementId: doc.elementId || null,
        showName: doc.showName || null,
        client: doc.client || null,
        venue: doc.venue || null,
        projectManager: doc.projectManager || null,
        plannedStartDate: doc.plannedStartDate || null,
        plannedEndDate: doc.plannedEndDate || null,
        matchReason: doc.matchReason || null,
        matchScore: doc.matchScore ?? null,
        sections: doc.sections || [],
        counts: doc.counts || {},
        totals: doc.totals || {},
        laborItems: doc.laborItems || [],
        transportationItems: doc.transportationItems || [],
        inventoryItems: doc.inventoryItems || [],
      })),
      relatedWorkstreams: (Array.isArray(flexDocuments) ? flexDocuments : []).map((doc) => ({
        documentNumber: doc.documentNumber || null,
        showName: doc.showName || null,
        client: doc.client || null,
        plannedStartDate: doc.plannedStartDate || null,
        plannedEndDate: doc.plannedEndDate || null,
        matchReason: doc.matchReason || null,
        matchScore: doc.matchScore ?? null,
      })),
      combinedCounts: flexSummary.combinedCounts,
      combinedTotals: flexSummary.combinedTotals,
      laborHeadcount: flexSummary.laborHeadcount,
      laborPersonDays: flexSummary.laborPersonDays,
      transportationLineCount: flexSummary.transportationLineCount,
      equipmentLineItemCount: flexSummary.equipmentLineItemCount,
      majorFamilies: flexSummary.majorFamilies,
      relatedQuotes: flexSummary.relatedQuotes,
      complexityEstimate: estimateFlexScopeComplexity(flexSummary),
      warnings: flexWarnings,
    },
    trucking: {
      source: truckingResult?.source || "unavailable",
      usedFallback: Boolean(truckingResult?.usedFallback),
      fallbackReason: truckingResult?.fallbackReason || null,
      sourceStatus: truckingSourceStatus,
      rows: Array.isArray(truckingResult?.safeRows) ? truckingResult.safeRows : [],
      summary: truckingSummary || {},
      comparison: comparison || null,
    },
    activeShows: {
      source: activeShowResult?.source || "unavailable",
      usedFallback: Boolean(activeShowResult?.usedFallback),
      fallbackReason: activeShowResult?.fallbackReason || null,
      sourceStatus: activeSourceStatus,
      matchedShow: matched
        ? {
            id: matched.id || null,
            name: matched.name || null,
            timing: matched.timing || null,
            priority: matched.priority || null,
            readinessStatus: matched.readinessStatus || null,
            topIssue: matched.topIssue || null,
            nextAction: matched.nextAction || null,
            technicalCoverage:
              matched.technicalCoverage ||
              matched.activeShowsIndex?.technicalCoverage ||
              matched.trucking ||
              null,
            risk: matched.risk || matched.activeShowsIndex?.risk || matched.topIssue || null,
          }
        : null,
      readinessStatus: matched?.readinessStatus || null,
      priority: matched?.priority || null,
      topIssue: matched?.topIssue || null,
      nextAction: matched?.nextAction || null,
      technicalCoverage:
        matched?.technicalCoverage ||
        matched?.activeShowsIndex?.technicalCoverage ||
        null,
      risk: matched?.risk || matched?.activeShowsIndex?.risk || matched?.topIssue || null,
    },
    slack: {
      sourceStatus: slackSignals?.sourceStatus || "unavailable",
      lastSyncAt: slackSignals?.lastSyncAt || null,
      matchedSignals: Array.isArray(slackSignals?.matchedSignals)
        ? slackSignals.matchedSignals.slice(0, 20)
        : Array.isArray(slackSignals?.signals)
          ? slackSignals.signals.slice(0, 20)
          : [],
      unresolvedCount: Number(slackSignals?.unresolvedCount || 0),
      atRiskCount: Number(slackSignals?.atRiskCount || 0),
      blockedCount: Number(slackSignals?.blockedCount || 0),
      resolvedCount: Number(slackSignals?.resolvedCount || 0),
      needsReviewCount: Number(slackSignals?.needsReviewCount || 0),
      warning: slackSignals?.warning || null,
    },
    unavailableSources: [...new Set(unavailableSources)],
  };
}

export function buildDeterministicCrossSourceFindings(payload) {
  const findings = [];
  const flex = payload?.flex || {};
  const trucking = payload?.trucking || {};
  const summary = trucking.summary || {};
  const active = payload?.activeShows || {};
  const docs = Array.isArray(flex.documents) ? flex.documents : [];

  const flexSimple = (flex.complexityEstimate || "Low") === "Low";
  const truckingComplex =
    Number(summary.rowsFound || 0) >= 3 ||
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.needDriverRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0 ||
    Number(summary.tbdRows || 0) > 0;

  if (flexSimple && truckingComplex) {
    findings.push(
      finding({
        category: "flex_vs_trucking_contrast",
        status: "review_needed",
        area: "Trucking",
        finding:
          "FLEX scope appears simple, but trucking execution requires attention across Weekly Runs.",
        evidence: `FLEX complexity ${flex.complexityEstimate || "Low"}; trucking rows=${summary.rowsFound || 0}, maybeTruck=${summary.maybeTruckRows || 0}, needDriver=${summary.needDriverRows || 0}, infoSentFalse=${summary.infoSentFalse || 0}, lpoSentFalse=${summary.lpoSentFalse || 0}, tbd=${summary.tbdRows || 0}.`,
        sources: ["FLEX", "Trucking"],
        owner: "Brian Kee / Trucking Coordinator",
        action: "Treat Weekly Runs as the execution authority for movement complexity.",
      })
    );
  }

  if ((flex.transportationLineCount || 0) > 0 && Number(summary.rowsFound || 0) === 0) {
    findings.push(
      finding({
        category: "flex_trucking_presence_gap",
        status: "review_needed",
        area: "Trucking",
        finding: "FLEX lists transportation lines, but no matching Weekly Runs rows were found.",
        evidence: `FLEX transportation lines=${flex.transportationLineCount}; trucking rowsFound=0.`,
        sources: ["FLEX", "Trucking"],
        owner: "Brian Kee / Trucking Coordinator",
        action: "Confirm whether Weekly Runs rows need to be created or linked to these quotes.",
      })
    );
  }

  if (Number(summary.rowsFound || 0) > 0 && (flex.transportationLineCount || 0) === 0) {
    findings.push(
      finding({
        category: "flex_trucking_presence_gap",
        status: "review_needed",
        area: "Data",
        finding: "Weekly Runs has trucking rows, but FLEX shows no transportation line items.",
        evidence: `Trucking rows=${summary.rowsFound}; FLEX transportationLineCount=0.`,
        sources: ["FLEX", "Trucking"],
        owner: "Brian Kee / PM",
        action: "Confirm whether transportation scope lives only in Weekly Runs or is missing from FLEX.",
      })
    );
  }

  // Quote-to-trucking alignment: one direct match among multiple related quotes.
  const matchedQuotes = asStringArray(summary.quoteNumbersMatched, 20);
  const relatedQuotes = asStringArray(flex.relatedQuotes, 20);
  if (
    Number(summary.rowsFound || 0) > 0 &&
    relatedQuotes.length >= 2 &&
    matchedQuotes.length === 1
  ) {
    findings.push(
      finding({
        category: "quote_trucking_alignment",
        status: "review_needed",
        area: "Trucking",
        finding: `Weekly Runs references ${matchedQuotes[0]} directly. Confirm whether the other related workstreams intentionally share that transportation plan.`,
        evidence: `Trucking matched quote(s): ${matchedQuotes.join(", ")}; related FLEX quotes: ${relatedQuotes.join(", ")}.`,
        sources: ["FLEX", "Trucking"],
        owner: "Brian Kee / PM",
        action: "Confirm shared vs separate transportation plans across related workstreams.",
      })
    );
  }

  if (Number(summary.maybeTruckRows || 0) > 0) {
    findings.push(
      finding({
        category: "trucking_maybe_truck",
        status: "review_needed",
        area: "Trucking",
        finding: "Maybe Truck rows remain unresolved in Weekly Runs.",
        evidence: `${summary.maybeTruckRows} Maybe Truck row(s).`,
        sources: ["Trucking"],
        owner: "Brian Kee / Trucking Coordinator",
        action: "Confirm whether Maybe Truck rows are required or can be closed.",
      })
    );
  }

  if (Number(summary.needDriverRows || 0) > 0) {
    findings.push(
      finding({
        category: "trucking_need_driver",
        status: "at_risk",
        severity: "high",
        area: "Trucking",
        finding: "NEED DRIVER is present on one or more Weekly Runs rows.",
        evidence: `${summary.needDriverRows} NEED DRIVER row(s).`,
        sources: ["Trucking"],
        owner: "Brian Kee / Trucking Coordinator",
        action: "Assign/confirm driver coverage for NEED DRIVER rows.",
      })
    );
  }

  if (Number(summary.infoSentFalse || 0) > 0) {
    findings.push(
      finding({
        category: "trucking_info_sent",
        status: "review_needed",
        area: "Trucking",
        finding: "Info Sent is incomplete on trucking rows.",
        evidence: `${summary.infoSentFalse} row(s) with Info Sent = FALSE.`,
        sources: ["Trucking"],
        owner: "Brian Kee / PM",
        action: "Confirm Info Sent status for incomplete trucking rows.",
      })
    );
  }

  if (Number(summary.lpoSentFalse || 0) > 0) {
    findings.push(
      finding({
        category: "trucking_lpo_sent",
        status: "review_needed",
        area: "Trucking",
        finding: "LPO Sent is incomplete on trucking rows.",
        evidence: `${summary.lpoSentFalse} row(s) with LPO Sent = FALSE.`,
        sources: ["Trucking"],
        owner: "Brian Kee / PM",
        action: "Confirm LPO Sent status for incomplete trucking rows.",
      })
    );
  }

  if (Number(summary.tbdRows || 0) > 0) {
    findings.push(
      finding({
        category: "trucking_tbd",
        status: "review_needed",
        area: "Timing",
        finding: "Trucking rows still contain TBD timing or equipment fields.",
        evidence: `${summary.tbdRows} TBD row(s) in Weekly Runs.`,
        sources: ["Trucking"],
        owner: "Brian Kee / Trucking Coordinator",
        action: "Replace TBD timing/truck fields with confirmed values.",
      })
    );
  }

  // Active Shows notes are contextual unless independently confirmed by live trucking/FLEX.
  const activeRiskText = String(active.risk || active.topIssue || "").toLowerCase();
  const activeMentionsDriver =
    /\b(driver|need driver|driver confirmation)\b/i.test(activeRiskText) ||
    /\b(driver|need driver)\b/i.test(String(active.nextAction || ""));
  const liveNeedDriver = Number(summary.needDriverRows || 0) > 0;

  if (active.matchedShow && activeMentionsDriver && !liveNeedDriver) {
    findings.push(
      finding({
        category: "active_shows_context",
        bucket: "contextual",
        status: "review_needed",
        area: "Trucking",
        finding:
          "Active Shows notes incomplete driver confirmation, but current Weekly Runs does not independently confirm NEED DRIVER.",
        evidence: `Active Shows topIssue/nextAction reference driver confirmation; Weekly Runs needDriverRows=0.`,
        sources: ["Active Shows"],
        owner: "PM / Brian Kee",
        action: "Verify the Active Shows driver note against live Weekly Runs before treating it as confirmed.",
      })
    );
  } else if (
    active.matchedShow &&
    (/\b(magenta|red|follow-up|unclear|missing)\b/i.test(String(active.readinessStatus || "")) ||
      /\b(unclear|missing|confirm|gap)\b/i.test(activeRiskText))
  ) {
    findings.push(
      finding({
        category: "active_shows_context",
        bucket: "contextual",
        status: "review_needed",
        area: "Data",
        finding: String(active.topIssue || active.risk || "Active Shows flags follow-up."),
        evidence: `Active Shows readiness="${active.readinessStatus || ""}"; contextual note only unless confirmed by live FLEX/trucking.`,
        sources: ["Active Shows"],
        owner: "PM",
        action: "Verify Active Shows readiness notes against live FLEX and Weekly Runs.",
      })
    );
  }

  if ((flex.relatedQuotes || []).length >= 2) {
    findings.push(
      finding({
        category: "flex_multi_quote",
        status: "review_needed",
        area: "FLEX",
        finding: "Multiple related FLEX quotes/workstreams are in scope for this show.",
        evidence: `Related quotes: ${(flex.relatedQuotes || []).join(", ")}.`,
        sources: ["FLEX"],
        owner: "PM",
        action: "Confirm which quotes are authoritative for each department/workstream.",
      })
    );
  }

  const docsMissingPm = docs.filter((doc) => !hasAssignedProjectManager(doc.projectManager));
  if (docs.length && docsMissingPm.length) {
    findings.push(
      finding({
        category: "pm_visibility",
        status: "review_needed",
        area: "PM",
        finding:
          docsMissingPm.length === docs.length
            ? "No PM is visible on the related FLEX quote(s)."
            : "PM visibility is missing on some related FLEX quotes.",
        evidence: `${docsMissingPm.length}/${docs.length} quote(s) lack visible projectManager.`,
        sources: ["FLEX"],
        owner: "PM / Sales",
        action: "Confirm whether a PM should be visible on each related FLEX quote.",
      })
    );
  }

  const missingVenue = !payload?.show?.venue && docs.every((doc) => !doc.venue);
  const missingDates = [
    !payload?.show?.loadInDate ? "load-in" : null,
    !payload?.show?.showStartDate && !payload?.show?.plannedStartDate ? "show start" : null,
    !payload?.show?.loadOutDate ? "load-out" : null,
  ].filter(Boolean);

  if (missingVenue || missingDates.length) {
    findings.push(
      finding({
        category: "flex_missing_schedule",
        status: "review_needed",
        area: "Timing",
        finding: "Critical venue or schedule fields are missing across connected FLEX data.",
        evidence: [
          missingVenue ? "venue missing" : null,
          missingDates.length ? `missing dates: ${missingDates.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; "),
        sources: ["FLEX"],
        owner: "PM",
        action: "Confirm venue and critical dates in FLEX.",
      })
    );
  }

  if ((flex.equipmentLineItemCount || 0) >= 25 && (flex.combinedCounts?.sections || 0) < 2) {
    findings.push(
      finding({
        category: "warehouse_detail_gap",
        status: "review_needed",
        area: "Warehouse",
        finding:
          "Equipment line-item count is high relative to visible FLEX section/warehouse detail.",
        evidence: `equipmentLineItemCount=${flex.equipmentLineItemCount}; sections=${flex.combinedCounts?.sections || 0}.`,
        sources: ["FLEX"],
        owner: "Warehouse / PM",
        action: "Review warehouse pull sequencing against equipment families and department scope.",
      })
    );
  }

  const slackSignals = Array.isArray(payload?.slack?.matchedSignals)
    ? payload.slack.matchedSignals
    : [];
  for (const signal of slackSignals.slice(0, 8)) {
    const statusRaw = String(signal.status || "").toLowerCase();
    const findingStatus =
      statusRaw === "blocked"
        ? "blocked"
        : statusRaw === "at_risk"
          ? "at_risk"
          : statusRaw === "resolved"
            ? "review_needed"
            : "review_needed";
    const cats = Array.isArray(signal.categories) ? signal.categories.join(", ") : "operations";
    findings.push(
      finding({
        category: `slack_${String(cats).split(",")[0] || "signal"}`,
        status: findingStatus,
        severity: statusRaw === "blocked" || statusRaw === "at_risk" ? "high" : "medium",
        area: /truck/i.test(cats) ? "Trucking" : /warehouse/i.test(cats) ? "Warehouse" : "Data",
        finding:
          statusRaw === "resolved"
            ? `Slack reports resolution: ${signal.summary || signal.originalMessage || "update"}`
            : `Slack signal (${cats}): ${signal.summary || signal.originalMessage || "update"}`,
        evidence: [
          signal.channelName ? `channel=${signal.channelName}` : null,
          signal.authorName ? `author=${signal.authorName}` : null,
          signal.timestamp ? `ts=${signal.timestamp}` : null,
          signal.confidence ? `confidence=${signal.confidence}` : null,
          Array.isArray(signal.matchReasons) && signal.matchReasons.length
            ? `match=${signal.matchReasons.slice(0, 2).join("; ")}`
            : null,
          signal.originalMessage
            ? `message=${String(signal.originalMessage).slice(0, 180)}`
            : null,
        ]
          .filter(Boolean)
          .join(" | "),
        sources: ["Slack"],
        owner: /truck/i.test(cats) ? "Brian Kee / Trucking Coordinator" : "PM",
        action:
          statusRaw === "resolved"
            ? "Confirm Slack resolution against FLEX/Trucking state."
            : "Review Slack operational signal and update execution status.",
        bucket: statusRaw === "resolved" ? "contextual" : undefined,
      })
    );
  }

  if (Number(payload?.slack?.needsReviewCount || 0) > 0) {
    findings.push(
      finding({
        category: "slack_needs_review",
        status: "review_needed",
        area: "Data",
        finding: "Medium-confidence Slack signals need human review before attachment.",
        evidence: `${payload.slack.needsReviewCount} Slack signal(s) in Needs Review.`,
        sources: ["Slack"],
        owner: "PM",
        action: "Review medium-confidence Slack matches in the Needs Review queue.",
        bucket: "contextual",
      })
    );
  }

  return dedupeFindingsByCategory(findings);
}

function deriveOverallStatus(crossSourceFindings, payload) {
  const summary = payload?.trucking?.summary || {};
  let overall = "clear";

  // Execution-impacting live trucking evidence.
  if (Number(summary.needDriverRows || 0) > 0) {
    overall = maxStatus(overall, "at_risk");
  }

  // Admin / unresolved confirmation items.
  if (
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0 ||
    Number(summary.tbdRows || 0) > 0
  ) {
    overall = maxStatus(overall, "review_needed");
  }

  for (const item of crossSourceFindings || []) {
    if (item.category === "trucking_maybe_truck") {
      overall = maxStatus(overall, "review_needed");
      continue;
    }
    if (item.bucket === "contextual" || item.category === "active_shows_context") {
      overall = maxStatus(overall, "review_needed");
      continue;
    }
    if (item.status === "blocked") {
      overall = maxStatus(overall, "blocked");
      continue;
    }
    if (item.status === "at_risk" && item.category === "trucking_need_driver") {
      overall = maxStatus(overall, "at_risk");
      continue;
    }
    if (item.status === "at_risk") {
      // Do not let soft/model at_risk inflate beyond review_needed unless NEED DRIVER.
      overall = maxStatus(overall, "review_needed");
      continue;
    }
    overall = maxStatus(overall, item.status);
  }

  const flexSimple = (payload?.flex?.complexityEstimate || "Low") === "Low";
  const truckingComplex =
    Number(summary.rowsFound || 0) >= 3 ||
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.needDriverRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0;

  if (flexSimple && truckingComplex && overall === "clear") {
    overall = "review_needed";
  }

  return overall;
}

function buildSourceCoverage(payload) {
  const flexNote =
    payload.flex?.sourceStatus === "connected"
      ? `${(payload.flex.relatedQuotes || []).length} related quote(s) loaded`
      : payload.flex?.warnings?.[0] || "No FLEX documents resolved";

  const truckingNote = payload.trucking?.usedFallback
    ? `Fallback Weekly Runs mock (${payload.trucking.summary?.rowsFound || 0} row(s))`
    : `${payload.trucking.summary?.rowsFound || 0} Weekly Runs row(s)`;

  const activeNote = payload.activeShows?.matchedShow
    ? payload.activeShows.usedFallback
      ? `Fallback match: ${payload.activeShows.matchedShow.name}`
      : `Matched: ${payload.activeShows.matchedShow.name}`
    : "No Active Shows row matched";

  const slack = payload.slack || {};
  const slackCount = Array.isArray(slack.matchedSignals) ? slack.matchedSignals.length : 0;
  const slackNote =
    slack.sourceStatus === "connected" || slack.sourceStatus === "partial"
      ? `${slackCount} matched signal(s); unresolved=${slack.unresolvedCount || 0}`
      : slack.warning || "Slack operational signals unavailable";

  return [
    {
      source: "FLEX",
      status: payload.flex?.sourceStatus || "unavailable",
      note: flexNote,
    },
    {
      source: "Trucking",
      status: payload.trucking?.sourceStatus || "unavailable",
      note: truckingNote,
    },
    {
      source: "Active Shows",
      status: payload.activeShows?.sourceStatus || "unavailable",
      note: activeNote,
    },
    {
      source: "Slack",
      status: slack.sourceStatus || "unavailable",
      note: slackNote,
    },
    {
      source: "Staffing",
      status: "unavailable",
      note: "No live staffing system connected; using FLEX labor lines only.",
    },
    {
      source: "Warehouse",
      status: "unavailable",
      note: "No live warehouse system connected; using FLEX equipment/section signals only.",
    },
  ];
}

function deriveComplexityLevel(payload, overallStatus) {
  const flexComplexity = payload?.flex?.complexityEstimate || "Low";
  const summary = payload?.trucking?.summary || {};
  const truckingComplex =
    Number(summary.rowsFound || 0) >= 3 ||
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.needDriverRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0;

  if (truckingComplex) {
    if (Number(summary.needDriverRows || 0) > 0 || Number(summary.rowsFound || 0) >= 5) {
      return "High";
    }
    return flexComplexity === "High" ? "High" : "Medium";
  }

  if (overallStatus === "at_risk" || overallStatus === "blocked") {
    return flexComplexity === "Low" ? "Medium" : flexComplexity;
  }

  return flexComplexity;
}

export function buildFullShowOperationalFallback(payload) {
  const rawFindings = buildDeterministicCrossSourceFindings(payload);
  const buckets = partitionOperationalBuckets(rawFindings, payload);
  const overallStatus = deriveOverallStatus(buckets.crossSourceFindings, payload);
  const complexityLevel = deriveComplexityLevel(payload, overallStatus);
  const sourceCoverage = buildSourceCoverage(payload);
  const statusReason = buildStatusReason(overallStatus, payload, buckets);
  const flex = payload.flex || {};
  const trucking = payload.trucking || {};
  const summary = trucking.summary || {};

  const flexSimple = (flex.complexityEstimate || "Low") === "Low";
  const truckingAttention =
    Number(summary.rowsFound || 0) >= 2 ||
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.needDriverRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0;

  let assessment;
  if (flexSimple && truckingAttention) {
    const bits = [];
    if (Number(summary.rowsFound || 0) > 1) bits.push("multiple movements");
    if (Number(summary.maybeTruckRows || 0) > 0) bits.push("unresolved Maybe Truck movements");
    if (
      Number(summary.infoSentFalse || 0) > 0 ||
      Number(summary.lpoSentFalse || 0) > 0
    ) {
      bits.push("incomplete Info/LPO administration");
    }
    if (Number(summary.needDriverRows || 0) > 0) {
      bits.push("NEED DRIVER requirement(s)");
    }
    if (Number(summary.tbdRows || 0) > 0) {
      bits.push("TBD timing or equipment fields");
    }
    const because = bits.length ? bits.join(", ") : "execution exceptions in Weekly Runs";
    assessment = `FLEX scope appears simple, but trucking execution needs review because Weekly Runs shows ${because}. Confirm open trucking items before treating the show as clear.`;
  } else if (overallStatus === "clear") {
    assessment = `Connected sources for ${payload.show?.name || "this show"} do not currently show material cross-source operational exceptions.`;
  } else {
    const bits = [];
    if (Number(summary.maybeTruckRows || 0) > 0) bits.push("unresolved Maybe Truck movements");
    if (Number(summary.infoSentFalse || 0) > 0 || Number(summary.lpoSentFalse || 0) > 0) {
      bits.push("incomplete Info/LPO administration");
    }
    if (Number(summary.tbdRows || 0) > 0) bits.push("TBD fields");
    if (Number(summary.needDriverRows || 0) > 0) bits.push("NEED DRIVER rows");
    const because = bits.length ? bits.join(", ") : "open items across connected sources";
    assessment = `${payload.show?.name || "This show"} needs operational follow-up. Weekly Runs and related FLEX workstreams show ${because}. Confirm those items before execution.`;
  }
  assessment = scrubExecutiveAssessment(assessment, 3);

  const dateRange = [
    payload.show?.loadInDate || payload.show?.plannedStartDate || null,
    payload.show?.loadOutDate || payload.show?.plannedEndDate || null,
  ]
    .filter(Boolean)
    .join(" → ");

  const confirmedIssueTexts = buckets.confirmedIssues.map((item) => item.finding);
  const needsConfirmationTexts = buckets.needsConfirmation.map((item) => item.finding);

  return {
    headline: "Full Show Operational Review",
    scopeLabel: "CUE Full Show Review",
    assessment,
    overallStatus,
    statusReason,
    complexityLevel,
    confidence:
      flex.documents?.length && Number(summary.rowsFound || 0) > 0 ? "medium" : "low",
    sourceCoverage,
    showSummary: {
      showName: payload.show?.name || null,
      client: payload.show?.client || null,
      venue: payload.show?.venue || null,
      dateRange: dateRange || null,
      relatedQuotes: flex.relatedQuotes || [],
      relatedWorkstreams: flex.relatedWorkstreams || [],
      projectManagers: payload.show?.projectManagers || [],
      operationalOwners: payload.show?.operationalOwners || [],
    },
    flexScope: {
      assessment: `FLEX complexity estimate ${flex.complexityEstimate || "Low"} across ${(flex.relatedQuotes || []).length} related quote(s).`,
      quoteCount: (flex.relatedQuotes || []).length,
      relatedQuotes: flex.relatedQuotes || [],
      relatedWorkstreams: flex.relatedWorkstreams || [],
      laborHeadcount: flex.laborHeadcount || 0,
      laborPersonDays: flex.laborPersonDays || 0,
      transportationLineCount: flex.transportationLineCount || 0,
      equipmentLineItemCount: flex.equipmentLineItemCount || 0,
      majorFamilies: flex.majorFamilies || [],
      findings: [
        `${(flex.relatedQuotes || []).length} related FLEX quote(s) in scope.`,
        `Labor headcount ${flex.laborHeadcount || 0}; person-days ${flex.laborPersonDays || 0}.`,
        `Transportation lines ${flex.transportationLineCount || 0}; equipment line items ${flex.equipmentLineItemCount || 0}.`,
      ],
    },
    truckingExecution: {
      assessment: summary.status || "Trucking status unavailable.",
      runCount: Number(summary.rowsFound || 0),
      status: summary.status || null,
      findings: asStringArray(summary.findings, 6),
      actions: asStringArray(summary.actions, 4),
    },
    staffing: {
      assessment:
        (flex.laborHeadcount || 0) > 0
          ? `FLEX lists ${flex.laborHeadcount} labor headcount. No live staffing system is connected.`
          : "No FLEX labor lines found. No live staffing system is connected.",
      sourceStatus: "unavailable",
      findings: [
        "Staffing status is inferred from FLEX labor lines only.",
        ...(flex.laborHeadcount
          ? [`FLEX labor headcount: ${flex.laborHeadcount}.`]
          : ["No FLEX labor headcount detected."]),
      ],
      actions:
        (flex.laborHeadcount || 0) > 0
          ? ["Confirm staffing coverage against FLEX labor lines."]
          : ["Confirm whether staffing scope should appear in FLEX."],
    },
    warehouse: {
      assessment:
        (flex.equipmentLineItemCount || 0) > 0
          ? `Warehouse view is inferred from ${flex.equipmentLineItemCount} FLEX equipment line item(s). No live warehouse system is connected.`
          : "No FLEX equipment line items found. No live warehouse system is connected.",
      sourceStatus: "unavailable",
      complexity: flex.complexityEstimate || "Low",
      findings: [
        ...(flex.majorFamilies || []).length
          ? [`Major equipment families: ${(flex.majorFamilies || []).join(", ")}.`]
          : ["No major equipment families detected from FLEX."],
      ],
      actions:
        (flex.equipmentLineItemCount || 0) > 0
          ? ["Review warehouse pull scope against FLEX equipment families."]
          : [],
    },
    slack: {
      sourceStatus: payload.slack?.sourceStatus || "unavailable",
      lastSyncAt: payload.slack?.lastSyncAt || null,
      matchedSignals: Array.isArray(payload.slack?.matchedSignals)
        ? payload.slack.matchedSignals
        : [],
      unresolvedCount: Number(payload.slack?.unresolvedCount || 0),
      atRiskCount: Number(payload.slack?.atRiskCount || 0),
      blockedCount: Number(payload.slack?.blockedCount || 0),
      resolvedCount: Number(payload.slack?.resolvedCount || 0),
      needsReviewCount: Number(payload.slack?.needsReviewCount || 0),
    },
    crossSourceFindings: buckets.crossSourceFindings.map((item) => ({
      ...item,
      evidence: cleanEvidenceText(item.evidence),
    })),
    confirmedIssues: confirmedIssueTexts,
    confirmedIssueDetails: buckets.confirmedIssues,
    needsConfirmation: needsConfirmationTexts,
    needsConfirmationDetails: buckets.needsConfirmation,
    coverageGaps: buckets.coverageGaps,
    recommendedNextActions: prioritizeActions(buckets, payload),
    assumptions: [
      "Full show review uses currently connected sources: FLEX, Trucking Weekly Runs, Active Shows Index, and Slack when configured.",
      "Staffing and warehouse systems are unavailable; FLEX lines are used as proxies only and are listed under Source / Coverage Gaps.",
      "Active Shows text notes are contextual unless independently confirmed by live FLEX or Weekly Runs.",
      "Slack is current operational evidence for matched messages but does not override FLEX sold scope.",
      trucking.usedFallback
        ? "Trucking data used the safe fallback mock because live Weekly Runs was unavailable."
        : "Trucking data reflects the connected Weekly Runs source.",
      payload.activeShows?.usedFallback
        ? "Active Shows data used the safe fallback mock because the live index was unavailable."
        : "Active Shows data reflects the connected index source when matched.",
    ],
    source: "local_fallback",
  };
}

export function normalizeFullShowOperationalAnalysis(raw, fallback, payload) {
  const base = isPlainObject(raw) ? raw : {};
  const fb = fallback || buildFullShowOperationalFallback(payload);
  const lockedFindings = buildDeterministicCrossSourceFindings(payload);
  const modelFindings = Array.isArray(base.crossSourceFindings)
    ? base.crossSourceFindings
        .filter(isPlainObject)
        .map((item) => ({
          category: inferFindingCategory(item.finding, item.evidence),
          severity: clampEnum(
            item.severity,
            ["low", "medium", "high", "critical"],
            "medium"
          ),
          status: clampEnum(
            item.status,
            ["review_needed", "at_risk", "blocked"],
            "review_needed"
          ),
          area: clampEnum(
            item.area,
            ["FLEX", "Trucking", "Staffing", "Warehouse", "Timing", "PM", "Data"],
            "Data"
          ),
          finding: String(item.finding || "").trim(),
          evidence: String(item.evidence || "").trim(),
          sources: asStringArray(item.sources, 6),
          owner: String(item.owner || "").trim() || "PM",
          action: String(item.action || "").trim(),
          bucket: item.bucket || null,
        }))
        .filter((item) => item.finding)
    : [];

  const mergedRawFindings = dedupeFindingsByCategory([
    ...lockedFindings,
    ...modelFindings,
  ]);
  const buckets = partitionOperationalBuckets(mergedRawFindings, payload);
  const lockedOverall = deriveOverallStatus(buckets.crossSourceFindings, payload);
  const lockedComplexity = deriveComplexityLevel(payload, lockedOverall);
  const statusReason = buildStatusReason(lockedOverall, payload, buckets);

  let finalAssessment =
    String(base.assessment || fb.assessment || "").trim() || fb.assessment;
  const summary = payload?.trucking?.summary || {};
  const flexSimple = (payload?.flex?.complexityEstimate || "Low") === "Low";
  const truckingComplex =
    Number(summary.rowsFound || 0) >= 3 ||
    Number(summary.maybeTruckRows || 0) > 0 ||
    Number(summary.needDriverRows || 0) > 0 ||
    Number(summary.infoSentFalse || 0) > 0 ||
    Number(summary.lpoSentFalse || 0) > 0;

  if (
    flexSimple &&
    truckingComplex &&
    /\b(simple|clear|low complexity|operationally simple)\b/i.test(finalAssessment) &&
    !/\btrucking\b/i.test(finalAssessment)
  ) {
    finalAssessment = fb.assessment;
  }

  // Keep statusReason in payload for debugging; scrub it out of executive assessment copy.
  finalAssessment = scrubExecutiveAssessment(finalAssessment, 3) || scrubExecutiveAssessment(fb.assessment, 3);

  let complexityLevel = clampEnum(
    base.complexityLevel,
    ["Low", "Medium", "High"],
    lockedComplexity
  );
  if (flexSimple && truckingComplex && complexityLevel === "Low") {
    complexityLevel = lockedComplexity === "Low" ? "Medium" : lockedComplexity;
  }

  return {
    headline: String(base.headline || fb.headline || "Full Show Operational Review").trim(),
    scopeLabel: String(base.scopeLabel || fb.scopeLabel || "CUE Full Show Review").trim(),
    assessment: finalAssessment,
    overallStatus: lockedOverall,
    statusReason,
    complexityLevel,
    confidence: clampEnum(base.confidence, ["low", "medium", "high"], fb.confidence),
    sourceCoverage: buildSourceCoverage(payload),
    showSummary: {
      showName: payload.show?.name || fb.showSummary?.showName || null,
      client: payload.show?.client || fb.showSummary?.client || null,
      venue: payload.show?.venue || fb.showSummary?.venue || null,
      dateRange: fb.showSummary?.dateRange || null,
      relatedQuotes: payload.flex?.relatedQuotes || [],
      relatedWorkstreams: payload.flex?.relatedWorkstreams || [],
      projectManagers: payload.show?.projectManagers || [],
      operationalOwners: payload.show?.operationalOwners || [],
    },
    flexScope: {
      assessment: String(base.flexScope?.assessment || fb.flexScope?.assessment || "").trim(),
      quoteCount: (payload.flex?.relatedQuotes || []).length,
      relatedQuotes: payload.flex?.relatedQuotes || [],
      relatedWorkstreams: payload.flex?.relatedWorkstreams || [],
      laborHeadcount: payload.flex?.laborHeadcount || 0,
      laborPersonDays: payload.flex?.laborPersonDays || 0,
      transportationLineCount: payload.flex?.transportationLineCount || 0,
      equipmentLineItemCount: payload.flex?.equipmentLineItemCount || 0,
      majorFamilies: payload.flex?.majorFamilies || [],
      findings: asStringArray(base.flexScope?.findings, 6).length
        ? asStringArray(base.flexScope?.findings, 6)
        : asStringArray(fb.flexScope?.findings, 6),
    },
    truckingExecution: {
      assessment: String(
        base.truckingExecution?.assessment || fb.truckingExecution?.assessment || ""
      ).trim(),
      runCount: Number(payload.trucking?.summary?.rowsFound || 0),
      status: payload.trucking?.summary?.status || null,
      findings: asStringArray(payload.trucking?.summary?.findings, 6),
      actions: asStringArray(payload.trucking?.summary?.actions, 4),
    },
    staffing: {
      assessment: String(base.staffing?.assessment || fb.staffing?.assessment || "").trim(),
      sourceStatus: "unavailable",
      findings: asStringArray(fb.staffing?.findings, 4),
      actions: asStringArray(fb.staffing?.actions, 3),
    },
    warehouse: {
      assessment: String(base.warehouse?.assessment || fb.warehouse?.assessment || "").trim(),
      sourceStatus: "unavailable",
      complexity: clampEnum(
        base.warehouse?.complexity,
        ["Low", "Medium", "High"],
        fb.warehouse?.complexity || "Low"
      ),
      findings: asStringArray(fb.warehouse?.findings, 4),
      actions: asStringArray(fb.warehouse?.actions, 3),
    },
    slack: {
      sourceStatus: payload.slack?.sourceStatus || fb.slack?.sourceStatus || "unavailable",
      lastSyncAt: payload.slack?.lastSyncAt || fb.slack?.lastSyncAt || null,
      matchedSignals: Array.isArray(payload.slack?.matchedSignals)
        ? payload.slack.matchedSignals
        : Array.isArray(fb.slack?.matchedSignals)
          ? fb.slack.matchedSignals
          : [],
      unresolvedCount: Number(payload.slack?.unresolvedCount || fb.slack?.unresolvedCount || 0),
      atRiskCount: Number(payload.slack?.atRiskCount || fb.slack?.atRiskCount || 0),
      blockedCount: Number(payload.slack?.blockedCount || fb.slack?.blockedCount || 0),
      resolvedCount: Number(payload.slack?.resolvedCount || fb.slack?.resolvedCount || 0),
      needsReviewCount: Number(
        payload.slack?.needsReviewCount || fb.slack?.needsReviewCount || 0
      ),
    },
    crossSourceFindings: buckets.crossSourceFindings.map((item) => ({
      ...item,
      evidence: cleanEvidenceText(item.evidence),
    })),
    confirmedIssues: buckets.confirmedIssues.map((item) => item.finding),
    confirmedIssueDetails: buckets.confirmedIssues,
    needsConfirmation: buckets.needsConfirmation.map((item) => item.finding),
    needsConfirmationDetails: buckets.needsConfirmation,
    coverageGaps: buckets.coverageGaps,
    recommendedNextActions: prioritizeActions(buckets, payload),
    assumptions: asStringArray(base.assumptions, 8).length
      ? asStringArray(base.assumptions, 8)
      : asStringArray(fb.assumptions, 8),
    source: isPlainObject(raw) ? "openai" : "local_fallback",
  };
}

const FULL_SHOW_OPERATIONAL_RULES = `
Ask FLEX Full Show Operational Review rules:

1. Analyze the whole show across connected sources: FLEX, Trucking Weekly Runs, Active Shows Index.
2. Never invent quantities, dates, trucks, drivers, or conflicts.
3. The most operationally significant evidence across sources drives the final assessment. Write assessment in concise operating language (max 3 sentences). Do not include internal phrasing like "overallStatus is...".
4. If FLEX looks simple but trucking has multiple movements / Maybe Truck / NEED DRIVER / incomplete Info/LPO, overall status must NOT be clear and complexity must NOT stay Low solely due to FLEX.
5. Explicit trucking Weekly Runs evidence overrides quote-only assumptions.
6. Do not suppress NEED DRIVER when trucking rows contain it. NEED DRIVER is an execution-impacting issue and may justify at_risk.
7. Info Sent / LPO Sent / TBD alone should normally be review_needed, not at_risk. Maybe Truck with unclear requirement/impact is review_needed, not at_risk. blocked requires a confirmed blocker.
8. Active Shows text notes are contextual unless independently confirmed by live FLEX or Weekly Runs. Do not place contextual/stale Active Shows notes under confirmedIssues.
9. Staffing and warehouse live systems are unavailable — list them under coverage gaps only; never as confirmed show issues. Use FLEX proxies only.
10. Deduplicate findings by issue category (Maybe Truck, Info Sent, LPO Sent, TBD, missing venue, multi-quote alignment each appear at most once). Merge same-issue evidence.
11. One direct trucking quote match among multiple related workstreams is Needs Confirmation, not a confirmed issue. Phrase: Weekly Runs references {quote} directly. Confirm whether the other related workstreams intentionally share that transportation plan.
12. Keep crossSourceFindings to the highest-value unique findings. Keep recommendedNextActions to at most 5 prioritized actions. Do not repeat the same issue across assessment, findings, confirmedIssues, needsConfirmation, and actions.
13. Distinguish facts from interpretation. AI recommends; humans approve.
`;

export async function buildFullShowOperationalAnalysis(payload, deps = {}) {
  const fallback = buildFullShowOperationalFallback(payload);

  if (!process.env.OPENAI_API_KEY || !deps.openai?.responses?.create) {
    return fallback;
  }

  try {
    const selectCueModel =
      typeof deps.selectCueModel === "function" ? deps.selectCueModel : () => ({ model: "gpt-4.1-mini" });
    const modelConfig = selectCueModel({}, payload);
    console.log("[CUE ASK FLEX FULL SHOW MODEL SELECT]", {
      selectedModel: modelConfig.model,
    });

    const compactPayload = {
      question: payload.question,
      scope: payload.scope,
      show: payload.show,
      flex: {
        sourceStatus: payload.flex?.sourceStatus,
        relatedQuotes: payload.flex?.relatedQuotes,
        laborHeadcount: payload.flex?.laborHeadcount,
        laborPersonDays: payload.flex?.laborPersonDays,
        transportationLineCount: payload.flex?.transportationLineCount,
        equipmentLineItemCount: payload.flex?.equipmentLineItemCount,
        majorFamilies: payload.flex?.majorFamilies,
        complexityEstimate: payload.flex?.complexityEstimate,
        documentSummaries: (payload.flex?.documents || []).map((doc) => ({
          documentNumber: doc.documentNumber,
          showName: doc.showName,
          client: doc.client,
          venue: doc.venue,
          projectManager: doc.projectManager,
          sectionCount: doc.sections?.length || 0,
          laborCount: doc.laborItems?.length || 0,
          transportationCount: doc.transportationItems?.length || 0,
          equipmentCount: doc.inventoryItems?.length || 0,
        })),
      },
      trucking: {
        source: payload.trucking?.source,
        usedFallback: payload.trucking?.usedFallback,
        sourceStatus: payload.trucking?.sourceStatus,
        summary: payload.trucking?.summary,
        comparison: payload.trucking?.comparison,
        rowCount: payload.trucking?.rows?.length || 0,
      },
      activeShows: {
        source: payload.activeShows?.source,
        usedFallback: payload.activeShows?.usedFallback,
        sourceStatus: payload.activeShows?.sourceStatus,
        matchedShow: payload.activeShows?.matchedShow,
        readinessStatus: payload.activeShows?.readinessStatus,
        topIssue: payload.activeShows?.topIssue,
        nextAction: payload.activeShows?.nextAction,
      },
      unavailableSources: payload.unavailableSources,
      deterministicFindings: buildDeterministicCrossSourceFindings(payload),
    };

    const response = await deps.openai.responses.create({
      model: modelConfig.model,
      input: [
        {
          role: "system",
          content:
            "You are CUE Ask FLEX Full Show Operational Review for Music Matters. Return only valid JSON. Do not include markdown. Distinguish connected-source facts from interpretation. Never invent quantities, dates, trucks, drivers, or conflicts. AI recommends; humans approve.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Produce a cross-source full show operational review.",
            output_requirement:
              "Return only valid JSON matching required_schema. The response must be JSON.",
            operating_rules: FULL_SHOW_OPERATIONAL_RULES,
            required_schema: {
              headline: "Full Show Operational Review",
              scopeLabel: "CUE Full Show Review",
              assessment: "2-3 concise operating sentences; no internal overallStatus phrasing",
              overallStatus: "clear | review_needed | at_risk | blocked",
              complexityLevel: "Low | Medium | High",
              confidence: "low | medium | high",
              sourceCoverage: [
                {
                  source: "FLEX | Trucking | Active Shows | Staffing | Warehouse",
                  status: "connected | partial | unavailable | fallback",
                  note: "string",
                },
              ],
              showSummary: {
                showName: "string",
                client: "string | null",
                venue: "string | null",
                dateRange: "string | null",
                relatedQuotes: ["string"],
                projectManagers: ["string"],
                operationalOwners: ["string"],
              },
              flexScope: {
                assessment: "string",
                quoteCount: "number",
                relatedQuotes: ["string"],
                laborHeadcount: "number",
                laborPersonDays: "number",
                transportationLineCount: "number",
                equipmentLineItemCount: "number",
                majorFamilies: ["string"],
                findings: ["string"],
              },
              truckingExecution: {
                assessment: "string",
                runCount: "number",
                status: "string",
                findings: ["string"],
                actions: ["string"],
              },
              staffing: {
                assessment: "string",
                sourceStatus: "unavailable",
                findings: ["string"],
                actions: ["string"],
              },
              warehouse: {
                assessment: "string",
                sourceStatus: "unavailable",
                complexity: "Low | Medium | High",
                findings: ["string"],
                actions: ["string"],
              },
              crossSourceFindings: [
                {
                  severity: "low | medium | high | critical",
                  status: "review_needed | at_risk | blocked",
                  area: "FLEX | Trucking | Staffing | Warehouse | Timing | PM | Data",
                  finding: "string",
                  evidence: "string",
                  sources: ["string"],
                  owner: "string",
                  action: "string",
                },
              ],
              confirmedIssues: ["string"],
              needsConfirmation: ["string"],
              coverageGaps: ["string"],
              recommendedNextActions: ["up to 5 prioritized strings"],
              assumptions: ["string"],
            },
            compact_payload: compactPayload,
            fallback_assessment_example:
              "FLEX scope appears simple, but trucking execution needs review because Weekly Runs shows multiple movements, unresolved Maybe Truck movements, and incomplete Info/LPO administration. Confirm open trucking items before treating the show as clear.",
          }),
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    });

    const parse =
      typeof deps.safeParseModelJson === "function"
        ? deps.safeParseModelJson
        : (text) => {
            try {
              return JSON.parse(text);
            } catch {
              return null;
            }
          };

    const raw = parse(response.output_text);
    if (!raw || raw?.cue_review_cards) {
      return fallback;
    }

    return normalizeFullShowOperationalAnalysis(raw, fallback, payload);
  } catch (error) {
    console.error("[CUE ASK FLEX FULL SHOW] OpenAI failed; using local fallback.", error);
    return fallback;
  }
}

function buildSafeSupportingData(payload) {
  return {
    scope: payload.scope,
    showName: payload.show?.name || null,
    relatedQuotes: payload.flex?.relatedQuotes || [],
    flexSourceStatus: payload.flex?.sourceStatus || null,
    truckingSource: payload.trucking?.source || null,
    truckingUsedFallback: Boolean(payload.trucking?.usedFallback),
    truckingRowCount: payload.trucking?.rows?.length || 0,
    activeShowsSource: payload.activeShows?.source || null,
    activeShowsUsedFallback: Boolean(payload.activeShows?.usedFallback),
    activeShowsMatched: Boolean(payload.activeShows?.matchedShow),
    unavailableSources: payload.unavailableSources || [],
    truckingSummary: {
      rowsFound: payload.trucking?.summary?.rowsFound ?? 0,
      maybeTruckRows: payload.trucking?.summary?.maybeTruckRows ?? 0,
      needDriverRows: payload.trucking?.summary?.needDriverRows ?? 0,
      infoSentFalse: payload.trucking?.summary?.infoSentFalse ?? 0,
      lpoSentFalse: payload.trucking?.summary?.lpoSentFalse ?? 0,
      tbdRows: payload.trucking?.summary?.tbdRows ?? 0,
      status: payload.trucking?.summary?.status || null,
      quoteNumbersMatched: Array.isArray(payload.trucking?.summary?.quoteNumbersMatched)
        ? payload.trucking.summary.quoteNumbersMatched.slice(0, 20)
        : [],
    },
  };
}

export async function answerShowOperationalAnalysis(question, deps = {}) {
  const resolved = await resolveFullShowContext(question, deps);

  if (resolved.needsClarification) {
    return {
      question,
      intent: "show_operational_analysis",
      needsClarification: true,
      found: false,
      answer: resolved.answer,
    };
  }

  if (resolved.needsSelection) {
    return {
      question,
      intent: "show_operational_analysis",
      needsSelection: true,
      found: false,
      showName: resolved.showNameQuery || null,
      answer: resolved.answer,
      matches: resolved.matches || [],
      searchQuery: resolved.showNameQuery || null,
    };
  }

  if (!resolved.ok || resolved.found === false) {
    return {
      question,
      intent: "show_operational_analysis",
      found: false,
      showName: resolved.showNameQuery || null,
      answer: resolved.answer || "I could not resolve that show for a full operational review.",
    };
  }

  const payload = buildFullShowOperationalPayload({
    question,
    resolvedShow: resolved.resolvedShow,
    flexDocuments: resolved.flexDocuments,
    truckingResult: resolved.truckingResult,
    truckingSummary: resolved.truckingSummary,
    comparison: resolved.comparison,
    activeShowResult: resolved.activeShowResult,
    flexWarnings: resolved.flexWarnings,
    slackSignals: resolved.slackSignals,
  });

  const result = await buildFullShowOperationalAnalysis(payload, deps);

  let snapshotMeta = null;
  try {
    const store =
      deps.reviewSnapshotStore ||
      (typeof deps.getReviewSnapshotStore === "function"
        ? deps.getReviewSnapshotStore()
        : null);
    if (store?.saveFromReview) {
      const saveResult = await store.saveFromReview(result, {
        showName: payload.show?.name || resolved.resolvedShow?.name || null,
        supportingData: buildSafeSupportingData(payload),
        buildLabel: deps.buildLabel || null,
        activeShows: {
          readinessStatus: payload.activeShows?.readinessStatus || null,
          priority: payload.activeShows?.matchedShow?.priority || null,
          topIssue: payload.activeShows?.topIssue || null,
          nextAction: payload.activeShows?.nextAction || null,
        },
        reviewedAt: new Date().toISOString(),
      });
      snapshotMeta = {
        id: saveResult.snapshot?.id || null,
        showKey: saveResult.snapshot?.showKey || null,
        saved: Boolean(saveResult.saved),
        duplicate: Boolean(saveResult.duplicate),
        previousSnapshotId: saveResult.previousSnapshotId || null,
        changeCount: Number(saveResult.changeCount || 0),
        hasChanges: Boolean(saveResult.hasChanges),
        warning: saveResult.warning || null,
      };
      if (saveResult.warning) {
        result.warnings = [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          saveResult.warning,
        ];
      }
    }
  } catch (error) {
    console.warn(
      "[CUE ASK FLEX SNAPSHOTS] Snapshot attach failed; continuing without persistence.",
      error?.message || error
    );
    snapshotMeta = {
      id: null,
      showKey: null,
      saved: false,
      duplicate: false,
      previousSnapshotId: null,
      changeCount: 0,
      hasChanges: false,
      warning: "Snapshot persistence unavailable for this review.",
    };
  }

  return {
    question,
    intent: "show_operational_analysis",
    found: true,
    showName: payload.show?.name || resolved.resolvedShow?.name || null,
    answer: result.assessment,
    result,
    supportingData: buildSafeSupportingData(payload),
    sourceCoverage: result.sourceCoverage,
    snapshot: snapshotMeta,
  };
}
