import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import OpenAI from "openai";
import "dotenv/config";
import {
  isShowOperationalAnalysisQuestion,
  answerShowOperationalAnalysis,
} from "./ask-flex-full-show-review.mjs";
import {
  isShowOperationalFollowupQuestion,
  isRefreshFollowupQuestion,
  answerFullShowFollowup,
  sanitizeFullShowFollowupContext,
  classifyFullShowFollowupType,
} from "./ask-flex-full-show-followup.mjs";
import { defaultReviewSnapshotStore } from "./ask-flex-review-snapshot-store.mjs";
import { formatChangeComparisonItems } from "./ask-flex-review-change-detection.mjs";
import { createSlackOperationalSignalsService } from "./slack-operational-signals-service.mjs";
import { defaultCueFoundationStore } from "./cue-foundation-store.mjs";
import { canonicalShowToSlackCandidate } from "./canonical-show-registry.mjs";
import {
  adaptDriveFileToIntakeRecord,
  adaptEmailMessageToIntakeRecord,
  buildActiveShowIndexBatch,
} from "./cue-intake-evidence-adapters.mjs";
import {
  activeShowIndexRowsToObjects as parseActiveShowIndexRows,
  extractActiveShowFlexDocumentRefs,
  extractActiveShowFlexDocumentNumbers,
  mapActiveShowIndexAuthorityRow,
  runSourceFirstIntakeSync,
} from "./active-show-index-authority.mjs";
import {
  buildFlexQuoteUrl,
  inferFlexDocumentType,
  isFlexElementId,
  parseFlexQuoteUrl,
  selectFlexDocumentCandidate,
  selectPrimaryShowQuote,
} from "./flex-quote-link.mjs";
import {
  FLEX_LIFECYCLE_CONNECTOR_NAME,
  FLEX_LIFECYCLE_REQUIRED_FIELDS,
  flexLifecycleUnavailable,
  runFlexLifecycleDiscovery,
} from "./flex-lifecycle-discovery.mjs";
import {
  FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR,
  FLEX_CONFIRMED_STATUS_ID,
  FLEX_MMP_QUOTE_DEFINITION_ID,
  FLEX_PEACHTREE_CORNERS_LOCATION_ID as FLEX_CONFIRMED_QUOTE_LOCATION_ID,
  buildFlexConfirmedQuoteListUrl,
  buildFlexStatusHistoryUrl,
  runFlexConfirmedQuoteSnapshot,
} from "./flex-confirmed-quote-snapshot.mjs";
import {
  fetchFlexJson,
  getFlexRequestTimeoutMs,
  isSkippableFlexRequestError,
} from "./flex-request-client.mjs";
import { loadIntelligenceRulesCatalog } from "./cue-intelligence-rules-catalog.mjs";
import { adaptActiveShowToIntelligenceSnapshot } from "./cue-intelligence-show-snapshot.mjs";
import { evaluateIntelligenceRules } from "./cue-intelligence-rules-engine.mjs";
import { defaultIntelligenceFindingsStore } from "./cue-intelligence-findings-store.mjs";

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.resolve("./cue-flex-intake-lab.html");
const ASK_FLEX_HTML_FILE = path.resolve("./ask-flex.html");
const COMMAND_CENTER_HTML_FILE = path.resolve("./command-center.html");
const CUE_LOGO_FILE = path.resolve("./cue-logo.svg");
const CUE_PILOT_PASSWORD = process.env.CUE_PILOT_PASSWORD || "";
const CUE_PILOT_SESSION_SECRET =
  process.env.CUE_PILOT_SESSION_SECRET || "local-private-pilot-secret";

function resolveCueBuildId() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.CUE_BUILD_ID || "unknown";
  }
}

function resolveCueBuildBranch() {
  try {
    return execSync("git branch --show-current", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.CUE_BUILD_BRANCH || "unknown";
  }
}

// Temporary build identifier so browser/API can confirm the intended server build.
const CUE_BUILD_ID = resolveCueBuildId();
const CUE_BUILD_BRANCH = resolveCueBuildBranch();
const CUE_BUILD_LABEL = `${CUE_BUILD_BRANCH}@${CUE_BUILD_ID}`;

const slackOperationalSignalsService = createSlackOperationalSignalsService();
const SLACK_FIXTURE_MODE =
  String(process.env.SLACK_OPERATIONAL_FIXTURE_MODE || "").trim() === "1" ||
  String(process.env.SLACK_OPERATIONAL_FIXTURE_MODE || "").toLowerCase() === "true";

/** Wired after Active Shows helpers exist inside the HTTP server bootstrap. */
const slackMatchDeps = {
  getCandidateShows: async () => [],
  resolveQuoteCandidate: null,
};

slackOperationalSignalsService.configureMatching({
  getCandidateShows: (...args) => slackMatchDeps.getCandidateShows(...args),
  resolveQuoteCandidate: (...args) =>
    typeof slackMatchDeps.resolveQuoteCandidate === "function"
      ? slackMatchDeps.resolveQuoteCandidate(...args)
      : null,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const FLEX_ROW_DATA_CODES = [
  "conflict",
  "type",
  "quantity",
  "name",
  "note",
  "timeQty",
  "pricingModel",
  "priceEach",
  "priceExtended",
  "warehouseMute",
  "noteMute",
  "priceMute",
  "lineMute",
  "totalMute",
];

const FLEX_HEADER_CODES = [
  "documentNumber",
  "name",
  "status",
  "statusId",
  "workflowStatus",
  "elementStatus",
  "clientId",
  "venueId",
  "plannedStartDate",
  "plannedEndDate",
  "loadInDate",
  "showStartDate",
  "loadOutDate",
  "shippingMethodId",
  "personResponsibleId",
  "projectManagerId",
  "notes",

  // FLEX financial totals shown on the quote/invoice Totals tab.
  // These may vary by FLEX configuration; summary logic includes fallbacks.
  "discount",
  "subtotal",
  "salesTax",
  "additionalDiscount",
  "creditCardFee",
  "total",
  "totalAppliedPayments",
  "balanceDue",

  // Music Matters custom Ship Date field discovered earlier.
  "1d3824da-d004-41cc-b9f8-a3db6b9c4a6d",
];


const FLEX_MUSIC_MATTERS_INVOICES_DEFINITION_ID =
  process.env.FLEX_MUSIC_MATTERS_INVOICES_DEFINITION_ID ||
  "d256daec-b055-11df-b8d5-00e08175e43e";

const FLEX_PEACHTREE_CORNERS_LOCATION_ID =
  process.env.FLEX_PEACHTREE_CORNERS_LOCATION_ID ||
  "2f49c62c-b139-11df-b8d5-00e08175e43e";

const FLEX_MONTHLY_SALES_HEADER_FIELDS = [
  "name",
  "documentNumber",
  "clientId",
  "personResponsibleId",
  "statusId",
  "corporateIdentityId",
  "locationId",
  "preparedDate",
  "plannedStartDate",
  "dueDate",
  "totalPrice",
  "totalAppliedPayments",
  "balanceDue",
  "notes",
  "pickupLocationId",
  "returnLocationId",
];

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(data));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 2_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeParseModelJson(outputText) {
  try {
    return JSON.parse(outputText);
  } catch {
    return {
      summary: outputText || "Model returned an empty or non-JSON response.",
      cue_review_cards: [
        {
          card_type: "risk",
          title: "Model Response Format Warning",
          owner: "Ops Review",
          status: "warning",
          priority: "medium",
          summary: "The model returned text instead of valid JSON.",
          detected_items: [],
          risks: ["The AI response could not be parsed into CUE review cards."],
          recommended_actions: [
            "Retry the analysis.",
            "Reduce the payload size if this continues.",
            "Confirm the model supports JSON output.",
          ],
        },
      ],
      questions_for_pm: [],
      recommended_next_actions: [],
    };
  }
}

function buildFlexHeaders() {
  const headers = {
    Accept: "application/json",
  };

  if (process.env.FLEX_AUTH_HEADER && process.env.FLEX_AUTH_VALUE) {
    headers[process.env.FLEX_AUTH_HEADER] = process.env.FLEX_AUTH_VALUE;
  }

  return headers;
}

function getFlexBaseUrl() {
  if (!process.env.FLEX_BASE_URL) {
    throw new Error("Missing FLEX_BASE_URL in .env");
  }

  return process.env.FLEX_BASE_URL.replace(/\/$/, "");
}

function buildFlexRowDataUrl(elementId) {
  const base = getFlexBaseUrl();

  const url = new URL(
    `${base}/api/financial-document-line-item/${encodeURIComponent(
      elementId
    )}/row-data/`
  );

  url.searchParams.set("_dc", String(Date.now()));

  for (const code of FLEX_ROW_DATA_CODES) {
    url.searchParams.append("codeList", code);
  }

  url.searchParams.set("node", "root");

  return url;
}

function buildFlexHeaderDataUrl(elementId) {
  const base = getFlexBaseUrl();

  const url = new URL(
    `${base}/api/element/${encodeURIComponent(elementId)}/header-data`
  );

  url.searchParams.set("_dc", String(Date.now()));

  for (const code of FLEX_HEADER_CODES) {
    url.searchParams.append("codeList", code);
  }

  return url;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getAtlantaFlexMonthRange(year, month) {
  const yearNumber = Number(year);
  const monthNumber = Number(month);

  if (!Number.isInteger(yearNumber) || yearNumber < 2000 || yearNumber > 2100) {
    throw new Error("Invalid year. Use a four-digit year like 2026.");
  }

  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error("Invalid month. Use 1 through 12.");
  }

  const startMonth = pad2(monthNumber);
  const nextMonthDate = new Date(Date.UTC(yearNumber, monthNumber, 1));
  const nextYear = nextMonthDate.getUTCFullYear();
  const nextMonth = pad2(nextMonthDate.getUTCMonth() + 1);

  // This matches the FLEX report request observed from Music Matters Invoices:
  // local Atlanta month start/end represented as 04:00:00 through 03:59:59.
  // Later we can make this DST-aware, but this exactly matches the discovered June report call.
  return {
    start: `${yearNumber}-${startMonth}-01T04:00:00`,
    end: `${nextYear}-${nextMonth}-01T03:59:59`,
  };
}

function buildFlexMonthlySalesUrl(year, month) {
  const base = getFlexBaseUrl();
  const { start, end } = getAtlantaFlexMonthRange(year, month);

  const url = new URL(`${base}/api/element-list/total-data`);

  url.searchParams.set("_dc", String(Date.now()));
  url.searchParams.set("definitionId", FLEX_MUSIC_MATTERS_INVOICES_DEFINITION_ID);

  for (const field of FLEX_MONTHLY_SALES_HEADER_FIELDS) {
    url.searchParams.append("headerFieldTypeIds", field);
  }

  const filter = [
    {
      property: "locationId",
      valueList: [FLEX_PEACHTREE_CORNERS_LOCATION_ID],
    },
    {
      property: "plannedStartDate",
      value: `${start}|${end}`,
      dateRangeFilter: true,
    },
  ];

  url.searchParams.set("filter", JSON.stringify(filter));

  return {
    url,
    dateRange: { start, end },
    filter,
  };
}

async function fetchFlexMonthlySales(year, month) {
  const { url, dateRange, filter } = buildFlexMonthlySalesUrl(year, month);

  console.log("Fetching FLEX monthly sales total from:", url.toString());

  const data = await fetchJsonFromFlex(url);
  const headerValueMap = data?.headerValueMap || {};

  const monthlySalesTotal = toNumber(headerValueMap.totalPrice);
  const totalAppliedPayments = toNumber(headerValueMap.totalAppliedPayments);
  const balanceDue = toNumber(headerValueMap.balanceDue);

  return {
    year: Number(year),
    month: Number(month),
    dateRange,
    elementCount: Number(data?.elementCount || 0),
    monthlySalesTotal,
    totalPrice: monthlySalesTotal,
    totalAppliedPayments,
    balanceDue,
    source: "Music Matters Invoices total-data report",
    definitionId: FLEX_MUSIC_MATTERS_INVOICES_DEFINITION_ID,
    locationId: FLEX_PEACHTREE_CORNERS_LOCATION_ID,
    dateField: "plannedStartDate",
    filter,
    rawHeaderValueMap: headerValueMap,
    requestUrl: url.toString(),
  };
}

async function fetchFlexSalesGoalsRollup(year) {
  const yearNumber = Number(year);

  if (!Number.isInteger(yearNumber) || yearNumber < 2000 || yearNumber > 2100) {
    throw new Error("Invalid year. Use a four-digit year like 2026.");
  }

  const months = [];

  for (let month = 1; month <= 12; month += 1) {
    const result = await fetchFlexMonthlySales(yearNumber, month);

    months.push({
      year: yearNumber,
      month,
      monthName: [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ][month - 1],
      dateRange: result.dateRange,
      elementCount: result.elementCount,
      monthlySalesTotal: result.monthlySalesTotal,
      totalPrice: result.totalPrice,
      totalAppliedPayments: result.totalAppliedPayments,
      balanceDue: result.balanceDue,
    });
  }

  const yearTotal = Math.round(
    months.reduce((sum, item) => sum + item.monthlySalesTotal, 0) * 100
  ) / 100;

  const totalAppliedPayments = Math.round(
    months.reduce((sum, item) => sum + item.totalAppliedPayments, 0) * 100
  ) / 100;

  const balanceDue = Math.round(
    months.reduce((sum, item) => sum + item.balanceDue, 0) * 100
  ) / 100;

  const elementCount = months.reduce((sum, item) => sum + item.elementCount, 0);

  return {
    year: yearNumber,
    months,
    yearTotal,
    totalPrice: yearTotal,
    totalAppliedPayments,
    balanceDue,
    elementCount,
    source: "Music Matters Invoices total-data report",
    definitionId: FLEX_MUSIC_MATTERS_INVOICES_DEFINITION_ID,
    locationId: FLEX_PEACHTREE_CORNERS_LOCATION_ID,
    dateField: "plannedStartDate",
    generatedAt: new Date().toISOString(),
  };
}

async function fetchFlexSalesGoalsRow(year) {
  const rollup = await fetchFlexSalesGoalsRollup(year);

  const monthMap = {};
  for (const month of rollup.months) {
    monthMap[month.monthName.toLowerCase()] = month.monthlySalesTotal;
  }

  return {
    year: rollup.year,
    january: monthMap.january || 0,
    february: monthMap.february || 0,
    march: monthMap.march || 0,
    april: monthMap.april || 0,
    may: monthMap.may || 0,
    june: monthMap.june || 0,
    july: monthMap.july || 0,
    august: monthMap.august || 0,
    september: monthMap.september || 0,
    october: monthMap.october || 0,
    november: monthMap.november || 0,
    december: monthMap.december || 0,
    total: rollup.yearTotal,
    elementCount: rollup.elementCount,
    totalAppliedPayments: rollup.totalAppliedPayments,
    balanceDue: rollup.balanceDue,
    source: rollup.source,
    dateField: rollup.dateField,
    generatedAt: rollup.generatedAt,
  };
}

async function fetchJsonFromFlex(url) {
  return fetchFlexJson(url, {
    headers: buildFlexHeaders(),
    timeoutMs: getFlexRequestTimeoutMs(),
  });
}

async function fetchFlexRowData(elementId) {
  const url = buildFlexRowDataUrl(elementId);

  console.log("Fetching FLEX row-data from:", url.toString());

  const data = await fetchJsonFromFlex(url);

  return {
    elementId,
    requestUrl: url.toString(),
    data,
  };
}

async function fetchFlexHeaderData(elementId) {
  const url = buildFlexHeaderDataUrl(elementId);

  console.log("Fetching FLEX header-data from:", url.toString());

  const data = await fetchJsonFromFlex(url);

  return {
    elementId,
    requestUrl: url.toString(),
    data,
  };
}

function normalizeHeaderValue(value) {
  if (value == null) return null;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "object") {
    if ("data" in value) {
      return normalizeHeaderValue(value.data);
    }

    if ("fieldType" in value && !("data" in value)) {
      return null;
    }

    return (
      value.preferredDisplayString ||
      value.displayName ||
      value.name ||
      value.value ||
      value.text ||
      value.label ||
      value.formattedValue ||
      value.shortName ||
      value.barcode ||
      value.id ||
      null
    );
  }

  return value;
}

function extractHeaderValue(headerData, code) {
  if (!headerData) return null;

  if (Array.isArray(headerData)) {
    const found = headerData.find(
      (item) =>
        item.code === code ||
        item.fieldCode === code ||
        item.key === code ||
        item.name === code ||
        item.id === code ||
        item.fieldType === code
    );

    return normalizeHeaderValue(
      found?.value ?? found?.displayValue ?? found?.data ?? found
    );
  }

  if (typeof headerData === "object") {
    return normalizeHeaderValue(headerData[code]);
  }

  return null;
}

function buildShowContext(headerData, elementId) {
  const shipDateCustomCode = "1d3824da-d004-41cc-b9f8-a3db6b9c4a6d";

  return {
    elementId,
    documentNumber: extractHeaderValue(headerData, "documentNumber"),
    documentType: extractHeaderValue(headerData, "documentType") || extractHeaderValue(headerData, "elementType"),
    definitionName: extractHeaderValue(headerData, "definitionName") || extractHeaderValue(headerData, "elementDefinitionName"),
    definitionId: extractHeaderValue(headerData, "definitionId") || extractHeaderValue(headerData, "elementDefinitionId"),
    showName: extractHeaderValue(headerData, "name"),
    status: extractHeaderValue(headerData, "status")
      || extractHeaderValue(headerData, "workflowStatus")
      || extractHeaderValue(headerData, "elementStatus"),
    statusId: extractHeaderValue(headerData, "statusId"),
    client: extractHeaderValue(headerData, "clientId"),
    venue: extractHeaderValue(headerData, "venueId"),
    plannedStartDate: extractHeaderValue(headerData, "plannedStartDate"),
    plannedEndDate: extractHeaderValue(headerData, "plannedEndDate"),
    shipDate: extractHeaderValue(headerData, shipDateCustomCode),
    loadInDate: extractHeaderValue(headerData, "loadInDate"),
    showStartDate: extractHeaderValue(headerData, "showStartDate"),
    loadOutDate: extractHeaderValue(headerData, "loadOutDate"),
    shippingMethod: extractHeaderValue(headerData, "shippingMethodId"),
    personResponsible: extractHeaderValue(headerData, "personResponsibleId"),
    projectManager: extractHeaderValue(headerData, "projectManagerId"),
    notes: extractHeaderValue(headerData, "notes"),
    financials: {
      discount: toNumber(extractHeaderValue(headerData, "discount")),
      subtotal: toNumber(extractHeaderValue(headerData, "subtotal")),
      salesTax: toNumber(extractHeaderValue(headerData, "salesTax")),
      additionalDiscount: toNumber(extractHeaderValue(headerData, "additionalDiscount")),
      creditCardFee: toNumber(extractHeaderValue(headerData, "creditCardFee")),
      total: toNumber(extractHeaderValue(headerData, "total")),
      totalAppliedPayments: toNumber(extractHeaderValue(headerData, "totalAppliedPayments")),
      balanceDue: toNumber(extractHeaderValue(headerData, "balanceDue")),
    },
  };
}

async function fetchFlexShowIntake(elementId) {
  const [headerResult, rowResult] = await Promise.all([
    fetchFlexHeaderData(elementId),
    fetchFlexRowData(elementId),
  ]);

  const showContext = buildShowContext(headerResult.data, elementId);

  return {
    elementId,
    showContext,
    headerData: headerResult.data,
    rowData: rowResult.data,
    requests: {
      headerDataUrl: headerResult.requestUrl,
      rowDataUrl: rowResult.requestUrl,
    },
  };
}

function buildFlexElementTreeUrl(elementId) {
  const base = getFlexBaseUrl();
  const url = new URL(
    `${base}/api/element/${encodeURIComponent(elementId)}/tree`
  );
  url.searchParams.set("_dc", String(Date.now()));
  return url;
}

async function fetchFlexElementTree(elementId) {
  const id = String(elementId || "").trim();
  if (!id) {
    throw new Error("Missing required elementId for FLEX element tree.");
  }

  const url = buildFlexElementTreeUrl(id);
  console.log("Fetching FLEX element tree from:", url.toString());
  const data = await fetchJsonFromFlex(url);

  return {
    elementId: id,
    requestUrl: url.toString(),
    data,
  };
}

function pickFirstString(obj, keys = []) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let cursor = obj;
      for (const part of parts) {
        if (cursor == null || typeof cursor !== "object") {
          cursor = null;
          break;
        }
        cursor = cursor[part];
      }
      const value = normalizeFlexCellValue(cursor);
      if (value != null && String(value).trim()) return String(value).trim();
      continue;
    }
    const value = normalizeFlexCellValue(obj[key]);
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function looksLikeFlexTreeElementNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const hasId = Boolean(
    pickFirstString(node, [
      "id",
      "elementId",
      "elementID",
      "uuid",
      "objectId",
      "objectID",
      "nodeId",
      "entityId",
      "financialDocumentId",
      "element.id",
    ])
  );
  const hasDoc = Boolean(
    pickFirstString(node, [
      "documentNumber",
      "docNumber",
      "number",
      "quoteNumber",
      "evNumber",
      "document_number",
    ])
  );
  const hasName = Boolean(
    pickFirstString(node, [
      "name",
      "title",
      "displayName",
      "elementName",
      "documentName",
      "description",
    ])
  );
  const hasChildrenKey =
    "children" in node || "childNodes" in node || "nodes" in node;
  return hasId || hasDoc || (hasName && hasChildrenKey);
}

function normalizeFlexElementTree(treeData) {
  const nodes = [];
  const seen = new Set();

  function walk(value, parentHint = null) {
    if (value == null) return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, parentHint);
      return;
    }

    if (typeof value !== "object") return;

    if (looksLikeFlexTreeElementNode(value)) {
      const elementId = pickFirstString(value, [
        "id",
        "elementId",
        "elementID",
        "uuid",
        "objectId",
        "objectID",
        "nodeId",
        "entityId",
        "financialDocumentId",
        "element.id",
      ]);
      const documentNumber = pickFirstString(value, [
        "documentNumber",
        "docNumber",
        "number",
        "quoteNumber",
        "evNumber",
        "document_number",
      ]);
      const name = pickFirstString(value, [
        "name",
        "title",
        "displayName",
        "elementName",
        "documentName",
        "description",
      ]);
      const type =
        pickFirstString(value, [
          "type",
          "elementType",
          "elementTypeName",
          "elementType.name",
          "type.name",
          "domainId",
          "domain",
          "definitionName",
          "elementDefinitionName",
          "definitionId",
          "elementDefinitionId",
          "elementDefinition.name",
          "elementDefinition.id",
        ]) || null;
      const parentId =
        pickFirstString(value, [
          "parentId",
          "parentElementId",
          "parentUUID",
          "parent.id",
          "parent.elementId",
          "parentElement.id",
          "parent.element.id",
        ]) ||
        parentHint ||
        null;

      const dedupeKey = [
        elementId || "",
        documentNumber || "",
        name || "",
      ]
        .join("|")
        .toLowerCase();

      if (!seen.has(dedupeKey) && (elementId || documentNumber || name)) {
        seen.add(dedupeKey);
        nodes.push({
          elementId: elementId || null,
          documentNumber: documentNumber || null,
          name: name || null,
          type,
          parentId,
          leaf: typeof value.leaf === "boolean" ? value.leaf : null,
          domainId: pickFirstString(value, ["domainId", "domain"]) || null,
        });
      }

      const nextParent = elementId || parentHint;
      if (Array.isArray(value.children)) walk(value.children, nextParent);
      if (Array.isArray(value.childNodes)) walk(value.childNodes, nextParent);
      if (Array.isArray(value.nodes)) walk(value.nodes, nextParent);
      return;
    }

    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") walk(nested, parentHint);
    }
  }

  walk(treeData, null);
  return nodes;
}

function getFlexLifecycleFeedConfig() {
  const configuredPath = String(process.env.CUE_FLEX_LIFECYCLE_FEED_PATH || "").trim();
  if (!configuredPath) return null;
  const base = getFlexBaseUrl();
  const url = new URL(configuredPath, `${base}/`);
  const baseUrl = new URL(base);
  if (url.origin !== baseUrl.origin) {
    throw new Error("CUE_FLEX_LIFECYCLE_FEED_PATH must use the configured FLEX origin.");
  }
  return {
    url,
    cursorParam: String(process.env.CUE_FLEX_LIFECYCLE_CURSOR_PARAM || "cursor").trim(),
    sinceParam: String(process.env.CUE_FLEX_LIFECYCLE_SINCE_PARAM || "updatedSince").trim(),
    initialSince: String(process.env.CUE_FLEX_LIFECYCLE_INITIAL_SINCE || "").trim() || null,
    limitParam: String(process.env.CUE_FLEX_LIFECYCLE_LIMIT_PARAM || "limit").trim(),
    limit: Math.max(1, Math.min(Number(process.env.CUE_FLEX_LIFECYCLE_LIMIT || 100) || 100, 1000)),
  };
}

function flexLifecycleFeedUrl(config, cursorBefore = null) {
  const url = new URL(config.url);
  url.searchParams.set("_dc", String(Date.now()));
  if (cursorBefore && config.cursorParam) url.searchParams.set(config.cursorParam, String(cursorBefore));
  else if (config.initialSince && config.sinceParam) url.searchParams.set(config.sinceParam, config.initialSince);
  if (config.limitParam) url.searchParams.set(config.limitParam, String(config.limit));
  return url;
}

async function verifyFlexLifecycleCandidate(candidate) {
  const header = await fetchFlexHeaderData(candidate.elementId);
  const context = buildShowContext(header.data, candidate.elementId);
  let treeNode = null;
  try {
    const tree = await fetchFlexElementTree(candidate.elementId);
    treeNode = normalizeFlexElementTree(tree.data).find(node =>
      String(node.elementId || "").toLowerCase() === candidate.elementId
    ) || null;
  } catch {
    // A strongly typed header/feed remains usable when a tenant omits tree access.
  }
  const classifiedTypes = [
    inferFlexDocumentType(candidate.documentType, "unknown"),
    inferFlexDocumentType(`${context.documentType || ""} ${context.definitionName || ""}`, "unknown"),
    inferFlexDocumentType(`${treeNode?.type || ""} ${treeNode?.name || ""} ${treeNode?.domainId || ""}`, "unknown"),
  ].filter(type => type !== "unknown");
  if (classifiedTypes.some(type => type !== "quote")) {
    return { ok: false, reason: `non_quote_document:${classifiedTypes.join(",")}` };
  }
  if (!classifiedTypes.includes("quote")) {
    return { ok: false, reason: "document_type_not_authoritatively_verified" };
  }
  const candidateNumber = String(candidate.documentNumber || "").trim().toUpperCase();
  const headerNumber = String(context.documentNumber || "").trim().toUpperCase();
  if (candidateNumber && headerNumber && candidateNumber !== headerNumber) {
    return { ok: false, reason: `document_number_conflict:${candidateNumber}:${headerNumber}` };
  }
  const documentNumber = headerNumber || candidateNumber;
  const status = candidate.status || context.status;
  const changedAt = candidate.changedAt;
  const showName = context.showName || candidate.showName;
  if (!documentNumber) return { ok: false, reason: "missing_document_number" };
  if (!status) return { ok: false, reason: "missing_lifecycle_status" };
  if (!changedAt) return { ok: false, reason: "missing_status_change_timestamp" };
  if (!showName) return { ok: false, reason: "missing_show_name" };
  return {
    ok: true,
    observation: {
      ...candidate,
      ...context,
      elementId: candidate.elementId,
      documentNumber,
      documentType: "quote",
      status,
      changedAt,
      showName,
      client: context.client || candidate.client,
      venue: context.venue || candidate.venue,
      plannedStartDate: context.plannedStartDate || candidate.plannedStartDate,
      plannedEndDate: context.plannedEndDate || candidate.plannedEndDate,
      source: "flex_lifecycle_feed",
      sourceEventId: candidate.sourceEventId || `${candidate.elementId}:${status}:${changedAt}`,
      metadata: {
        statusId: context.statusId,
        parentElementId: treeNode?.parentId || candidate.parentElementId || null,
      },
    },
  };
}

async function discoverConfiguredFlexQuoteLifecycle(options = {}) {
  let config = null;
  try {
    config = getFlexLifecycleFeedConfig();
  } catch (error) {
    return {
      ...flexLifecycleUnavailable("endpoint_configuration_invalid", {
        error: error?.message || String(error),
      }),
      ok: false,
      available: true,
      configured: true,
    };
  }
  const cursorRecord = await defaultCueFoundationStore.getConnectorCursor(FLEX_LIFECYCLE_CONNECTOR_NAME);
  const cursorBefore = options.cursorBefore ?? cursorRecord?.cursor ?? null;
  return runFlexLifecycleDiscovery({
    connectorName: FLEX_LIFECYCLE_CONNECTOR_NAME,
    connectorVersion: "live-flex-v1",
    endpointConfigured: Boolean(config),
    endpoint: config?.url?.pathname || null,
    cursorBefore,
    fetchFeed: config ? async cursor => fetchJsonFromFlex(flexLifecycleFeedUrl(config, cursor)) : null,
    verifyCandidate: verifyFlexLifecycleCandidate,
    observe: observation => defaultCueFoundationStore.observeFlexQuoteStatus(observation, {
      confirmedStatuses: options.confirmedStatuses || [],
    }),
    checkpoint: checkpoint => defaultCueFoundationStore.checkpointConnectorRun(checkpoint),
  });
}

function getFlexConfirmedQuoteSnapshotConfig() {
  return {
    baseUrl: getFlexBaseUrl(),
    definitionId: String(process.env.CUE_FLEX_MMP_QUOTE_DEFINITION_ID || FLEX_MMP_QUOTE_DEFINITION_ID).trim(),
    confirmedStatusId: String(process.env.CUE_FLEX_CONFIRMED_STATUS_ID || FLEX_CONFIRMED_STATUS_ID).trim(),
    locationId: String(process.env.CUE_FLEX_LOCATION_ID || FLEX_CONFIRMED_QUOTE_LOCATION_ID).trim(),
    pageSize: Math.max(1, Math.min(Number(process.env.CUE_FLEX_CONFIRMED_PAGE_SIZE || 50) || 50, 500)),
    lookbackDays: Math.max(0, Number(process.env.CUE_FLEX_BASELINE_LOOKBACK_DAYS || 30) || 30),
  };
}

function confirmedQuoteRegistryDisposition(quote, activeShows = []) {
  const elementId = String(quote?.elementId || "").trim().toLowerCase();
  const documentNumber = String(quote?.documentNumber || "").trim().toUpperCase();
  for (const show of activeShows) {
    const primary = show?.flex?.primaryShowQuote || null;
    const primaryMatches = Boolean(primary) && (
      (elementId && String(primary.elementId || "").trim().toLowerCase() === elementId)
      || (documentNumber && String(primary.documentNumber || "").trim().toUpperCase() === documentNumber)
    );
    if (primaryMatches) {
      return {
        action: "observe",
        observation: {
          provisionalShowId: show.id,
          metadata: {
            canonicalShowId: show.id,
            flexAuthorityRole: "primary_show_quote",
            registryHierarchyStatus: show.flex?.hierarchyStatus || null,
          },
        },
      };
    }
    const related = (show?.flex?.documents || []).find(document => {
      const matches = (elementId && String(document?.elementId || "").trim().toLowerCase() === elementId)
        || (documentNumber && String(document?.documentNumber || "").trim().toUpperCase() === documentNumber);
      return matches && document?.role !== "primary_show_quote";
    });
    if (related) {
      return {
        action: "defer",
        reason: "known_related_flex_document_attaches_to_parent_show",
        metadata: {
          canonicalShowId: show.id,
          canonicalShowName: show.name,
          primaryShowQuote: primary || null,
          relatedDocumentRole: related.role || "related",
        },
      };
    }
  }
  // This is a verified tenant list filtered to the Confirmed MMP Quote
  // definition. Unknown rows create provisional show awareness. The Active
  // Show Index then reconciles the operational identity and hierarchy.
  return {
    action: "observe",
    observation: {
      metadata: {
        flexAuthorityRole: "confirmed_mmp_quote_candidate",
        registryHierarchyStatus: "awaiting_active_show_index_reconciliation",
      },
    },
  };
}

async function discoverFlexConfirmedQuoteSnapshot(options = {}) {
  let config;
  try {
    config = getFlexConfirmedQuoteSnapshotConfig();
  } catch (error) {
    return {
      ok: false,
      available: false,
      configured: false,
      status: "flex_connection_not_configured",
      error: error?.message || String(error),
    };
  }
  const foundation = await defaultCueFoundationStore.read();
  const activeShows = Object.values(foundation.showRegistry || {}).filter(show =>
    show.lifecycle?.status === "active" || show.activeShowsIndex || show.source?.activeShowsIndex
  );
  const activeElementIds = new Set();
  const activeDocumentNumbers = new Set();
  for (const show of activeShows) {
    for (const document of show.flex?.documents || []) {
      if (document.elementId) activeElementIds.add(String(document.elementId).toLowerCase());
      if (document.documentNumber) activeDocumentNumbers.add(String(document.documentNumber).toUpperCase());
    }
  }
  return runFlexConfirmedQuoteSnapshot({
    connectorName: FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR,
    confirmedStatusId: config.confirmedStatusId,
    lookbackDays: config.lookbackDays,
    activeElementIds,
    activeDocumentNumbers,
    fullReconciliation: Boolean(options.fullReconciliation),
    fetchConfirmedPage: async ({ pageIndex }) => fetchJsonFromFlex(buildFlexConfirmedQuoteListUrl(config.baseUrl, {
      definitionId: config.definitionId,
      confirmedStatusId: config.confirmedStatusId,
      locationId: config.locationId,
      pageSize: config.pageSize,
      pageIndex,
    })),
    fetchStatusHistory: elementId => fetchJsonFromFlex(buildFlexStatusHistoryUrl(config.baseUrl, elementId)),
    prepareObservation: input => confirmedQuoteRegistryDisposition(input.quote, activeShows),
    observe: observation => defaultCueFoundationStore.observeFlexQuoteStatus(observation, {
      confirmedStatuses: options.confirmedStatuses || [],
    }),
    getState: connectorName => defaultCueFoundationStore.getConnectorState(connectorName),
    saveState: (connectorName, state) => defaultCueFoundationStore.saveConnectorState(connectorName, state),
    checkpoint: checkpoint => defaultCueFoundationStore.checkpointConnectorRun(checkpoint),
  });
}

async function discoverAuthoritativeFlexQuoteLifecycle(options = {}) {
  let feedConfig = null;
  try {
    feedConfig = getFlexLifecycleFeedConfig();
  } catch {
    // The verified confirmed-quote snapshot remains available even if an
    // optional tenant-wide change-feed setting is invalid.
  }
  return feedConfig
    ? discoverConfiguredFlexQuoteLifecycle(options)
    : discoverFlexConfirmedQuoteSnapshot(options);
}

function classifyFlexEventFolderQuote(name) {
  const text = String(name || "").toLowerCase();

  // LED Trailer is a vendor-managed video/LED product with transport dependency,
  // not Music Matters trucking / normal transportation scope.
  if (
    /\bled\s*trailer\b/.test(text) ||
    (/\bled\b/.test(text) && /\btrailer\b/.test(text))
  ) {
    return {
      department: "Video / LED",
      primaryDepartment: "Video / LED",
      productFamily: "LED Trailer",
      fulfillmentModel: "Turnkey Cross-Rental",
      vendorManaged: true,
      transportationDependency: true,
      musicMattersTruckingRequired: false,
      tags: [
        "LED",
        "Video",
        "LED Trailer",
        "Delay Screen",
        "Vendor Managed",
        "Transportation Dependency",
      ],
    };
  }

  let department = "Other";
  if (/\baudio\b/.test(text)) department = "Audio";
  else if (/\blighting\b|\blx\b/.test(text)) department = "Lighting";
  else if (/\bled\b/.test(text)) department = "LED";
  else if (/\bvideo\b|\bimag\b|\bcamera\b/.test(text)) department = "Video";
  else if (
    /\brigging\b|\bproduction mgmt\b|\bproduction management\b|\bproduction\b/.test(
      text
    )
  ) {
    department = "Rigging / Production";
  } else if (/\bdelay\b/.test(text)) {
    department = "Delay";
  } else if (/\btrailer\b|\btransportation\b|\btransport\b/.test(text)) {
    department = "Trailer / Transportation";
  }

  return {
    department,
    primaryDepartment: department,
    productFamily: null,
    fulfillmentModel: null,
    vendorManaged: false,
    transportationDependency: false,
    musicMattersTruckingRequired: null,
    tags: department === "Other" ? [] : [department],
  };
}

function classifyFlexEventFolderDepartment(name) {
  return classifyFlexEventFolderQuote(name).department;
}

function isFlexQuoteDocumentNumber(value) {
  return /^\d{2}-\d{4}$/.test(String(value || "").trim());
}

function dedupeFlexEventFolderNodes(nodes = []) {
  const out = [];
  const seen = new Set();
  for (const node of nodes) {
    const key = [
      String(node.elementId || "").toLowerCase(),
      String(node.documentNumber || "").toLowerCase(),
      String(node.name || "").toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

async function buildFlexEventFolderRollup(treeResult, options = {}) {
  const requestedElementId = String(
    options.elementId || treeResult?.elementId || ""
  ).trim();
  const includeRaw = Boolean(options.includeRaw);
  const includeChildDetails = Boolean(options.includeChildDetails);

  const normalizedNodes = dedupeFlexEventFolderNodes(
    normalizeFlexElementTree(treeResult?.data)
  );

  let eventFolder =
    normalizedNodes.find(
      (node) =>
        requestedElementId &&
        String(node.elementId || "").toLowerCase() ===
          requestedElementId.toLowerCase()
    ) || null;

  if (!eventFolder) {
    eventFolder =
      normalizedNodes.find((node) => {
        const doc = String(node.documentNumber || "");
        const typeName = `${node.type || ""} ${node.name || ""} ${node.domainId || ""}`;
        return (
          isFlexQuoteDocumentNumber(doc) &&
          /event\s*folder|simple-project-element|project/i.test(typeName)
        );
      }) || null;
  }

  if (!eventFolder) {
    eventFolder = normalizedNodes[0] || null;
  }

  const eventFolderDoc = String(eventFolder?.documentNumber || "").trim();

  const childQuotes = dedupeFlexEventFolderNodes(
    normalizedNodes
      .filter((node) => {
        const doc = String(node.documentNumber || "").trim();
        if (!isFlexQuoteDocumentNumber(doc)) return false;
        if (eventFolderDoc && doc === eventFolderDoc) return false;
        if (
          eventFolder?.elementId &&
          node.elementId &&
          String(node.elementId) === String(eventFolder.elementId)
        ) {
          return false;
        }
        return true;
      })
      .map((node) => {
        const classification = classifyFlexEventFolderQuote(node.name);
        return {
          ...node,
          department: classification.department,
          primaryDepartment: classification.primaryDepartment,
          productFamily: classification.productFamily,
          fulfillmentModel: classification.fulfillmentModel,
          vendorManaged: classification.vendorManaged,
          transportationDependency: classification.transportationDependency,
          musicMattersTruckingRequired: classification.musicMattersTruckingRequired,
          tags: Array.isArray(classification.tags) ? classification.tags : [],
        };
      })
  ).sort((a, b) =>
    String(a.documentNumber || "").localeCompare(String(b.documentNumber || ""))
  );

  if (includeChildDetails) {
    for (const child of childQuotes) {
      if (!child.elementId) {
        child.detailError = "Missing elementId for child quote.";
        continue;
      }
      try {
        const intake = await fetchFlexShowIntake(child.elementId);
        const detail = buildFlexDocumentDetail(intake);
        const soldDepartments = Array.from(
          new Set(
            (detail.sections || [])
              .map((section) => String(section?.name || "").trim())
              .filter(Boolean)
          )
        );
        child.detail = {
          showContext: detail.showContext || null,
          summary: detail.summary || null,
          counts: detail.counts || null,
          financials: detail.summary?.financials || detail.showContext?.financials || null,
          sections: detail.sections || [],
          soldDepartments,
        };
      } catch (error) {
        child.detailError = error?.message || String(error);
      }
    }
  }

  const departments = Array.from(
    new Set(childQuotes.map((child) => child.department).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const documentNumbers = childQuotes
    .map((child) => child.documentNumber)
    .filter(Boolean);

  const payload = {
    elementId: requestedElementId || eventFolder?.elementId || null,
    requestUrl: treeResult?.requestUrl || null,
    eventFolder: eventFolder
      ? {
          elementId: eventFolder.elementId || null,
          documentNumber: eventFolder.documentNumber || null,
          name: eventFolder.name || null,
          type: eventFolder.type || null,
          parentId: eventFolder.parentId || null,
          domainId: eventFolder.domainId || null,
        }
      : null,
    childQuotes,
    rollup: {
      quoteCount: childQuotes.length,
      departments,
      documentNumbers,
    },
  };

  if (includeRaw) {
    payload.rawTree = treeResult?.data ?? null;
  }

  return payload;
}

const ACTIVE_SHOW_EVENT_FOLDER_HINTS = {
  "country-calling-2026": {
    documentNumber: "26-0021",
    elementId: "881d3614-ee81-4786-a16b-8153cb59d5e3",
    showName: "Country Calling 2026",
  },
  "country-calling": {
    documentNumber: "26-0021",
    elementId: "881d3614-ee81-4786-a16b-8153cb59d5e3",
    showName: "Country Calling 2026",
  },
};

function normalizeShowKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getActiveShowEventFolderHint(show) {
  const texts = [
    show?.id,
    show?.showName,
    show?.name,
    show?.client,
    show?.activeShowsIndex?.client,
    show?.topIssue,
    show?.nextAction,
    show?.flexSignal,
    show?.trucking,
    show?.technicalCoverage,
    show?.risk,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const text of texts) {
    const key = normalizeShowKey(text);
    if (ACTIVE_SHOW_EVENT_FOLDER_HINTS[key]) {
      return { ...ACTIVE_SHOW_EVENT_FOLDER_HINTS[key], matchedOn: text };
    }
  }

  for (const text of texts) {
    const key = normalizeShowKey(text);
    for (const [hintKey, hint] of Object.entries(ACTIVE_SHOW_EVENT_FOLDER_HINTS)) {
      if (key.includes(hintKey) || hintKey.includes(key)) {
        return { ...hint, matchedOn: text };
      }
    }
  }

  return null;
}

function mapEventFolderChildToActiveShowDocument(child) {
  return {
    status: "Event Folder Child",
    approvalNeeded: false,
    documentNumber: child?.documentNumber || null,
    elementId: child?.elementId || null,
    showName: child?.name || null,
    client: null,
    venue: null,
    plannedStartDate: null,
    plannedEndDate: null,
    loadInDate: null,
    loadOutDate: null,
    department: child?.department || null,
    primaryDepartment: child?.primaryDepartment || null,
    productFamily: child?.productFamily || null,
    fulfillmentModel: child?.fulfillmentModel || null,
    vendorManaged: child?.vendorManaged ?? null,
    transportationDependency: child?.transportationDependency ?? null,
    musicMattersTruckingRequired: child?.musicMattersTruckingRequired ?? null,
    tags: Array.isArray(child?.tags) ? child.tags : [],
    soldDepartments: child?.department ? [child.department] : [],
    totals: null,
    financials: null,
    counts: null,
    quoteLookup: null,
    detail: child?.detail || null,
    detailError: child?.detailError || null,
  };
}

async function enrichActiveShowWithEventFolder(show, eventFolderHint, lastPullAt) {
  let treeResult;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      treeResult = await fetchFlexElementTree(eventFolderHint.elementId);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
  }
  if (!treeResult) {
    throw lastError || new Error("Could not refresh FLEX Event Folder.");
  }

  const folder = await buildFlexEventFolderRollup(treeResult, {
    elementId: eventFolderHint.elementId,
    includeChildDetails: false,
    includeRaw: false,
  });

  const childQuotes = Array.isArray(folder.childQuotes) ? folder.childQuotes : [];
  const departments = Array.isArray(folder.rollup?.departments)
    ? folder.rollup.departments
    : [];
  const documentNumbers = Array.isArray(folder.rollup?.documentNumbers)
    ? folder.rollup.documentNumbers
    : childQuotes.map((child) => child.documentNumber).filter(Boolean);

  const eventFolder = folder.eventFolder || {
    documentNumber: eventFolderHint.documentNumber,
    elementId: eventFolderHint.elementId,
    name: eventFolderHint.showName || show.name || null,
  };

  const documents = childQuotes.map(mapEventFolderChildToActiveShowDocument);
  const deptText = departments.join(", ") || "No departments found";
  const parentDoc =
    eventFolder.documentNumber || eventFolderHint.documentNumber || "Event Folder";
  const parentName = eventFolder.name || eventFolderHint.showName || show.name || "";
  const flexSignal = `FLEX Event Folder - ${parentDoc} ${parentName} verified. ${childQuotes.length} child quote workstreams found. Departments: ${deptText}.`;

  return {
    ...show,
    flexDocumentNumbers: documentNumbers,
    flex: {
      status: "Event Folder",
      matchType: "event_folder",
      approvalNeeded: false,
      documentNumber: parentDoc,
      documentNumbers,
      elementId: eventFolder.elementId || eventFolderHint.elementId,
      showName: parentName || show.name || null,
      client: null,
      venue: null,
      plannedStartDate: null,
      plannedEndDate: null,
      loadInDate: null,
      loadOutDate: null,
      soldDepartments: departments,
      totals: null,
      financials: null,
      counts: {
        quotes: childQuotes.length,
      },
      documents,
      eventFolder,
      childQuotes,
      rollup: folder.rollup || {
        quoteCount: childQuotes.length,
        departments,
        documentNumbers,
      },
      primary: eventFolder,
      verifiedDocumentCount: childQuotes.length,
      unresolvedDocumentCount: 0,
      lastPullAt,
      message: null,
      eventFolderError: null,
      hintMatchedOn: eventFolderHint.matchedOn || null,
    },
    flexSignal,
  };
}

function buildMissingEventFolderHintShows(existingShows = []) {
  const presentElementIds = new Set();
  for (const show of existingShows) {
    const hint = getActiveShowEventFolderHint(show);
    if (hint?.elementId) presentElementIds.add(hint.elementId);
  }

  const extras = [];
  const seen = new Set();
  for (const [key, hint] of Object.entries(ACTIVE_SHOW_EVENT_FOLDER_HINTS)) {
    if (!hint?.elementId || seen.has(hint.elementId)) continue;
    if (presentElementIds.has(hint.elementId)) continue;
    seen.add(hint.elementId);

    extras.push({
      id: /-\d{4}$/.test(key) ? key : `${key}-2026`,
      name: hint.showName || key,
      timing: "Event Folder / multi-workstream",
      priority: "High",
      readinessStatus: "MAGENTA - Event Folder rollup",
      changeSignal: "Cyan - FLEX Event Folder hint available",
      topIssue:
        "Multi-department festival scope lives under one FLEX Event Folder; confirm child quote workstreams.",
      nextAction:
        "Review Event Folder child quotes and pull individual workstreams as needed.",
      flexSignal: `Event Folder parent expected: ${[
        hint.documentNumber,
        hint.showName,
      ]
        .filter(Boolean)
        .join(" ")}.`,
      trucking:
        "Use child quote workstreams for trucking matching; LED Trailer is vendor-managed turnkey (not MM trucking).",
      eventFolderHintInjected: true,
    });
  }

  return extras;
}


function toNumber(value) {
  if (value == null) return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const cleaned = String(value)
    .replace(/[$,]/g, "")
    .trim();

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeFlexCellValue(value) {
  if (value == null) return null;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "object") {
    if ("data" in value) return normalizeFlexCellValue(value.data);

    return (
      value.preferredDisplayString ||
      value.displayName ||
      value.name ||
      value.value ||
      value.text ||
      value.label ||
      value.formattedValue ||
      value.shortName ||
      value.id ||
      null
    );
  }

  return value;
}

function rowToObject(row) {
  if (!row) return {};

  if (!Array.isArray(row) && typeof row === "object") {
    const output = {};

    for (const [key, value] of Object.entries(row)) {
      output[key] = normalizeFlexCellValue(value);
    }

    return output;
  }

  if (Array.isArray(row)) {
    const output = {};

    FLEX_ROW_DATA_CODES.forEach((code, index) => {
      output[code] = normalizeFlexCellValue(row[index]);
    });

    return output;
  }

  return {};
}

function unwrapFlexRows(rowData) {
  if (Array.isArray(rowData)) return rowData;

  if (Array.isArray(rowData?.rows)) return rowData.rows;
  if (Array.isArray(rowData?.data)) return rowData.data;
  if (Array.isArray(rowData?.items)) return rowData.items;
  if (Array.isArray(rowData?.children)) return rowData.children;

  return [];
}

function classifyFlexLineItem(rowObject) {
  const typeText = String(rowObject.type || rowObject.source_type || "").toLowerCase();
  const nameText = String(rowObject.name || "").toLowerCase();
  const noteText = String(rowObject.note || "").toLowerCase();

  const combined = `${typeText} ${nameText} ${noteText}`;

  if (
    /\b(labor|crew|tech|technician|engineer|stagehand|operator|ld|a1|a2|v1|v2|pm|project manager)\b/i.test(
      combined
    )
  ) {
    return "labor";
  }

  if (
    /\b(transport|transportation|truck|trucking|delivery|pickup|pick up|freight|mileage|van|box truck|trailer)\b/i.test(
      combined
    )
  ) {
    return "transportation";
  }

  if (
    /\b(rental|fixture|console|audio|lighting|video|led|truss|rigging|cable|power|speaker|pa|microphone|deck|stage)\b/i.test(
      combined
    )
  ) {
    return "rental";
  }

  return "other";
}

function buildFlexDocumentSummary(intake) {
  const rows = unwrapFlexRows(intake.rowData).map(rowToObject);

  const summary = {
    elementId: intake.elementId,
    showContext: intake.showContext,
    totals: {
      document: 0,
      rental: 0,
      labor: 0,
      transportation: 0,
      other: 0,
    },
    counts: {
      lineItems: rows.length,
      rentalLines: 0,
      laborLines: 0,
      transportationLines: 0,
      otherLines: 0,
    },
    lineItems: [],
    warnings: [],
    requests: intake.requests,
  };

  for (const row of rows) {
    const category = classifyFlexLineItem(row);
    const priceExtended = toNumber(row.priceExtended);
    const quantity = toNumber(row.quantity);
    const timeQty = toNumber(row.timeQty);

    summary.totals.document += priceExtended;

    if (category === "rental") {
      summary.totals.rental += priceExtended;
      summary.counts.rentalLines += 1;
    } else if (category === "labor") {
      summary.totals.labor += priceExtended;
      summary.counts.laborLines += 1;
    } else if (category === "transportation") {
      summary.totals.transportation += priceExtended;
      summary.counts.transportationLines += 1;
    } else {
      summary.totals.other += priceExtended;
      summary.counts.otherLines += 1;
    }

    summary.lineItems.push({
      category,
      name: row.name || null,
      type: row.type || null,
      quantity,
      timeQty,
      pricingModel: row.pricingModel || null,
      priceEach: toNumber(row.priceEach),
      priceExtended,
      note: row.note || null,
    });
  }

  for (const key of Object.keys(summary.totals)) {
    summary.totals[key] = Math.round(summary.totals[key] * 100) / 100;
  }

  // The line-item/category math above matches the category subtotal shown by FLEX,
  // but FLEX can also apply quote-level adjustments after that, such as
  // Additional Discount, tax, or credit-card fees. Keep both values so Sales Goals
  // can use the final invoice/quote total instead of the category subtotal.
  const flexFinancials = summary.showContext?.financials || {};
  const categorySubtotal = summary.totals.document;
  const balanceDue = flexFinancials.balanceDue || 0;
  const totalAppliedPayments = flexFinancials.totalAppliedPayments || 0;

  const inferredInvoiceTotalFromBalance =
    balanceDue || totalAppliedPayments
      ? Math.round((balanceDue + totalAppliedPayments) * 100) / 100
      : 0;

  const calculatedInvoiceTotal =
    Math.round(
      (
        categorySubtotal +
        (flexFinancials.salesTax || 0) +
        (flexFinancials.additionalDiscount || 0) +
        (flexFinancials.creditCardFee || 0)
      ) * 100
    ) / 100;

  summary.totals.categorySubtotal = categorySubtotal;

  summary.financials = {
    categorySubtotal,
    discount: flexFinancials.discount || 0,
    subtotal: flexFinancials.subtotal || categorySubtotal,
    salesTax: flexFinancials.salesTax || 0,
    additionalDiscount: flexFinancials.additionalDiscount || 0,
    creditCardFee: flexFinancials.creditCardFee || 0,
    invoiceTotal:
      flexFinancials.total ||
      inferredInvoiceTotalFromBalance ||
      calculatedInvoiceTotal,
    totalAppliedPayments,
    balanceDue,
    invoiceTotalSource: flexFinancials.total
      ? "flex_total"
      : inferredInvoiceTotalFromBalance
        ? "balance_due_plus_payments"
        : "category_subtotal_fallback",
  };

  if (summary.financials.invoiceTotalSource === "balance_due_plus_payments") {
    summary.warnings.push(
      "Invoice total was inferred from FLEX balanceDue + totalAppliedPayments because FLEX header total was not returned."
    );
  }

  if (summary.financials.invoiceTotalSource === "category_subtotal_fallback") {
    summary.warnings.push(
      "Invoice total fell back to category subtotal because FLEX final total fields were not returned."
    );
  }

  if (!summary.showContext?.showName) {
    summary.warnings.push("Missing show name from FLEX header data.");
  }

  if (!summary.showContext?.client) {
    summary.warnings.push("Missing client from FLEX header data.");
  }

  if (!summary.showContext?.showStartDate && !summary.showContext?.plannedStartDate) {
    summary.warnings.push("Missing show/planned start date from FLEX header data.");
  }

  if (summary.counts.lineItems === 0) {
    summary.warnings.push("No FLEX line items were returned.");
  }

  return summary;
}



function buildFlexSearchUrl(searchText) {
  const base = getFlexBaseUrl();

  const url = new URL(`${base}/api/search`);

  url.searchParams.set("_dc", String(Date.now()));
  url.searchParams.set("searchText", String(searchText || "").trim());

  // Search types captured from FLEX global search while looking up quote 26-1747.
  // Keep this broad enough to match quotes/financial documents while preserving FLEX behavior.
  url.searchParams.set(
    "searchTypes",
    [
      "inventory-model",
      "358f312c-b051-11df-b8d5-00e08175e43e",
      "d256daec-b055-11df-b8d5-00e08175e43e",
      "9bfb850c-b117-11df-b8d5-00e08175e43e",
    ].join(",")
  );

  url.searchParams.set("maxResults", "1000");
  url.searchParams.set("canIncludeSerialUnits", "true");
  url.searchParams.set("includeDeleted", "false");
  url.searchParams.set("includeClosed", "true");
  url.searchParams.set("page", "1");
  url.searchParams.set("start", "0");
  url.searchParams.set("limit", "25");

  return url;
}

async function fetchFlexSearch(searchText) {
  const url = buildFlexSearchUrl(searchText);

  console.log("Fetching FLEX search from:", url.toString());

  const data = await fetchJsonFromFlex(url);

  return {
    searchText,
    requestUrl: url.toString(),
    data,
  };
}

function normalizeFlexSearchResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;

  return [];
}

function extractSearchResultId(result) {
  return (
    result?.id ||
    result?.elementId ||
    result?.elementID ||
    result?.element_id ||
    result?.objectId ||
    result?.objectID ||
    null
  );
}

async function findFlexQuoteByDocumentNumber(documentNumber, options = {}) {
  const normalizedDocumentNumber = String(documentNumber || "").trim();

  if (!normalizedDocumentNumber) {
    throw new Error("Missing required documentNumber.");
  }

  const searchResult = await fetchFlexSearch(normalizedDocumentNumber);
  const results = normalizeFlexSearchResults(searchResult.data);

  const candidates = results
    .map((result) => ({
      raw: result,
      elementId: extractSearchResultId(result),
      name:
        result?.name ||
        result?.displayName ||
        result?.preferredDisplayString ||
        result?.text ||
        result?.label ||
        null,
      documentNumber:
        result?.documentNumber ||
        result?.number ||
        result?.docNumber ||
        result?.identifier ||
        null,
      type:
        result?.type ||
        result?.definitionName ||
        result?.className ||
        result?.category ||
        null,
    }))
    .filter((candidate) => candidate.elementId);

  if (!candidates.length) {
    return {
      documentNumber: normalizedDocumentNumber,
      found: false,
      ambiguous: false,
      elementId: null,
      name: null,
      matches: [],
      requestUrl: searchResult.requestUrl,
      rawCount: results.length,
    };
  }

  // FLEX document numbers are not globally unique across quotes, pull sheets,
  // manifests, and other financial-document types. Verify every plausible hit
  // against its own header and then use show identity to disambiguate it.
  const wantedLower = normalizedDocumentNumber.toLowerCase();
  const exactSearchHits = candidates.filter(candidate =>
    String(candidate.documentNumber || "").trim().toLowerCase() === wantedLower
  );
  const candidatesToVerify = (exactSearchHits.length ? exactSearchHits : candidates).slice(0, 12);
  const verified = [];
  for (const candidate of candidatesToVerify) {
    try {
      const header = await fetchFlexHeaderData(candidate.elementId);
      const context = buildShowContext(header.data, candidate.elementId);
      if (String(context.documentNumber || "").trim().toLowerCase() !== wantedLower) continue;
      let documentType = inferFlexDocumentType(`${context.documentType || ""} ${context.definitionName || ""} ${candidate.type || ""} ${candidate.name || ""}`, "unknown");
      let parentElementId = null;
      try {
        const tree = await fetchFlexElementTree(candidate.elementId);
        const treeNode = normalizeFlexElementTree(tree.data).find(node =>
          String(node.elementId || "").toLowerCase() === String(candidate.elementId).toLowerCase()
        );
        if (treeNode) {
          const treeDocumentType = inferFlexDocumentType(`${treeNode.type || ""} ${treeNode.name || ""} ${treeNode.domainId || ""}`, "unknown");
          // The element tree describes the node's actual role. It must override
          // generic search categories such as "financial document" or a
          // misleading quote-family label applied to child pull sheets.
          if (treeDocumentType !== "unknown") documentType = treeDocumentType;
          parentElementId = treeNode.parentId || null;
        }
      } catch {
        // Header verification remains valid; opaque type stays conservative.
      }
      verified.push({
        ...candidate,
        showName: context.showName || candidate.name || null,
        client: context.client || null,
        documentNumber: context.documentNumber,
        documentType,
        parentElementId,
        context,
      });
    } catch {
      // Try the next candidate. A single inaccessible result must not cause a
      // different document to be selected by position.
    }
  }

  const selection = selectFlexDocumentCandidate(verified, {
    showName: options.showName || options.name || null,
    client: options.client || null,
    documentType: options.documentType || null,
  });
  const exactMatch = selection.candidate;
  if (!exactMatch) {
    return {
      documentNumber: normalizedDocumentNumber,
      found: false,
      ambiguous: selection.ambiguous,
      elementId: null,
      name: null,
      matches: selection.ranked.map(candidate => ({
        elementId: candidate.elementId,
        name: candidate.showName || candidate.name,
        documentNumber: candidate.documentNumber,
        type: candidate.type,
        documentType: candidate.documentType,
        parentElementId: candidate.parentElementId || null,
        identityScore: candidate.identityScore,
      })),
      requestUrl: searchResult.requestUrl,
      rawCount: results.length,
    };
  }

  return {
    documentNumber: normalizedDocumentNumber,
    found: true,
    ambiguous: false,
    elementId: exactMatch.elementId,
    name: exactMatch.showName || exactMatch.name,
    type: exactMatch.type,
    documentType: exactMatch.documentType,
    parentElementId: exactMatch.parentElementId || null,
    context: exactMatch.context,
    matches: selection.ranked.map((candidate) => ({
      elementId: candidate.elementId,
      name: candidate.showName || candidate.name,
      documentNumber: candidate.documentNumber,
      type: candidate.type,
      documentType: candidate.documentType,
      parentElementId: candidate.parentElementId || null,
      identityScore: candidate.identityScore,
    })),
    requestUrl: searchResult.requestUrl,
    rawCount: results.length,
  };
}

function extractQuoteNumbersFromText(value) {
  const matches = String(value || "").match(/\b\d{2}-\d{3,6}\b/g) || [];
  return [...new Set(matches.map((item) => item.trim()))];
}

function buildSlackCandidateFromActiveShow(show) {
  const showName = show?.name || show?.showName || "Unnamed Show";
  const childQuotes = Array.isArray(show?.flex?.childQuotes) ? show.flex.childQuotes : [];
  const flexDocuments = Array.isArray(show?.flex?.documents) ? show.flex.documents : [];
  const primaryDocumentNumber = String(
    show?.flex?.primary?.documentNumber || show?.flex?.documentNumber || ""
  ).trim() || null;
  const primaryElementId =
    show?.flex?.primary?.elementId || show?.flex?.elementId || show?.elementId || null;
  const documentRefs = [
    primaryDocumentNumber
      ? {
          documentNumber: primaryDocumentNumber,
          elementId: primaryElementId,
          documentType: show?.flex?.primary?.documentType || inferFlexDocumentType(show?.flex?.matchType, "quote"),
          role: "primary_show_quote",
          name: show?.flex?.primary?.name || show?.flex?.showName || showName,
          parentElementId: null,
          source: "active_shows_primary",
        }
      : null,
    ...flexDocuments.map((document) => ({
      documentNumber: document?.documentNumber || null,
      elementId: document?.elementId || null,
      documentType: document?.documentType || inferFlexDocumentType(`${document?.type || ""} ${document?.status || ""} ${document?.showName || ""}`, "unknown"),
      role: String(document?.documentNumber || "") === primaryDocumentNumber ? "primary_show_quote" : "related",
      name: document?.showName || document?.name || null,
      parentElementId: document?.parentElementId || null,
      source: "active_shows_document",
    })),
    ...childQuotes.map((child) => ({
      documentNumber: child?.documentNumber || null,
      elementId: child?.elementId || null,
      documentType: inferFlexDocumentType(`${child?.type || ""} ${child?.name || ""}`, "quote"),
      role: "related",
      name: child?.name || null,
      parentElementId: child?.parentId || show?.flex?.eventFolder?.elementId || null,
      source: "active_shows_child",
    })),
  ].filter((ref, index, refs) => ref?.documentNumber && index === refs.findIndex((candidate) => candidate?.documentNumber === ref.documentNumber && candidate?.documentType === ref.documentType));
  const documentNumbers = [
    primaryDocumentNumber,
    ...extractQuoteNumbersFromText(
      [
        show?.id,
        showName,
        show?.timing,
        show?.priority,
        show?.readinessStatus,
        show?.changeSignal,
        show?.topIssue,
        show?.nextAction,
        show?.flexSignal,
        show?.trucking,
        show?.activeShowsIndex?.keyDocs,
      ]
        .filter(Boolean)
        .join(" ")
    ),
    ...(Array.isArray(show?.flexDocumentNumbers) ? show.flexDocumentNumbers : []),
    ...(Array.isArray(show?.flex?.documentNumbers) ? show.flex.documentNumbers : []),
    ...childQuotes.map((child) => child.documentNumber).filter(Boolean),
  ];

  const daysOutRaw =
    show?.activeShowsIndex?.daysOut ??
    show?.daysOut ??
    (String(show?.timing || "").match(/(\d+)\s*days?\s*out/i) || [])[1] ??
    null;

  return {
    showKey: show?.id || normalizeShowKey(showName),
    showName,
    client: show?.activeShowsIndex?.client || show?.client || null,
    venue: show?.venue || null,
    documentNumbers: [...new Set(documentNumbers.map((d) => d == null ? "" : String(d).trim()).filter(Boolean))],
    primaryDocumentNumber,
    elementId: primaryElementId,
    documentRefs,
    quoteElements: documentRefs.map((ref) => ({ documentNumber: ref.documentNumber, elementId: ref.elementId || null, documentType: ref.documentType })),
    aliases: [],
    plannedStartDate: show?.flex?.plannedStartDate || null,
    plannedEndDate: show?.flex?.plannedEndDate || null,
    loadInDate: show?.flex?.loadInDate || null,
    loadOutDate: show?.flex?.loadOutDate || null,
    departments: Array.isArray(show?.flex?.soldDepartments)
      ? show.flex.soldDepartments
      : Array.isArray(show?.flex?.rollup?.departments)
        ? show.flex.rollup.departments
        : [],
    daysOut: daysOutRaw,
    status: show?.readinessStatus || show?.status || null,
    source: "active_shows",
  };
}

async function resolveSlackCandidateFromFlexQuote(documentNumber) {
  const wanted = String(documentNumber || "").trim();
  if (!wanted) return null;

  // FLEX global search often returns an unrelated top hit with no documentNumber
  // on the search payload. Never trust candidates[0] alone for Slack auto-attach.
  const searchResult = await fetchFlexSearch(wanted);
  const results = normalizeFlexSearchResults(searchResult.data);
  const searchCandidates = results
    .map((result) => ({
      elementId: extractSearchResultId(result),
      name:
        result?.name ||
        result?.displayName ||
        result?.preferredDisplayString ||
        result?.text ||
        result?.label ||
        null,
      documentNumber:
        result?.documentNumber ||
        result?.number ||
        result?.docNumber ||
        result?.identifier ||
        null,
    }))
    .filter((candidate) => candidate.elementId)
    .slice(0, 8);

  if (!searchCandidates.length) return null;

  const wantedLower = wanted.toLowerCase();
  const exactSearchHits = searchCandidates.filter(
    (candidate) =>
      String(candidate.documentNumber || "").trim().toLowerCase() === wantedLower
  );

  const ranked = exactSearchHits.length ? exactSearchHits : searchCandidates;
  let verified = null;

  for (const candidate of ranked) {
    try {
      const intake = await fetchFlexShowIntake(candidate.elementId);
      const ctx = intake?.showContext || {};
      const headerDoc = String(ctx.documentNumber || "").trim();
      const headerMatches = headerDoc.toLowerCase() === wantedLower;
      if (!headerMatches) continue;

      const nameBlob = `${candidate.name || ""} ${ctx.showName || ""}`.toLowerCase();
      const nameMentionsDoc = nameBlob.includes(wantedLower);
      const searchHadExactDoc =
        String(candidate.documentNumber || "").trim().toLowerCase() === wantedLower;

      // Header can echo a searched number on the wrong element after a weak
      // global-search fallback. Require the quote number to appear on the search
      // hit itself or in the show/quote name before promoting a Slack candidate.
      if (!searchHadExactDoc && !nameMentionsDoc) {
        continue;
      }

      verified = {
        elementId: candidate.elementId,
        showName: ctx.showName || candidate.name || wanted,
        ctx,
        headerDoc,
      };
      break;
    } catch {
      // Best-effort enrichment; try the next search hit.
    }
  }

  if (!verified) return null;

  const showName = verified.showName;
  return {
    showKey: normalizeShowKey(`${showName}-${wanted}`),
    showName,
    client: verified.ctx.client || null,
    venue: verified.ctx.venue || null,
    documentNumbers: [...new Set([wanted, verified.headerDoc].filter(Boolean))],
    aliases: [],
    plannedStartDate: verified.ctx.plannedStartDate || null,
    plannedEndDate: verified.ctx.plannedEndDate || null,
    loadInDate: verified.ctx.loadInDate || null,
    loadOutDate: verified.ctx.loadOutDate || null,
    showStartDate: verified.ctx.showStartDate || null,
    departments: [],
    source: "flex_quote_lookup",
    elementId: verified.elementId,
    quoteVerified: true,
  };
}

function flattenFlexRows(rows, parentSection = null, depth = 0) {
  const flattened = [];

  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const row = rowToObject(rawRow);
    const children = Array.isArray(rawRow?.children) ? rawRow.children : [];

    const typeName =
      typeof rawRow?.type === "object"
        ? rawRow.type?.name
        : row.type;

    const normalized = {
      id: rawRow?.id || null,
      parentSection,
      depth,
      name: row.name || rawRow?.name || null,
      type: typeName || null,
      lineItemType: rawRow?.lineItemType || null,
      subtotalType: rawRow?.subtotalType || null,
      category: classifyFlexLineItem({
        ...row,
        type: typeName,
      }),
      quantity: toNumber(row.quantity ?? rawRow?.quantity),
      timeQty: toNumber(row.timeQty ?? rawRow?.timeQty),
      pricingModel: normalizeFlexCellValue(row.pricingModel ?? rawRow?.pricingModel),
      priceEach: toNumber(row.priceEach ?? rawRow?.priceEach),
      priceExtended: toNumber(row.priceExtended ?? rawRow?.priceExtended),
      costExtended: toNumber(rawRow?.costExtended),
      note: row.note || rawRow?.note || null,
      lineMute: Boolean(row.lineMute ?? rawRow?.lineMute),
      priceMute: Boolean(row.priceMute ?? rawRow?.priceMute),
      totalMute: Boolean(row.totalMute ?? rawRow?.totalMute),
      leaf: Boolean(rawRow?.leaf),
      subtotal: Boolean(rawRow?.subtotal),
      container: Boolean(rawRow?.container),
      hasChildren: children.length > 0,
    };

    flattened.push(normalized);

    const nextParentSection =
      depth === 0 && normalized.name ? normalized.name : parentSection;

    if (children.length > 0) {
      flattened.push(...flattenFlexRows(children, nextParentSection, depth + 1));
    }
  }

  return flattened;
}

function isSectionTotalLine(item) {
  return (
    item.depth === 0 &&
    item.subtotal === true &&
    item.subtotalType === "header" &&
    item.name
  );
}

function isBillableDetailLine(item) {
  if (!item.name) return false;
  if (item.lineItemType === "subtotal") return false;
  if (item.subtotal === true) return false;
  if (item.priceExtended === 0 && item.quantity === 0) return false;

  return true;
}

function buildFlexDocumentDetail(intake) {
  const summary = buildFlexDocumentSummary(intake);
  const topRows = unwrapFlexRows(intake.rowData);
  const flatRows = flattenFlexRows(topRows);

  const sectionTotals = flatRows.filter(isSectionTotalLine);

  const sections = sectionTotals.map((section) => {
    const items = flatRows
      .filter((item) => item.parentSection === section.name)
      .filter(isBillableDetailLine)
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        type: item.type,
        quantity: item.quantity,
        timeQty: item.timeQty,
        pricingModel: item.pricingModel,
        priceEach: item.priceEach,
        priceExtended: item.priceExtended,
        note: item.note,
        lineMute: item.lineMute,
        priceMute: item.priceMute,
        totalMute: item.totalMute,
      }));

    return {
      name: section.name,
      category: section.category,
      total: section.priceExtended,
      itemCount: items.length,
      items,
    };
  });

  const laborItems = sections
    .filter((section) => section.category === "labor" || /labor/i.test(section.name))
    .flatMap((section) => section.items);

  const transportationItems = sections
    .filter(
      (section) =>
        section.category === "transportation" || /transport/i.test(section.name)
    )
    .flatMap((section) => section.items);

  const inventoryItems = sections
    .filter(
      (section) =>
        section.category === "rental" &&
        !/labor|transport/i.test(section.name)
    )
    .flatMap((section) => section.items);

  return {
    elementId: intake.elementId,
    showContext: intake.showContext,
    summary,
    counts: {
      sections: sections.length,
      flattenedRows: flatRows.length,
      inventoryItems: inventoryItems.length,
      laborItems: laborItems.length,
      transportationItems: transportationItems.length,
    },
    sections,
    laborItems,
    transportationItems,
    inventoryItems,
    warnings: summary.warnings || [],
  };
}



function formatUsd(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function extractDocumentNumberFromQuestion(question) {
  const text = String(question || "");
  const match = text.match(/\b\d{2}-\d{3,6}\b/);

  return match ? match[0] : null;
}

function extractDocumentNumbersFromQuestion(question) {
  const text = String(question || "");
  const matches = text.match(/\b\d{2}-\d{3,6}\b/g) || [];
  return [...new Set(matches)];
}

function normalizeCompareItemName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s.+/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFlexDetailByDocumentNumber(documentNumber) {
  const quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber);

  if (!quoteLookup.found || !quoteLookup.elementId) {
    return {
      found: false,
      documentNumber,
      lookup: quoteLookup,
    };
  }

  const intake = await fetchFlexShowIntake(quoteLookup.elementId);
  const detail = buildFlexDocumentDetail(intake);

  return {
    found: true,
    documentNumber,
    elementId: quoteLookup.elementId,
    lookup: quoteLookup,
    detail,
  };
}

function getCompareDocumentLabel(detail) {
  const showContext = detail?.showContext || {};
  return [showContext.documentNumber, showContext.showName].filter(Boolean).join(" — ");
}

function getCompareFinancials(detail) {
  const summary = detail?.summary || {};
  const financials = summary.financials || {};
  const totals = summary.totals || {};

  return {
    invoiceTotal: Number(financials.invoiceTotal || totals.document || 0),
    invoiceTotalFormatted: formatUsd(financials.invoiceTotal || totals.document || 0),
    categorySubtotal: Number(financials.categorySubtotal || totals.document || 0),
    categorySubtotalFormatted: formatUsd(financials.categorySubtotal || totals.document || 0),
    rental: Number(totals.rental || 0),
    rentalFormatted: formatUsd(totals.rental || 0),
    labor: Number(totals.labor || 0),
    laborFormatted: formatUsd(totals.labor || 0),
    transportation: Number(totals.transportation || 0),
    transportationFormatted: formatUsd(totals.transportation || 0),
    balanceDue: Number(financials.balanceDue || 0),
    balanceDueFormatted: formatUsd(financials.balanceDue || 0),
  };
}

function buildCompareMetricRows(detailA, detailB) {
  const a = getCompareFinancials(detailA);
  const b = getCompareFinancials(detailB);

  const rows = [
    ["Invoice total", "invoiceTotal"],
    ["Category subtotal", "categorySubtotal"],
    ["Rental", "rental"],
    ["Labor", "labor"],
    ["Transportation", "transportation"],
    ["Balance due", "balanceDue"],
  ];

  return rows.map(([label, key]) => {
    const valueA = Number(a[key] || 0);
    const valueB = Number(b[key] || 0);
    const delta = Math.round((valueB - valueA) * 100) / 100;

    return {
      label,
      a: valueA,
      aFormatted: formatUsd(valueA),
      b: valueB,
      bFormatted: formatUsd(valueB),
      delta,
      deltaFormatted: `${delta >= 0 ? "+" : "-"}${formatUsd(Math.abs(delta))}`,
    };
  });
}

function buildCompareSectionRows(detailA, detailB) {
  const mapA = new Map();
  const mapB = new Map();

  for (const section of Array.isArray(detailA?.sections) ? detailA.sections : []) {
    mapA.set(String(section.name || "Unnamed"), section);
  }

  for (const section of Array.isArray(detailB?.sections) ? detailB.sections : []) {
    mapB.set(String(section.name || "Unnamed"), section);
  }

  const names = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return names
    .map((name) => {
      const a = mapA.get(name);
      const b = mapB.get(name);
      const totalA = Number(a?.total || 0);
      const totalB = Number(b?.total || 0);
      const delta = Math.round((totalB - totalA) * 100) / 100;

      return {
        name,
        category: b?.category || a?.category || null,
        a: totalA,
        aFormatted: formatUsd(totalA),
        b: totalB,
        bFormatted: formatUsd(totalB),
        delta,
        deltaFormatted: `${delta >= 0 ? "+" : "-"}${formatUsd(Math.abs(delta))}`,
        aItemCount: a?.itemCount || 0,
        bItemCount: b?.itemCount || 0,
      };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

function buildCompareItemMap(detail) {
  const items = [
    ...(Array.isArray(detail?.inventoryItems) ? detail.inventoryItems : []),
    ...(Array.isArray(detail?.laborItems) ? detail.laborItems : []),
    ...(Array.isArray(detail?.transportationItems) ? detail.transportationItems : []),
  ];

  const map = new Map();

  for (const item of items) {
    const key = normalizeCompareItemName(item.name);
    const existing = map.get(key) || {
      name: item.name,
      quantity: 0,
      value: 0,
      sections: new Set(),
    };

    existing.quantity += Number(item.quantity || 0);
    existing.value += Number(item.priceExtended || 0);
    if (item.sectionName) existing.sections.add(item.sectionName);

    map.set(key, existing);
  }

  return map;
}

function buildCompareItemRows(detailA, detailB) {
  const mapA = buildCompareItemMap(detailA);
  const mapB = buildCompareItemMap(detailB);
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];

  return keys
    .map((key) => {
      const a = mapA.get(key);
      const b = mapB.get(key);
      const qtyA = Number(a?.quantity || 0);
      const qtyB = Number(b?.quantity || 0);
      const valueA = Number(a?.value || 0);
      const valueB = Number(b?.value || 0);

      return {
        name: b?.name || a?.name || key,
        aQuantity: qtyA,
        bQuantity: qtyB,
        quantityDelta: qtyB - qtyA,
        aValue: valueA,
        aValueFormatted: formatUsd(valueA),
        bValue: valueB,
        bValueFormatted: formatUsd(valueB),
        valueDelta: Math.round((valueB - valueA) * 100) / 100,
        valueDeltaFormatted: `${valueB - valueA >= 0 ? "+" : "-"}${formatUsd(Math.abs(valueB - valueA))}`,
        status: a && b ? "changed_or_same" : a ? "removed" : "added",
      };
    })
    .filter((row) => row.quantityDelta !== 0 || Math.abs(row.valueDelta) >= 0.01 || row.status !== "changed_or_same")
    .sort((x, y) => Math.abs(y.valueDelta) - Math.abs(x.valueDelta))
    .slice(0, 25);
}

function buildFlexDocumentComparison(question, detailA, detailB) {
  const labelA = getCompareDocumentLabel(detailA);
  const labelB = getCompareDocumentLabel(detailB);
  const financialRows = buildCompareMetricRows(detailA, detailB);
  const sectionRows = buildCompareSectionRows(detailA, detailB);
  const itemRows = buildCompareItemRows(detailA, detailB);

  const invoiceRow = financialRows.find((row) => row.label === "Invoice total");
  const laborRow = financialRows.find((row) => row.label === "Labor");
  const rentalRow = financialRows.find((row) => row.label === "Rental");

  const biggestSectionChanges = sectionRows
    .filter((row) => Math.abs(row.delta) >= 0.01)
    .slice(0, 5);

  const answerParts = [
    `${labelB} is ${invoiceRow?.deltaFormatted || "$0.00"} vs ${labelA} on invoice total.`,
    rentalRow ? `Rental changed ${rentalRow.deltaFormatted}.` : null,
    laborRow ? `Labor changed ${laborRow.deltaFormatted}.` : null,
    biggestSectionChanges.length
      ? `Biggest section changes: ${biggestSectionChanges
          .slice(0, 3)
          .map((row) => `${row.name} ${row.deltaFormatted}`)
          .join(", ")}.`
      : "No section-total changes found.",
  ].filter(Boolean);

  return {
    headline: "Quote Comparison",
    comparisonType: "two_quote_compare",
    answer: answerParts.join(" "),
    documents: {
      a: {
        label: labelA,
        documentNumber: detailA?.showContext?.documentNumber || null,
        showName: detailA?.showContext?.showName || null,
        client: detailA?.showContext?.client || null,
        venue: detailA?.showContext?.venue || null,
        plannedStartDate: detailA?.showContext?.plannedStartDate || null,
      },
      b: {
        label: labelB,
        documentNumber: detailB?.showContext?.documentNumber || null,
        showName: detailB?.showContext?.showName || null,
        client: detailB?.showContext?.client || null,
        venue: detailB?.showContext?.venue || null,
        plannedStartDate: detailB?.showContext?.plannedStartDate || null,
      },
    },
    financialRows,
    sectionRows,
    itemRows,
    counts: {
      changedSections: sectionRows.filter((row) => Math.abs(row.delta) >= 0.01).length,
      changedItems: itemRows.length,
    },
  };
}


const FLEX_EQUIPMENT_FAMILIES = [
  {
    id: "speaker",
    label: "Speakers / PA",
    primaryPatterns: [
      /\bspeakers?\b/i,
      /\bloudspeakers?\b/i,
      /\bline array\b/i,
      /\barray\b/i,
      /\bpa\b/i,
      /\bsubwoofers?\b/i,
      /\bsubs?\b/i,
      /\bmonitors?\b/i,
      /\bwedges?\b/i,
      /\bfront fill\b/i,
      /\bside fill\b/i,
      /\bdelay\b/i,
      /\bleopard\b/i,
      /\blyon\b/i,
      /\bmina\b/i,
      /\bmelodie\b/i,
      /\b700-hp\b/i,
      /\b900-lfc\b/i,
      /\b1100-lfc\b/i,
      /\bmjf\b/i,
      /\bmeyer\b/i,
      /\bl-acoustics\b/i,
      /\bd&b\b/i,
      /\bjbl\b/i,
      /\bqsc\b/i,
      /\bks28\b/i,
      /\bk1\b/i,
      /\bk2\b/i,
      /\bkara\b/i,
      /\bara\b/i,
      /\by-?series\b/i,
      /\bv-?series\b/i,
    ],
    relatedPatterns: [
      /\bspeaker cable\b/i,
      /\bnl4\b/i,
      /\bnl8\b/i,
      /\bamplifier\b/i,
      /\bamp rack\b/i,
      /\bgalileo\b/i,
      /\bgalaxy\b/i,
      /\blake\b/i,
      /\bprocessor\b/i,
      /\bdrive rack\b/i,
    ],
  },
  {
    id: "led_panel",
    label: "Video LED Panels",
    primaryPatterns: [
      /\bled panels?\b/i,
      /\bvideo panels?\b/i,
      /\bwall panels?\b/i,
      /\bled wall\b/i,
      /\bvideo wall\b/i,
      /\binfiled\b/i,
      /\babsen\b/i,
      /\broe\b/i,
      /\bunilumin\b/i,
      /\bcb5\b/i,
      /\bcb8\b/i,
      /\bar4\.?6\b/i,
      /\bdb2\b/i,
      /\bbp2\b/i,
      /\bpanel:\s*xl\b/i,
      /\bpixel\b/i,
    ],
    relatedPatterns: [
      /\bnovastar\b/i,
      /\bvx1000s?\b/i,
      /\bvx4s\b/i,
      /\bmctrl\b/i,
      /\bprocessor\b/i,
      /\bsending card\b/i,
      /\breceiving card\b/i,
      /\bdata jumper\b/i,
      /\bpower jumper\b/i,
      /\bled cable\b/i,
      /\bground support\b/i,
      /\bheader bar\b/i,
      /\bhanging bar\b/i,
      /\bcurving\b/i,
    ],
  },
  {
    id: "video",
    label: "Video",
    primaryPatterns: [
      /\bvideo\b/i,
      /\bswitcher\b/i,
      /\bprocessor\b/i,
      /\bscaler\b/i,
      /\bprojector\b/i,
      /\bscreen\b/i,
      /\bcamera\b/i,
      /\bmonitors?\b/i,
      /\bconfidence monitor\b/i,
      /\bpreview monitor\b/i,
      /\bplayback\b/i,
      /\bresolume\b/i,
      /\bbarco\b/i,
      /\bblackmagic\b/i,
      /\bdecimator\b/i,
      /\baja\b/i,
      /\bnovastar\b/i,
      /\bvx1000s?\b/i,
    ],
    relatedPatterns: [
      /\bsdi\b/i,
      /\bhdmi\b/i,
      /\bfiber\b/i,
      /\bconverter\b/i,
      /\bextender\b/i,
      /\bcat6\b/i,
    ],
  },
  {
    id: "truss",
    label: "Truss",
    primaryPatterns: [
      /\btruss\b/i,
      /\bbox truss\b/i,
      /\b12x12\b/i,
      /\b20\.?5\b/i,
      /\bgt\b/i,
      /\btomcat\b/i,
      /\btyler\b/i,
      /\bglobal truss\b/i,
      /\bcorner block\b/i,
      /\bbase plate\b/i,
      /\bspigots?\b/i,
      /\btruss tower\b/i,
      /\bcircle truss\b/i,
    ],
    relatedPatterns: [
      /\bcouplers?\b/i,
      /\bclamps?\b/i,
      /\bcheeseborough\b/i,
      /\bsafet(y|ies)\b/i,
      /\bspan set\b/i,
      /\bsteel\b/i,
      /\bshackle\b/i,
    ],
  },
  {
    id: "motor",
    label: "Motors / Hoists",
    primaryPatterns: [
      /\bmotors?\b/i,
      /\bhoists?\b/i,
      /\bchain motor\b/i,
      /\bchain hoist\b/i,
      /\b1\/2 ton\b/i,
      /\bhalf ton\b/i,
      /\b1 ton\b/i,
      /\bone ton\b/i,
      /\bquarter ton\b/i,
      /\bcm lodestar\b/i,
      /\blodestar\b/i,
      /\bliftket\b/i,
    ],
    relatedPatterns: [
      /\bmotor controller\b/i,
      /\bcontroller\b/i,
      /\bpickle\b/i,
      /\bpickle cable\b/i,
      /\bsocapex\b/i,
      /\bspan set\b/i,
      /\bshackle\b/i,
      /\bsteel\b/i,
    ],
  },
  {
    id: "console",
    label: "Consoles / Desks",
    primaryPatterns: [
      /\bconsoles?\b/i,
      /\bdesks?\b/i,
      /\bcontrol surface\b/i,
      /\bgrandma\b/i,
      /\bma2\b/i,
      /\bma3\b/i,
      /\bavid\b/i,
      /\bdigico\b/i,
      /\byamaha\b/i,
      /\bcl5\b/i,
      /\bql5\b/i,
      /\bsd10\b/i,
      /\bsd12\b/i,
      /\bsd9\b/i,
      /\bprofile\b/i,
      /\bvenue\b/i,
      /\bwing\b/i,
      /\bx32\b/i,
      /\bm32\b/i,
    ],
    relatedPatterns: [
      /\bstage rack\b/i,
      /\bsnake\b/i,
      /\bdante\b/i,
      /\brio\b/i,
      /\bsoundgrid\b/i,
      /\bnetwork switch\b/i,
      /\bartnet\b/i,
      /\bdmx\b/i,
    ],
  },
  {
    id: "mic",
    label: "Microphones / Wireless",
    primaryPatterns: [
      /\bmics?\b/i,
      /\bmicrophones?\b/i,
      /\bwireless\b/i,
      /\biem\b/i,
      /\bin ear\b/i,
      /\bin-ear\b/i,
      /\bhandheld\b/i,
      /\blavalier\b/i,
      /\blav\b/i,
      /\bbodypack\b/i,
      /\bheadset\b/i,
      /\bshure\b/i,
      /\bsennheiser\b/i,
      /\bsm58\b/i,
      /\bsm57\b/i,
      /\bksm\b/i,
      /\bulxd\b/i,
      /\bqlxd\b/i,
      /\baxient\b/i,
    ],
    relatedPatterns: [
      /\bantenna\b/i,
      /\bpaddle\b/i,
      /\bcombiners?\b/i,
      /\bdistribution\b/i,
      /\brf\b/i,
      /\bmic stand\b/i,
      /\bboom stand\b/i,
      /\bxlr\b/i,
    ],
  },
  {
    id: "cable",
    label: "Cable",
    primaryPatterns: [
      /\bcables?\b/i,
      /\bxlr\b/i,
      /\bsdi\b/i,
      /\bhdmi\b/i,
      /\bnl4\b/i,
      /\bnl8\b/i,
      /\bsocapex\b/i,
      /\bcat6\b/i,
      /\bethernet\b/i,
      /\bpower cable\b/i,
      /\bstinger\b/i,
      /\bjumper\b/i,
      /\bfeeder\b/i,
      /\btail\b/i,
    ],
    relatedPatterns: [],
  },
  {
    id: "power",
    label: "Power",
    primaryPatterns: [
      /\bpower\b/i,
      /\bdistro\b/i,
      /\bpower distribution\b/i,
      /\bdisconnect\b/i,
      /\bfeeder\b/i,
      /\btails?\b/i,
      /\bcamlock\b/i,
      /\bsocapex\b/i,
      /\bstingers?\b/i,
      /\blunchbox\b/i,
      /\bbreaker\b/i,
      /\btransformer\b/i,
    ],
    relatedPatterns: [
      /\bcable ramp\b/i,
      /\byellow jacket\b/i,
    ],
  },
  {
    id: "lighting",
    label: "Lighting",
    primaryPatterns: [
      /\blights?\b/i,
      /\blighting\b/i,
      /\bfixtures?\b/i,
      /\bwashes?\b/i,
      /\bbeams?\b/i,
      /\bspots?\b/i,
      /\bstrobes?\b/i,
      /\bpixelline\b/i,
      /\bpar\b/i,
      /\bmoving head\b/i,
      /\bvl\d+\b/i,
      /\bproteus\b/i,
      /\bmaximus\b/i,
      /\bhybrid\b/i,
      /\brobe\b/i,
      /\bmega ?pointe\b/i,
      /\bbmfl\b/i,
      /\bviper\b/i,
      /\bultra\b/i,
      /\bmartin\b/i,
      /\bmac\b/i,
      /\bcolorado\b/i,
      /\bchauvet\b/i,
      /\belation\b/i,
    ],
    relatedPatterns: [
      /\bdmx\b/i,
      /\bartnet\b/i,
      /\bsacn\b/i,
      /\bnode\b/i,
      /\bdimmer\b/i,
      /\brelay\b/i,
    ],
  },
];

const FLEX_ITEM_QUESTION_PATTERNS = [
  /\bdoes\b/i,
  /\bdo we have\b/i,
  /\bhas\b/i,
  /\bhave\b/i,
  /\bhow many\b/i,
  /\bwhat .* are on\b/i,
  /\bwhich .* are on\b/i,
  /\bis there\b/i,
  /\bare there\b/i,
  /\bshow me .* on\b/i,
  /\bfind .* on\b/i,
];

function normalizeFlexItemText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s.+/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAllInventoryItemsWithSection(detail) {
  const sections = Array.isArray(detail?.sections) ? detail.sections : [];

  return sections
    .filter(
      (section) =>
        section.category === "rental" &&
        !/labor|transport/i.test(String(section.name || ""))
    )
    .flatMap((section) =>
      (Array.isArray(section.items) ? section.items : []).map((item) => ({
        ...item,
        sectionName: section.name,
        sectionCategory: section.category,
      }))
    );
}

function detectEquipmentFamilyFromQuestion(question) {
  const text = String(question || "");

  for (const family of FLEX_EQUIPMENT_FAMILIES) {
    const allPatterns = [...family.primaryPatterns, ...family.relatedPatterns];
    if (allPatterns.some((pattern) => pattern.test(text))) {
      return family;
    }
  }

  return null;
}

function stripItemSearchPhrase(question) {
  let text = String(question || "");

  text = text.replace(/\b\d{2}-\d{3,6}\b/g, " ");

  const removePatterns = [
    /\bwhat\b/gi,
    /\bwhich\b/gi,
    /\bdoes\b/gi,
    /\bdo\b/gi,
    /\bwe\b/gi,
    /\bhave\b/gi,
    /\bhas\b/gi,
    /\bhow many\b/gi,
    /\bis there\b/gi,
    /\bare there\b/gi,
    /\bshow\b/gi,
    /\bme\b/gi,
    /\bfind\b/gi,
    /\bon\b/gi,
    /\bin\b/gi,
    /\bthe\b/gi,
    /\ba\b/gi,
    /\ban\b/gi,
    /\bquote\b/gi,
    /\bjob\b/gi,
    /\bflex\b/gi,
    /\bitems?\b/gi,
    /\bequipment\b/gi,
    /\bgear\b/gi,
    /\brentals?\b/gi,
  ];

  for (const pattern of removePatterns) {
    text = text.replace(pattern, " ");
  }

  return text
    .replace(/[?!.:,;()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSignificantSearchTokens(value) {
  const baseTokens = normalizeFlexItemText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter(
      (token) =>
        ![
          "the",
          "and",
          "for",
          "with",
          "quote",
          "job",
          "flex",
          "items",
          "item",
          "gear",
          "equipment",
          "rental",
          "rentals",
          "what",
          "which",
          "have",
          "does",
          "show",
          "many",
          "there",
          "are",
          "is",
        ].includes(token)
    );

  const expanded = [];

  for (const token of baseTokens) {
    expanded.push(token);

    // Handle simple plurals and model-number plurals, e.g. VX1000s -> vx1000.
    if (token.length > 3 && token.endsWith("s")) {
      expanded.push(token.slice(0, -1));
    }

    if (token.length > 4 && token.endsWith("es")) {
      expanded.push(token.slice(0, -2));
    }
  }

  return [...new Set(expanded)];
}

function itemMatchesAnyPattern(item, patterns) {
  const haystack = `${item.name || ""} ${item.note || ""}`;
  return patterns.some((pattern) => pattern.test(haystack));
}

function scoreExactItemMatch(item, tokens) {
  if (!tokens.length) return 0;

  const haystack = normalizeFlexItemText(
    `${item.name || ""} ${item.note || ""} ${item.sectionName || ""}`
  );

  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 2 : 1;
    }
  }

  // Reward phrase-level match when the user's original phrase survives cleanup.
  const phrase = [...new Set(tokens)].join(" ");
  if (phrase.length >= 4 && haystack.includes(phrase)) {
    score += 4;
  }

  return score;
}

function summarizeMatchedFlexItems(items, maxItems = 80) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((item) => ({
      name: item.name,
      sectionName: item.sectionName,
      quantity: item.quantity,
      timeQty: item.timeQty,
      pricingModel: item.pricingModel,
      priceEach: item.priceEach,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: formatUsd(item.priceExtended),
      lineMute: item.lineMute,
      matchType: item.matchType || null,
      matchScore: item.matchScore || 0,
    }));
}


function isSpecificItemSearchPhrase(tokens) {
  const genericTokens = new Set([
    "audio",
    "speaker",
    "speakers",
    "pa",
    "sub",
    "subs",
    "video",
    "led",
    "panel",
    "panels",
    "wall",
    "truss",
    "motor",
    "motors",
    "hoist",
    "hoists",
    "console",
    "consoles",
    "mic",
    "mics",
    "microphone",
    "microphones",
    "cable",
    "cables",
    "power",
    "lighting",
    "light",
    "lights",
  ]);

  return tokens.some((token) => {
    const t = String(token || "").toLowerCase();
    return /[a-z]+[0-9]+|[0-9]+[a-z]+/i.test(t) || (t.length >= 6 && !genericTokens.has(t));
  });
}

function isPrimaryFamilyMatch(item, family) {
  const name = String(item?.name || "");

  if (family?.id === "truss") {
    return /\bbox truss\b|\bcircle truss\b|\btriangle truss\b|\b12"?\s*box truss\b|\b20\.?5"?\s*truss\b|\btruss\s*-\s*\d/i.test(name);
  }

  if (family?.id === "led_panel") {
    return /\bpanel\b/i.test(name) && !/\b(processor|novastar|vx1000|vx4s|mctrl|sending|receiving|jumper|cable|ground support|header|hanging|curving)\b/i.test(name);
  }

  if (family?.id === "speaker") {
    return !/\b(cable|nl4|nl8|amplifier|amp rack|processor|galileo|galaxy|lake|drive rack)\b/i.test(name);
  }

  return true;
}

function shouldDemotePrimaryFamilyMatch(item, family) {
  const name = String(item?.name || "");

  if (family?.id === "truss") {
    return /(bolt|tool set|tool|base plate|steel pipe|strap|ballast|shackle|span set|safety|safeties|clamp|coupler)/i.test(name);
  }

  if (family?.id === "led_panel") {
    return /(processor|novastar|vx1000|vx4s|mctrl|sending|receiving|jumper|cable|ground support|header|hanging|curving)/i.test(name);
  }

  if (family?.id === "speaker") {
    return /(cable|nl4|nl8|amplifier|amp rack|processor|galileo|galaxy|lake|drive rack)/i.test(name);
  }

  return false;
}

function buildFlexSmartItemSearch(detail, question) {
  const family = detectEquipmentFamilyFromQuestion(question);
  const rawSearchPhrase = stripItemSearchPhrase(question);
  const tokens = getSignificantSearchTokens(rawSearchPhrase);
  const allItems = getAllInventoryItemsWithSection(detail);

  let primaryMatches = [];
  let relatedMatches = [];
  let searchMode = family ? "family" : "exact";

  const exactMatches = tokens.length
    ? allItems
        .map((item) => ({
          ...item,
          matchType: "primary",
          matchScore: scoreExactItemMatch(item, tokens),
        }))
        .filter((item) => item.matchScore > 0)
        .sort((a, b) => b.matchScore - a.matchScore)
    : [];

  if (isSpecificItemSearchPhrase(tokens) && exactMatches.length) {
    searchMode = "exact";
    primaryMatches = exactMatches;
    relatedMatches = [];
  } else if (family) {
    const familyMatches = allItems
      .filter((item) => itemMatchesAnyPattern(item, family.primaryPatterns))
      .map((item) => ({ ...item, matchScore: 10 }));

    primaryMatches = familyMatches
      .filter((item) => isPrimaryFamilyMatch(item, family))
      .filter((item) => !shouldDemotePrimaryFamilyMatch(item, family))
      .map((item) => ({ ...item, matchType: "primary" }));

    const demotedMatches = familyMatches
      .filter(
        (item) =>
          !isPrimaryFamilyMatch(item, family) ||
          shouldDemotePrimaryFamilyMatch(item, family)
      )
      .map((item) => ({ ...item, matchType: "related", matchScore: 5 }));

    relatedMatches = [
      ...demotedMatches,
      ...allItems
        .filter((item) => itemMatchesAnyPattern(item, family.relatedPatterns))
        .filter(
          (item) =>
            !primaryMatches.some(
              (primary) =>
                primary.id === item.id &&
                primary.name === item.name &&
                primary.sectionName === item.sectionName
            )
        )
        .map((item) => ({ ...item, matchType: "related", matchScore: 5 })),
    ];

    relatedMatches = relatedMatches.filter(
      (item, index, array) =>
        index ===
        array.findIndex(
          (other) =>
            other.id === item.id &&
            other.name === item.name &&
            other.sectionName === item.sectionName
        )
    );
  } else if (exactMatches.length) {
    searchMode = "exact";
    primaryMatches = exactMatches;
    relatedMatches = [];
  }

  const totalPrimaryQuantity = primaryMatches.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );
  const totalRelatedQuantity = relatedMatches.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );
  const primaryTotal = primaryMatches.reduce(
    (sum, item) => sum + Number(item.priceExtended || 0),
    0
  );
  const relatedTotal = relatedMatches.reduce(
    (sum, item) => sum + Number(item.priceExtended || 0),
    0
  );

  const familyLabel =
    searchMode === "exact"
      ? `Item Search: ${rawSearchPhrase || "Item"}`
      : family?.label || (rawSearchPhrase ? `Item Search: ${rawSearchPhrase}` : "Item Search");

  return {
    familyId: searchMode === "exact" ? null : family?.id || null,
    familyLabel,
    searchMode,
    searchPhrase: rawSearchPhrase,
    tokens,
    primaryMatches: summarizeMatchedFlexItems(primaryMatches, 100),
    relatedMatches: summarizeMatchedFlexItems(relatedMatches, 100),
    primaryCount: primaryMatches.length,
    relatedCount: relatedMatches.length,
    totalCount: primaryMatches.length + relatedMatches.length,
    totalPrimaryQuantity,
    totalRelatedQuantity,
    primaryTotal: Math.round(primaryTotal * 100) / 100,
    primaryTotalFormatted: formatUsd(primaryTotal),
    relatedTotal: Math.round(relatedTotal * 100) / 100,
    relatedTotalFormatted: formatUsd(relatedTotal),
    totalMatchedValue: Math.round((primaryTotal + relatedTotal) * 100) / 100,
    totalMatchedValueFormatted: formatUsd(primaryTotal + relatedTotal),
  };
}


function formatFlexDateTime(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatFlexDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function classifyFlexContextQuestion(question) {
  const text = String(question || "").toLowerCase();

  if (/\b(pm|project manager)\b/i.test(text)) {
    return "project_manager";
  }

  if (/\b(owner|owns|responsible|person responsible|salesperson|sales person|account manager)\b/i.test(text)) {
    return "owner";
  }

  if (/\b(client|customer)\b/i.test(text)) {
    return "client";
  }

  if (/\b(venue|where|location|site)\b/i.test(text)) {
    return "venue";
  }

  if (/\b(load[- ]?in|load in|loadin)\b/i.test(text)) {
    return "load_in";
  }

  if (/\b(load[- ]?out|load out|loadout|strike)\b/i.test(text)) {
    return "load_out";
  }

  if (/\b(start|planned start|begins|begin)\b/i.test(text)) {
    return "planned_start";
  }

  if (/\b(end|planned end|ends|finish|finishes)\b/i.test(text)) {
    return "planned_end";
  }

  if (/\b(date|dates|when|schedule|timeline)\b/i.test(text)) {
    return "dates";
  }

  return "overview";
}

function buildFlexContextAnswer(detail, question) {
  const showContext = detail?.showContext || {};
  const contextType = classifyFlexContextQuestion(question);

  const documentLabel = [
    showContext.documentNumber,
    showContext.showName,
  ]
    .filter(Boolean)
    .join(" — ");

  const personResponsible = showContext.personResponsible || null;
  const projectManager = showContext.projectManager || null;
  const client = showContext.client || null;
  const venue = showContext.venue || null;
  const plannedStart = showContext.plannedStartDate || null;
  const plannedEnd = showContext.plannedEndDate || null;
  const loadIn = showContext.loadInDate || null;
  const loadOut = showContext.loadOutDate || null;

  const facts = {
    personResponsible,
    projectManager,
    client,
    venue,
    plannedStart,
    plannedStartFormatted: formatFlexDateTime(plannedStart),
    plannedEnd,
    plannedEndFormatted: formatFlexDateTime(plannedEnd),
    loadIn,
    loadInFormatted: formatFlexDateTime(loadIn),
    loadOut,
    loadOutFormatted: formatFlexDateTime(loadOut),
  };

  if (contextType === "owner") {
    return {
      headline: "Quote Owner",
      contextType,
      answer: `${documentLabel}: person responsible is ${personResponsible || "not assigned"}. Project manager is ${projectManager || "not assigned"}.`,
      facts,
    };
  }

  if (contextType === "project_manager") {
    return {
      headline: "Project Manager",
      contextType,
      answer: `${documentLabel}: project manager is ${projectManager || "not assigned"}.`,
      facts,
    };
  }

  if (contextType === "client") {
    return {
      headline: "Client",
      contextType,
      answer: `${documentLabel}: client is ${client || "not listed"}.`,
      facts,
    };
  }

  if (contextType === "venue") {
    return {
      headline: "Venue",
      contextType,
      answer: `${documentLabel}: venue is ${venue || "not listed"}.`,
      facts,
    };
  }

  if (contextType === "load_in") {
    return {
      headline: "Load In",
      contextType,
      answer: `${documentLabel}: load in is ${facts.loadInFormatted || "not listed"}.`,
      facts,
    };
  }

  if (contextType === "load_out") {
    return {
      headline: "Load Out",
      contextType,
      answer: `${documentLabel}: load out is ${facts.loadOutFormatted || "not listed"}.`,
      facts,
    };
  }

  if (contextType === "planned_start") {
    return {
      headline: "Planned Start",
      contextType,
      answer: `${documentLabel}: planned start is ${facts.plannedStartFormatted || "not listed"}.`,
      facts,
    };
  }

  if (contextType === "planned_end") {
    return {
      headline: "Planned End",
      contextType,
      answer: `${documentLabel}: planned end is ${facts.plannedEndFormatted || "not listed"}.`,
      facts,
    };
  }

  const dateParts = [
    facts.plannedStartFormatted && facts.plannedEndFormatted
      ? `planned ${facts.plannedStartFormatted} to ${facts.plannedEndFormatted}`
      : null,
    facts.loadInFormatted ? `load in ${facts.loadInFormatted}` : null,
    facts.loadOutFormatted ? `load out ${facts.loadOutFormatted}` : null,
  ].filter(Boolean);

  if (contextType === "dates") {
    return {
      headline: "Dates",
      contextType,
      answer: `${documentLabel}: ${dateParts.length ? dateParts.join("; ") : "no dates are listed."}`,
      facts,
    };
  }

  return {
    headline: "Quote Context",
    contextType,
    answer: `${documentLabel}: ${client || "No client listed"}${venue ? ` at ${venue}` : ""}. Person responsible is ${personResponsible || "not assigned"}; PM is ${projectManager || "not assigned"}.`,
    facts,
  };
}


function isFlexOperationalAnalysisQuestion(question) {
  // Full-show / cross-source language belongs to show_operational_analysis.
  if (isShowOperationalAnalysisQuestion(question)) {
    return false;
  }

  const text = String(question || "").toLowerCase();

  if (
    /\boperational analysis\b/.test(text) ||
    /\boperational review\b/.test(text) ||
    /\banalyze (?:quote|show|job)\b/.test(text) ||
    /\boperational risks?\b/.test(text) ||
    /\bred flags?\b/.test(text) ||
    /\breadiness review\b/.test(text) ||
    /\bshow review\b/.test(text) ||
    /\bfull review\b/.test(text) ||
    /\bwarehouse needs?\b/.test(text) ||
    /\bquestions? for the pm\b/.test(text) ||
    /\bquestions? (?:should|for) (?:the )?pm\b/.test(text) ||
    /\bconcern(?:ed|s)?\b/.test(text) ||
    /\blabor(?:\s+and\s+|,)\s*trucking\b/.test(text) ||
    /\bequipment and labor\b/.test(text) ||
    /\breview labor[, ].*trucking/.test(text) ||
    /\blabor[, ].*trucking[, ].*(?:equipment|warehouse)/.test(text)
  ) {
    return true;
  }

  // Plain "operational summary" stays on the existing quick sections path
  // unless the question also asks for analysis / readiness / risks / multi-dept review.
  if (/\boperational summary\b/.test(text)) {
    return /\b(analysis|readiness|risks?|concerns?|red flags?|pm questions?|warehouse|labor|trucking|equipment)\b/.test(
      text
    );
  }

  return false;
}

function classifyFlexAskIntent(question) {
  const text = String(question || "").toLowerCase();

  // Full-show cross-source review must win before single-quote operational analysis.
  if (isShowOperationalAnalysisQuestion(question)) {
    return "show_operational_analysis";
  }

  // Operational analysis must win before labor / trucking / sections / inventory.
  if (isFlexOperationalAnalysisQuestion(question)) {
    return "document_operational_analysis";
  }

  if (/\b(labor|crew|tech|technician|engineer|stagehand|operator|staffing)\b/i.test(text)) {
    return "document_labor";
  }

  if (/\b(transport|transportation|truck|trucking|delivery|pickup|pick up|freight)\b/i.test(text)) {
    return "document_transportation";
  }

  if (/\b(compare|comparison|versus|vs\.?|difference|different|changed|changes|between)\b/i.test(text)) {
    return "document_compare";
  }

  if (/\b(paid|payment|payments|collected|received|deposit|balance|due|owed|outstanding|remaining|open|closed|real revenue|revenue quote|real quote|placeholder|zero|0 quote|\$0|category subtotal|subtotal|adjustment|discount|invoice total source)\b/i.test(text)) {
    return "document_money";
  }

  if (/\b(total|price|cost|amount|invoice total|quote total)\b/i.test(text)) {
    return "document_total";
  }

  if (/\b(owner|owns|responsible|person responsible|salesperson|sales person|account manager|pm|project manager|client|customer|venue|where|location|site|date|dates|when|schedule|timeline|load[- ]?in|load[- ]?out|loadin|loadout|strike|planned start|planned end)\b/i.test(text)) {
    return "document_context";
  }

  if (/\b(operational summary|ops summary|operation summary|quick summary|quick overview|overview|summarize|sections?|categories|category breakdown|breakdown|departments?|dept|video vs|audio vs|lighting vs|truss vs|power vs)\b/i.test(text)) {
    return "document_sections";
  }

  const hasItemQuestionShape = FLEX_ITEM_QUESTION_PATTERNS.some((pattern) =>
    pattern.test(text)
  );
  const hasEquipmentFamily = Boolean(detectEquipmentFamilyFromQuestion(text));

  if (hasEquipmentFamily || hasItemQuestionShape) {
    return "document_item_search";
  }

  if (/\b(inventory|gear|equipment|rental|rentals|items|item list|what is on|what's on)\b/i.test(text)) {
    return "document_inventory";
  }

  return "document_summary";
}

function summarizeItemsForAnswer(items, maxItems = 20) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      timeQty: item.timeQty,
      pricingModel: item.pricingModel,
      priceEach: item.priceEach,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: formatUsd(item.priceExtended),
      lineMute: item.lineMute,
    }));
}

function getSectionByCategoryOrName(detail, category, namePattern) {
  const sections = Array.isArray(detail?.sections) ? detail.sections : [];

  return sections.find((section) => {
    const sectionName = String(section?.name || "");
    return (
      String(section?.category || "").toLowerCase() === category ||
      (namePattern && namePattern.test(sectionName))
    );
  });
}


function pluralizeFlexWord(count, singular, plural = `${singular}s`) {
  return Number(count || 0) === 1 ? singular : plural;
}

function formatFlexItemOneLine(item) {
  if (!item) return "";
  const qty = item.quantity != null ? `${item.quantity}x ` : "";
  const section = item.sectionName ? ` from ${item.sectionName}` : "";
  const price =
    item.priceExtendedFormatted && item.priceExtendedFormatted !== "$0.00"
      ? ` (${item.priceExtendedFormatted})`
      : "";

  return `${qty}${item.name}${section}${price}`;
}

function makeHumanItemSearchAnswer(documentLabel, itemSearch) {
  const primary = Array.isArray(itemSearch?.primaryMatches)
    ? itemSearch.primaryMatches
    : [];
  const related = Array.isArray(itemSearch?.relatedMatches)
    ? itemSearch.relatedMatches
    : [];
  const searchPhrase = itemSearch?.searchPhrase || "that item";
  const familyLabel = itemSearch?.familyLabel || "Item Search";
  const primaryCount = Number(itemSearch?.primaryCount || 0);
  const relatedCount = Number(itemSearch?.relatedCount || 0);
  const totalPrimaryQuantity = Number(itemSearch?.totalPrimaryQuantity || 0);

  if (!primaryCount && !relatedCount) {
    return `${documentLabel}: I do not see ${searchPhrase} on this quote.`;
  }

  if (itemSearch?.searchMode === "exact") {
    if (primaryCount === 1) {
      return `Yes — ${documentLabel} has ${formatFlexItemOneLine(
        primary[0]
      )} on the quote.`;
    }

    return `Yes — ${documentLabel} has ${primaryCount} matches for ${searchPhrase}, totaling ${totalPrimaryQuantity} units and ${itemSearch.primaryTotalFormatted}.`;
  }

  const hasRelated = relatedCount > 0;

  if (primaryCount === 1) {
    return `${documentLabel} has ${formatFlexItemOneLine(primary[0])}. ${
      hasRelated
        ? `I also found ${relatedCount} related ${pluralizeFlexWord(
            relatedCount,
            "item"
          )}.`
        : ""
    }`.trim();
  }

  return `${documentLabel} has ${totalPrimaryQuantity} primary ${familyLabel.toLowerCase()} units across ${primaryCount} ${pluralizeFlexWord(
    primaryCount,
    "line"
  )}, totaling ${itemSearch.primaryTotalFormatted}.${
    hasRelated
      ? ` I also found ${relatedCount} related ${pluralizeFlexWord(
          relatedCount,
          "item"
        )} totaling ${itemSearch.relatedTotalFormatted}.`
      : ""
  }`;
}

function makeHumanLaborAnswer(documentLabel, items, laborTotal) {
  const count = Array.isArray(items) ? items.length : 0;

  if (!count) {
    return `${documentLabel}: I do not see any labor lines on this quote.`;
  }

  return `${documentLabel} has ${count} labor ${pluralizeFlexWord(
    count,
    "line"
  )} totaling ${formatUsd(laborTotal)}.`;
}

function makeHumanTransportationAnswer(documentLabel, items, transportationTotal) {
  const count = Array.isArray(items) ? items.length : 0;

  if (!count) {
    return `${documentLabel}: I do not see any transportation lines on this quote.`;
  }

  if (count === 1) {
    return `${documentLabel} has ${formatFlexItemOneLine(
      items[0]
    )} for transportation.`;
  }

  return `${documentLabel} has ${count} transportation ${pluralizeFlexWord(
    count,
    "line"
  )} totaling ${formatUsd(transportationTotal)}.`;
}

function makeHumanInventoryAnswer(documentLabel, detail, sections, inventoryTotal) {
  const itemCount = detail?.counts?.inventoryItems || 0;
  const sectionCount = Array.isArray(sections) ? sections.length : 0;

  if (!itemCount) {
    return `${documentLabel}: I do not see any rental inventory on this quote.`;
  }

  return `${documentLabel} has ${itemCount} rental inventory ${pluralizeFlexWord(
    itemCount,
    "item"
  )} across ${sectionCount} ${pluralizeFlexWord(
    sectionCount,
    "section"
  )}, totaling ${formatUsd(inventoryTotal)}.`;
}

function makeHumanTotalAnswer(documentLabel, invoiceTotal, categorySubtotal, balanceDue) {
  return `${documentLabel} is ${formatUsd(invoiceTotal)} total, with ${formatUsd(
    balanceDue || 0
  )} still due. The category subtotal before final invoice adjustments is ${formatUsd(
    categorySubtotal
  )}.`;
}



function classifyFlexMoneyQuestion(question) {
  const text = String(question || "").toLowerCase();

  if (/\b(is|is this|is it|paid in full|paid\?)\b/i.test(text) && /\bpaid\b/i.test(text)) {
    return "paid_status";
  }

  if (/\b(how much|what amount|amount|payments?|collected|received|deposit)\b/i.test(text) && /\b(paid|payment|payments|collected|received|deposit)\b/i.test(text)) {
    return "payments";
  }

  if (/\bpaid\b/i.test(text)) {
    return "paid_status";
  }

  if (/\b(balance|due|owed|outstanding|remaining)\b/i.test(text)) {
    return "balance";
  }

  if (/\b(open|closed|still open|outstanding)\b/i.test(text)) {
    return "open_status";
  }

  if (/\b(real revenue|revenue quote|real quote|placeholder|zero|0 quote|\$0)\b/i.test(text)) {
    return "revenue_signal";
  }

  if (/\b(category subtotal|subtotal|match|why.*total|adjustment|discount|invoice total source)\b/i.test(text)) {
    return "subtotal_vs_invoice";
  }

  return "money_summary";
}

function buildFlexMoneyAnswer(detail, question) {
  const showContext = detail?.showContext || {};
  const summary = detail?.summary || {};
  const financials = summary?.financials || {};
  const totals = summary?.totals || {};
  const moneyType = classifyFlexMoneyQuestion(question);

  const documentLabel = [
    showContext.documentNumber,
    showContext.showName,
  ]
    .filter(Boolean)
    .join(" — ");

  const invoiceTotal = Number(financials.invoiceTotal ?? totals.document ?? 0);
  const categorySubtotal = Number(financials.categorySubtotal ?? totals.document ?? 0);
  const totalAppliedPayments = Number(financials.totalAppliedPayments || 0);
  const balanceDue = Number(financials.balanceDue || 0);
  const discount = Number(financials.discount || 0);
  const additionalDiscount = Number(financials.additionalDiscount || 0);
  const salesTax = Number(financials.salesTax || 0);
  const creditCardFee = Number(financials.creditCardFee || 0);
  const invoiceTotalSource = financials.invoiceTotalSource || null;

  const isPaid = invoiceTotal > 0 && balanceDue <= 0;
  const hasPayments = totalAppliedPayments > 0;
  const isZeroPlaceholder = invoiceTotal === 0 && categorySubtotal === 0;
  const hasRevenueSignal = invoiceTotal > 0 || categorySubtotal > 0;
  const subtotalDelta = Math.round((categorySubtotal - invoiceTotal) * 100) / 100;

  const facts = {
    invoiceTotal,
    invoiceTotalFormatted: formatUsd(invoiceTotal),
    categorySubtotal,
    categorySubtotalFormatted: formatUsd(categorySubtotal),
    totalAppliedPayments,
    totalAppliedPaymentsFormatted: formatUsd(totalAppliedPayments),
    balanceDue,
    balanceDueFormatted: formatUsd(balanceDue),
    discount,
    discountFormatted: formatUsd(discount),
    additionalDiscount,
    additionalDiscountFormatted: formatUsd(additionalDiscount),
    salesTax,
    salesTaxFormatted: formatUsd(salesTax),
    creditCardFee,
    creditCardFeeFormatted: formatUsd(creditCardFee),
    invoiceTotalSource,
    isPaid,
    hasPayments,
    isZeroPlaceholder,
    hasRevenueSignal,
    subtotalDelta,
    subtotalDeltaFormatted: formatUsd(Math.abs(subtotalDelta)),
  };

  if (moneyType === "paid_status") {
    return {
      headline: "Paid Status",
      moneyType,
      answer: isPaid
        ? `Yes — ${documentLabel} appears to be paid in full.`
        : `No — ${documentLabel} does not appear to be paid yet. Balance due is ${facts.balanceDueFormatted}.`,
      facts,
    };
  }

  if (moneyType === "payments") {
    return {
      headline: "Payments",
      moneyType,
      answer: hasPayments
        ? `${documentLabel} has ${facts.totalAppliedPaymentsFormatted} in applied payments. Balance due is ${facts.balanceDueFormatted}.`
        : `${documentLabel} does not show any applied payments yet. Balance due is ${facts.balanceDueFormatted}.`,
      facts,
    };
  }

  if (moneyType === "balance") {
    return {
      headline: "Balance Due",
      moneyType,
      answer: isPaid
        ? `${documentLabel} is paid in full.`
        : `${documentLabel} has ${facts.balanceDueFormatted} still due against a ${facts.invoiceTotalFormatted} invoice total.`,
      facts,
    };
  }

  if (moneyType === "open_status") {
    return {
      headline: "Open Balance",
      moneyType,
      answer: balanceDue > 0
        ? `${documentLabel} still appears financially open, with ${facts.balanceDueFormatted} due.`
        : `${documentLabel} does not show an open balance.`,
      facts,
    };
  }

  if (moneyType === "revenue_signal") {
    return {
      headline: "Revenue Signal",
      moneyType,
      answer: isZeroPlaceholder
        ? `${documentLabel} looks like a $0 placeholder from the financial fields I can see.`
        : `${documentLabel} looks like a revenue quote: invoice total is ${facts.invoiceTotalFormatted}, category subtotal is ${facts.categorySubtotalFormatted}, and balance due is ${facts.balanceDueFormatted}.`,
      facts,
    };
  }

  if (moneyType === "subtotal_vs_invoice") {
    let reason = "The category subtotal and invoice total match.";

    if (subtotalDelta > 0) {
      reason = `The category subtotal is ${facts.subtotalDeltaFormatted} higher than the invoice total, which usually means a final discount, adjustment, package price, or other invoice-level change was applied.`;
    } else if (subtotalDelta < 0) {
      reason = `The invoice total is ${facts.subtotalDeltaFormatted} higher than the category subtotal, which usually means tax, fees, or another invoice-level charge was added.`;
    }

    return {
      headline: "Subtotal vs Invoice Total",
      moneyType,
      answer: `${documentLabel}: ${reason}`,
      facts,
    };
  }

  return {
    headline: "Money Summary",
    moneyType,
    answer: `${documentLabel} is ${facts.invoiceTotalFormatted} total. ${facts.totalAppliedPaymentsFormatted} has been applied, leaving ${facts.balanceDueFormatted} due.`,
    facts,
  };
}



function classifyFlexSectionQuestion(question) {
  const text = String(question || "").toLowerCase();

  if (/\b(operational summary|ops summary|operation summary|quick summary|quick overview|overview|summarize|summary)\b/i.test(text)) {
    return "operational_summary";
  }

  if (/\b(sections?|categories|category breakdown|breakdown|departments?|dept|video vs|audio vs|lighting vs|truss vs|power vs)\b/i.test(text)) {
    return "section_breakdown";
  }

  return "section_breakdown";
}


function buildSectionTotalAudit(section) {
  const lines = Array.isArray(section?.lines) ? section.lines : [];
  const visibleLineTotal = lines.reduce(
    (sum, item) => sum + Number(item.priceExtended || 0),
    0
  );
  const officialSectionTotal = Number(section?.total || 0);
  const delta = Math.round((visibleLineTotal - officialSectionTotal) * 100) / 100;

  return {
    visibleLineTotal: Math.round(visibleLineTotal * 100) / 100,
    visibleLineTotalFormatted: formatUsd(visibleLineTotal),
    officialSectionTotal,
    officialSectionTotalFormatted: formatUsd(officialSectionTotal),
    delta,
    deltaFormatted: formatUsd(Math.abs(delta)),
    hasMismatch: Math.abs(delta) >= 0.01,
  };
}


function buildFlexSectionSummary(detail, question) {
  const showContext = detail?.showContext || {};
  const summary = detail?.summary || {};
  const totals = summary?.totals || {};
  const financials = summary?.financials || {};
  const sectionType = classifyFlexSectionQuestion(question);

  const documentLabel = [
    showContext.documentNumber,
    showContext.showName,
  ]
    .filter(Boolean)
    .join(" — ");

  const sections = (Array.isArray(detail.sections) ? detail.sections : []).map((section) => {
    const mapped = {
      name: section.name,
      category: section.category,
      total: Number(section.total || 0),
      totalFormatted: formatUsd(section.total || 0),
      itemCount: section.itemCount || 0,
      lines: summarizeItemsForAnswer(section.items, 100),
    };

    return {
      ...mapped,
      totalAudit: buildSectionTotalAudit(mapped),
    };
  });

  const billableSections = sections.filter((section) => Number(section.total || 0) !== 0 || section.itemCount > 0);
  const rentalSections = sections.filter(
    (section) =>
      section.category === "rental" &&
      !/labor|transport/i.test(String(section.name || ""))
  );
  const laborSections = sections.filter(
    (section) => section.category === "labor" || /labor/i.test(String(section.name || ""))
  );
  const transportationSections = sections.filter(
    (section) =>
      section.category === "transportation" || /transport/i.test(String(section.name || ""))
  );

  const topSections = [...billableSections]
    .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 6);

  const sectionsWithTotalMismatches = sections.filter(
    (section) => section.totalAudit?.hasMismatch
  );

  const facts = {
    invoiceTotal: financials.invoiceTotal || totals.document || 0,
    invoiceTotalFormatted: formatUsd(financials.invoiceTotal || totals.document || 0),
    categorySubtotal: financials.categorySubtotal || totals.document || 0,
    categorySubtotalFormatted: formatUsd(financials.categorySubtotal || totals.document || 0),
    rentalTotal: totals.rental || 0,
    rentalTotalFormatted: formatUsd(totals.rental || 0),
    laborTotal: totals.labor || 0,
    laborTotalFormatted: formatUsd(totals.labor || 0),
    transportationTotal: totals.transportation || 0,
    transportationTotalFormatted: formatUsd(totals.transportation || 0),
    sectionCount: sections.length,
    rentalSectionCount: rentalSections.length,
    inventoryItemCount: detail?.counts?.inventoryItems || 0,
    laborItemCount: detail?.counts?.laborItems || 0,
    transportationItemCount: detail?.counts?.transportationItems || 0,
    sectionsWithTotalMismatchCount: sectionsWithTotalMismatches.length,
    hasSectionTotalMismatches: sectionsWithTotalMismatches.length > 0,
  };

  const sectionTotalNote = sectionsWithTotalMismatches.length
    ? ` Note: ${sectionsWithTotalMismatches.length} section ${pluralizeFlexWord(
        sectionsWithTotalMismatches.length,
        "total does",
        "totals do"
      )} not match the visible line-item sum, so I am using FLEX section totals as the official section numbers.`
    : "";

  if (sectionType === "operational_summary") {
    const topSectionText = topSections
      .slice(0, 3)
      .map((section) => `${section.name} ${section.totalFormatted}`)
      .join(", ");

    return {
      headline: "Operational Summary",
      sectionType,
      answer: `${documentLabel}: ${facts.invoiceTotalFormatted} total with ${facts.inventoryItemCount} rental inventory ${pluralizeFlexWord(
        facts.inventoryItemCount,
        "item"
      )}, ${facts.laborItemCount} labor ${pluralizeFlexWord(
        facts.laborItemCount,
        "line"
      )}, and ${facts.transportationItemCount} transportation ${pluralizeFlexWord(
        facts.transportationItemCount,
        "line"
      )}.${topSectionText ? ` Biggest sections: ${topSectionText}.` : ""}${sectionTotalNote}`,
      facts,
      sections,
      topSections,
      rentalSections,
      laborSections,
      transportationSections,
    };
  }

  return {
    headline: "Section Breakdown",
    sectionType,
    answer: `${documentLabel} has ${sections.length} ${pluralizeFlexWord(
      sections.length,
      "section"
    )}. Rental totals ${facts.rentalTotalFormatted}, labor totals ${facts.laborTotalFormatted}, and transportation totals ${facts.transportationTotalFormatted}.${sectionTotalNote}`,
    facts,
    sections,
    topSections,
    rentalSections,
    laborSections,
    transportationSections,
  };
}


function buildFlexAskAnswer(intent, detail, question) {
  const showContext = detail?.showContext || {};
  const summary = detail?.summary || {};
  const totals = summary?.totals || {};
  const financials = summary?.financials || {};

  const documentLabel = [
    showContext.documentNumber,
    showContext.showName,
  ]
    .filter(Boolean)
    .join(" — ");

  if (intent === "document_money") {
    return buildFlexMoneyAnswer(detail, question);
  }

  if (intent === "document_context") {
    return buildFlexContextAnswer(detail, question);
  }

  if (intent === "document_sections") {
    return buildFlexSectionSummary(detail, question);
  }

  if (intent === "document_labor") {
    const laborSection = getSectionByCategoryOrName(detail, "labor", /labor/i);
    const laborTotal = laborSection?.total ?? totals.labor ?? 0;
    const items = summarizeItemsForAnswer(detail.laborItems, 50);

    return {
      answer: makeHumanLaborAnswer(documentLabel, items, laborTotal),
      headline: "Labor",
      total: laborTotal,
      totalFormatted: formatUsd(laborTotal),
      items,
    };
  }

  if (intent === "document_transportation") {
    const transportationSection = getSectionByCategoryOrName(
      detail,
      "transportation",
      /transport/i
    );
    const transportationTotal =
      transportationSection?.total ?? totals.transportation ?? 0;
    const items = summarizeItemsForAnswer(detail.transportationItems, 50);

    return {
      answer: makeHumanTransportationAnswer(
        documentLabel,
        items,
        transportationTotal
      ),
      headline: "Transportation",
      total: transportationTotal,
      totalFormatted: formatUsd(transportationTotal),
      items,
    };
  }

  if (intent === "document_item_search") {
    const itemSearch = buildFlexSmartItemSearch(detail, question);
    const primaryText =
      itemSearch.primaryCount === 1
        ? "1 primary match"
        : `${itemSearch.primaryCount} primary matches`;
    const relatedText =
      itemSearch.relatedCount === 1
        ? "1 related match"
        : `${itemSearch.relatedCount} related matches`;

    const answer = makeHumanItemSearchAnswer(documentLabel, itemSearch);

    return {
      answer,
      headline: itemSearch.familyLabel,
      itemSearch,
      total: itemSearch.primaryTotal,
      totalFormatted: itemSearch.primaryTotalFormatted,
      items: itemSearch.primaryMatches,
      relatedItems: itemSearch.relatedMatches,
    };
  }

  if (intent === "document_inventory") {
    const sections = (Array.isArray(detail.sections) ? detail.sections : [])
      .filter(
        (section) =>
          section.category === "rental" &&
          !/labor|transport/i.test(String(section.name || ""))
      )
      .map((section) => ({
        name: section.name,
        total: section.total,
        totalFormatted: formatUsd(section.total),
        itemCount: section.itemCount,
        items: summarizeItemsForAnswer(section.items, 50),
      }));

    const inventoryTotal = sections.reduce(
      (sum, section) => sum + Number(section.total || 0),
      0
    );

    return {
      answer: makeHumanInventoryAnswer(
        documentLabel,
        detail,
        sections,
        inventoryTotal
      ),
      headline: "Inventory",
      total: Math.round(inventoryTotal * 100) / 100,
      totalFormatted: formatUsd(inventoryTotal),
      sections,
    };
  }

  if (intent === "document_total") {
    const invoiceTotal = financials.invoiceTotal ?? totals.document ?? 0;
    const categorySubtotal = financials.categorySubtotal ?? totals.document ?? 0;

    return {
      answer: makeHumanTotalAnswer(
        documentLabel,
        invoiceTotal,
        categorySubtotal,
        financials.balanceDue || 0
      ),
      headline: "Quote Total",
      invoiceTotal,
      invoiceTotalFormatted: formatUsd(invoiceTotal),
      categorySubtotal,
      categorySubtotalFormatted: formatUsd(categorySubtotal),
      balanceDue: financials.balanceDue || 0,
      balanceDueFormatted: formatUsd(financials.balanceDue || 0),
      invoiceTotalSource: financials.invoiceTotalSource || null,
      categoryBreakdown: {
        rental: totals.rental || 0,
        rentalFormatted: formatUsd(totals.rental || 0),
        labor: totals.labor || 0,
        laborFormatted: formatUsd(totals.labor || 0),
        transportation: totals.transportation || 0,
        transportationFormatted: formatUsd(totals.transportation || 0),
        other: totals.other || 0,
        otherFormatted: formatUsd(totals.other || 0),
      },
    };
  }

  return {
    answer: `${documentLabel} is ${formatUsd(
      financials.invoiceTotal || totals.document || 0
    )} total: ${formatUsd(totals.rental || 0)} rental, ${formatUsd(
      totals.labor || 0
    )} labor, and ${formatUsd(totals.transportation || 0)} transportation.`,
    headline: "Document Summary",
    totals,
    financials,
    counts: detail.counts,
  };
}


function buildFlexAskBriefPayload(fullResult) {
  const result = fullResult?.result || {};
  const showContext = fullResult?.showContext || {};
  const summary = fullResult?.supportingData?.summary || {};
  const financials = summary?.financials || {};
  const totals = summary?.totals || {};

  const payload = {
    question: fullResult?.question || null,
    intent: fullResult?.intent || null,
    documentNumber: fullResult?.documentNumber || showContext?.documentNumber || null,
    elementId: fullResult?.elementId || null,
    showName: showContext?.showName || null,
    client: showContext?.client || null,
    venue: showContext?.venue || null,
    plannedStartDate: showContext?.plannedStartDate || null,
    answer: fullResult?.answer || result?.answer || "",
    headline: result?.headline || null,
    warnings: summary?.warnings || [],
    cueBuildId: CUE_BUILD_ID,
    cueBuildBranch: CUE_BUILD_BRANCH,
    cueBuildLabel: CUE_BUILD_LABEL,
  };

  if (fullResult?.needsSelection) {
    payload.needsSelection = true;
    payload.searchQuery = fullResult.searchQuery || null;
    payload.filters = fullResult.filters || null;
    payload.filterDescriptions = fullResult.filterDescriptions || [];
    payload.search = fullResult.search || null;
    payload.matches = Array.isArray(fullResult.matches) ? fullResult.matches : [];
    payload.matchCount = payload.matches.length;
    payload.initialDisplayCount = fullResult.initialDisplayCount || 5;
    payload.hasMoreMatches =
      fullResult.hasMoreMatches != null
        ? Boolean(fullResult.hasMoreMatches)
        : payload.matches.length > payload.initialDisplayCount;
    payload.headline = "Choose a FLEX Quote";
    payload.lines = payload.matches.map((match) => ({
      text: `${match.index}. ${match.documentNumber || "No quote #"} — ${match.name || "Untitled"} — ${match.client || "No client"} — ${match.invoiceTotalFormatted || "$0.00"}`,
      index: match.index,
      documentNumber: match.documentNumber,
      elementId: match.elementId,
      name: match.name,
      client: match.client,
      venue: match.venue,
      plannedStartDate: match.plannedStartDate,
      invoiceTotal: match.invoiceTotal,
      invoiceTotalFormatted: match.invoiceTotalFormatted,
      balanceDue: match.balanceDue,
      balanceDueFormatted: match.balanceDueFormatted,
      searchRank: match.searchRank,
    }));
    return payload;
  }

  if (fullResult?.needsClarification) {
    payload.needsClarification = true;
    payload.lines = [];
    return payload;
  }

  if (fullResult?.intent === "document_compare") {
    payload.documents = result.documents || null;
    payload.comparisonType = result.comparisonType || null;
    payload.financialRows = result.financialRows || [];
    payload.sectionRows = result.sectionRows || [];
    payload.itemRows = result.itemRows || [];
    payload.counts = result.counts || {};
    payload.lines = (result.sectionRows || []).slice(0, 10).map((row) => ({
      text: `${row.name} — ${row.aFormatted} → ${row.bFormatted} (${row.deltaFormatted})`,
      name: row.name,
      a: row.a,
      aFormatted: row.aFormatted,
      b: row.b,
      bFormatted: row.bFormatted,
      delta: row.delta,
      deltaFormatted: row.deltaFormatted,
      category: row.category,
    }));
    return payload;
  }

  if (fullResult?.intent === "document_operational_analysis") {
    payload.headline = result.headline || "Operational Review";
    payload.answer = fullResult?.answer || result.assessment || "";
    payload.assessment = result.assessment || payload.answer;
    payload.complexityLevel = result.complexityLevel || null;
    payload.readinessStatus = result.readinessStatus || null;
    payload.coordinationRequired = Array.isArray(result.coordinationRequired)
      ? result.coordinationRequired
      : [];
    payload.showSummary = result.showSummary || null;
    payload.labor = result.labor || null;
    payload.trucking = result.trucking || null;
    payload.equipment = result.equipment || null;
    payload.warehouse = result.warehouse || null;
    payload.commercial = result.commercial || null;
    payload.redFlags = Array.isArray(result.redFlags) ? result.redFlags : [];
    payload.needsConfirmation = Array.isArray(result.needsConfirmation)
      ? result.needsConfirmation
      : Array.isArray(result.questionsForPm)
        ? result.questionsForPm
        : [];
    payload.questionsForPm = payload.needsConfirmation;
    payload.recommendedNextActions = Array.isArray(result.recommendedNextActions)
      ? result.recommendedNextActions
      : [];
    payload.confidence = result.confidence || null;
    payload.assumptions = Array.isArray(result.assumptions) ? result.assumptions : [];
    payload.source = result.source || null;
    payload.lines = (payload.recommendedNextActions || []).slice(0, 8).map((action) => ({
      text: String(action),
    }));
    return payload;
  }

  if (fullResult?.intent === "show_operational_followup") {
    payload.headline = fullResult.headline || "Follow-up";
    payload.showName = fullResult.showName || null;
    payload.found = fullResult.found !== false;
    payload.answer = fullResult.answer || "";
    payload.followupType = fullResult.followupType || null;
    payload.sourceReviewTimestamp = fullResult.sourceReviewTimestamp || null;
    payload.usedStoredReview = Boolean(fullResult.usedStoredReview);
    payload.refreshRequired = Boolean(fullResult.refreshRequired);
    payload.refreshed = Boolean(fullResult.refreshed);
    payload.refreshNote = fullResult.refreshNote || null;
    payload.items = Array.isArray(fullResult.items) ? fullResult.items : [];
    payload.supportingData = fullResult.supportingData || null;
    payload.overallStatus = fullResult.supportingData?.overallStatus || null;
    payload.complexityLevel = fullResult.supportingData?.complexityLevel || null;
    payload.confidence = fullResult.supportingData?.confidence || null;
    payload.sourceCoverage = Array.isArray(fullResult.supportingData?.sourceCoverage)
      ? fullResult.supportingData.sourceCoverage
      : [];
    payload.needsClarification = Boolean(fullResult.needsClarification);
    payload.refreshedReview = fullResult.refreshedReview || null;
    payload.changeComparison = fullResult.changeComparison || null;
    payload.reviewHistory = Array.isArray(fullResult.reviewHistory)
      ? fullResult.reviewHistory
      : null;
    payload.snapshot = fullResult.snapshot || null;
    payload.usedPersistedSnapshots = Boolean(fullResult.usedPersistedSnapshots);
    payload.lines = (payload.items || []).slice(0, 5).map((item) => ({
      text: [item.finding, item.action].filter(Boolean).join(" — "),
      area: item.area || null,
      owner: item.owner || null,
      evidence: item.evidence || null,
    }));
    return payload;
  }

  if (fullResult?.intent === "show_operational_analysis") {
    payload.headline = result.headline || "Full Show Operational Review";
    payload.scopeLabel = result.scopeLabel || "CUE Full Show Review";
    payload.showName = fullResult?.showName || result.showSummary?.showName || null;
    payload.found = fullResult?.found !== false;
    payload.answer = fullResult?.answer || result.assessment || "";
    payload.assessment = result.assessment || payload.answer;
    payload.overallStatus = result.overallStatus || null;
    payload.statusReason = result.statusReason || null;
    payload.complexityLevel = result.complexityLevel || null;
    payload.confidence = result.confidence || null;
    payload.sourceCoverage = Array.isArray(result.sourceCoverage)
      ? result.sourceCoverage
      : Array.isArray(fullResult?.sourceCoverage)
        ? fullResult.sourceCoverage
        : [];
    payload.showSummary = result.showSummary || null;
    payload.relatedWorkstreams = Array.isArray(result.showSummary?.relatedWorkstreams)
      ? result.showSummary.relatedWorkstreams
      : Array.isArray(result.flexScope?.relatedWorkstreams)
        ? result.flexScope.relatedWorkstreams
        : [];
    payload.flexScope = result.flexScope || null;
    payload.truckingExecution = result.truckingExecution || null;
    payload.staffing = result.staffing || null;
    payload.warehouse = result.warehouse || null;
    payload.crossSourceFindings = Array.isArray(result.crossSourceFindings)
      ? result.crossSourceFindings
      : [];
    payload.confirmedIssues = Array.isArray(result.confirmedIssues)
      ? result.confirmedIssues
      : [];
    payload.needsConfirmation = Array.isArray(result.needsConfirmation)
      ? result.needsConfirmation
      : [];
    payload.coverageGaps = Array.isArray(result.coverageGaps) ? result.coverageGaps : [];
    payload.recommendedNextActions = Array.isArray(result.recommendedNextActions)
      ? result.recommendedNextActions.slice(0, 5)
      : [];
    payload.assumptions = Array.isArray(result.assumptions) ? result.assumptions : [];
    payload.source = result.source || null;
    payload.supportingData = fullResult?.supportingData || null;
    payload.snapshot = fullResult?.snapshot || null;
    payload.slack = result.slack || fullResult?.result?.slack || null;
    payload.lines = (payload.recommendedNextActions || []).slice(0, 5).map((action) => ({
      text: String(action),
    }));
    return payload;
  }

  if (fullResult?.intent === "document_sections") {
    payload.sectionType = result.sectionType || null;
    payload.facts = result.facts || {};
    payload.total = result.facts?.invoiceTotal || 0;
    payload.totalFormatted = result.facts?.invoiceTotalFormatted || formatUsd(0);
    payload.sections = (result.sections || []).map((section) => ({
      name: section.name,
      category: section.category,
      total: section.total,
      totalFormatted: section.totalFormatted,
      itemCount: section.itemCount,
      totalAudit: section.totalAudit || null,
      lines: (section.lines || []).map((item) => ({
        text: `${item.name} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
        name: item.name,
        quantity: item.quantity,
        timeQty: item.timeQty,
        priceExtended: item.priceExtended,
        priceExtendedFormatted: item.priceExtendedFormatted,
      })),
    }));
    payload.topSections = result.topSections || [];
    payload.lines = (result.topSections || []).map((section) => ({
      text: `${section.name} — ${section.itemCount} item(s) — ${section.totalFormatted}`,
      name: section.name,
      itemCount: section.itemCount,
      total: section.total,
      totalFormatted: section.totalFormatted,
      category: section.category,
    }));
    return payload;
  }

  if (fullResult?.intent === "document_money") {
    payload.moneyType = result.moneyType || null;
    payload.facts = result.facts || {};
    payload.lines = [
      {
        label: "Invoice total",
        value: result.facts?.invoiceTotalFormatted || "$0.00",
      },
      {
        label: "Category subtotal",
        value: result.facts?.categorySubtotalFormatted || "$0.00",
      },
      {
        label: "Applied payments",
        value: result.facts?.totalAppliedPaymentsFormatted || "$0.00",
      },
      {
        label: "Balance due",
        value: result.facts?.balanceDueFormatted || "$0.00",
      },
      {
        label: "Paid in full",
        value: result.facts?.isPaid ? "Yes" : "No",
      },
      {
        label: "Revenue signal",
        value: result.facts?.hasRevenueSignal ? "Yes" : "No / $0 placeholder",
      },
      {
        label: "Invoice total source",
        value: result.facts?.invoiceTotalSource || "FLEX header / calculated fields",
      },
    ];
    return payload;
  }

  if (fullResult?.intent === "document_context") {
    payload.contextType = result.contextType || null;
    payload.facts = result.facts || {};
    payload.lines = [
      {
        label: "Person responsible",
        value: result.facts?.personResponsible || "Not assigned",
      },
      {
        label: "Project manager",
        value: result.facts?.projectManager || "Not assigned",
      },
      {
        label: "Client",
        value: result.facts?.client || "Not listed",
      },
      {
        label: "Venue",
        value: result.facts?.venue || "Not listed",
      },
      {
        label: "Planned start",
        value: result.facts?.plannedStartFormatted || "Not listed",
      },
      {
        label: "Planned end",
        value: result.facts?.plannedEndFormatted || "Not listed",
      },
      {
        label: "Load in",
        value: result.facts?.loadInFormatted || "Not listed",
      },
      {
        label: "Load out",
        value: result.facts?.loadOutFormatted || "Not listed",
      },
    ];
    return payload;
  }

  if (fullResult?.intent === "document_item_search") {
    payload.total = result.total || 0;
    payload.totalFormatted = result.totalFormatted || formatUsd(result.total || 0);
    payload.itemSearch = result.itemSearch || null;
    payload.lines = (result.items || []).map((item) => ({
      text: `${item.name} — ${item.sectionName || "Inventory"} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
      name: item.name,
      sectionName: item.sectionName,
      quantity: item.quantity,
      timeQty: item.timeQty,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: item.priceExtendedFormatted,
      matchType: item.matchType,
      matchScore: item.matchScore,
    }));
    payload.relatedLines = (result.relatedItems || []).map((item) => ({
      text: `${item.name} — ${item.sectionName || "Inventory"} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
      name: item.name,
      sectionName: item.sectionName,
      quantity: item.quantity,
      timeQty: item.timeQty,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: item.priceExtendedFormatted,
      matchType: item.matchType,
      matchScore: item.matchScore,
    }));
    return payload;
  }

  if (fullResult?.intent === "document_labor") {
    payload.total = result.total || 0;
    payload.totalFormatted = result.totalFormatted || formatUsd(result.total || 0);
    payload.lines = (result.items || []).map((item) => ({
      text: `${item.name} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
      name: item.name,
      quantity: item.quantity,
      timeQty: item.timeQty,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: item.priceExtendedFormatted,
    }));
    return payload;
  }

  if (fullResult?.intent === "document_transportation") {
    payload.total = result.total || 0;
    payload.totalFormatted = result.totalFormatted || formatUsd(result.total || 0);
    payload.lines = (result.items || []).map((item) => ({
      text: `${item.name} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
      name: item.name,
      quantity: item.quantity,
      timeQty: item.timeQty,
      priceExtended: item.priceExtended,
      priceExtendedFormatted: item.priceExtendedFormatted,
    }));
    return payload;
  }

  if (fullResult?.intent === "document_inventory") {
    payload.total = result.total || 0;
    payload.totalFormatted = result.totalFormatted || formatUsd(result.total || 0);
    payload.sections = (result.sections || []).map((section) => ({
      name: section.name,
      total: section.total,
      totalFormatted: section.totalFormatted,
      itemCount: section.itemCount,
      lines: (section.items || []).map((item) => ({
        text: `${item.name} — Qty ${item.quantity}, Time Qty ${item.timeQty} — ${item.priceExtendedFormatted}`,
        name: item.name,
        quantity: item.quantity,
        timeQty: item.timeQty,
        priceExtended: item.priceExtended,
        priceExtendedFormatted: item.priceExtendedFormatted,
        lineMute: item.lineMute,
      })),
    }));
    return payload;
  }

  if (fullResult?.intent === "document_total") {
    payload.invoiceTotal = result.invoiceTotal || financials.invoiceTotal || 0;
    payload.invoiceTotalFormatted =
      result.invoiceTotalFormatted || formatUsd(payload.invoiceTotal);
    payload.categorySubtotal =
      result.categorySubtotal || financials.categorySubtotal || totals.document || 0;
    payload.categorySubtotalFormatted =
      result.categorySubtotalFormatted || formatUsd(payload.categorySubtotal);
    payload.balanceDue = result.balanceDue || financials.balanceDue || 0;
    payload.balanceDueFormatted =
      result.balanceDueFormatted || formatUsd(payload.balanceDue);
    payload.invoiceTotalSource = result.invoiceTotalSource || financials.invoiceTotalSource || null;
    payload.categoryBreakdown = result.categoryBreakdown || {
      rental: totals.rental || 0,
      rentalFormatted: formatUsd(totals.rental || 0),
      labor: totals.labor || 0,
      laborFormatted: formatUsd(totals.labor || 0),
      transportation: totals.transportation || 0,
      transportationFormatted: formatUsd(totals.transportation || 0),
      other: totals.other || 0,
      otherFormatted: formatUsd(totals.other || 0),
    };
    return payload;
  }

  payload.totals = totals;
  payload.financials = financials;
  payload.counts = fullResult?.supportingData?.counts || null;
  return payload;
}


function extractQuoteSearchQueryFromQuestion(question) {
  let text = String(question || "").trim();

  // Remove quote-number patterns if present.
  text = text.replace(/\b\d{2}-\d{3,6}\b/g, " ");

  // Remove common question / intent words while leaving the likely quote name.
  const removePatterns = [
    /\bwhat\b/gi,
    /\bwhat's\b/gi,
    /\bwho\b/gi,
    /\bwhose\b/gi,
    /\bshow\b/gi,
    /\bme\b/gi,
    /\bgive\b/gi,
    /\btell\b/gi,
    /\bfind\b/gi,
    /\blook\b/gi,
    /\bup\b/gi,
    /\bsearch\b/gi,
    /\bfor\b/gi,
    /\bthe\b/gi,
    /\ba\b/gi,
    /\ban\b/gi,
    /\bon\b/gi,
    /\bin\b/gi,
    /\bof\b/gi,
    /\bis\b/gi,
    /\bare\b/gi,
    /\bthere\b/gi,
    /\bany\b/gi,
    /\bto\b/gi,
    /\bassigned\b/gi,
    /\bquote\b/gi,
    /\bjob\b/gi,
    /\bshow\b/gi,
    /\bdocument\b/gi,
    /\bflex\b/gi,
    /\blabor\b/gi,
    /\bcrew\b/gi,
    /\bstaffing\b/gi,
    /\btechs?\b/gi,
    /\btechnicians?\b/gi,
    /\binventory\b/gi,
    /\bgear\b/gi,
    /\bequipment\b/gi,
    /\brentals?\b/gi,
    /\bitems?\b/gi,
    /\btransportation\b/gi,
    /\btransport\b/gi,
    /\btrucking\b/gi,
    /\btrucks?\b/gi,
    /\bdelivery\b/gi,
    /\bpickup\b/gi,
    /\btotal\b/gi,
    /\bprice\b/gi,
    /\bcost\b/gi,
    /\bamount\b/gi,
    /\bbalance\b/gi,
    /\bsummary\b/gi,
    /\babout\b/gi,
    /\bfull\b/gi,
    /\bwhole\b/gi,
    /\bentire\b/gi,
    /\bcross[- ]source\b/gi,
    /\boverall\b/gi,
    /\breal\b/gi,
    /\boperational\b/gi,
    /\breview\b/gi,
    /\banalysis\b/gi,
    /\banalyze\b/gi,
    /\bpicture\b/gi,
    /\brisks?\b/gi,
    /\bcue\b/gi,
    /\brelated\b/gi,
    /\bsources?\b/gi,
    /\bconnected\b/gi,
    /\bacross\b/gi,

    // Context-question intent words. These should not pollute quote-name search.
    /\bowner\b/gi,
    /\bowns\b/gi,
    /\bresponsible\b/gi,
    /\bperson responsible\b/gi,
    /\bsalesperson\b/gi,
    /\bsales person\b/gi,
    /\baccount manager\b/gi,
    /\bpm\b/gi,
    /\bproject manager\b/gi,
    /\bclient\b/gi,
    /\bcustomer\b/gi,
    /\bvenue\b/gi,
    /\bwhere\b/gi,
    /\blocation\b/gi,
    /\bsite\b/gi,
    /\bdate\b/gi,
    /\bdates\b/gi,
    /\bwhen\b/gi,
    /\bschedule\b/gi,
    /\btimeline\b/gi,
    /\bload[- ]?in\b/gi,
    /\bload[- ]?out\b/gi,
    /\bloadin\b/gi,
    /\bloadout\b/gi,
    /\bstrike\b/gi,
    /\bplanned start\b/gi,
    /\bplanned end\b/gi,
  ];

  for (const pattern of removePatterns) {
    text = text.replace(pattern, " ");
  }

  text = text
    .replace(/[?!.:,;()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}



function parseFlexSearchFilters(questionOrQuery, options = {}) {
  const text = String(questionOrQuery || "").toLowerCase();
  const filters = {
    year: options.year ? Number(options.year) : null,
    quoteOnly: Boolean(options.quoteOnly || options.excludeInvoices),
    invoiceOnly: Boolean(options.invoiceOnly),
    currentOnly: Boolean(options.currentOnly),
    futureOnly: Boolean(options.futureOnly),
    openOnly: Boolean(options.openOnly),
    paidOnly: Boolean(options.paidOnly),
    revenueOnly: Boolean(options.revenueOnly),
    includeInvoices: options.includeInvoices != null ? Boolean(options.includeInvoices) : true,
  };

  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (!filters.year && yearMatch) {
    filters.year = Number(yearMatch[1]);
  }

  if (/\b(no invoices|don't show invoices|do not show invoices|hide invoices|exclude invoices|quotes only|only quotes|quote only)\b/i.test(text)) {
    filters.quoteOnly = true;
    filters.includeInvoices = false;
  }

  if (/\b(only invoices|invoice only|invoices only|show invoices)\b/i.test(text)) {
    filters.invoiceOnly = true;
    filters.quoteOnly = false;
    filters.includeInvoices = true;
  }

  if (/\b(current|active|open\/current|current\/open|recent)\b/i.test(text)) {
    filters.currentOnly = true;
  }

  if (/\b(future|upcoming)\b/i.test(text)) {
    filters.futureOnly = true;
  }

  if (/\b(open|outstanding|balance due|unpaid)\b/i.test(text)) {
    filters.openOnly = true;
  }

  if (/\b(paid|paid in full|closed)\b/i.test(text)) {
    filters.paidOnly = true;
  }

  if (/\b(real revenue|revenue quote|over \$0|greater than \$0|not \$0|nonzero|non-zero)\b/i.test(text)) {
    filters.revenueOnly = true;
  }

  return filters;
}

function flexSearchFiltersAreActive(filters) {
  if (!filters) return false;

  return Boolean(
    filters.year ||
      filters.quoteOnly ||
      filters.invoiceOnly ||
      filters.currentOnly ||
      filters.futureOnly ||
      filters.openOnly ||
      filters.paidOnly ||
      filters.revenueOnly ||
      filters.includeInvoices === false
  );
}

function matchPassesFlexSearchFilters(match, filters) {
  if (!filters) return true;

  const doc = String(match?.documentNumber || "");
  const isInvoice = /^INV-/i.test(doc);
  const isQuote = /^\d{2}-\d{3,6}$/i.test(doc);
  const plannedTime = getDateTimestamp(match?.plannedStartDate);
  const plannedYear = plannedTime ? new Date(plannedTime).getFullYear() : null;
  const now = Date.now();

  if (filters.quoteOnly && !isQuote) return false;
  if (filters.includeInvoices === false && isInvoice) return false;
  if (filters.invoiceOnly && !isInvoice) return false;
  if (filters.year && plannedYear !== Number(filters.year)) return false;
  if (filters.futureOnly && (!plannedTime || plannedTime < now)) return false;

  if (filters.currentOnly) {
    // "Current" is intentionally broad: current-era jobs, not old archive noise.
    const jan2025 = Date.UTC(2025, 0, 1);
    if (!plannedTime || plannedTime < jan2025) return false;
  }

  if (filters.openOnly && !(Number(match?.balanceDue || 0) > 0)) return false;
  if (filters.paidOnly && !(Number(match?.balanceDue || 0) <= 0 && Number(match?.invoiceTotal || 0) > 0)) return false;
  if (filters.revenueOnly && !(Number(match?.invoiceTotal || 0) > 0 || Number(match?.categorySubtotal || 0) > 0)) return false;

  return true;
}

function describeFlexSearchFilters(filters) {
  if (!filters || !flexSearchFiltersAreActive(filters)) return [];

  const descriptions = [];

  if (filters.year) descriptions.push(`${filters.year}`);
  if (filters.quoteOnly || filters.includeInvoices === false) descriptions.push("quotes only");
  if (filters.invoiceOnly) descriptions.push("invoices only");
  if (filters.currentOnly) descriptions.push("current/recent");
  if (filters.futureOnly) descriptions.push("future/upcoming");
  if (filters.openOnly) descriptions.push("open balance");
  if (filters.paidOnly) descriptions.push("paid");
  if (filters.revenueOnly) descriptions.push("revenue > $0");

  return descriptions;
}

function removeFilterWordsFromQuoteSearchQuery(value) {
  let text = String(value || "");

  const patterns = [
    /\bshow\b/gi,
    /\bonly\b/gi,
    /\bcurrent\b/gi,
    /\bactive\b/gi,
    /\brecent\b/gi,
    /\bfuture\b/gi,
    /\bupcoming\b/gi,
    /\bopen\b/gi,
    /\bpaid\b/gi,
    /\bunpaid\b/gi,
    /\boutstanding\b/gi,
    /\bbalance due\b/gi,
    /\bquotes?\b/gi,
    /\binvoices?\b/gi,
    /\bdon't show invoices\b/gi,
    /\bdo not show invoices\b/gi,
    /\bhide invoices\b/gi,
    /\bexclude invoices\b/gi,
    /\bno invoices\b/gi,
    /\bquotes only\b/gi,
    /\bonly quotes\b/gi,
    /\binvoices only\b/gi,
    /\bonly invoices\b/gi,
    /\breal revenue\b/gi,
    /\brevenue quote\b/gi,
    /\bover \$0\b/gi,
    /\bgreater than \$0\b/gi,
    /\bnot \$0\b/gi,
    /\bnonzero\b/gi,
    /\bnon-zero\b/gi,
    /\b20\d{2}\b/g,
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, " ");
  }

  return text.replace(/\s+/g, " ").trim();
}


function getDocumentNumberRank(documentNumber) {
  const doc = String(documentNumber || "");

  // Quotes look like 26-1747. Invoices look like INV-08668.
  if (/^\d{2}-\d{3,6}$/i.test(doc)) return 0;
  if (/^INV-/i.test(doc)) return 2;
  return 1;
}

function getDateTimestamp(value) {
  if (!value) return 0;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getSearchRelevanceScore(match, query) {
  const q = String(query || "").toLowerCase().trim();
  const name = String(match?.name || "").toLowerCase();
  const client = String(match?.client || "").toLowerCase();
  const venue = String(match?.venue || "").toLowerCase();
  const documentNumber = String(match?.documentNumber || "").toLowerCase();

  if (!q) return 0;

  let score = 0;
  const tokens = q.split(/\s+/).filter(Boolean);

  if (documentNumber === q) score += 1000;
  if (name === q) score += 400;
  if (name.includes(q)) score += 240;
  if (client.includes(q)) score += 150;
  if (venue.includes(q)) score += 80;

  for (const token of tokens) {
    if (name.includes(token)) score += 35;
    if (client.includes(token)) score += 20;
    if (venue.includes(token)) score += 12;
    if (documentNumber.includes(token)) score += 25;
  }

  return score;
}

function rankFlexQuoteMatches(matches, query) {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;

  return [...(Array.isArray(matches) ? matches : [])]
    .map((match, originalIndex) => {
      const plannedTime = getDateTimestamp(match.plannedStartDate);
      const agePenalty = plannedTime
        ? Math.max(0, Math.floor((now - plannedTime) / oneYearMs)) * 20
        : 20;
      const futureBonus = plannedTime && plannedTime >= now ? 60 : 0;
      const currentEraBonus = plannedTime && plannedTime >= Date.UTC(2025, 0, 1) ? 40 : 0;
      const quoteBonus = getDocumentNumberRank(match.documentNumber) === 0 ? 120 : 0;
      const invoicePenalty = /^INV-/i.test(String(match.documentNumber || "")) ? 220 : 0;
      const valueBonus = Number(match.invoiceTotal || 0) > 0 ? 15 : 0;
      const relevanceScore = getSearchRelevanceScore(match, query);

      return {
        ...match,
        searchRank: Math.round(
          relevanceScore +
            futureBonus +
            currentEraBonus +
            quoteBonus +
            valueBonus -
            invoicePenalty -
            agePenalty
        ),
        _originalIndex: originalIndex,
      };
    })
    .sort((a, b) => {
      if (b.searchRank !== a.searchRank) return b.searchRank - a.searchRank;

      const docRankA = getDocumentNumberRank(a.documentNumber);
      const docRankB = getDocumentNumberRank(b.documentNumber);
      if (docRankA !== docRankB) return docRankA - docRankB;

      const dateA = getDateTimestamp(a.plannedStartDate);
      const dateB = getDateTimestamp(b.plannedStartDate);
      if (dateA !== dateB) return dateB - dateA;

      return a._originalIndex - b._originalIndex;
    })
    .map((match, index) => {
      const { _originalIndex, ...clean } = match;
      return {
        ...clean,
        index: index + 1,
      };
    });
}


async function searchFlexQuotes(query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  const filters = options.filters || parseFlexSearchFilters(normalizedQuery, options);
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 25));

  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      count: 0,
      matches: [],
      filters,
      filterDescriptions: describeFlexSearchFilters(filters),
      requestUrl: null,
    };
  }

  const searchResult = await fetchFlexSearch(normalizedQuery);
  const results = normalizeFlexSearchResults(searchResult.data);
  const enrichLimit = Math.max(limit, Math.min(Number(options.enrichLimit || 25), 40));

  const baseCandidates = results
    .map((result) => ({
      raw: result,
      elementId: extractSearchResultId(result),
      name:
        result?.name ||
        result?.displayName ||
        result?.preferredDisplayString ||
        result?.text ||
        result?.label ||
        null,
      type:
        result?.type ||
        result?.definitionName ||
        result?.className ||
        result?.category ||
        null,
    }))
    .filter((candidate) => candidate.elementId)
    .slice(0, enrichLimit);

  const matches = [];

  for (const candidate of baseCandidates) {
    try {
      const intake = await fetchFlexShowIntake(candidate.elementId);
      const summary = buildFlexDocumentSummary(intake);
      const showContext = intake.showContext || {};

      matches.push({
        elementId: candidate.elementId,
        documentNumber: showContext.documentNumber || null,
        name: showContext.showName || candidate.name,
        client: showContext.client || null,
        venue: showContext.venue || null,
        plannedStartDate: showContext.plannedStartDate || null,
        plannedEndDate: showContext.plannedEndDate || null,
        loadInDate: showContext.loadInDate || null,
        loadOutDate: showContext.loadOutDate || null,
        personResponsible: showContext.personResponsible || null,
        projectManager: showContext.projectManager || null,
        invoiceTotal: summary?.financials?.invoiceTotal || 0,
        invoiceTotalFormatted: formatUsd(summary?.financials?.invoiceTotal || 0),
        balanceDue: summary?.financials?.balanceDue || 0,
        balanceDueFormatted: formatUsd(summary?.financials?.balanceDue || 0),
        categorySubtotal: summary?.financials?.categorySubtotal || 0,
        categorySubtotalFormatted: formatUsd(summary?.financials?.categorySubtotal || 0),
        rawSearchName: candidate.name,
        type: candidate.type,
        documentType: inferFlexDocumentType(
          `${showContext.documentType || ""} ${showContext.definitionName || ""} ${candidate.type || ""} ${candidate.name || ""}`,
          "unknown"
        ),
        definitionName: showContext.definitionName || null,
        definitionId: showContext.definitionId || null,
      });
    } catch (error) {
      matches.push({
        elementId: candidate.elementId,
        documentNumber: null,
        name: candidate.name,
        client: null,
        venue: null,
        plannedStartDate: null,
        invoiceTotal: 0,
        invoiceTotalFormatted: formatUsd(0),
        balanceDue: 0,
        balanceDueFormatted: formatUsd(0),
        rawSearchName: candidate.name,
        type: candidate.type,
        enrichmentError: error.message || "Unable to enrich search result.",
      });
    }
  }

  const rankedAllMatches = rankFlexQuoteMatches(matches, normalizedQuery);
  const filteredMatches = rankedAllMatches.filter((match) =>
    matchPassesFlexSearchFilters(match, filters)
  );
  const rankedMatches = filteredMatches.slice(0, limit);

  return {
    query: normalizedQuery,
    count: rankedMatches.length,
    rawCount: results.length,
    enrichedCount: matches.length,
    filteredCount: filteredMatches.length,
    filters,
    filterDescriptions: describeFlexSearchFilters(filters),
    ranking: {
      prefersQuotesOverInvoices: true,
      prefersNewerAndFutureJobs: true,
      invoiceResultsArePenalized: true,
      filtersApplied: flexSearchFiltersAreActive(filters),
    },
    matches: rankedMatches,
    requestUrl: searchResult.requestUrl,
  };
}

function buildQuoteSearchSelectionResponse(question, intent, searchQuery, searchResult) {
  const matches = Array.isArray(searchResult?.matches) ? searchResult.matches : [];

  if (matches.length === 0) {
    return {
      question,
      intent,
      searchQuery,
      found: false,
      needsClarification: true,
      answer: `I could not find any FLEX quotes matching "${searchQuery}".`,
      matches: [],
      search: searchResult,
    };
  }

  return {
    question,
    intent,
    searchQuery,
    found: true,
    needsSelection: true,
    answer:
      matches.length === 1
        ? `I found one possible FLEX quote for "${searchQuery}".`
        : `I found ${matches.length} possible FLEX quotes for "${searchQuery}". Which one do you mean?`,
    initialDisplayCount: 5,
    hasMoreMatches: matches.length > 5,
    matches: matches.map((match, index) => ({
      index: match.index || index + 1,
      elementId: match.elementId,
      documentNumber: match.documentNumber,
      name: match.name,
      client: match.client,
      venue: match.venue,
      plannedStartDate: match.plannedStartDate,
      invoiceTotal: match.invoiceTotal,
      invoiceTotalFormatted: match.invoiceTotalFormatted,
      balanceDue: match.balanceDue,
      balanceDueFormatted: match.balanceDueFormatted,
      searchRank: match.searchRank,
    })),
    filters: searchResult.filters || null,
    filterDescriptions: searchResult.filterDescriptions || [],
    search: {
      query: searchResult.query,
      count: searchResult.count,
      rawCount: searchResult.rawCount,
      enrichedCount: searchResult.enrichedCount,
      filteredCount: searchResult.filteredCount,
      requestUrl: searchResult.requestUrl,
    },
  };
}

function compactAskFlexLineItem(item) {
  if (!item || typeof item !== "object") return null;

  return {
    id: item.id ?? null,
    name: item.name ?? null,
    quantity: item.quantity ?? null,
    timeQty: item.timeQty ?? null,
    pricingModel: item.pricingModel ?? null,
    priceEach: item.priceEach ?? null,
    priceExtended: item.priceExtended ?? null,
    note: item.note ?? null,
    category: item.category ?? null,
    type: item.type ?? null,
  };
}

function buildAskFlexOperationalPayload(detail, question) {
  const showContext = detail?.showContext || {};

  return {
    question: String(question || ""),
    show_context: {
      elementId: showContext.elementId ?? detail?.elementId ?? null,
      documentNumber: showContext.documentNumber ?? null,
      showName: showContext.showName ?? null,
      client: showContext.client ?? null,
      venue: showContext.venue ?? null,
      plannedStartDate: showContext.plannedStartDate ?? null,
      plannedEndDate: showContext.plannedEndDate ?? null,
      shipDate: showContext.shipDate ?? null,
      loadInDate: showContext.loadInDate ?? null,
      showStartDate: showContext.showStartDate ?? null,
      loadOutDate: showContext.loadOutDate ?? null,
      shippingMethod: showContext.shippingMethod ?? null,
      personResponsible: showContext.personResponsible ?? null,
      projectManager: showContext.projectManager ?? null,
      notes: showContext.notes ?? null,
    },
    counts: detail?.counts || {},
    financials: detail?.summary?.financials || {},
    category_totals: detail?.summary?.totals || {},
    sections: (Array.isArray(detail?.sections) ? detail.sections : []).map((section) => ({
      name: section.name ?? null,
      category: section.category ?? null,
      total: section.total ?? null,
      itemCount: section.itemCount ?? null,
    })),
    staffing: (Array.isArray(detail?.laborItems) ? detail.laborItems : [])
      .map(compactAskFlexLineItem)
      .filter(Boolean),
    trucking: (Array.isArray(detail?.transportationItems) ? detail.transportationItems : [])
      .map(compactAskFlexLineItem)
      .filter(Boolean),
    equipment: (Array.isArray(detail?.inventoryItems) ? detail.inventoryItems : [])
      .map(compactAskFlexLineItem)
      .filter(Boolean),
  };
}

function hasAssignedProjectManager(value) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (text === "—" || /^not assigned$/i.test(text)) return false;
  return true;
}

function pmNotVisibleMessage() {
  return "No PM is visible on this FLEX quote.";
}

function pmNotVisibleQuestion() {
  return "No PM is visible on this FLEX quote — does this show need one?";
}

function scrubAskFlexOperationalWording(text, { hasPm = false } = {}) {
  let out = String(text ?? "");
  if (!out) return out;

  out = out.replace(/\bequipment items\b/gi, "equipment line items");
  out = out.replace(/\binventory items\b/gi, "equipment line items");
  out = out.replace(/\bitem count\b/gi, "line-item count");
  out = out.replace(/\bboth truck units\b/gi, "the quoted transportation quantity");
  out = out.replace(/\btruck units\b/gi, "transportation quantity");

  if (!hasPm) {
    out = out.replace(
      /No PM is assigned(?: in FLEX)?/gi,
      pmNotVisibleMessage().replace(/\.$/, "")
    );
    out = out.replace(
      /no project manager is assigned/gi,
      "no PM is visible on this FLEX quote"
    );
    out = out.replace(
      /Null project manager means no PM is currently assigned in FLEX/gi,
      "A blank projectManagerId means no PM is visible on this FLEX quote"
    );
  }

  return out;
}

function buildTruckingQuantityNotes(truckingLines) {
  const notes = [];

  for (const line of Array.isArray(truckingLines) ? truckingLines : []) {
    const qty = Number(line?.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    notes.push(
      `FLEX lists "${line.name || "Transportation line"}" with quantity ${qty}. That quantity may represent vehicles, trips, or billing units — confirm with Brian Kee / Trucking Coordinator before treating it as a truck count.`
    );
  }

  return notes;
}

function isMeaningfulCommercialIssue(commercial, financials = {}) {
  if (commercial == null) return false;
  if (commercial?.meaningful === true) return true;
  if (commercial?.meaningful === false) return false;

  const text = [
    commercial?.assessment,
    ...(Array.isArray(commercial?.findings) ? commercial.findings : []),
  ]
    .map((item) => String(item || ""))
    .join(" ")
    .toLowerCase();

  if (!text.trim()) return false;
  if (
    /no (material |meaningful )?(commercial|pricing|operating) (issue|concern|risk|red flag)/.test(
      text
    ) ||
    /commercially,? the quote appears straightforward/.test(text) ||
    /no pricing-based operating concern/.test(text) ||
    /secondary unless/.test(text)
  ) {
    return false;
  }

  return /\b(discount|underpriced|overpriced|scope creep|pricing concern|commercial risk|\$0 placeholder|zero[- ]dollar|credit card fee|unusual balance|collections)\b/.test(
    text
  );
}

function detectAskFlexEquipmentSignals(items) {
  const names = (Array.isArray(items) ? items : [])
    .map((item) => String(item?.name || "").toLowerCase())
    .filter(Boolean);

  const joined = names.join(" | ");

  return {
    hasRigging: /\b(rigging|motor|hoist|span\s*set|truss)\b/i.test(joined),
    hasPower: /\b(power|distro|cam-?lok|feeder|generator|genny)\b/i.test(joined),
    hasCable: /\b(cable|snake|multicore|fiber|loom)\b/i.test(joined),
    hasControl: /\b(control|console|processor|matrix|network)\b/i.test(joined),
    hasVideoLed: /\b(video|led|panel|wall|processor|novastar|brompton)\b/i.test(joined),
    majorFamilies: [
      /\bled|video\b/i.test(joined) ? "Video / LED" : null,
      /\baudio|speaker|pa|console|mic\b/i.test(joined) ? "Audio" : null,
      /\blight|fixture|lamp\b/i.test(joined) ? "Lighting" : null,
      /\btruss|rigging|motor|hoist\b/i.test(joined) ? "Rigging / Truss" : null,
      /\bpower|distro|feeder|generator\b/i.test(joined) ? "Power" : null,
      /\bcable|snake|fiber\b/i.test(joined) ? "Cable / Infrastructure" : null,
    ].filter(Boolean),
  };
}

function estimateAskFlexOperationalComplexity(payload) {
  const staffing = Array.isArray(payload?.staffing) ? payload.staffing : [];
  const trucking = Array.isArray(payload?.trucking) ? payload.trucking : [];
  const equipment = Array.isArray(payload?.equipment) ? payload.equipment : [];
  const sections = Array.isArray(payload?.sections) ? payload.sections : [];
  const signals = detectAskFlexEquipmentSignals(equipment);

  const laborHeadcount = staffing.reduce(
    (sum, item) => sum + Number(item?.quantity || 0),
    0
  );
  const lineCount =
    staffing.length + trucking.length + equipment.length + sections.length;

  let score = 0;
  if (lineCount >= 80 || equipment.length >= 60) score += 2;
  else if (lineCount >= 35 || equipment.length >= 25) score += 1;

  if (sections.length >= 6) score += 2;
  else if (sections.length >= 3) score += 1;

  if (trucking.length >= 3) score += 2;
  else if (trucking.length >= 1) score += 1;

  if (laborHeadcount >= 12) score += 2;
  else if (laborHeadcount >= 4) score += 1;

  if (signals.hasRigging) score += 1;
  if (signals.hasPower) score += 1;
  if (signals.hasCable) score += 1;
  if (signals.hasVideoLed) score += 1;

  if (score >= 7) return "High";
  if (score >= 3) return "Medium";
  return "Low";
}

function buildAskFlexOperationalFallback(detail, question) {
  const payload = buildAskFlexOperationalPayload(detail, question);
  const show = payload.show_context || {};
  const staffing = payload.staffing || [];
  const trucking = payload.trucking || [];
  const equipment = payload.equipment || [];
  const sections = payload.sections || [];
  const signals = detectAskFlexEquipmentSignals(equipment);

  const laborHeadcount = staffing.reduce(
    (sum, item) => sum + Number(item?.quantity || 0),
    0
  );
  const laborPersonDays = staffing.reduce((sum, item) => {
    const qty = Number(item?.quantity || 0);
    const timeQty = Number(item?.timeQty || 0);
    return sum + qty * timeQty;
  }, 0);

  const hasPm = hasAssignedProjectManager(show.projectManager);
  const missingDates = [
    !show.loadInDate ? "load-in" : null,
    !show.showStartDate && !show.plannedStartDate ? "show start" : null,
    !show.loadOutDate ? "load-out" : null,
  ].filter(Boolean);

  const complexityLevel = estimateAskFlexOperationalComplexity(payload);
  const coordinationRequired = [];
  if (staffing.length) coordinationRequired.push("Staffing");
  if (trucking.length) coordinationRequired.push("Trucking");
  if (equipment.length || sections.length >= 2) coordinationRequired.push("Warehouse");
  if (hasPm || complexityLevel !== "Low") coordinationRequired.push("PM");

  const roles = staffing.map((item) => ({
    name: item.name || "Labor line",
    quantity: Number(item.quantity || 0),
    timeQty: Number(item.timeQty || 0),
    note: item.note || null,
  }));

  const likelyDepartments = sections
    .map((section) => section.name)
    .filter(Boolean)
    .slice(0, 8);

  const assessmentParts = [
    `${show.documentNumber || "This quote"} has ${laborHeadcount} labor headcount across ${staffing.length} staffing line(s), ${trucking.length} trucking line(s), and ${equipment.length} equipment line item(s).`,
    `Complexity is estimated ${complexityLevel} from FLEX line counts and department scope.`,
  ];

  if (!hasPm) {
    assessmentParts.push(pmNotVisibleMessage());
  } else {
    assessmentParts.push(`PM ownership is listed as ${show.projectManager}.`);
  }

  const needsConfirmation = [];
  if (!hasPm) {
    needsConfirmation.push(pmNotVisibleQuestion());
  }
  if (missingDates.length) {
    needsConfirmation.push(
      `Confirm missing schedule fields in FLEX: ${missingDates.join(", ")}.`
    );
  }

  const recommendedNextActions = [];
  if (staffing.length) {
    recommendedNextActions.push(
      "Confirm staffing coverage against the FLEX labor lines."
    );
  }
  if (trucking.length) {
    recommendedNextActions.push(
      "Route trucking review to Brian Kee / Trucking Coordinator."
    );
  }
  if (equipment.length) {
    recommendedNextActions.push(
      "Review warehouse pull scope against equipment families and department count."
    );
  }
  if (hasPm) {
    recommendedNextActions.push(
      `Align staffing, trucking, and warehouse timing with ${show.projectManager}.`
    );
  }

  const truckingQuantityNotes = buildTruckingQuantityNotes(trucking);

  return {
    headline: "Operational Review",
    assessment: assessmentParts.join(" "),
    complexityLevel,
    readinessStatus: missingDates.length ? "review_needed" : "clear",
    coordinationRequired: [...new Set(coordinationRequired)],
    showSummary: {
      documentNumber: show.documentNumber || null,
      showName: show.showName || null,
      client: show.client || null,
      venue: show.venue || null,
      projectManager: show.projectManager || null,
      shippingMethod: show.shippingMethod || null,
      loadInDate: show.loadInDate || null,
      showStartDate: show.showStartDate || null,
      loadOutDate: show.loadOutDate || null,
    },
    labor: {
      assessment: staffing.length
        ? `FLEX lists ${laborHeadcount} headcount and about ${Math.round(laborPersonDays * 100) / 100} person-days across ${staffing.length} labor line(s).`
        : "No labor lines were found on this FLEX quote.",
      headcount: laborHeadcount,
      personDays: Math.round(laborPersonDays * 100) / 100,
      roles,
      findings: staffing.length
        ? [
            `Labor headcount from FLEX quantity fields: ${laborHeadcount}.`,
            `Person-days from quantity × timeQty: ${Math.round(laborPersonDays * 100) / 100}.`,
          ]
        : ["No staffing lines present in FLEX."],
      actions: staffing.length
        ? ["Confirm role coverage and call times against FLEX labor lines."]
        : [],
    },
    trucking: {
      assessment: trucking.length
        ? `FLEX lists ${trucking.length} transportation line(s). Route review to Brian Kee / Trucking Coordinator.`
        : "No transportation lines were found on this FLEX quote.",
      lineCount: trucking.length,
      findings: trucking.length
        ? [
            `Transportation line count from FLEX: ${trucking.length}.`,
            ...truckingQuantityNotes.slice(0, 2),
          ]
        : ["No trucking lines present in FLEX."],
      actions: trucking.length
        ? [
            "Route truck timing and dispatch planning to Brian Kee / Trucking Coordinator.",
            truckingQuantityNotes.length
              ? "Confirm whether transportation quantities mean vehicles, trips, or billing units."
              : null,
          ].filter(Boolean)
        : [],
    },
    equipment: {
      assessment: equipment.length
        ? `FLEX lists ${equipment.length} equipment line items across ${sections.length} section(s).`
        : "No equipment/inventory lines were found on this FLEX quote.",
      itemCount: equipment.length,
      majorFamilies: signals.majorFamilies,
      findings: equipment.length
        ? [
            `Quoted equipment rows from FLEX: ${equipment.length}.`,
            signals.majorFamilies.length
              ? `Detected equipment families from names: ${signals.majorFamilies.join(", ")}.`
              : "No major equipment family keywords were detected from item names.",
          ]
        : ["No equipment lines present in FLEX."],
      actions: equipment.length
        ? ["Validate warehouse pull lists against FLEX equipment line items."]
        : [],
    },
    warehouse: {
      assessment: `Warehouse complexity estimated ${complexityLevel} from ${sections.length} department/section(s), ${equipment.length} equipment line item(s), and schedule/trucking signals in FLEX.`,
      complexity: complexityLevel,
      likelyDepartments,
      findings: [
        `Department/section count: ${sections.length}.`,
        `Equipment line-item count: ${equipment.length}.`,
      ],
      actions: sections.length
        ? ["Confirm warehouse department ownership for the listed FLEX sections."]
        : [],
    },
    commercial: null,
    redFlags: [],
    needsConfirmation,
    questionsForPm: needsConfirmation,
    recommendedNextActions,
    confidence: "medium",
    assumptions: [
      "Fallback used FLEX line counts and header fields only.",
      "No AI interpretation was applied; no red flags were invented.",
      "Quantity is treated as labor headcount; quantity × timeQty is person-days only.",
      "A blank projectManagerId means no PM is visible on this FLEX quote, not a confirmed unassignment statement beyond the header field.",
      "Equipment line-item count is quoted row count, not physical unit quantity.",
    ],
    source: "local_fallback",
  };
}

function asStringArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAskFlexOperationalAnalysis(raw, fallback) {
  const base = isPlainObject(raw) ? raw : {};
  const fb = isPlainObject(fallback) ? fallback : {};

  const complexityCandidates = ["Low", "Medium", "High"];
  let complexityLevel = String(base.complexityLevel || "").trim();
  if (!complexityCandidates.includes(complexityLevel)) {
    complexityLevel = fb.complexityLevel || "Medium";
  }

  const readinessCandidates = ["clear", "review_needed", "at_risk", "blocked"];
  let readinessStatus = String(base.readinessStatus || "").trim().toLowerCase();
  if (!readinessCandidates.includes(readinessStatus)) {
    readinessStatus = fb.readinessStatus || "review_needed";
  }

  const confidenceCandidates = ["low", "medium", "high"];
  let confidence = String(base.confidence || "").trim().toLowerCase();
  if (!confidenceCandidates.includes(confidence)) {
    confidence = fb.confidence || "medium";
  }

  const coordinationAllowed = new Set(["Staffing", "Trucking", "Warehouse", "PM"]);
  let coordinationRequired = Array.isArray(base.coordinationRequired)
    ? base.coordinationRequired
        .map((item) => String(item || "").trim())
        .filter((item) => coordinationAllowed.has(item))
    : [];
  if (!coordinationRequired.length) {
    coordinationRequired = Array.isArray(fb.coordinationRequired)
      ? fb.coordinationRequired
      : [];
  }

  // FLEX header facts always win over model-invented show context.
  const showSummary = {
    ...(isPlainObject(fb.showSummary) ? fb.showSummary : {}),
  };

  const modelLabor = isPlainObject(base.labor) ? base.labor : {};
  const labor = {
    ...(isPlainObject(fb.labor) ? fb.labor : {}),
    assessment: String(modelLabor.assessment || fb.labor?.assessment || "").trim(),
    findings: asStringArray(modelLabor.findings, 8),
    actions: asStringArray(modelLabor.actions, 8),
    // Lock FLEX-derived counts/roles so the model cannot invent headcount or roles.
    headcount: Number(fb.labor?.headcount || 0) || 0,
    personDays: Number(fb.labor?.personDays || 0) || 0,
    roles: Array.isArray(fb.labor?.roles) ? fb.labor.roles : [],
  };

  const modelTrucking = isPlainObject(base.trucking) ? base.trucking : {};
  const trucking = {
    ...(isPlainObject(fb.trucking) ? fb.trucking : {}),
    assessment: String(modelTrucking.assessment || fb.trucking?.assessment || "").trim(),
    findings: asStringArray(modelTrucking.findings, 8),
    actions: asStringArray(modelTrucking.actions, 8),
    lineCount: Number(fb.trucking?.lineCount || 0) || 0,
  };

  const modelEquipment = isPlainObject(base.equipment) ? base.equipment : {};
  const equipment = {
    ...(isPlainObject(fb.equipment) ? fb.equipment : {}),
    assessment: String(
      modelEquipment.assessment || fb.equipment?.assessment || ""
    ).trim(),
    findings: asStringArray(modelEquipment.findings, 8),
    actions: asStringArray(modelEquipment.actions, 8),
    majorFamilies: asStringArray(
      modelEquipment.majorFamilies?.length
        ? modelEquipment.majorFamilies
        : fb.equipment?.majorFamilies,
      10
    ),
    // Line-item count from FLEX, never summed quantity.
    itemCount: Number(fb.equipment?.itemCount || 0) || 0,
  };

  const modelWarehouse = isPlainObject(base.warehouse) ? base.warehouse : {};
  const warehouse = {
    ...(isPlainObject(fb.warehouse) ? fb.warehouse : {}),
    assessment: String(
      modelWarehouse.assessment || fb.warehouse?.assessment || ""
    ).trim(),
    findings: asStringArray(modelWarehouse.findings, 8),
    actions: asStringArray(modelWarehouse.actions, 8),
    likelyDepartments: asStringArray(
      modelWarehouse.likelyDepartments?.length
        ? modelWarehouse.likelyDepartments
        : fb.warehouse?.likelyDepartments,
      12
    ),
  };
  let warehouseComplexity = String(modelWarehouse.complexity || "").trim();
  if (!complexityCandidates.includes(warehouseComplexity)) {
    warehouseComplexity = fb.warehouse?.complexity || complexityLevel;
  }
  warehouse.complexity = warehouseComplexity;

  const modelCommercial = isPlainObject(base.commercial) ? base.commercial : {};
  let commercial = {
    assessment: String(
      modelCommercial.assessment || fb.commercial?.assessment || ""
    ).trim(),
    findings: asStringArray(modelCommercial.findings, 8),
    meaningful: modelCommercial.meaningful,
  };

  const areaAllowed = new Set([
    "Staffing",
    "Trucking",
    "Warehouse",
    "Equipment",
    "Timing",
    "PM",
    "Data",
  ]);
  const severityAllowed = new Set(["low", "medium", "high"]);

  let redFlags = Array.isArray(base.redFlags)
    ? base.redFlags
        .map((flag) => {
          if (!isPlainObject(flag)) return null;
          const severity = String(flag.severity || "").toLowerCase();
          const area = String(flag.area || "").trim();
          const finding = String(flag.finding || "").trim();
          if (!severityAllowed.has(severity) || !areaAllowed.has(area) || !finding) {
            return null;
          }
          return {
            severity,
            area,
            finding,
            evidence: String(flag.evidence || "").trim() || "FLEX payload evidence not specified.",
            action: String(flag.action || "").trim() || "Review with the owning coordinator.",
          };
        })
        .filter(Boolean)
    : [];

  const hasPm = hasAssignedProjectManager(showSummary.projectManager);
  const movedPmConfirmations = [];

  // Missing/unconfirmed PM ownership is confirmation work, not a red flag.
  redFlags = redFlags.filter((flag) => {
    const blob = `${flag.finding} ${flag.action} ${flag.evidence}`.toLowerCase();
    const isPmVisibilityIssue =
      flag.area === "PM" &&
      /\b(no pm|missing pm|pm is (not |un)?assigned|not visible|project manager|pm ownership|pm assignment)\b/.test(
        blob
      ) &&
      !/\b(conflict|contradict|blocker|shortage|missing critical)\b/.test(blob);

    if (isPmVisibilityIssue) {
      movedPmConfirmations.push(
        scrubAskFlexOperationalWording(flag.action || flag.finding, { hasPm })
      );
      return false;
    }

    return true;
  });

  let needsConfirmation = asStringArray(base.needsConfirmation, 10);
  if (!needsConfirmation.length) {
    needsConfirmation = asStringArray(fb.needsConfirmation, 10);
  }

  let questionsForPm = asStringArray(base.questionsForPm, 10);
  if (!questionsForPm.length) {
    questionsForPm = asStringArray(fb.questionsForPm, 10);
  }

  needsConfirmation = [
    ...needsConfirmation,
    ...questionsForPm,
    ...movedPmConfirmations,
  ];

  if (!hasPm) {
    needsConfirmation = [
      pmNotVisibleQuestion(),
      ...needsConfirmation.filter(
        (item) =>
          !/no pm is (assigned|visible)/i.test(item) &&
          !/assign(?: a)? pm/i.test(item)
      ),
    ];
  }

  needsConfirmation = [
    ...new Set(
      needsConfirmation
        .map((item) => scrubAskFlexOperationalWording(item, { hasPm }))
        .filter(Boolean)
    ),
  ].slice(0, 10);

  let recommendedNextActions = asStringArray(base.recommendedNextActions, 10);
  if (!recommendedNextActions.length) {
    recommendedNextActions = asStringArray(fb.recommendedNextActions, 10);
  }
  recommendedNextActions = recommendedNextActions
    .map((item) => scrubAskFlexOperationalWording(item, { hasPm }))
    .filter((item) => !/no pm is assigned/i.test(item))
    .slice(0, 10);

  // Soften blocked / at_risk unless evidence-looking content exists.
  if (readinessStatus === "blocked" && redFlags.every((flag) => flag.severity !== "high")) {
    readinessStatus = "at_risk";
  }
  if (readinessStatus === "at_risk" && redFlags.length === 0) {
    readinessStatus = "review_needed";
  }

  const scrubDept = (dept) => {
    if (!isPlainObject(dept)) return dept;
    return {
      ...dept,
      assessment: scrubAskFlexOperationalWording(dept.assessment, { hasPm }),
      findings: asStringArray(dept.findings, 8).map((item) =>
        scrubAskFlexOperationalWording(item, { hasPm })
      ),
      actions: asStringArray(dept.actions, 8).map((item) =>
        scrubAskFlexOperationalWording(item, { hasPm })
      ),
    };
  };

  const assessment = scrubAskFlexOperationalWording(
    String(base.assessment || "").trim() ||
      String(fb.assessment || "").trim() ||
      "Operational review is available from FLEX quote data.",
    { hasPm }
  );

  labor.assessment = scrubAskFlexOperationalWording(labor.assessment, { hasPm });
  labor.findings = labor.findings.map((item) =>
    scrubAskFlexOperationalWording(item, { hasPm })
  );
  labor.actions = labor.actions.map((item) =>
    scrubAskFlexOperationalWording(item, { hasPm })
  );

  Object.assign(trucking, scrubDept(trucking));
  Object.assign(equipment, scrubDept(equipment));
  Object.assign(warehouse, scrubDept(warehouse));

  redFlags = redFlags.map((flag) => ({
    ...flag,
    finding: scrubAskFlexOperationalWording(flag.finding, { hasPm }),
    evidence: scrubAskFlexOperationalWording(flag.evidence, { hasPm }),
    action: scrubAskFlexOperationalWording(flag.action, { hasPm }),
  }));

  const financials = fb.financials || base.financials || {};
  const commercialMeaningful = isMeaningfulCommercialIssue(commercial, financials);
  commercial = commercialMeaningful
    ? {
        assessment: scrubAskFlexOperationalWording(commercial.assessment, { hasPm }),
        findings: commercial.findings.map((item) =>
          scrubAskFlexOperationalWording(item, { hasPm })
        ),
        meaningful: true,
      }
    : null;

  return {
    headline: String(base.headline || fb.headline || "Operational Review").trim(),
    assessment,
    complexityLevel,
    readinessStatus,
    coordinationRequired,
    showSummary: {
      documentNumber: showSummary.documentNumber || null,
      showName: showSummary.showName || null,
      client: showSummary.client || null,
      venue: showSummary.venue || null,
      projectManager: showSummary.projectManager || null,
      shippingMethod: showSummary.shippingMethod || null,
      loadInDate: showSummary.loadInDate || null,
      showStartDate: showSummary.showStartDate || null,
      loadOutDate: showSummary.loadOutDate || null,
    },
    labor,
    trucking,
    equipment,
    warehouse,
    commercial,
    redFlags,
    needsConfirmation,
    questionsForPm: needsConfirmation,
    recommendedNextActions,
    confidence,
    assumptions: (
      asStringArray(base.assumptions, 10).length
        ? asStringArray(base.assumptions, 10)
        : asStringArray(fb.assumptions, 10)
    ).map((item) => scrubAskFlexOperationalWording(item, { hasPm })),
    source: isPlainObject(raw) ? "openai" : "local_fallback",
  };
}

const ASK_FLEX_OPERATIONAL_ANALYSIS_RULES = `
Ask FLEX Operational Analysis operating rules:

1. FLEX facts and AI interpretation must remain distinguishable.
2. Never invent quantities, dates, equipment, trucks, employees, or conflicts.
3. Quantity is headcount for labor.
4. Quantity multiplied by timeQty may be described only as person-days or billing units, never headcount.
5. Transportation belongs to Brian Kee / Trucking Coordinator.
6. Do not claim separate driver labor is missing merely because no driver line appears.
7. Only discuss a driver when an explicit FLEX line names a driver.
8. Large scope is coordination-heavy, not automatically risky.
9. Use at_risk only when there is evidence of a genuine concern.
10. Use blocked only for a confirmed blocker.
11. If projectManager is blank/null on the FLEX quote, say exactly: "No PM is visible on this FLEX quote." Never say "No PM is assigned" unless FLEX definitively states unassignment. Ask once via needsConfirmation: "No PM is visible on this FLEX quote — does this show need one?"
12. If a PM is assigned, route coordination to that PM.
13. Warehouse analysis must be based on the number of departments, equipment line-item count, equipment families, rigging, cable, power, control, trucking, and schedule.
14. Do not claim truck capacity is insufficient unless the payload provides defensible evidence.
15. Do not interpret transportation quantity as a truck count unless the line explicitly supports that. For quantity values, say the quantity may represent vehicles, trips, or billing units and route confirmation to Brian Kee / Trucking Coordinator. Never say "both truck units" unless confirmed.
16. When referring to detail.counts.inventoryItems / equipment arrays, say "equipment line items" or "quoted equipment rows", never imply physical unit quantity from line-item count.
17. Red flags are only for actual blockers, conflicts, missing critical data, shortages, or contradictory evidence. Do not put missing/unconfirmed PM ownership in redFlags; put it in needsConfirmation.
18. Commercial analysis should remain secondary. Set commercial.meaningful=true only when pricing, discounts, totals, balance, or scope create a real operating concern; otherwise omit commercial concern.
19. Prefer package-specific recommendations tied to actual FLEX signals (for example dual console workflow, RF/wireless prep, cable/power labeling, rigging handoff, warehouse pack sequencing) without inventing shortages.
20. Keep department findings concise (up to 3) and actions concise (up to 2).
21. For clean shows, clearly say no material red flags were detected.
22. Include assumptions and confidence.
23. AI recommends; humans approve.
`;

async function buildAskFlexOperationalAnalysis(detail, question) {
  const compactPayload = buildAskFlexOperationalPayload(detail, question);
  const fallback = buildAskFlexOperationalFallback(detail, question);

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const modelConfig = selectCueModel({}, compactPayload);
    console.log("[CUE ASK FLEX OPS ANALYSIS MODEL SELECT]", {
      requestedAiMode: modelConfig.requestedAiMode,
      currentModel: modelConfig.currentModel,
      advancedModel: modelConfig.advancedModel,
      selectedModel: modelConfig.model,
    });

    const response = await openai.responses.create({
      model: modelConfig.model,
      input: [
        {
          role: "system",
          content:
            "You are CUE Ask FLEX Operational Analysis for Music Matters. Return only valid JSON. Do not include markdown. Distinguish FLEX facts from interpretation. Never invent quantities, dates, equipment, trucks, employees, or conflicts. AI recommends; humans approve.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Produce an Ask FLEX operational analysis for this quote.",
            output_requirement:
              "Return only valid JSON matching required_schema. The response must be JSON.",
            operating_rules: ASK_FLEX_OPERATIONAL_ANALYSIS_RULES,
            required_schema: {
              headline: "Operational Review",
              assessment: "Two or three concise sentences.",
              complexityLevel: "Low | Medium | High",
              readinessStatus: "clear | review_needed | at_risk | blocked",
              coordinationRequired: ["Staffing", "Trucking", "Warehouse", "PM"],
              showSummary: {
                documentNumber: "string",
                showName: "string",
                client: "string | null",
                venue: "string | null",
                projectManager: "string | null",
                shippingMethod: "string | null",
                loadInDate: "string | null",
                showStartDate: "string | null",
                loadOutDate: "string | null",
              },
              labor: {
                assessment: "string",
                headcount: "number",
                personDays: "number",
                roles: [
                  {
                    name: "string",
                    quantity: "number",
                    timeQty: "number",
                    note: "string | null",
                  },
                ],
                findings: ["string"],
                actions: ["string"],
              },
              trucking: {
                assessment: "string",
                lineCount: "number",
                findings: ["string"],
                actions: ["string"],
              },
              equipment: {
                assessment: "string",
                itemCount: "number",
                majorFamilies: ["string"],
                findings: ["string"],
                actions: ["string"],
              },
              warehouse: {
                assessment: "string",
                complexity: "Low | Medium | High",
                likelyDepartments: ["string"],
                findings: ["string"],
                actions: ["string"],
              },
              commercial: {
                assessment: "string",
                findings: ["string"],
                meaningful:
                  "boolean — true only when pricing/discounts/totals/balance/scope create a real operating concern",
              },
              redFlags: [
                {
                  severity: "low | medium | high",
                  area: "Staffing | Trucking | Warehouse | Equipment | Timing | Data",
                  finding: "string",
                  evidence: "string",
                  action: "string",
                },
              ],
              needsConfirmation: ["string"],
              questionsForPm: ["string"],
              recommendedNextActions: ["string"],
              confidence: "low | medium | high",
              assumptions: ["string"],
            },
            compact_flex_payload: compactPayload,
            pm_visibility_note:
              compactPayload?.show_context?.projectManager
                ? `PM visible on quote: ${compactPayload.show_context.projectManager}`
                : "projectManagerId has no data on this FLEX quote header. Say: No PM is visible on this FLEX quote.",
            deterministic_counts: {
              laborHeadcount: fallback.labor?.headcount ?? 0,
              laborPersonDays: fallback.labor?.personDays ?? 0,
              truckingLineCount: fallback.trucking?.lineCount ?? 0,
              equipmentLineItemCount: fallback.equipment?.itemCount ?? 0,
              sectionCount: Array.isArray(compactPayload.sections)
                ? compactPayload.sections.length
                : 0,
              complexityEstimate: fallback.complexityLevel,
            },
          }),
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    });

    const raw = safeParseModelJson(response.output_text);
    // If safeParse fell back to the analyze-flex-intake shape, treat as failure.
    if (raw?.cue_review_cards && !raw?.assessment && !raw?.labor) {
      return fallback;
    }

    return normalizeAskFlexOperationalAnalysis(raw, fallback);
  } catch (error) {
    console.error("[CUE ASK FLEX OPS ANALYSIS] OpenAI failed; using local fallback.", error);
    return fallback;
  }
}

function buildAskFlexFullShowDeps() {
  return {
    searchFlexQuotes,
    findFlexQuoteByDocumentNumber,
    fetchFlexShowIntake,
    buildFlexDocumentDetail,
    matchTruckingRowsWithFallback,
    summarizeTruckingRows,
    buildFlexVsTruckingComparison,
    selectCueModel,
    safeParseModelJson,
    openai,
    parseCsvRows,
    reviewSnapshotStore: defaultReviewSnapshotStore,
    buildLabel: CUE_BUILD_LABEL,
    getSlackSignalsForShow: async (showContext) => {
      const payload = await slackOperationalSignalsService.getSlackSignalsForShow(
        showContext,
        { allowStaleRefresh: !SLACK_FIXTURE_MODE }
      );
      if (SLACK_FIXTURE_MODE) {
        return {
          ...payload,
          sourceStatus:
            payload.sourceStatus === "unavailable" ? "fallback" : payload.sourceStatus || "fallback",
          warning: "Slack source is fixture/test data (not live Slack).",
          fixtureMode: true,
          sourceLabel: "fixture/test data",
        };
      }
      return payload;
    },
  };
}

function sanitizeSnapshotForApi(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    id: snapshot.id || null,
    showKey: snapshot.showKey || null,
    showName: snapshot.showName || null,
    createdAt: snapshot.createdAt || null,
    reviewedAt: snapshot.reviewedAt || null,
    buildLabel: snapshot.buildLabel || null,
    source: snapshot.source || null,
    overallStatus: snapshot.overallStatus || null,
    complexityLevel: snapshot.complexityLevel || null,
    confidence: snapshot.confidence || null,
    relatedQuotes: Array.isArray(snapshot.relatedQuotes) ? snapshot.relatedQuotes : [],
    sourceCoverage: Array.isArray(snapshot.sourceCoverage) ? snapshot.sourceCoverage : [],
    flex: snapshot.flex || null,
    trucking: snapshot.trucking || null,
    activeShows: snapshot.activeShows || null,
    findingCategories: Array.isArray(snapshot.findingCategories)
      ? snapshot.findingCategories
      : [],
    confirmedIssues: Array.isArray(snapshot.confirmedIssues) ? snapshot.confirmedIssues : [],
    needsConfirmation: Array.isArray(snapshot.needsConfirmation)
      ? snapshot.needsConfirmation
      : [],
    coverageGaps: Array.isArray(snapshot.coverageGaps) ? snapshot.coverageGaps : [],
    recommendedNextActions: Array.isArray(snapshot.recommendedNextActions)
      ? snapshot.recommendedNextActions
      : [],
    contentHash: snapshot.contentHash || null,
  };
}

function isValidShowKeyParam(showKey) {
  return /^[a-z0-9]+(?:-[a-z0-9]+){0,12}-\d{4}$/i.test(String(showKey || "").trim());
}

async function answerFlexAskQuestion(question, options = {}) {
  const documentNumbers = extractDocumentNumbersFromQuestion(question);
  const documentNumber = documentNumbers[0] || null;
  const followupContext = sanitizeFullShowFollowupContext(options.context);

  // Session follow-up against a stored full-show review (ASK-FLEX-003/004).
  if (isShowOperationalFollowupQuestion(question, followupContext)) {
    const wantsRefresh = isRefreshFollowupQuestion(question);
    let contextForAnswer = followupContext;
    let refreshed = false;
    let snapshotMeta = null;
    let refreshComparison = null;

    if (wantsRefresh && followupContext?.showName) {
      const refreshQuestion = `Give me a full operational review of ${followupContext.showName}`;
      const fresh = await answerShowOperationalAnalysis(
        refreshQuestion,
        buildAskFlexFullShowDeps()
      );
      if (fresh?.found && fresh?.result) {
        snapshotMeta = fresh.snapshot || null;
        const briefLike = {
          ...fresh.result,
          showName: fresh.showName || fresh.result.showSummary?.showName || followupContext.showName,
          answer: fresh.answer || fresh.result.assessment,
          supportingData: fresh.supportingData || null,
          sourceCoverage: fresh.sourceCoverage || fresh.result.sourceCoverage || [],
          snapshot: snapshotMeta,
        };
        contextForAnswer = sanitizeFullShowFollowupContext({
          type: "full_show_review",
          showName: briefLike.showName,
          reviewedAt: new Date().toISOString(),
          question: refreshQuestion,
          previousResult: followupContext.result,
          result: briefLike,
          cueBuildLabel: CUE_BUILD_LABEL,
        });
        refreshed = true;

        // Prefer persisted prior-vs-current comparison; never compare a duplicate to itself.
        if (snapshotMeta?.showKey && !snapshotMeta.duplicate) {
          refreshComparison = await defaultReviewSnapshotStore.compareLatest(
            snapshotMeta.showKey
          );
        } else if (snapshotMeta?.duplicate) {
          refreshComparison = {
            hasChanges: false,
            changeCount: 0,
            improved: [],
            worsened: [],
            newIssues: [],
            resolvedIssues: [],
            changed: [],
            summary:
              "No operational changes were detected between the two latest distinct saved reviews.",
            insufficientHistory: false,
          };
        }
      }
    }

    const followupDeps = {
      openai,
      selectCueModel,
      safeParseModelJson,
      refreshed,
      reviewSnapshotStore: defaultReviewSnapshotStore,
      snapshotMeta,
      usedPersistedSnapshots: true,
    };

    const followup = await answerFullShowFollowup(question, contextForAnswer, followupDeps);

    if (refreshed) {
      followup.refreshed = true;
      followup.refreshNote = "Refreshed from live connected sources";
      followup.refreshedReview = contextForAnswer?.result || null;
      followup.previousReview = followupContext?.result || null;
      followup.snapshot = snapshotMeta;
      const wantsChangeSummary =
        classifyFullShowFollowupType(question) === "persistent_change_since_last" ||
        /\bwhat changed\b/i.test(question);
      if (wantsChangeSummary) {
        if (refreshComparison) {
          followup.changeComparison = refreshComparison;
          followup.answer = `${followup.refreshNote}. ${refreshComparison.summary}`;
          followup.items = formatChangeComparisonItems(refreshComparison, "all");
          followup.followupType = "persistent_change_since_last";
          followup.headline = `Changes since last saved review · ${
            followup.showName || followupContext.showName || "this show"
          }`;
        } else {
          const changed = await answerFullShowFollowup(
            "What changed since the last review?",
            contextForAnswer,
            { ...followupDeps, refreshed: true }
          );
          followup.answer = `${followup.refreshNote}. ${changed.answer}`;
          followup.items = changed.items;
          followup.followupType = changed.followupType || "persistent_change_since_last";
          followup.headline = changed.headline;
          followup.changeComparison = changed.changeComparison || null;
        }
      } else {
        followup.answer = `${followup.refreshNote}. ${followup.answer}`;
      }
    }

    return followup;
  }

  const intent = documentNumbers.length >= 2 ? "document_compare" : classifyFlexAskIntent(question);

  if (intent === "show_operational_analysis") {
    return answerShowOperationalAnalysis(question, buildAskFlexFullShowDeps());
  }

  if (intent === "document_compare") {
    if (documentNumbers.length < 2) {
      return {
        question,
        intent,
        needsClarification: true,
        answer: "I need two FLEX quote numbers to compare, like 26-1747 and 26-0829.",
      };
    }

    const [documentNumberA, documentNumberB] = documentNumbers;
    const [resultA, resultB] = await Promise.all([
      fetchFlexDetailByDocumentNumber(documentNumberA),
      fetchFlexDetailByDocumentNumber(documentNumberB),
    ]);

    if (!resultA.found || !resultB.found) {
      return {
        question,
        intent,
        found: false,
        answer: `I could not find ${
          !resultA.found && !resultB.found
            ? `${documentNumberA} or ${documentNumberB}`
            : !resultA.found
              ? documentNumberA
              : documentNumberB
        } in FLEX.`,
        lookups: {
          [documentNumberA]: resultA.lookup,
          [documentNumberB]: resultB.lookup,
        },
      };
    }

    const comparison = buildFlexDocumentComparison(
      question,
      resultA.detail,
      resultB.detail
    );

    return {
      question,
      intent,
      found: true,
      documentNumbers,
      answer: comparison.answer,
      result: comparison,
      supportingData: {
        documents: comparison.documents,
        financialRows: comparison.financialRows,
        sectionRows: comparison.sectionRows,
        itemRows: comparison.itemRows,
      },
      lookups: {
        [documentNumberA]: resultA.lookup,
        [documentNumberB]: resultB.lookup,
      },
    };
  }

  let quoteLookup = null;

  if (documentNumber) {
    quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber);

    if (!quoteLookup.found || !quoteLookup.elementId) {
      return {
        question,
        intent,
        documentNumber,
        found: false,
        answer: `I could not find a FLEX quote for ${documentNumber}.`,
        lookup: quoteLookup,
      };
    }
  } else {
    const searchFilters = parseFlexSearchFilters(question);
    const rawSearchQuery = extractQuoteSearchQueryFromQuestion(question);
    const searchQuery = removeFilterWordsFromQuoteSearchQuery(rawSearchQuery) || rawSearchQuery;

    if (!searchQuery) {
      return {
        question,
        intent,
        needsClarification: true,
        answer:
          "I need either a FLEX quote number like 26-1747 or enough of a quote name to search for it.",
      };
    }

    const searchResult = await searchFlexQuotes(searchQuery, {
      limit: 15,
      enrichLimit: 40,
      filters: searchFilters,
    });

    if (searchResult.matches.length !== 1) {
      return buildQuoteSearchSelectionResponse(
        question,
        intent,
        searchQuery,
        searchResult
      );
    }

    const match = searchResult.matches[0];

    quoteLookup = {
      documentNumber: match.documentNumber,
      found: true,
      elementId: match.elementId,
      name: match.name,
      type: match.type || null,
      matches: searchResult.matches,
      requestUrl: searchResult.requestUrl,
      rawCount: searchResult.rawCount,
      searchQuery,
    };
  }

  const intake = await fetchFlexShowIntake(quoteLookup.elementId);
  const detail = buildFlexDocumentDetail(intake);

  if (intent === "document_operational_analysis") {
    const result = await buildAskFlexOperationalAnalysis(detail, question);

    return {
      question,
      intent,
      documentNumber:
        detail.showContext?.documentNumber ||
        documentNumber ||
        quoteLookup.documentNumber ||
        null,
      found: true,
      elementId: quoteLookup.elementId,
      showContext: detail.showContext,
      answer: result.assessment,
      result,
      supportingData: {
        summary: detail.summary,
        counts: detail.counts,
      },
      lookup: quoteLookup,
    };
  }

  const result = buildFlexAskAnswer(intent, detail, question);

  return {
    question,
    intent,
    documentNumber: detail.showContext?.documentNumber || documentNumber || quoteLookup.documentNumber || null,
    found: true,
    elementId: quoteLookup.elementId,
    showContext: detail.showContext,
    answer: result.answer,
    result,
    supportingData: {
      summary: detail.summary,
      counts: detail.counts,
      laborItems: intent === "document_labor" ? detail.laborItems : undefined,
      transportationItems:
        intent === "document_transportation" ? detail.transportationItems : undefined,
      inventoryItems:
        intent === "document_inventory" || intent === "document_item_search" ? detail.inventoryItems : undefined,
    },
    lookup: quoteLookup,
  };
}


/**
 * CUE product-rule post-processing.
 * This makes output more reliable than prompt-only behavior.
 */
function normalizeCueAnalysis(analysis, payload) {
  const normalized = {
    summary: analysis?.summary || "",
    cue_review_cards: Array.isArray(analysis?.cue_review_cards)
      ? analysis.cue_review_cards
      : [],
    questions_for_pm: Array.isArray(analysis?.questions_for_pm)
      ? analysis.questions_for_pm
      : [],
    recommended_next_actions: Array.isArray(analysis?.recommended_next_actions)
      ? analysis.recommended_next_actions
      : [],
  };

  const showContext = payload?.show_context || {};
  const projectManager = showContext.projectManager;
  const hasProjectManager =
    projectManager != null &&
    String(projectManager).trim() !== "" &&
    String(projectManager).trim() !== "—";

  const allLineItems = [
    ...(Array.isArray(payload?.staffing) ? payload.staffing : []),
    ...(Array.isArray(payload?.trucking) ? payload.trucking : []),
  ];

  const explicitDriverLineExists = allLineItems.some((item) =>
    /\b(driver|cdl|truck driver)\b/i.test(String(item?.name || ""))
  );

  normalizeOwners(normalized, hasProjectManager, projectManager);
  normalizeComplexityCards(normalized);
  removeInvalidPmQuestions(normalized, hasProjectManager);
  removeExtraPmSupportQuestions(normalized, hasProjectManager);
  removeDriverMentionsWhenNoExplicitDriver(normalized, explicitDriverLineExists);
  normalizeStaffingTruckingStatuses(normalized);

  return normalized;
}

function normalizeOwners(analysis, hasProjectManager, projectManager) {
  for (const card of analysis.cue_review_cards) {
    const type = String(card.card_type || "").toLowerCase();

    if (type === "staffing") {
      card.owner = "Staffing Coordinator";
    }

    if (type === "trucking") {
      card.owner = "Brian Kee / Trucking Coordinator";
    }

    if (type === "show_context") {
      card.owner = hasProjectManager
        ? `${projectManager} / Project Manager`
        : "Operations Review";
    }

    if (type === "coordination") {
      card.owner = hasProjectManager
        ? `${projectManager} / Project Manager`
        : "Operations Review";
    }
  }
}

function normalizeComplexityCards(analysis) {
  const complexityPattern =
    /\b(complexity|coordination|pm recommendation|project manager recommendation|large equipment|large pa|warehouse coordination|trucking coordination|multi-day|multiple trucks|festival|load-in|load-out|equipment scope|rigging|fiber|power distribution|delay|fill)\b/i;

  for (const card of analysis.cue_review_cards) {
    const combinedText = [
      card.card_type,
      card.title,
      card.summary,
      ...(Array.isArray(card.risks) ? card.risks : []),
      ...(Array.isArray(card.recommended_actions)
        ? card.recommended_actions
        : []),
    ]
      .filter(Boolean)
      .join(" ");

    const type = String(card.card_type || "").toLowerCase();

    if (
      (type === "risk" || type === "next_actions") &&
      complexityPattern.test(combinedText)
    ) {
      card.card_type = "coordination";
      card.status = "review_needed";
      card.priority = card.priority || "medium";

      if (/risk/i.test(String(card.title || ""))) {
        card.title = card.title.replace(/risk/gi, "Coordination").trim();
      }

      if (!card.title || card.title.toLowerCase().includes("operational complexity")) {
        card.title = "Operational Coordination Review";
      }

      card.risks = Array.isArray(card.risks) ? card.risks : [];
    }
  }
}

function removeInvalidPmQuestions(analysis, hasProjectManager) {
  if (!hasProjectManager) return;

  const pmMissingPattern =
    /\b(no|not|none|missing|unassigned)\b.*\b(project manager|pm)\b|\b(project manager|pm)\b.*\b(no|not|none|missing|unassigned)\b/i;

  analysis.questions_for_pm = analysis.questions_for_pm.filter(
    (question) => !pmMissingPattern.test(String(question || ""))
  );

  analysis.recommended_next_actions = analysis.recommended_next_actions.filter(
    (action) => !pmMissingPattern.test(String(action || ""))
  );

  for (const card of analysis.cue_review_cards) {
    card.risks = Array.isArray(card.risks)
      ? card.risks.filter((risk) => !pmMissingPattern.test(String(risk || "")))
      : [];

    card.recommended_actions = Array.isArray(card.recommended_actions)
      ? card.recommended_actions.filter(
          (action) => !pmMissingPattern.test(String(action || ""))
        )
      : [];

    if (pmMissingPattern.test(String(card.summary || ""))) {
      card.summary = card.summary
        .replace(/No project manager is assigned\.?/gi, "")
        .replace(/No PM is assigned\.?/gi, "")
        .trim();
    }
  }
}

function removeExtraPmSupportQuestions(analysis, hasProjectManager) {
  if (!hasProjectManager) return;

  const extraPmSupportPattern =
    /\b(additional|extra|more|support)\b.*\b(pm|project manager|project management)\b|\b(pm|project manager|project management)\b.*\b(additional|extra|more|support)\b/i;

  analysis.questions_for_pm = analysis.questions_for_pm.filter(
    (question) => !extraPmSupportPattern.test(String(question || ""))
  );

  analysis.recommended_next_actions = analysis.recommended_next_actions.map((action) => {
    const text = String(action || "");

    if (extraPmSupportPattern.test(text)) {
      return "Assigned PM to review coordination needs across staffing, trucking, warehouse, venue access, equipment scope, and load-in/load-out timing.";
    }

    return action;
  });

  for (const card of analysis.cue_review_cards) {
    card.recommended_actions = Array.isArray(card.recommended_actions)
      ? card.recommended_actions.map((action) => {
          const text = String(action || "");

          if (extraPmSupportPattern.test(text)) {
            return "Assigned PM to review coordination needs across staffing, trucking, warehouse, venue access, equipment scope, and load-in/load-out timing.";
          }

          return action;
        })
      : [];

    if (extraPmSupportPattern.test(String(card.summary || ""))) {
      card.summary = card.summary
        .replace(/Are additional PM resources or support needed\??/gi, "")
        .replace(/additional PM resources or support/gi, "assigned PM coordination")
        .trim();
    }
  }
}

function removeDriverMentionsWhenNoExplicitDriver(
  analysis,
  explicitDriverLineExists
) {
  if (explicitDriverLineExists) return;

  const driverMentionPattern =
    /\b(driver|drivers|driver labor|driver assignment|driver confirmation|driver coverage|missing driver|driver line|driver lines|driver-related)\b/i;

  const stripDriverSentence = (text) => {
    if (!text || typeof text !== "string") return text;

    return text
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !driverMentionPattern.test(sentence))
      .join(" ")
      .trim();
  };

  analysis.summary = stripDriverSentence(analysis.summary);

  analysis.questions_for_pm = analysis.questions_for_pm.filter(
    (question) => !driverMentionPattern.test(String(question || ""))
  );

  analysis.recommended_next_actions = analysis.recommended_next_actions.filter(
    (action) => !driverMentionPattern.test(String(action || ""))
  );

  for (const card of analysis.cue_review_cards) {
    card.summary = stripDriverSentence(card.summary);

    card.risks = Array.isArray(card.risks)
      ? card.risks.filter((risk) => !driverMentionPattern.test(String(risk || "")))
      : [];

    card.recommended_actions = Array.isArray(card.recommended_actions)
      ? card.recommended_actions.filter(
          (action) => !driverMentionPattern.test(String(action || ""))
        )
      : [];

    card.detected_items = Array.isArray(card.detected_items)
      ? card.detected_items.map((item) => ({
          ...item,
          interpretation: stripDriverSentence(item.interpretation),
        }))
      : [];
  }
}

function normalizeStaffingTruckingStatuses(analysis) {
  for (const card of analysis.cue_review_cards) {
    const type = String(card.card_type || "").toLowerCase();
    const detectedItems = Array.isArray(card.detected_items)
      ? card.detected_items
      : [];

    if (
      (type === "staffing" || type === "trucking") &&
      detectedItems.length > 0 &&
      String(card.status || "").toLowerCase() === "passed"
    ) {
      card.status = "review_needed";
    }
  }
}

function selectCueModel(requestBody, payloadFallback = {}) {
  const requestedAiMode = String(
    requestBody?.aiMode ||
      requestBody?.mode ||
      payloadFallback?.aiMode ||
      payloadFallback?.mode ||
      "advanced"
  ).toLowerCase();

  const currentModel = process.env.OPENAI_CURRENT_MODEL || "gpt-4.1-mini";
  const advancedModel = process.env.OPENAI_ADVANCED_MODEL || "gpt-5.4";
  const model = requestedAiMode === "current" ? currentModel : advancedModel;

  return {
    requestedAiMode,
    currentModel,
    advancedModel,
    model
  };
}

function normalizeOperationalSummaryShape(summary, fallbackSummary) {
  const base = summary && typeof summary === "object" ? summary : {};
  const fallback = fallbackSummary && typeof fallbackSummary === "object" ? fallbackSummary : {};

  const modelRecommendedSteps = Array.isArray(base.recommendedNextSteps)
    ? base.recommendedNextSteps
    : Array.isArray(base.recommended_next_steps)
      ? base.recommended_next_steps
      : [];

  const recommendedNextSteps = modelRecommendedSteps
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    ;

  let complexityLevel = String(base.complexityLevel || base.complexity_level || "").trim();
  if (!["Low", "Medium", "High"].includes(complexityLevel)) {
    complexityLevel = String(fallback.complexityLevel || "Medium");
    if (!["Low", "Medium", "High"].includes(complexityLevel)) {
      complexityLevel = "Medium";
    }
  }

  const assessmentFromModel =
    String(base.assessment || "").trim();
  const coordinationFromModel =
    String(base.coordinationRequired || base.coordination_required || "").trim();
  const usedFallback =
    !assessmentFromModel ||
    recommendedNextSteps.length === 0 ||
    !coordinationFromModel;

  return {
    assessment:
      assessmentFromModel ||
      String(fallback.assessment || "").trim() ||
      "Operational summary is available after FLEX intake review.",
    recommendedNextSteps:
      recommendedNextSteps.length > 0
        ? recommendedNextSteps
        : Array.isArray(fallback.recommendedNextSteps)
          ? fallback.recommendedNextSteps
          : [],
    complexityLevel,
    coordinationRequired:
      coordinationFromModel ||
      String(fallback.coordinationRequired || "").trim() ||
      "Staffing + Trucking",
    source: usedFallback ? "local_fallback" : "openai"
  };
}


function getCookieValue(req, cookieName) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = cookieHeader.split(";").map((item) => item.trim());

  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split("=");

    if (name === cookieName) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return "";
}

function getPilotSessionToken() {
  return crypto
    .createHash("sha256")
    .update(`${CUE_PILOT_PASSWORD}|${CUE_PILOT_SESSION_SECRET}`)
    .digest("hex");
}

function isPilotAuthorized(req) {
  if (!CUE_PILOT_PASSWORD) return true;

  const token = getCookieValue(req, "cue_pilot_auth");

  return token && token === getPilotSessionToken();
}

function isAutomationAuthorized(req, url) {
  const configuredToken = process.env.CUE_AUTOMATION_TOKEN || "";

  if (!configuredToken) return false;

  const queryToken = url.searchParams.get("automationToken") || "";
  const headerToken = req.headers["x-cue-automation-token"] || "";

  return queryToken === configuredToken || headerToken === configuredToken;
}

function isAutomationAllowedPath(pathname) {
  return [
    "/api/flex/monthly-sales",
    "/api/flex/sales-goals-rollup",
    "/api/flex/sales-goals-row",
    "/api/flex/document-detail",
    "/api/flex/event-folder",
    "/api/flex/find-quote",
    "/api/flex/search-quotes",
    "/api/flex/ask",
    "/api/flex/ask-brief",
    "/api/flex/review-snapshots",
    "/api/flex/review-snapshots/latest",
    "/api/flex/review-snapshots/compare",
    "/api/slack-operational-signals/sync",
    "/api/slack-operational-signals/status",
    "/api/slack-operational-signals/show",
    "/api/slack-operational-signals/review",
    "/api/slack-operational-signals/review/approve",
    "/api/slack-operational-signals/review/reject",
    "/api/slack-operational-signals/general",
    "/api/slack-operational-signals/rematch",
    "/api/foundation/source-first/sync",
    "/api/foundation/flex/lifecycle/discover",
    "/api/foundation/flex/lifecycle/status",
    "/api/foundation/flex/confirmed-snapshot/sync",
    "/api/foundation/flex/confirmed-snapshot/status",
  ].includes(pathname);
}

function renderLoginPage(message = "") {
  const escapedMessage = String(message || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CUE Private Pilot</title>
  <style>
    :root {
      --bg: #020403;
      --border: rgba(128, 255, 153, 0.18);
      --text: #f4fff7;
      --muted: #9bb5aa;
      --green: #43d154;
      --cyan: #00d5e8;
      --danger: #ff6b6b;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 20%, rgba(67, 209, 84, 0.12), transparent 32%),
        radial-gradient(circle at 80% 40%, rgba(0, 213, 232, 0.08), transparent 28%),
        var(--bg);
    }

    .shell {
      width: min(520px, calc(100vw - 32px));
      border: 1px solid var(--border);
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(11, 21, 18, 0.96), rgba(4, 8, 7, 0.96));
      box-shadow: 0 0 80px rgba(67, 209, 84, 0.10);
      padding: 34px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 26px;
    }

    .mark {
      width: 46px;
      height: 46px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      color: var(--green);
      background: rgba(67, 209, 84, 0.16);
      font-weight: 900;
      letter-spacing: -0.02em;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.05;
    }

    .subtitle {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .pill {
      display: inline-flex;
      margin-bottom: 22px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(0, 213, 232, 0.24);
      background: rgba(0, 213, 232, 0.08);
      color: #b9f8ff;
      font-size: 13px;
    }

    label {
      display: block;
      color: var(--muted);
      font-size: 14px;
      margin-bottom: 8px;
    }

    input {
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--text);
      font-size: 18px;
      padding: 14px 16px;
      outline: none;
    }

    input:focus {
      border-color: rgba(67, 209, 84, 0.65);
      box-shadow: 0 0 0 4px rgba(67, 209, 84, 0.10);
    }

    button {
      width: 100%;
      margin-top: 16px;
      border: 0;
      border-radius: 16px;
      background: var(--green);
      color: #041006;
      font-weight: 800;
      font-size: 16px;
      padding: 14px 16px;
      cursor: pointer;
    }

    .message {
      min-height: 20px;
      margin-top: 14px;
      color: var(--danger);
      font-size: 14px;
    }

    .note {
      margin-top: 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 18px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="brand">
      <div class="mark">C</div>
      <div>
        <h1>CUE Private Pilot</h1>
        <p class="subtitle">Crew Utilization Engine</p>
      </div>
    </div>

    <div class="pill">Private access · Real FLEX data</div>

    <form method="POST" action="/api/login">
      <label for="password">Access password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">Enter Private Pilot</button>
      <div class="message">${escapedMessage}</div>
    </form>

    <div class="note">
      This pilot can pull live FLEX show intake data and generate CUE review cards. Access is limited to approved Music Matters stakeholders.
    </div>
  </main>
</body>
</html>`;
}

function redirectToLogin(res) {
  res.writeHead(302, {
    Location: "/login",
    "Cache-Control": "no-store",
  });
  res.end();
}


const TRUCKING_SHEET_ID =
  process.env.TRUCKING_SHEET_ID || "1CY6wk2Heuw0JxO4inMaLnCd9bhCQa4NpLuAG9FO6nDo";

const TRUCKING_WEEKLY_RUNS_SHEET =
  process.env.TRUCKING_WEEKLY_RUNS_SHEET || "Weekly Runs";

function parseCsvRows(csvText) {
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
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      row.push(value);
      value = "";

      if (row.some((cell) => String(cell || "").trim() !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    value += char;
  }

  row.push(value);

  if (row.some((cell) => String(cell || "").trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeaderKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function rowsToObjects(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const headerRowIndex = rows.findIndex((row) =>
    row.some((cell) => /quote|runs|driver|truck|trailer|info|lpo/i.test(String(cell || "")))
  );

  if (headerRowIndex < 0) return [];

  const headers = rows[headerRowIndex].map((header) => String(header || "").trim());
  const dataRows = rows.slice(headerRowIndex + 1);

  return dataRows.map((row) => {
    const object = {};

    headers.forEach((header, index) => {
      const key = normalizeHeaderKey(header);
      if (!key) return;
      object[key] = row[index] || "";
      object[header] = row[index] || "";
    });

    return object;
  });
}

function getFirstCell(row, names) {
  for (const name of names) {
    const key = normalizeHeaderKey(name);

    if (row[key] != null && String(row[key]).trim() !== "") {
      return row[key];
    }

    if (row[name] != null && String(row[name]).trim() !== "") {
      return row[name];
    }
  }

  return "";
}

function safeIncludes(haystack, needle) {
  if (!needle) return false;
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

async function fetchWeeklyRunsRowsFromGoogleSheet() {
  const sheetName = encodeURIComponent(TRUCKING_WEEKLY_RUNS_SHEET);

  const urls = [
    `https://docs.google.com/spreadsheets/d/${TRUCKING_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${sheetName}`,
    `https://docs.google.com/spreadsheets/d/${TRUCKING_SHEET_ID}/export?format=csv&sheet=${sheetName}`,
  ];

  let lastError = null;

  for (const csvUrl of urls) {
    try {
      console.log("[TRUCKING SHEET]", TRUCKING_WEEKLY_RUNS_SHEET);

      const response = await fetch(csvUrl);
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`Google Sheets CSV request failed: ${response.status} ${response.statusText}`);
      }

      if (/<!doctype html>|<html/i.test(text)) {
        throw new Error("Google Sheets returned HTML instead of CSV. The sheet may not be accessible to this local server.");
      }

      const csvRows = parseCsvRows(text);
      const rowObjects = rowsToObjects(csvRows);

      if (!rowObjects.length) {
        throw new Error("No parseable Weekly Runs rows found in CSV.");
      }

      return rowObjects;
    } catch (error) {
      lastError = error;
      console.warn("[TRUCKING SHEET WARNING]", error.message);
    }
  }

  throw lastError || new Error("Unable to fetch Weekly Runs CSV.");
}

function normalizeLiveTruckingRow(row) {
  const quote = getFirstCell(row, ["QUOTE", "Quote", "quote", "Job", "Job #"]);
  const runName = getFirstCell(row, ["Runs", "Run", "Run Name", "run"]);
  const date = getFirstCell(row, ["Date", "date"]);
  const when = getFirstCell(row, ["When", "Time", "when"]);
  const truck = getFirstCell(row, ["Truck", "truck", "Unit"]);
  const trailer = getFirstCell(row, ["Trailer", "trailer"]);
  const where = getFirstCell(row, ["Where", "Location", "Venue", "where"]);
  const stage = getFirstCell(row, ["Stage", "stage"]);
  const notes = getFirstCell(row, ["Notes", "Note", "notes"]);

  const driverName = getFirstCell(row, [
    "Who",
    "Driver",
    "Driver Name",
    "Name",
  ]);

  const driverConfirmedRaw = getFirstCell(row, [
    "Driver Confirmed",
    "Driver Confirmed?",
    "Confirmed",
  ]) || driverName;

  const infoSentRaw = getFirstCell(row, [
    "Info Sent",
    "Info Sent?",
    "Info",
  ]);

  const lpoSentRaw = getFirstCell(row, [
    "LPO Sent",
    "LPO Sent?",
    "LPO",
  ]);

  const combined = `${runName} ${notes} ${truck} ${trailer} ${where} ${stage}`;

  return {
    quote: String(quote || "").trim(),
    driverName: String(driverName || "").trim(),
    runName: String(runName || "").trim(),
    date: String(date || "").trim(),
    when: String(when || "").trim(),
    driverConfirmed: normalizeTruckingBoolean(driverConfirmedRaw),
    infoSent: normalizeTruckingBoolean(infoSentRaw),
    lpoSent: normalizeTruckingBoolean(lpoSentRaw),
    truck: String(truck || "").trim(),
    trailer: String(trailer || "").trim(),
    where: String(where || "").trim(),
    stage: String(stage || "").trim(),
    maybeTruck: /maybe truck/i.test(combined),
    needDriver: /need driver/i.test(combined),
    notes: String(notes || "").trim(),
  };
}

async function matchLiveTruckingRows({ showId, showName, quoteNumbers }) {
  const quoteSet = new Set(
    (Array.isArray(quoteNumbers) ? quoteNumbers : [])
      .map((quote) => String(quote || "").trim())
      .filter(Boolean)
  );

  const weeklyRunsRows = await fetchWeeklyRunsRowsFromGoogleSheet();

  const showWords = String(showName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4);

  const matchedRows = weeklyRunsRows
    .map(normalizeLiveTruckingRow)
    .filter((row) => {
      const quoteMatch = row.quote && quoteSet.has(row.quote);

      const nameText = `${row.runName} ${row.where} ${row.stage} ${row.notes}`.toLowerCase();
      const nameMatch =
        showWords.length >= 2 &&
        showWords.filter((word) => nameText.includes(word)).length >= 2;

      return quoteMatch || nameMatch;
    });

  return matchedRows;
}

async function matchTruckingRowsWithFallback({ showId, showName, quoteNumbers }) {
  try {
    const liveRows = await matchLiveTruckingRows({
      showId,
      showName,
      quoteNumbers,
    });

    return {
      source: "Trucking Schedule / Weekly Runs",
      safeRows: liveRows,
      usedFallback: false,
    };
  } catch (error) {
    console.warn("[TRUCKING FALLBACK]", error.message);

    return {
      source: "trucking-weekly-runs-safe-mock",
      safeRows: matchSafeTruckingRows({
        showId,
        showName,
        quoteNumbers,
      }),
      usedFallback: true,
      fallbackReason: error.message,
    };
  }
}


const SAFE_TRUCKING_ROWS = [
  // Desibels Raleigh
  {
    quote: "26-1603",
    driverName: "Driver assigned",
    showKey: "desibels-raleigh",
    runName: "Desibels Raleigh - Lighting & Rigging",
    date: "7/3",
    when: "LI: 6 AM LO: 11 PM",
    driverConfirmed: true,
    infoSent: true,
    lpoSent: true,
    truck: "Salem Sleeper 20528 #2",
    trailer: "5320 Dock 7",
    where: "Martin Marietta Center for the Performing Arts, Raleigh, NC",
    notes: "Driver/truck mapped; Info and LPO sent."
  },
  {
    quote: "26-1624",
    driverName: "Driver assigned",
    showKey: "desibels-raleigh",
    runName: "Desibels Raleigh - Audio & Video",
    date: "7/3",
    when: "LI: 7 AM LO: 11 PM",
    driverConfirmed: true,
    infoSent: true,
    lpoSent: true,
    truck: "1108",
    trailer: "5316 Dock 14",
    where: "Martin Marietta Center for the Performing Arts, Raleigh, NC",
    notes: "Driver/truck mapped; Info and LPO sent."
  },

  // Production Design Associates
  {
    quote: "26-1777",
    driverName: "Geneva Gardner",
    showKey: "production-design-associates",
    runName: "Production Design Associates - Depart / Charleston",
    date: "7/5",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: true,
    truck: "2605",
    trailer: "",
    where: "Credit One Stadium / Charleston",
    notes: "Trucking begins before folder date suggests."
  },
  {
    quote: "26-1777",
    driverName: "Geneva Gardner",
    showKey: "production-design-associates",
    runName: "Production Design Associates - Load In",
    date: "7/6",
    when: "LI",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: true,
    truck: "2605",
    trailer: "",
    where: "Credit One Stadium / Charleston",
    notes: "Info Sent remains false."
  },
  {
    quote: "26-1777",
    driverName: "Geneva Gardner",
    showKey: "production-design-associates",
    runName: "Production Design Associates - Load Out",
    date: "7/7",
    when: "LO",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: true,
    truck: "2605",
    trailer: "",
    where: "Credit One Stadium / Charleston",
    notes: "Info Sent remains false."
  },

  // Sound Haven
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LI Continuum - SL320 - Sound Haven",
    date: "7/27",
    when: "LI: 8 AM",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "Tractor",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    notes: "Info/LPO false."
  },
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LI Continuum - SL320 - Sound Haven - Flatbed",
    date: "7/27",
    when: "LI: 8 AM",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "Tractor",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    notes: "Info/LPO false."
  },
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LI Continuum - SL320 - Sound Haven - Maybe Truck",
    date: "7/27",
    when: "LI: 12 PM",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "26",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    maybeTruck: true,
    notes: "Maybe Truck unresolved."
  },
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LO Continuum - SL320 - Sound Haven",
    date: "8/3",
    when: "TBD",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "Tractor",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    notes: "Load-out timing/confirmation still needs review."
  },
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LO Continuum - SL320 - Sound Haven - Flatbed",
    date: "8/3",
    when: "TBD",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "Tractor",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    needDriver: true,
    notes: "NEED DRIVER."
  },
  {
    quote: "26-1421",
    driverName: "TBD",
    showKey: "sound-haven",
    runName: "LO Continuum - SL320 - Sound Haven - Maybe Truck",
    date: "8/3",
    when: "TBD",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "26",
    trailer: "",
    where: "Sound Haven, Gruetli-Laager, TN",
    maybeTruck: true,
    notes: "Maybe Truck unresolved."
  },

  // Summer X Games
  ...["26-0714", "26-0715", "26-0716"].flatMap((quote) => [
    {
      quote,
      showKey: "summer-x-games-nola",
      runName: `Departs Summer X Games // NOLA 26 - ${quote}`,
      date: "7/22",
      when: "AM",
      driverConfirmed: true,
      infoSent: false,
      lpoSent: false,
      truck: "Sleeper",
      trailer: "53",
      where: "Smoothie King Arena, New Orleans, LA",
      notes: "Main truck mapped; Info/LPO false."
    },
    {
      quote,
      showKey: "summer-x-games-nola",
      runName: `LI Summer X Games // NOLA 26 - ${quote}`,
      date: "7/23",
      when: "8:00 AM",
      driverConfirmed: true,
      infoSent: false,
      lpoSent: false,
      truck: "Sleeper",
      trailer: "53",
      where: "Smoothie King Arena, New Orleans, LA",
      notes: "Main truck mapped; Info/LPO false."
    },
    {
      quote,
      showKey: "summer-x-games-nola",
      runName: `LO Summer X Games // NOLA 26 - ${quote}`,
      date: "7/25",
      when: "11:00 PM",
      driverConfirmed: true,
      infoSent: false,
      lpoSent: false,
      truck: "Sleeper",
      trailer: "53",
      where: "Smoothie King Arena, New Orleans, LA",
      notes: "Main truck mapped; Info/LPO false."
    }
  ]),
  {
    quote: "26-0717",
    driverName: "TBD",
    showKey: "summer-x-games-nola",
    runName: "Departs Summer X Games // NOLA 26 - Maybe Truck",
    date: "7/22",
    when: "AM",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "Sleeper",
    trailer: "53",
    where: "Smoothie King Arena, New Orleans, LA",
    maybeTruck: true,
    notes: "Maybe Truck unresolved."
  },
  {
    quote: "26-0717",
    driverName: "TBD",
    showKey: "summer-x-games-nola",
    runName: "LI Summer X Games // NOLA 26 - Maybe Truck",
    date: "7/23",
    when: "8:00 AM",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "Sleeper",
    trailer: "53",
    where: "Smoothie King Arena, New Orleans, LA",
    maybeTruck: true,
    notes: "Maybe Truck unresolved."
  },
  {
    quote: "26-0717",
    driverName: "TBD",
    showKey: "summer-x-games-nola",
    runName: "LO Summer X Games // NOLA 26 - Maybe Truck",
    date: "7/25",
    when: "11:00 PM",
    driverConfirmed: false,
    infoSent: false,
    lpoSent: false,
    truck: "Sleeper",
    trailer: "53",
    where: "Smoothie King Arena, New Orleans, LA",
    maybeTruck: true,
    notes: "Maybe Truck unresolved."
  },

  // FIFA / early mock signal rows. Phase 2 will replace this with the live sheet.
  {
    quote: "26-0071",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "FIFA Finals Watch Party / Piedmont Park",
    date: "7/18",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "TBD",
    trailer: "",
    where: "Piedmont Park / Atlanta",
    notes: "FIFA row mapped; Info/LPO false."
  },
  {
    quote: "26-1752",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "Stage 2 Audio - FIFA Finals Watch Party",
    date: "7/18",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "TBD",
    trailer: "",
    where: "Piedmont Park / Atlanta",
    notes: "FIFA Stage 2 Audio trucking mapped; Info/LPO false."
  },
  {
    quote: "26-1759",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "Stage 2 Video - FIFA Finals Watch Party",
    date: "7/18",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "TBD",
    trailer: "",
    where: "Piedmont Park / Atlanta",
    notes: "FIFA Stage 2 Video trucking mapped; Info/LPO false."
  },
  {
    quote: "26-1804",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "WAC FIFA Watch Party / Calaway Plaza",
    date: "7/9",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "16' Box Truck",
    trailer: "",
    where: "Woodruff Arts Center",
    notes: "WAC FIFA row mapped; Info/LPO false."
  },
  {
    quote: "26-1225",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "FIFA @ Coca-Cola / Centennial Park",
    date: "6/4",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "26' Box Truck",
    trailer: "",
    where: "Centennial Park / Atlanta",
    notes: "Filmworks/Coke row mapped; Info/LPO false."
  },
  {
    quote: "26-1637",
    driverName: "Driver assigned",
    showKey: "fifa-final-piedmont",
    runName: "FIFA Viewing HQ - Video Distribution",
    date: "6/9",
    when: "TBD",
    driverConfirmed: true,
    infoSent: false,
    lpoSent: false,
    truck: "TBD",
    trailer: "",
    where: "FIFA Viewing HQ",
    notes: "HQ video distribution row mapped; Info/LPO false."
  }
];

function normalizeTruckingBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "y";
}

function summarizeTruckingRows(rows, quoteNumbers = []) {
  const safeRows = Array.isArray(rows) ? rows : [];

  const summary = {
    rowsFound: safeRows.length,
    quoteNumbersRequested: quoteNumbers,
    quoteNumbersMatched: [...new Set(safeRows.map((row) => row.quote).filter(Boolean))],
    driverConfirmedTrue: 0,
    driverConfirmedFalse: 0,
    infoSentTrue: 0,
    infoSentFalse: 0,
    lpoSentTrue: 0,
    lpoSentFalse: 0,
    maybeTruckRows: 0,
    needDriverRows: 0,
    tbdRows: 0,
    dates: [...new Set(safeRows.map((row) => row.date).filter(Boolean))],
  };

  for (const row of safeRows) {
    if (normalizeTruckingBoolean(row.driverConfirmed)) {
      summary.driverConfirmedTrue += 1;
    } else {
      summary.driverConfirmedFalse += 1;
    }

    if (normalizeTruckingBoolean(row.infoSent)) {
      summary.infoSentTrue += 1;
    } else {
      summary.infoSentFalse += 1;
    }

    if (normalizeTruckingBoolean(row.lpoSent)) {
      summary.lpoSentTrue += 1;
    } else {
      summary.lpoSentFalse += 1;
    }

    if (row.maybeTruck || /maybe truck/i.test(String(row.runName || ""))) {
      summary.maybeTruckRows += 1;
    }

    if (row.needDriver || /need driver/i.test(String(row.runName || row.notes || ""))) {
      summary.needDriverRows += 1;
    }

    if (/tbd/i.test(String(row.when || row.truck || row.notes || ""))) {
      summary.tbdRows += 1;
    }
  }

  let status = "GREEN - Trucking aligned";
  const findings = [];
  const actions = [];

  if (summary.rowsFound === 0) {
    status = "MAGENTA - No Music Matters trucking action found";
    findings.push(
      "No Music Matters trucking action found in Weekly Runs for the requested quote numbers or show name. This may be normal if transportation is not required yet, is TBD, or is vendor-managed."
    );
    actions.push(
      "Confirm whether Music Matters trucking should exist in Weekly Runs, or whether transportation is intentionally not required yet."
    );
  } else {
    findings.push(`${summary.rowsFound} trucking row${summary.rowsFound === 1 ? "" : "s"} found.`);
    findings.push(`${summary.quoteNumbersMatched.length} quote number${summary.quoteNumbersMatched.length === 1 ? "" : "s"} matched in trucking.`);

    if (summary.infoSentFalse > 0) {
      status = "MAGENTA - Trucking admin incomplete";
      findings.push(`${summary.infoSentFalse} row${summary.infoSentFalse === 1 ? "" : "s"} still have Info Sent = FALSE.`);
      actions.push("Brian Kee / PM to confirm Info Sent status.");
    }

    if (summary.lpoSentFalse > 0) {
      status = "MAGENTA - Trucking admin incomplete";
      findings.push(`${summary.lpoSentFalse} row${summary.lpoSentFalse === 1 ? "" : "s"} still have LPO Sent = FALSE.`);
      actions.push("Brian Kee / PM to confirm LPO Sent status.");
    }

    if (summary.maybeTruckRows > 0) {
      status = "MAGENTA - Maybe Truck unresolved";
      findings.push(`${summary.maybeTruckRows} Maybe Truck row${summary.maybeTruckRows === 1 ? "" : "s"} found.`);
      actions.push("Resolve Maybe Truck rows or mark them not needed.");
    }

    if (summary.needDriverRows > 0) {
      status = "RED - NEED DRIVER";
      findings.push(`${summary.needDriverRows} NEED DRIVER row${summary.needDriverRows === 1 ? "" : "s"} found.`);
      actions.push("Assign/confirm driver coverage for NEED DRIVER rows.");
    }
  }

  return {
    ...summary,
    status,
    findings,
    actions,
  };
}


function buildFlexVsTruckingComparison({ quoteNumbers, truckingSummary }) {
  const requestedQuotes = [...new Set(
    (Array.isArray(quoteNumbers) ? quoteNumbers : [])
      .map((quote) => String(quote || "").trim())
      .filter(Boolean)
  )];

  const matchedQuotes = truckingSummary?.quoteNumbersMatched || [];
  const rowsFound = Number(truckingSummary?.rowsFound || 0);
  const infoFalse = Number(truckingSummary?.infoSentFalse || 0);
  const lpoFalse = Number(truckingSummary?.lpoSentFalse || 0);
  const maybeTruckRows = Number(truckingSummary?.maybeTruckRows || 0);
  const needDriverRows = Number(truckingSummary?.needDriverRows || 0);

  const missingQuotes = requestedQuotes.filter(
    (quote) => !matchedQuotes.includes(quote)
  );

  let status = "GREEN - FLEX and trucking aligned";
  const findings = [];
  const actions = [];

  findings.push(`FLEX quote/workstream hints checked: ${requestedQuotes.length}.`);
  findings.push(`Trucking matched ${matchedQuotes.length} quote number${matchedQuotes.length === 1 ? "" : "s"}.`);
  findings.push(`Weekly Runs returned ${rowsFound} row${rowsFound === 1 ? "" : "s"}.`);

  if (requestedQuotes.length > 0 && matchedQuotes.length === 0) {
    status = "RED - FLEX transport not represented in trucking";
    findings.push("No trucking rows matched the requested FLEX quote numbers.");
    actions.push("Brian Kee / PM to confirm whether transportation rows need to be created or linked.");
  } else if (missingQuotes.length > 0) {
    status = "MAGENTA - Some FLEX quotes missing trucking rows";
    findings.push(`Missing trucking matches for: ${missingQuotes.join(", ")}.`);
    actions.push("Confirm whether each missing quote has transportation scope or should be excluded from trucking.");
  }

  if (infoFalse > 0 || lpoFalse > 0) {
    if (!status.startsWith("RED")) {
      status = "MAGENTA - Trucking mapped, admin incomplete";
    }

    if (infoFalse > 0) {
      findings.push(`${infoFalse} trucking row${infoFalse === 1 ? "" : "s"} still have Info Sent = FALSE.`);
      actions.push("Confirm Info Sent status for incomplete trucking rows.");
    }

    if (lpoFalse > 0) {
      findings.push(`${lpoFalse} trucking row${lpoFalse === 1 ? "" : "s"} still have LPO Sent = FALSE.`);
      actions.push("Confirm LPO Sent status for incomplete trucking rows.");
    }
  }

  if (maybeTruckRows > 0) {
    if (!status.startsWith("RED")) {
      status = "MAGENTA - Maybe Truck unresolved";
    }

    findings.push(`${maybeTruckRows} Maybe Truck row${maybeTruckRows === 1 ? "" : "s"} found.`);
    actions.push("Resolve Maybe Truck rows or mark them not needed.");
  }

  if (needDriverRows > 0) {
    status = "RED - NEED DRIVER";
    findings.push(`${needDriverRows} NEED DRIVER row${needDriverRows === 1 ? "" : "s"} found.`);
    actions.push("Assign/confirm driver coverage for NEED DRIVER rows.");
  }

  if (status.startsWith("GREEN")) {
    findings.push("FLEX transportation appears represented in Weekly Runs with no current trucking exceptions.");
    actions.push("No trucking action required beyond normal monitoring.");
  }

  return {
    status,
    requestedQuotes,
    matchedQuotes,
    missingQuotes,
    rowsFound,
    infoFalse,
    lpoFalse,
    maybeTruckRows,
    needDriverRows,
    findings,
    actions,
  };
}

function matchSafeTruckingRows({ showId, showName, quoteNumbers }) {
  const quotes = (Array.isArray(quoteNumbers) ? quoteNumbers : [])
    .map((quote) => String(quote || "").trim())
    .filter(Boolean);

  const nameText = String(showName || "").toLowerCase();
  const showIdText = String(showId || "").toLowerCase();

  const rows = SAFE_TRUCKING_ROWS.filter((row) => {
    const quoteMatch = quotes.length ? quotes.includes(row.quote) : false;
    const showIdMatch = showIdText && row.showKey === showIdText;
    const nameMatch =
      nameText &&
      (
        String(row.runName || "").toLowerCase().includes(nameText) ||
        String(row.where || "").toLowerCase().includes(nameText)
      );

    return quoteMatch || showIdMatch || nameMatch;
  });

  return rows.map((row) => ({
    quote: row.quote,
    driverName: row.driverName || (row.needDriver ? "NEED DRIVER" : row.driverConfirmed ? "Assigned" : "TBD"),
    runName: row.runName,
    date: row.date,
    when: row.when,
    driverConfirmed: Boolean(row.driverConfirmed),
    infoSent: Boolean(row.infoSent),
    lpoSent: Boolean(row.lpoSent),
    truck: row.truck || "",
    trailer: row.trailer || "",
    where: row.where || "",
    maybeTruck: Boolean(row.maybeTruck),
    needDriver: Boolean(row.needDriver),
    notes: row.notes || "",
  }));
}


const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderLoginPage());
      return;
    }
    // Active Shows dashboard route. Uses readFileSync because this server imports callback-style fs.
    if (req.method === "GET" && url.pathname === "/active-shows") {
      const html = fs.readFileSync(
        path.resolve("./active-shows.html"),
        "utf8"
      );

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });

      res.end(html);
      return;
    }
    
    const mockActiveShows = [
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
        trucking:
          "Driver/truck mapped. Use trucking only as execution evidence.",
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
        nextAction:
          "Pull authoritative FLEX scope and separate each quote/workstream.",
        flexSignal:
          "Ask FLEX should identify official FLEX records; trucking hints include multiple quote numbers.",
        trucking:
          "Many rows mapped; Info Sent / LPO Sent remain FALSE.",
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
        flexSignal:
          "Use Ask FLEX to confirm official FLEX record. Trucking hint: 26-1421.",
        trucking:
          "Maybe truck rows; load-out NEED DRIVER; Info/LPO FALSE.",
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
        flexSignal:
          "Trucking hints: 26-0714; 26-0715; 26-0716; 26-0717.",
        trucking:
          "Drivers mapped for main trucks; maybe truck unresolved; Info/LPO FALSE.",
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
        flexSignal:
          "Use Ask FLEX to confirm whether 26-1777 is authoritative FLEX record.",
        trucking:
          "Runs found on 7/5, 7/6, 7/7. Driver/LPO true; Info Sent FALSE.",
      },
      {
        id: "country-calling-2026",
        name: "Country Calling 2026",
        timing: "Festival / multi-workstream",
        priority: "High",
        readinessStatus: "MAGENTA - Event Folder rollup",
        changeSignal: "Cyan - FLEX Event Folder hint available",
        topIssue:
          "Multi-department festival scope lives under one FLEX Event Folder; confirm child quote workstreams.",
        nextAction:
          "Review Event Folder child quotes and pull individual workstreams as needed.",
        flexSignal: "Event Folder parent expected: 26-0021 Country Calling 2026.",
        trucking:
          "Use child quote workstreams for trucking matching; LED Trailer is vendor-managed turnkey (not MM trucking).",
      },
    ];
    
    function extractActiveShowDocumentNumbers(show) {
      return extractActiveShowFlexDocumentNumbers(show);
    }

    function getFlexSoldDepartments(detail) {
      return Array.from(
        new Set(
          [
            ...(detail.sections || []).map((section) => section.name),
            ...((detail.summary && detail.summary.lineItems) || []).map(
              (item) => item.name
            ),
          ]
            .filter(Boolean)
            .map((item) => String(item).trim())
        )
      );
    }

    function sumFlexNumber(values) {
      return Math.round(
        values.reduce((sum, value) => sum + Number(value || 0), 0) * 100
      ) / 100;
    }

    function buildCombinedFlexTotals(verifiedDocuments) {
      const totalsList = verifiedDocuments.map((doc) => doc.totals || {});
      const financialsList = verifiedDocuments.map((doc) => doc.financials || {});

      return {
        totals: {
          document: sumFlexNumber(totalsList.map((item) => item.document)),
          rental: sumFlexNumber(totalsList.map((item) => item.rental)),
          labor: sumFlexNumber(totalsList.map((item) => item.labor)),
          transportation: sumFlexNumber(totalsList.map((item) => item.transportation)),
          other: sumFlexNumber(totalsList.map((item) => item.other)),
          categorySubtotal: sumFlexNumber(totalsList.map((item) => item.categorySubtotal)),
        },
        financials: {
          invoiceTotal: sumFlexNumber(financialsList.map((item) => item.invoiceTotal)),
          balanceDue: sumFlexNumber(financialsList.map((item) => item.balanceDue)),
          totalAppliedPayments: sumFlexNumber(financialsList.map((item) => item.totalAppliedPayments)),
          categorySubtotal: sumFlexNumber(financialsList.map((item) => item.categorySubtotal)),
        },
        counts: {
          sections: verifiedDocuments.reduce((sum, doc) => sum + Number(doc.counts?.sections || 0), 0),
          flattenedRows: verifiedDocuments.reduce((sum, doc) => sum + Number(doc.counts?.flattenedRows || 0), 0),
          inventoryItems: verifiedDocuments.reduce((sum, doc) => sum + Number(doc.counts?.inventoryItems || 0), 0),
          laborItems: verifiedDocuments.reduce((sum, doc) => sum + Number(doc.counts?.laborItems || 0), 0),
          transportationItems: verifiedDocuments.reduce((sum, doc) => sum + Number(doc.counts?.transportationItems || 0), 0),
        },
      };
    }

    async function resolveActiveShowFlexDocument(documentNumber, show = {}, reference = null) {
      try {
        if (isFlexElementId(reference?.elementId)) {
          const intake = await fetchFlexShowIntake(reference.elementId);
          const detail = buildFlexDocumentDetail(intake);
          const context = detail.showContext || {};
          const expectedNumber = String(documentNumber || reference.documentNumber || "").trim().toUpperCase();
          const actualNumber = String(context.documentNumber || "").trim().toUpperCase();
          if (expectedNumber && actualNumber && expectedNumber !== actualNumber) {
            throw new Error(`Active Show Index FLEX reference conflict: ${expectedNumber} resolves to ${actualNumber}.`);
          }

          const referenceType = inferFlexDocumentType(reference.documentType, "unknown");
          let verifiedType = inferFlexDocumentType(
            `${context.documentType || ""} ${context.definitionName || ""}`,
            "unknown"
          );
          let parentElementId = isFlexElementId(reference.parentElementId)
            ? reference.parentElementId
            : null;
          try {
            const tree = await fetchFlexElementTree(reference.elementId);
            const node = normalizeFlexElementTree(tree.data).find(candidate =>
              String(candidate.elementId || "").toLowerCase() === String(reference.elementId).toLowerCase()
            );
            if (node) {
              const treeType = inferFlexDocumentType(
                `${node.type || ""} ${node.name || ""} ${node.domainId || ""}`,
                "unknown"
              );
              if (treeType !== "unknown") verifiedType = treeType;
              if (isFlexElementId(node.parentId)) parentElementId = node.parentId;
            }
          } catch {
            // The header and typed Active Show Index reference remain usable
            // when this FLEX tenant does not expose the element tree.
          }
          if (referenceType !== "unknown" && verifiedType !== "unknown" && referenceType !== verifiedType) {
            throw new Error(
              `Active Show Index FLEX type conflict for ${actualNumber || expectedNumber || reference.elementId}: expected ${referenceType}, FLEX reports ${verifiedType}.`
            );
          }
          const documentType = verifiedType !== "unknown" ? verifiedType : referenceType;
          const resolvedNumber = actualNumber || expectedNumber || null;
          return {
            status: "Verified",
            approvalNeeded: false,
            documentNumber: resolvedNumber,
            documentType,
            role: reference.role || "related",
            parentElementId,
            elementId: reference.elementId,
            showName: context.showName || show.name || show.showName || null,
            client: context.client || null,
            venue: context.venue || null,
            plannedStartDate: context.plannedStartDate || null,
            plannedEndDate: context.plannedEndDate || null,
            loadInDate: context.loadInDate || null,
            loadOutDate: context.loadOutDate || null,
            soldDepartments: getFlexSoldDepartments(detail),
            totals: detail.summary?.totals || null,
            financials: detail.summary?.financials || null,
            counts: detail.counts || null,
            quoteLookup: {
              found: true,
              source: "active_show_index_element_id",
              elementId: reference.elementId,
              documentNumber: resolvedNumber,
              documentType,
            },
          };
        }

        const quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber, {
          showName: show.name || show.showName || null,
          client: show.activeShowsIndex?.client || show.client || null,
        });

        if (!quoteLookup.found || !quoteLookup.elementId) {
          return {
            status: "Missing",
            approvalNeeded: true,
            documentNumber,
            documentType: "unknown",
            elementId: null,
            showName: null,
            client: null,
            venue: null,
            plannedStartDate: null,
            plannedEndDate: null,
            loadInDate: null,
            loadOutDate: null,
            soldDepartments: [],
            totals: null,
            financials: null,
            counts: null,
            quoteLookup,
            message: quoteLookup.ambiguous
              ? `FLEX document ${documentNumber} is ambiguous across document types or shows.`
              : `No verified FLEX document found for ${documentNumber}.`,
          };
        }

        const intake = await fetchFlexShowIntake(quoteLookup.elementId);
        const detail = buildFlexDocumentDetail(intake);
        const soldDepartments = getFlexSoldDepartments(detail);

        return {
          status: "Verified",
          approvalNeeded: false,
          documentNumber,
          documentType: quoteLookup.documentType || "unknown",
          role: reference?.role || "related",
          parentElementId: quoteLookup.parentElementId || null,
          elementId: quoteLookup.elementId,
          showName:
            detail.showContext?.showName || quoteLookup.name || null,
          client: detail.showContext?.client || null,
          venue: detail.showContext?.venue || null,
          plannedStartDate: detail.showContext?.plannedStartDate || null,
          plannedEndDate: detail.showContext?.plannedEndDate || null,
          loadInDate: detail.showContext?.loadInDate || null,
          loadOutDate: detail.showContext?.loadOutDate || null,
          soldDepartments,
          totals: detail.summary?.totals || null,
          financials: detail.summary?.financials || null,
          counts: detail.counts || null,
          quoteLookup,
        };
      } catch (error) {
        const skipped = isSkippableFlexRequestError(error);
        return {
          status: skipped ? "Skipped" : "Error",
          approvalNeeded: true,
          documentNumber,
          documentType: inferFlexDocumentType(reference?.documentType, "unknown"),
          role: reference?.role || "related",
          elementId: isFlexElementId(reference?.elementId) ? reference.elementId : null,
          showName: null,
          client: null,
          venue: null,
          plannedStartDate: null,
          plannedEndDate: null,
          loadInDate: null,
          loadOutDate: null,
          soldDepartments: [],
          totals: null,
          financials: null,
          counts: null,
          quoteLookup: null,
          skipped,
          skipReason: skipped ? error.code || "flex_request_unavailable" : null,
          message: error.message || "FLEX enrichment failed.",
        };
      }
    }

    async function resolveActiveShowFlexParent(elementId, show = {}) {
      if (!isFlexElementId(elementId)) return null;
      try {
        const header = await fetchFlexHeaderData(elementId);
        const context = buildShowContext(header.data, elementId);
        let documentType = inferFlexDocumentType(
          `${context.documentType || ""} ${context.definitionName || ""}`,
          "unknown"
        );
        let parentElementId = null;
        try {
          const tree = await fetchFlexElementTree(elementId);
          const node = normalizeFlexElementTree(tree.data).find(candidate =>
            String(candidate.elementId || "").toLowerCase() === String(elementId).toLowerCase()
          );
          if (node) {
            const treeType = inferFlexDocumentType(`${node.type || ""} ${node.name || ""} ${node.domainId || ""}`, "unknown");
            if (treeType !== "unknown") documentType = treeType;
            parentElementId = node.parentId || null;
          }
        } catch {
          // The verified header remains useful, but an opaque parent is never
          // promoted to the canonical quote.
        }
        if (documentType !== "quote" || !context.documentNumber) return null;
        const intake = await fetchFlexShowIntake(elementId);
        const detail = buildFlexDocumentDetail(intake);
        return {
          status: "Verified",
          approvalNeeded: false,
          documentNumber: context.documentNumber,
          documentType: "quote",
          parentElementId,
          elementId,
          showName: detail.showContext?.showName || context.showName || show.name || null,
          client: detail.showContext?.client || context.client || null,
          venue: detail.showContext?.venue || context.venue || null,
          plannedStartDate: detail.showContext?.plannedStartDate || null,
          plannedEndDate: detail.showContext?.plannedEndDate || null,
          loadInDate: detail.showContext?.loadInDate || null,
          loadOutDate: detail.showContext?.loadOutDate || null,
          soldDepartments: getFlexSoldDepartments(detail),
          totals: detail.summary?.totals || null,
          financials: detail.summary?.financials || null,
          counts: detail.counts || null,
          quoteLookup: { found: true, source: "explicit_parent_element" },
        };
      } catch {
        return null;
      }
    }

    async function resolveActiveShowFlexQuoteByName(show = {}) {
      const showName = String(show.name || show.showName || "").trim();
      if (!showName) return null;
      try {
        const search = await searchFlexQuotes(showName, {
          quoteOnly: true,
          includeInvoices: false,
          limit: 8,
          enrichLimit: 30,
        });
        const candidates = (search.matches || []).map(match => ({
          ...match,
          showName: match.name,
          documentType: match.documentType || inferFlexDocumentType(
            `${match.definitionName || ""} ${match.type || ""} ${match.rawSearchName || ""}`,
            "unknown"
          ),
        }));
        const selection = selectFlexDocumentCandidate(candidates, {
          showName,
          client: show.activeShowsIndex?.client || show.client || null,
          documentType: "quote",
        });
        const selected = selection.candidate;
        if (!selected || !selected.documentNumber || !selected.elementId) return null;
        // Name similarity alone is not enough to turn an opaque financial
        // document into the primary quote. FLEX must identify the result as a
        // quote; otherwise the Command Center asks a human to link it.
        if (selected.documentType !== "quote") return null;
        const intake = await fetchFlexShowIntake(selected.elementId);
        const detail = buildFlexDocumentDetail(intake);
        return {
          status: "Verified",
          approvalNeeded: false,
          documentNumber: selected.documentNumber,
          documentType: "quote",
          elementId: selected.elementId,
          showName: detail.showContext?.showName || selected.showName || showName,
          client: detail.showContext?.client || selected.client || null,
          venue: detail.showContext?.venue || selected.venue || null,
          plannedStartDate: detail.showContext?.plannedStartDate || selected.plannedStartDate || null,
          plannedEndDate: detail.showContext?.plannedEndDate || null,
          loadInDate: detail.showContext?.loadInDate || null,
          loadOutDate: detail.showContext?.loadOutDate || null,
          soldDepartments: getFlexSoldDepartments(detail),
          totals: detail.summary?.totals || null,
          financials: detail.summary?.financials || null,
          counts: detail.counts || null,
          quoteLookup: { found: true, source: "active_show_identity", search },
        };
      } catch {
        return null;
      }
    }

    async function enrichActiveShowWithFlex(show, options = {}) {
      let documentNumbers = extractActiveShowDocumentNumbers(show);
      const structuredDocumentRefs = extractActiveShowFlexDocumentRefs(show);
      let identityResolvedDocument = null;
      const lastPullAt = new Date().toISOString();

      const eventFolderHint = getActiveShowEventFolderHint(show);
      const onlyParentEventFolderNumber =
        Boolean(eventFolderHint?.documentNumber) &&
        documentNumbers.length > 0 &&
        documentNumbers.every(
          (documentNumber) => documentNumber === eventFolderHint.documentNumber
        );

      // Event Folder path: no quote numbers, or only the parent Event Folder doc #.
      // Direct child quote numbers still use normal quote matching.
      if (
        eventFolderHint?.elementId &&
        (!documentNumbers.length || onlyParentEventFolderNumber)
      ) {
        try {
          return await enrichActiveShowWithEventFolder(
            show,
            eventFolderHint,
            lastPullAt
          );
        } catch (error) {
          const errorMessage =
            error?.message || "Could not refresh FLEX Event Folder.";
          return {
            ...show,
            flex: {
              status: "Missing",
              matchType: "event_folder_error",
              approvalNeeded: true,
              documentNumber: eventFolderHint.documentNumber || null,
              documentNumbers: [],
              elementId: eventFolderHint.elementId || null,
              showName: eventFolderHint.showName || show.name || null,
              client: null,
              venue: null,
              plannedStartDate: null,
              plannedEndDate: null,
              loadInDate: null,
              loadOutDate: null,
              soldDepartments: [],
              totals: null,
              financials: null,
              counts: null,
              documents: [],
              eventFolder: {
                documentNumber: eventFolderHint.documentNumber || null,
                elementId: eventFolderHint.elementId || null,
                name: eventFolderHint.showName || show.name || null,
              },
              childQuotes: [],
              rollup: null,
              primary: {
                documentNumber: eventFolderHint.documentNumber || null,
                elementId: eventFolderHint.elementId || null,
                name: eventFolderHint.showName || show.name || null,
              },
              verifiedDocumentCount: 0,
              unresolvedDocumentCount: 0,
              lastPullAt,
              eventFolderError: errorMessage,
              message: errorMessage,
            },
            flexSignal: `Could not refresh FLEX Event Folder for ${
              eventFolderHint.documentNumber || "this show"
            }. ${errorMessage}`,
          };
        }
      }

      if (!documentNumbers.length && options.resolveByName !== false) {
        identityResolvedDocument = await resolveActiveShowFlexQuoteByName(show);
        if (identityResolvedDocument?.documentNumber) {
          documentNumbers = [identityResolvedDocument.documentNumber];
        }
      }

      if (!documentNumbers.length) {
        return {
          ...show,
          flex: {
            status: "Missing",
            approvalNeeded: true,
            documentNumber: null,
            documentNumbers,
            elementId: null,
            showName: null,
            client: null,
            venue: null,
            plannedStartDate: null,
            plannedEndDate: null,
            loadInDate: null,
            loadOutDate: null,
            soldDepartments: [],
            totals: null,
            financials: null,
            counts: null,
            documents: [],
            lastPullAt,
            message:
              "No FLEX document number found in this Active Shows row. Needs direct FLEX ID, command sheet, quote document, or PM approval.",
          },
          flexSignal:
            "FLEX Missing - no direct document number found. Trucking, folder, and Drive evidence remain hints only.",
        };
      }

      let documents = identityResolvedDocument
        ? [identityResolvedDocument]
        : await Promise.all(
            [
              ...structuredDocumentRefs.map(reference => ({
                documentNumber: reference.documentNumber,
                reference,
              })),
              ...documentNumbers
                .filter(documentNumber => !structuredDocumentRefs.some(reference => reference.documentNumber === documentNumber))
                .map(documentNumber => ({ documentNumber, reference: null })),
            ].map(target =>
              resolveActiveShowFlexDocument(target.documentNumber, show, target.reference)
            )
          );

      let verifiedDocuments = documents.filter(
        (document) => document.status === "Verified"
      );
      let unresolvedDocuments = documents.filter(
        (document) => document.status !== "Verified"
      );
      const expectedShowIdentity = {
        showName: show.name || show.showName || null,
        client: show.activeShowsIndex?.client || show.client || null,
      };

      // FLEX child documents expose their real parent UUID. Resolve that UUID
      // before any fuzzy name search, and promote it only when FLEX explicitly
      // types the parent as a quote. This is the authoritative path for cases
      // such as Moonchild pull sheet 26-0836 -> show quote 26-1846.
      const explicitParentIds = [...new Set(
        verifiedDocuments.map(document => document.parentElementId).filter(isFlexElementId)
      )];
      for (const parentElementId of explicitParentIds) {
        if (documents.some(document => String(document.elementId || "").toLowerCase() === String(parentElementId).toLowerCase())) continue;
        const parentQuote = await resolveActiveShowFlexParent(parentElementId, show);
        if (parentQuote?.documentType === "quote") {
          documents.push(parentQuote);
          documentNumbers = [...new Set([...documentNumbers, parentQuote.documentNumber].filter(Boolean))];
        }
      }
      verifiedDocuments = documents.filter(document => document.status === "Verified");
      unresolvedDocuments = documents.filter(document => document.status !== "Verified");
      let primary = selectPrimaryShowQuote(verifiedDocuments, expectedShowIdentity);

      // A row can contain only a child pull sheet (Moonchild 26-0836 is the
      // real-world example) or an opaque FLEX workstream.  In that case the
      // document number proves the workstream, not the canonical show quote.
      // Search once by the Active Show identity and add the verified parent
      // quote without discarding the child evidence.
      if (
        options.resolveByName !== false &&
        (!primary || primary.documentType !== "quote")
      ) {
        const canonicalQuote = await resolveActiveShowFlexQuoteByName(show);
        if (canonicalQuote?.documentType === "quote") {
          const existingIndex = documents.findIndex(
            document => String(document?.elementId || "").toLowerCase() === String(canonicalQuote.elementId || "").toLowerCase()
          );
          // Name resolution may rediscover the same UUID that a number lookup
          // returned with an opaque type.  Upgrade that record in place instead
          // of treating it as a duplicate and leaving LiteFlair unresolved.
          documents = existingIndex >= 0
            ? documents.map((document, index) => index === existingIndex ? { ...document, ...canonicalQuote } : document)
            : [...documents, canonicalQuote];
          documentNumbers = [...new Set([...documentNumbers, canonicalQuote.documentNumber].filter(Boolean))];
          verifiedDocuments = documents.filter(document => document.status === "Verified");
          unresolvedDocuments = documents.filter(document => document.status !== "Verified");
          primary = selectPrimaryShowQuote(verifiedDocuments, expectedShowIdentity);
        }
      }
      const soldDepartments = Array.from(
        new Set(
          verifiedDocuments.flatMap((document) => document.soldDepartments || [])
        )
      );
      const combined = buildCombinedFlexTotals(verifiedDocuments);

      const hasCanonicalQuote = primary?.documentType === "quote";
      const status = verifiedDocuments.length === 0
        ? unresolvedDocuments.some((document) => document.status === "Skipped")
          ? "Partial"
          : unresolvedDocuments.some((document) => document.status === "Error")
          ? "Error"
          : "Missing"
        : !hasCanonicalQuote
          ? "Partial"
        : unresolvedDocuments.length > 0
          ? "Partial"
          : "Verified";

      const approvalNeeded = status !== "Verified";
      const checkedText = `${verifiedDocuments.length}/${documentNumbers.length}`;
      const unresolvedText = unresolvedDocuments.length
        ? ` Unresolved: ${unresolvedDocuments
            .map((document) => `${document.documentNumber} ${document.status}`)
            .join(", ")}.`
        : "";

      const flexSignal = verifiedDocuments.length
        ? hasCanonicalQuote
          ? `FLEX ${status} - ${checkedText} document${documentNumbers.length === 1 ? "" : "s"} verified. Primary show quote: ${primary.documentNumber} / ${primary.elementId}. Combined sold scope: ${soldDepartments.join(", ") || "No departments found"}.${unresolvedText}`
          : `FLEX Partial - ${checkedText} document${documentNumbers.length === 1 ? "" : "s"} verified, but no canonical parent quote was identified. Human confirmation required.${unresolvedText}`
        : `FLEX ${status} - ${documentNumbers.join(", ")} did not fully resolve. Treat trucking / Drive evidence as hints only.${unresolvedText}`;

      return {
        ...show,
        flex: {
          status,
          approvalNeeded,
          documentNumber: hasCanonicalQuote ? primary.documentNumber : null,
          documentNumbers,
          elementId: hasCanonicalQuote ? primary.elementId : null,
          showName: primary?.showName || show.name,
          client: primary?.client || null,
          venue: primary?.venue || null,
          plannedStartDate: primary?.plannedStartDate || null,
          plannedEndDate: primary?.plannedEndDate || null,
          loadInDate: primary?.loadInDate || null,
          loadOutDate: primary?.loadOutDate || null,
          soldDepartments,
          totals: combined.totals,
          financials: combined.financials,
          counts: combined.counts,
          documents,
          primary: hasCanonicalQuote
            ? {
                documentNumber: primary.documentNumber,
                elementId: primary.elementId,
                name: primary.showName || show.name || null,
                documentType: primary.documentType || "quote",
              }
            : null,
          verifiedDocumentCount: verifiedDocuments.length,
          unresolvedDocumentCount: unresolvedDocuments.length,
          lastPullAt,
          quoteLookup: primary?.quoteLookup || null,
          message: unresolvedText.trim() || null,
        },
        flexSignal,
      };
    }

    const ACTIVE_SHOWS_INDEX_SHEET_ID =
      process.env.ACTIVE_SHOWS_INDEX_SHEET_ID ||
      "1U0rotUCZ2o5gUMkZb5hDfIzALA1SAQOmsVXYJJ9-ajc";

    const ACTIVE_SHOWS_INDEX_SHEET_NAME =
      process.env.ACTIVE_SHOWS_INDEX_SHEET_NAME || "Active Shows Index";

    function activeShowsIndexRowsToObjects(csvRows) {
      return parseActiveShowIndexRows(csvRows);
    }

    function mapActiveShowsIndexRow(rowObject) {
      return mapActiveShowIndexAuthorityRow(rowObject, {
        sheetId: ACTIVE_SHOWS_INDEX_SHEET_ID,
        sheetName: ACTIVE_SHOWS_INDEX_SHEET_NAME,
      });
    }

    async function fetchActiveShowsFromIndexSheet() {
      const sheetName = encodeURIComponent(ACTIVE_SHOWS_INDEX_SHEET_NAME);
      const urls = [
        `https://docs.google.com/spreadsheets/d/${ACTIVE_SHOWS_INDEX_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${sheetName}`,
        `https://docs.google.com/spreadsheets/d/${ACTIVE_SHOWS_INDEX_SHEET_ID}/export?format=csv&sheet=${sheetName}`,
      ];

      let lastError = null;

      for (const csvUrl of urls) {
        try {
          console.log("[ACTIVE SHOWS INDEX]", ACTIVE_SHOWS_INDEX_SHEET_NAME);

          const response = await fetch(csvUrl);
          const text = await response.text();

          if (!response.ok) {
            throw new Error(`Active Shows Index CSV request failed: ${response.status} ${response.statusText}`);
          }

          if (/<!doctype html>|<html/i.test(text)) {
            throw new Error("Active Shows Index returned HTML instead of CSV. The sheet may not be readable by this server.");
          }

          const csvRows = parseCsvRows(text);
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
          console.warn("[ACTIVE SHOWS INDEX WARNING]", error.message);
        }
      }

      throw lastError || new Error("Unable to fetch Active Shows Index CSV.");
    }

    async function getActiveShowsRowsWithFallback() {
      try {
        return await fetchActiveShowsFromIndexSheet();
      } catch (error) {
        console.warn("[ACTIVE SHOWS INDEX FALLBACK]", error.message);

        return {
          source: "active-shows-safe-mock",
          usedFallback: true,
          fallbackReason: error.message,
          sheetId: ACTIVE_SHOWS_INDEX_SHEET_ID,
          sheetName: ACTIVE_SHOWS_INDEX_SHEET_NAME,
          rowCount: mockActiveShows.length,
          shows: mockActiveShows,
        };
      }
    }

    let activeShowsEnrichmentCache = { signature: null, expiresAt: 0, shows: [] };
    async function enrichActiveShowsOnce(shows, options = {}) {
      const signature = JSON.stringify((shows || []).map(show => ({
        id: show.id,
        name: show.name,
        documents: extractActiveShowDocumentNumbers(show),
        documentRefs: extractActiveShowFlexDocumentRefs(show).map(reference => ({
          documentNumber: reference.documentNumber,
          elementId: reference.elementId,
          documentType: reference.documentType,
          role: reference.role,
          parentElementId: reference.parentElementId,
          status: reference.status,
        })),
        client: show.activeShowsIndex?.client || show.client || null,
      })).concat([{ resolveByName: options.resolveByName !== false }]));
      if (activeShowsEnrichmentCache.signature === signature && activeShowsEnrichmentCache.expiresAt > Date.now()) {
        return activeShowsEnrichmentCache.shows;
      }
      const enriched = await Promise.all((shows || []).map(show => enrichActiveShowWithFlex(show, options)));
      activeShowsEnrichmentCache = {
        signature,
        expiresAt: Date.now() + 5 * 60 * 1000,
        shows: enriched,
      };
      return enriched;
    }

    async function refreshActiveShowAuthority(options = {}) {
      const source = await getActiveShowsRowsWithFallback();
      if (source.usedFallback) {
        const canonicalShows = await defaultCueFoundationStore.listCanonicalShows({ activeOnly: true });
        return {
          source,
          authoritative: false,
          shows: source.shows,
          canonicalShows,
          registrySync: {
            ok: true,
            skipped: true,
            reason: "fallback_not_authoritative",
          },
          intakeSync: null,
        };
      }

      // Only actual rows from the live Active Shows Index define the current
      // show universe. FLEX/event-folder hints may help resolve a row, but are
      // never allowed to create or deactivate canonical shows themselves.
      const shows = await enrichActiveShowsOnce(source.shows, { resolveByName: true });
      const registrySync = await defaultCueFoundationStore.syncCanonicalShowRegistry(shows, {
        source: source.source,
        sheetId: source.sheetId,
        sheetName: source.sheetName,
      });
      let intakeSync = null;
      if (options.ingestEvidence) {
        const batch = buildActiveShowIndexBatch(shows, {
          sheetId: source.sheetId,
          sheetName: source.sheetName,
          connectorVersion: "source-first-v1",
        });
        intakeSync = await defaultCueFoundationStore.ingestSourceRecords(batch.records, {
          sourceType: "drive",
          connectorName: "active-show-index",
          connectorVersion: "source-first-v1",
          cursorAfter: options.cursorAfter || null,
          metadata: {
            identityAuthority: true,
            sheetId: source.sheetId,
            sheetName: source.sheetName,
          },
        });
      }
      const canonicalShows = await defaultCueFoundationStore.listCanonicalShows({ activeOnly: true });
      return {
        source,
        authoritative: true,
        shows,
        canonicalShows,
        registrySync,
        intakeSync,
      };
    }

    // Slack matching and the Active Shows screen must consume the same FLEX-
    // enriched objects. Raw sheet rows contain names and document hints but do
    // not contain the verified UUID/type hierarchy needed by Intake.
    slackMatchDeps.getCandidateShows = async () => {
      const authority = await refreshActiveShowAuthority();
      return authority.canonicalShows.map(canonicalShowToSlackCandidate);
    };
    slackMatchDeps.resolveQuoteCandidate = resolveSlackCandidateFromFlexQuote;

    async function buildActiveShowsResponse(sourceLabel) {
      const authority = await refreshActiveShowAuthority();
      const activeShowsSource = authority.source;
      const shows = authority.shows;
      const registrySync = authority.registrySync;
      const canonicalShows = authority.canonicalShows;
      const canonicalById = new Map(canonicalShows.map(show => [show.id, show]));

      // One shared Slack cache read — no per-show Slack API calls.
      let slackStatus = null;
      try {
        slackStatus = await slackOperationalSignalsService.getSlackSignalSyncStatus();
      } catch {
        slackStatus = { status: "unavailable" };
      }

      const showsWithSlack = await Promise.all(
        shows.map(async (show) => {
          try {
            const slack = await slackOperationalSignalsService.getSlackSignalsForShow(
              {
                showKey: show.id,
                showName: show.name,
                documentNumbers: extractActiveShowDocumentNumbers(show),
                client: show.activeShowsIndex?.client || show.client || null,
                venue: show.venue || null,
              },
              { allowStaleRefresh: false, limit: 5 }
            );
            return {
              ...show,
              canonicalIdentity: canonicalById.get(show.id) || null,
              slackOperationalSignals: {
                status: SLACK_FIXTURE_MODE
                  ? "fallback"
                  : slack.sourceStatus || slackStatus?.status || "unavailable",
                lastSyncAt: slack.lastSyncAt || slackStatus?.lastSuccessfulSyncAt || null,
                highConfidenceCount: slack.highConfidenceCount || 0,
                needsReviewCount: slack.needsReviewCount || 0,
                unresolvedCount: slack.unresolvedCount || 0,
                resolvedCount: slack.resolvedCount || 0,
                categories: slack.categories || {},
                signals: (slack.signals || []).slice(0, 5),
                stale: Boolean(slack.stale || slackStatus?.stale),
                fixtureMode: Boolean(SLACK_FIXTURE_MODE || slack.fixtureMode),
                sourceLabel:
                  SLACK_FIXTURE_MODE || slack.fixtureMode
                    ? "fixture/test data"
                    : slack.sourceLabel || null,
                warning: slack.warning || slackStatus?.warning || null,
              },
            };
          } catch {
            return {
              ...show,
              canonicalIdentity: canonicalById.get(show.id) || null,
              slackOperationalSignals: {
                status: "unavailable",
                lastSyncAt: null,
                highConfidenceCount: 0,
                needsReviewCount: 0,
                unresolvedCount: 0,
                resolvedCount: 0,
                categories: {},
                signals: [],
              },
            };
          }
        })
      );

      const flexSummary = {
        verified: showsWithSlack.filter((show) => show.flex?.status === "Verified").length,
        partial: showsWithSlack.filter((show) => show.flex?.status === "Partial").length,
        missing: showsWithSlack.filter((show) => show.flex?.status === "Missing").length,
        error: showsWithSlack.filter((show) => show.flex?.status === "Error").length,
        approvalNeeded: showsWithSlack.filter((show) => show.flex?.approvalNeeded).length,
      };

      return {
        ok: true,
        source: sourceLabel,
        activeShowsSource: activeShowsSource.source,
        activeShowsSourceUsedFallback: activeShowsSource.usedFallback,
        activeShowsSourceFallbackReason: activeShowsSource.fallbackReason || null,
        activeShowsIndex: {
          sheetId: activeShowsSource.sheetId,
          sheetName: activeShowsSource.sheetName,
          rowCount: activeShowsSource.rowCount,
        },
        flexAuthority: "live",
        slackOperationalSignalsStatus: slackStatus,
        generatedAt: new Date().toISOString(),
        message:
          "Active Shows now reads rows from the Active Shows Index when available, then enriches every FLEX/document number found on each row with live FLEX search, header fetch, and line-item pull.",
        flexSummary,
        canonicalShowRegistry: registrySync,
        shows: showsWithSlack,
      };
    }

    if (req.method === "GET" && url.pathname === "/api/active-shows") {
      const payload = await buildActiveShowsResponse("active-shows-flex-live");

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });

      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/active-shows/sync") {
      const payload = await buildActiveShowsResponse("active-shows-flex-sync");

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });

      res.end(JSON.stringify(payload));
      return;
    }


    if (req.method === "POST" && url.pathname === "/api/login") {
      const rawBody = await readRequestBody(req);
      const form = new URLSearchParams(rawBody);
      const password = form.get("password") || "";

      if (!CUE_PILOT_PASSWORD) {
        res.writeHead(500, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(renderLoginPage("CUE_PILOT_PASSWORD is not configured on this server."));
        return;
      }

      if (password !== CUE_PILOT_PASSWORD) {
        res.writeHead(401, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(renderLoginPage("Incorrect password."));
        return;
      }

      const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";

      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `cue_pilot_auth=${encodeURIComponent(getPilotSessionToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `cue_pilot_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const automationAuthorized =
      isAutomationAllowedPath(url.pathname) && isAutomationAuthorized(req, url);

    if (!isPilotAuthorized(req) && !automationAuthorized) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 401, {
          error:
            "Unauthorized. Enter the CUE Private Pilot password first, or provide a valid automation token for approved automation endpoints.",
        });
        return;
      }

      redirectToLogin(res);
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/cue-flex-intake-lab.html")
    ) {
      const html = fs.readFileSync(HTML_FILE, "utf8");

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });

      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/ask-flex") {
      let html = fs.readFileSync(ASK_FLEX_HTML_FILE, "utf8");
      html = html
        .replaceAll("__CUE_BUILD_ID__", CUE_BUILD_ID)
        .replaceAll("__CUE_BUILD_BRANCH__", CUE_BUILD_BRANCH)
        .replaceAll("__CUE_BUILD_LABEL__", CUE_BUILD_LABEL);

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });

      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/cue-logo.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
      res.end(fs.readFileSync(CUE_LOGO_FILE));
      return;
    }

    if (req.method === "GET" && url.pathname === "/command-center") {
      let html = fs.readFileSync(COMMAND_CENTER_HTML_FILE, "utf8");
      html = html.replaceAll("__CUE_BUILD_LABEL__", CUE_BUILD_LABEL);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex-line-items") {
      const elementId = url.searchParams.get("elementId");

      if (!elementId) {
        sendJson(res, 400, {
          error: "Missing required query parameter: elementId",
        });
        return;
      }

      const result = await fetchFlexRowData(elementId);

      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex-show-intake") {
      const elementId = url.searchParams.get("elementId");

      if (!elementId) {
        sendJson(res, 400, {
          error: "Missing required query parameter: elementId",
        });
        return;
      }

      const result = await fetchFlexShowIntake(elementId);

      sendJson(res, 200, result);
      return;
    }


    if (req.method === "GET" && url.pathname === "/api/flex-document-summary") {
      const elementId = url.searchParams.get("elementId");

      if (!elementId) {
        sendJson(res, 400, {
          error: "Missing required query parameter: elementId",
        });
        return;
      }

      const intake = await fetchFlexShowIntake(elementId);
      const summary = buildFlexDocumentSummary(intake);

      sendJson(res, 200, summary);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/search-quotes") {
      const query = url.searchParams.get("query") || url.searchParams.get("q");
      const limit = url.searchParams.get("limit") || 5;
      const filters = parseFlexSearchFilters(query, {
        year: url.searchParams.get("year"),
        quoteOnly:
          url.searchParams.get("quoteOnly") === "true" ||
          url.searchParams.get("excludeInvoices") === "true",
        invoiceOnly: url.searchParams.get("invoiceOnly") === "true",
        currentOnly: url.searchParams.get("currentOnly") === "true",
        futureOnly: url.searchParams.get("futureOnly") === "true",
        openOnly: url.searchParams.get("openOnly") === "true",
        paidOnly: url.searchParams.get("paidOnly") === "true",
        revenueOnly: url.searchParams.get("revenueOnly") === "true",
        includeInvoices: url.searchParams.get("includeInvoices") !== "false",
      });

      if (!query) {
        sendJson(res, 400, {
          error: "Missing required query parameter: query",
        });
        return;
      }

      const result = await searchFlexQuotes(query, { limit, filters });

      sendJson(res, 200, result);
      return;
    }

    if (
      (url.pathname === "/api/flex/ask" || url.pathname === "/api/flex/ask-brief") &&
      (req.method === "GET" || req.method === "POST")
    ) {
      let question = url.searchParams.get("question");
      let format = url.searchParams.get("format") || "";
      let requestContext = null;

      if (url.pathname === "/api/flex/ask-brief") {
        format = "brief";
      }

      if (req.method === "POST") {
        const rawBody = await readRequestBody(req);
        const requestBody = JSON.parse(rawBody || "{}");
        question = requestBody.question || question;
        format = requestBody.format || format;
        requestContext = requestBody.context || null;
      }

      if (!question) {
        sendJson(res, 400, {
          error: "Missing required question. Use POST JSON { question } or GET ?question=...",
        });
        return;
      }

      const result = await answerFlexAskQuestion(question, { context: requestContext });

      if (String(format).toLowerCase() === "brief") {
        sendJson(res, 200, buildFlexAskBriefPayload(result));
        return;
      }

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/review-snapshots") {
      const showKey = String(url.searchParams.get("showKey") || "").trim();
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
      if (!showKey || !isValidShowKeyParam(showKey)) {
        sendJson(res, 400, { error: "Valid showKey query parameter is required." });
        return;
      }
      const snapshots = await defaultReviewSnapshotStore.listSnapshots({ showKey, limit });
      sendJson(res, 200, {
        showKey,
        count: snapshots.length,
        snapshots: snapshots.map(sanitizeSnapshotForApi),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/review-snapshots/latest") {
      const showKey = String(url.searchParams.get("showKey") || "").trim();
      if (!showKey || !isValidShowKeyParam(showKey)) {
        sendJson(res, 400, { error: "Valid showKey query parameter is required." });
        return;
      }
      const latest = await defaultReviewSnapshotStore.getLatest(showKey);
      sendJson(res, 200, {
        showKey,
        snapshot: sanitizeSnapshotForApi(latest),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/review-snapshots/compare") {
      const showKey = String(url.searchParams.get("showKey") || "").trim();
      if (!showKey || !isValidShowKeyParam(showKey)) {
        sendJson(res, 400, { error: "Valid showKey query parameter is required." });
        return;
      }
      const comparison = await defaultReviewSnapshotStore.compareLatest(showKey);
      sendJson(res, 200, {
        showKey,
        comparison,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/intelligence-rules/catalog") {
      try {
        const catalog = loadIntelligenceRulesCatalog();
        sendJson(res, 200, {
          ok: true,
          catalog_version: catalog.catalog_version,
          status: catalog.status,
          finding_contract_version: catalog.finding_contract_version,
          default_mode: catalog.default_mode,
          pilot_rule_ids: catalog.pilotRuleIds,
          rules: catalog.rules,
        });
      } catch (error) {
        sendJson(res, 500, {
          error: error?.message || "Failed to load intelligence rules catalog.",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/intelligence-rules/findings") {
      const showId = String(url.searchParams.get("showId") || "").trim();
      const status = String(url.searchParams.get("status") || "").trim() || null;
      const ruleId = String(url.searchParams.get("ruleId") || "").trim() || null;
      const findings = await defaultIntelligenceFindingsStore.listFindings({
        showId: showId || null,
        status,
        ruleId,
      });
      sendJson(res, 200, {
        ok: true,
        mode: "observe_only",
        count: findings.length,
        items: findings,
      });
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/intelligence-rules/evaluate"
    ) {
      try {
        const rawBody = await readRequestBody(req);
        const body = rawBody ? JSON.parse(rawBody) : {};
        let snapshot = body.snapshot || null;
        let showId = String(body.showId || body.show_id || "").trim();

        if (!snapshot) {
          if (!showId) {
            sendJson(res, 400, {
              error: "showId or snapshot is required.",
            });
            return;
          }
          const payload = await buildActiveShowsResponse(
            "intelligence-rules-evaluate"
          );
          const show = (payload.shows || []).find(
            (item) =>
              item.id === showId ||
              item.showKey === showId ||
              item.show_id === showId
          );
          if (!show) {
            sendJson(res, 404, { error: `Show not found: ${showId}` });
            return;
          }
          const adapted = adaptActiveShowToIntelligenceSnapshot(show, {
            staffing: body.staffing || undefined,
            trucking: body.trucking || undefined,
            warehouse: body.warehouse || undefined,
            extraFactCandidates: body.extraFactCandidates || undefined,
          });
          if (!adapted.ok) {
            sendJson(res, 400, {
              error: "Unable to adapt Active Show to Intelligence snapshot.",
              missing_inputs: adapted.missing_inputs,
              notes: adapted.notes,
            });
            return;
          }
          snapshot = adapted.snapshot;
          showId = snapshot.show.show_id;
        } else {
          showId = snapshot.show?.show_id || showId;
        }

        if (!showId) {
          sendJson(res, 400, { error: "snapshot.show.show_id is required." });
          return;
        }

        const existingFindings =
          await defaultIntelligenceFindingsStore.listFindings({ showId });
        const result = evaluateIntelligenceRules(snapshot, {
          existingFindings,
          now: body.now ? new Date(body.now) : new Date(),
          ruleIds: body.ruleIds || undefined,
        });
        if (!result.ok) {
          sendJson(res, 400, { error: result.error || "Evaluation failed." });
          return;
        }
        await defaultIntelligenceFindingsStore.replaceShowFindings(
          showId,
          result.findings
        );
        sendJson(res, 200, {
          ok: true,
          mode: "observe_only",
          show_id: showId,
          evaluated_at: result.evaluated_at,
          stats: result.stats,
          missing_inputs: result.missing_inputs,
          telemetry: result.telemetry,
          count: result.findings.length,
          findings: result.findings,
          actionable: result.actionable,
        });
      } catch (error) {
        sendJson(res, 500, {
          error: error?.message || "Intelligence evaluation failed.",
        });
      }
      return;
    }

    const intelligenceLifecycleMatch = url.pathname.match(
      /^\/api\/intelligence-rules\/findings\/([^/]+)\/(acknowledge|snooze|dismiss|reopen)$/
    );
    if (req.method === "POST" && intelligenceLifecycleMatch) {
      try {
        const findingId = decodeURIComponent(intelligenceLifecycleMatch[1]);
        const action = intelligenceLifecycleMatch[2];
        const rawBody = await readRequestBody(req);
        const body = rawBody ? JSON.parse(rawBody) : {};
        let result;
        if (action === "acknowledge") {
          result = await defaultIntelligenceFindingsStore.acknowledge(
            findingId,
            {
              actorId: body.actorId || "active-shows-user",
              note: body.note || body.rationale || null,
            }
          );
        } else if (action === "snooze") {
          result = await defaultIntelligenceFindingsStore.snooze(findingId, {
            until: body.until || body.snooze_until,
            reason: body.reason || body.rationale || null,
            actorId: body.actorId || "active-shows-user",
          });
        } else if (action === "dismiss") {
          result = await defaultIntelligenceFindingsStore.dismiss(findingId, {
            reason: body.reason || body.rationale || null,
            actorId: body.actorId || "active-shows-user",
          });
        } else {
          result = await defaultIntelligenceFindingsStore.reopen(findingId, {
            reason: body.reason || body.rationale || null,
          });
        }
        if (!result.ok) {
          sendJson(res, result.error === "Finding not found." ? 404 : 400, result);
          return;
        }
        sendJson(res, 200, { ok: true, mode: "observe_only", finding: result.finding });
      } catch (error) {
        sendJson(res, 500, {
          error: error?.message || "Finding lifecycle update failed.",
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/slack-operational-signals/sync") {
      const telemetry = await slackOperationalSignalsService.syncSlackOperationalSignals();
      const snapshot = await slackOperationalSignalsService.getSlackOperationalSnapshot();
      const foundation = await defaultCueFoundationStore.syncSlackSnapshot(snapshot);
      sendJson(res, 200, { ok: true, telemetry, foundation });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/source-first/sync") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const emailMessages = Array.isArray(body.emailMessages) ? body.emailMessages : [];
      const driveFiles = Array.isArray(body.driveFiles) ? body.driveFiles : [];
      const flexQuoteStatuses = Array.isArray(body.flexQuoteStatuses) ? body.flexQuoteStatuses : [];
      const result = await runSourceFirstIntakeSync({
        discoverFlexQuoteStatuses: body.discoverFlexLifecycle === false
          ? null
          : () => discoverAuthoritativeFlexQuoteLifecycle({
            confirmedStatuses: Array.isArray(body.confirmedFlexQuoteStatuses) ? body.confirmedFlexQuoteStatuses : [],
            fullReconciliation: Boolean(body.fullFlexReconciliation),
          }),
        flexQuoteStatuses,
        observeFlexQuoteStatuses: async observations => {
          const items = [];
          for (const observation of observations) {
            items.push(await defaultCueFoundationStore.observeFlexQuoteStatus(observation, {
              confirmedStatuses: Array.isArray(body.confirmedFlexQuoteStatuses) ? body.confirmedFlexQuoteStatuses : [],
            }));
          }
          return {
            count: items.length,
            triggered: items.filter(item => item.triggered).length,
            idempotent: items.filter(item => item.idempotent).length,
            items,
          };
        },
        loadActiveShowIndex: getActiveShowsRowsWithFallback,
        prepareActiveShows: shows => enrichActiveShowsOnce(shows, { resolveByName: true }),
        syncCanonicalRegistry: (shows, source) => defaultCueFoundationStore.syncCanonicalShowRegistry(shows, {
          source: source.source,
          sheetId: source.sheetId,
          sheetName: source.sheetName,
        }),
        ingestActiveShowIndex: async (shows, source) => {
          const batch = buildActiveShowIndexBatch(shows, {
            sheetId: source.sheetId,
            sheetName: source.sheetName,
            connectorVersion: "source-first-v1",
          });
          return defaultCueFoundationStore.ingestSourceRecords(batch.records, {
            sourceType: "drive",
            connectorName: "active-show-index",
            connectorVersion: "source-first-v1",
            cursorBefore: body.cursorBefore ?? null,
            cursorAfter: body.cursorAfter ?? null,
            metadata: {
              identityAuthority: true,
              sheetId: source.sheetId,
              sheetName: source.sheetName,
            },
          });
        },
        getVerifiedFlexDocuments: async () => {
          const foundation = await defaultCueFoundationStore.read();
          return Object.values(foundation.flexDocumentRegistry || {});
        },
        emailMessages,
        ingestEmail: (messages, verifiedFlexDocuments) => {
          const records = messages.map(message => adaptEmailMessageToIntakeRecord(message, {
            connectorName: String(body.emailConnectorName || "gmail-operational-intake").trim(),
            connectorVersion: "source-first-v1",
            verifiedFlexDocuments,
          }));
          return defaultCueFoundationStore.ingestSourceRecords(records, {
            sourceType: "email",
            connectorName: String(body.emailConnectorName || "gmail-operational-intake").trim(),
            connectorVersion: "source-first-v1",
          });
        },
        driveFiles,
        ingestDrive: (files, verifiedFlexDocuments) => {
          const records = files.map(file => adaptDriveFileToIntakeRecord(file, {
            connectorName: String(body.driveConnectorName || "google-drive-operational-intake").trim(),
            connectorVersion: "source-first-v1",
            verifiedFlexDocuments,
          }));
          return defaultCueFoundationStore.ingestSourceRecords(records, {
            sourceType: "drive",
            connectorName: String(body.driveConnectorName || "google-drive-operational-intake").trim(),
            connectorVersion: "source-first-v1",
          });
        },
        syncSlack: body.syncSlack === false ? null : async () => {
          const rematch = await slackOperationalSignalsService.rematchAll(null, { expandQuotes: false });
          const snapshot = await slackOperationalSignalsService.getSlackOperationalSnapshot();
          const foundation = await defaultCueFoundationStore.syncSlackSnapshot(snapshot);
          return { rematch, foundation };
        },
      });
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/flex/lifecycle/status") {
      let config = null;
      let configurationError = null;
      try {
        config = getFlexLifecycleFeedConfig();
      } catch (error) {
        configurationError = error?.message || String(error);
      }
      const cursor = await defaultCueFoundationStore.getConnectorCursor(FLEX_LIFECYCLE_CONNECTOR_NAME);
      sendJson(res, 200, {
        ok: true,
        connectorName: FLEX_LIFECYCLE_CONNECTOR_NAME,
        configured: Boolean(config),
        available: Boolean(config) && !configurationError,
        status: configurationError ? "endpoint_configuration_invalid" : config ? "configured" : "endpoint_not_configured",
        endpointPath: config?.url?.pathname || null,
        cursor: cursor?.cursor ?? null,
        requiredFields: [...FLEX_LIFECYCLE_REQUIRED_FIELDS],
        error: configurationError,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/flex/confirmed-snapshot/status") {
      const state = await defaultCueFoundationStore.getConnectorState(FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR);
      const runs = await defaultCueFoundationStore.listConnectorRuns({
        connectorName: FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR,
        limit: 1,
      });
      sendJson(res, 200, {
        ok: true,
        connectorName: FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR,
        strategy: "confirmed_quote_snapshot_with_status_history",
        authoritativeForShowExistence: true,
        snapshot: state ? {
          baselineCompletedAt: state.baselineCompletedAt,
          lastSuccessfulAt: state.lastSuccessfulAt,
          lastFullReconciliationAt: state.lastFullReconciliationAt,
          confirmedCount: Object.keys(state.confirmedQuotes || {}).length,
          counts: state.counts || {},
        } : null,
        latestRun: runs[0] || null,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/flex/confirmed-snapshot/sync") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const result = await discoverFlexConfirmedQuoteSnapshot({
        confirmedStatuses: Array.isArray(body.confirmedStatuses) ? body.confirmedStatuses : [],
        fullReconciliation: Boolean(body.fullReconciliation),
      });
      sendJson(res, result.ok === false && result.available !== false ? 502 : 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/flex/lifecycle/discover") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const result = await discoverAuthoritativeFlexQuoteLifecycle({
        cursorBefore: body.cursorBefore ?? undefined,
        confirmedStatuses: Array.isArray(body.confirmedStatuses) ? body.confirmedStatuses : [],
        fullReconciliation: Boolean(body.fullReconciliation),
      });
      sendJson(res, result.ok === false && result.available ? 502 : 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/flex/quote-status/observe") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const observations = Array.isArray(body.quotes)
        ? body.quotes
        : body.quote ? [body.quote] : [];
      if (!observations.length) {
        sendJson(res, 400, { error: "quotes must contain at least one FLEX quote-status observation." });
        return;
      }
      const items = [];
      for (const observation of observations) {
        items.push(await defaultCueFoundationStore.observeFlexQuoteStatus(observation, {
          confirmedStatuses: Array.isArray(body.confirmedStatuses) ? body.confirmedStatuses : [],
        }));
      }
      const ok = items.every(item => item.ok);
      sendJson(res, ok ? 200 : 400, {
        ok,
        count: items.length,
        triggered: items.filter(item => item.triggered).length,
        idempotent: items.filter(item => item.idempotent).length,
        items,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/flex/quote-status/poll") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const quotes = Array.isArray(body.quotes) ? body.quotes : body.quote ? [body.quote] : [];
      if (!quotes.length) {
        sendJson(res, 400, { error: "quotes must contain at least one FLEX quote with an elementId." });
        return;
      }
      const items = [];
      for (const quote of quotes) {
        const elementId = String(quote.elementId || "").trim();
        if (!isFlexElementId(elementId)) {
          items.push({ ok: false, status: 400, error: "A valid FLEX quote elementId is required." });
          continue;
        }
        try {
          const header = await fetchFlexHeaderData(elementId);
          const context = buildShowContext(header.data, elementId);
          if (!context.status) {
            items.push({
              ok: false,
              status: 422,
              elementId,
              error: "FLEX header-data did not expose quote status. Configure the FLEX status-change endpoint or send the status through /observe.",
            });
            continue;
          }
          items.push(await defaultCueFoundationStore.observeFlexQuoteStatus({
            ...quote,
            ...context,
            documentType: "quote",
            documentNumber: context.documentNumber || quote.documentNumber,
            showName: context.showName || quote.showName,
            source: "flex_header_poll",
            metadata: { ...(quote.metadata || {}), statusId: context.statusId },
          }, {
            confirmedStatuses: Array.isArray(body.confirmedStatuses) ? body.confirmedStatuses : [],
          }));
        } catch (error) {
          items.push({ ok: false, status: 502, elementId, error: error?.message || String(error) });
        }
      }
      const ok = items.every(item => item.ok);
      sendJson(res, ok ? 200 : 422, {
        ok,
        count: items.length,
        triggered: items.filter(item => item.triggered).length,
        idempotent: items.filter(item => item.idempotent).length,
        items,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/flex/confirmed-quotes") {
      const items = await defaultCueFoundationStore.listFlexQuoteStatusObservations({ confirmedOnly: true });
      sendJson(res, 200, { count: items.length, items });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/slack/sync") {
      const rematch = await slackOperationalSignalsService.rematchAll(null, {
        // Active Shows / FLEX Intake Engine is authoritative. Do not manufacture
        // candidates from a bare document number that may belong to another type.
        expandQuotes: false,
      });
      const snapshot = await slackOperationalSignalsService.getSlackOperationalSnapshot();
      const foundation = await defaultCueFoundationStore.syncSlackSnapshot(snapshot);
      sendJson(res, 200, { ok: true, rematch, foundation });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/source-records/ingest") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const records = Array.isArray(body.records) ? body.records : body.record ? [body.record] : [];
      if (!records.length) {
        sendJson(res, 400, { error: "records must contain at least one connector record." });
        return;
      }
      const result = await defaultCueFoundationStore.ingestSourceRecords(records, {
        sourceType: String(body.sourceType || "").trim() || undefined,
        connectorName: String(body.connectorName || "shared-intake").trim(),
        connectorVersion: String(body.connectorVersion || "v1").trim(),
        cursorBefore: body.cursorBefore ?? null,
        cursorAfter: body.cursorAfter ?? null,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      });
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/email/ingest") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const messages = Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : [];
      if (!messages.length) {
        sendJson(res, 400, { error: "messages must contain at least one email message." });
        return;
      }
      const foundation = await defaultCueFoundationStore.read();
      let records;
      try {
        records = messages.map(message => adaptEmailMessageToIntakeRecord(message, {
          connectorName: String(body.connectorName || "gmail-operational-intake").trim(),
          connectorVersion: String(body.connectorVersion || "v1").trim(),
          provider: String(body.provider || "gmail").trim(),
          mailbox: String(body.mailbox || "").trim() || undefined,
          tenantDomain: String(body.tenantDomain || "").trim() || undefined,
          verifiedFlexDocuments: Object.values(foundation.flexDocumentRegistry || {}),
        }));
      } catch (error) {
        sendJson(res, 400, { error: error?.message || String(error) });
        return;
      }
      const result = await defaultCueFoundationStore.ingestSourceRecords(records, {
        sourceType: "email",
        connectorName: String(body.connectorName || "gmail-operational-intake").trim(),
        connectorVersion: String(body.connectorVersion || "v1").trim(),
        cursorBefore: body.cursorBefore ?? null,
        cursorAfter: body.cursorAfter ?? null,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      });
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/drive/ingest") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const files = Array.isArray(body.files) ? body.files : body.file ? [body.file] : [];
      if (!files.length) {
        sendJson(res, 400, { error: "files must contain at least one Drive file." });
        return;
      }
      const foundation = await defaultCueFoundationStore.read();
      let records;
      try {
        records = files.map(file => adaptDriveFileToIntakeRecord(file, {
          connectorName: String(body.connectorName || "google-drive-operational-intake").trim(),
          connectorVersion: String(body.connectorVersion || "v1").trim(),
          visibility: String(body.visibility || "").trim() || undefined,
          verifiedFlexDocuments: Object.values(foundation.flexDocumentRegistry || {}),
        }));
      } catch (error) {
        sendJson(res, 400, { error: error?.message || String(error) });
        return;
      }
      const result = await defaultCueFoundationStore.ingestSourceRecords(records, {
        sourceType: "drive",
        connectorName: String(body.connectorName || "google-drive-operational-intake").trim(),
        connectorVersion: String(body.connectorVersion || "v1").trim(),
        cursorBefore: body.cursorBefore ?? null,
        cursorAfter: body.cursorAfter ?? null,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      });
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/active-show-index/ingest") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const rows = Array.isArray(body.rows) ? body.rows : body.row ? [body.row] : [];
      if (!rows.length) {
        sendJson(res, 400, { error: "rows must contain at least one Active Show Index row." });
        return;
      }
      const adapterOptions = {
        sheetId: String(body.sheetId || "active-show-index").trim(),
        sheetName: String(body.sheetName || "Active Show Index").trim(),
        sourceUrl: String(body.sourceUrl || "").trim() || undefined,
        revisionId: String(body.revisionId || "").trim() || undefined,
        visibility: String(body.visibility || "").trim() || undefined,
        connectorVersion: String(body.connectorVersion || "v1").trim(),
      };
      let batch;
      try {
        batch = buildActiveShowIndexBatch(rows, adapterOptions);
      } catch (error) {
        sendJson(res, 400, { error: error?.message || String(error) });
        return;
      }
      const registry = await defaultCueFoundationStore.syncCanonicalShowRegistry(batch.shows, {
        source: "active-show-index",
        sheetId: adapterOptions.sheetId,
        sheetName: adapterOptions.sheetName,
      });
      const intake = await defaultCueFoundationStore.ingestSourceRecords(batch.records, {
        sourceType: "drive",
        connectorName: "active-show-index",
        connectorVersion: adapterOptions.connectorVersion,
        cursorBefore: body.cursorBefore ?? null,
        cursorAfter: body.cursorAfter ?? body.revisionId ?? null,
        metadata: {
          ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
          sheetId: adapterOptions.sheetId,
          sheetName: adapterOptions.sheetName,
        },
      });
      sendJson(res, intake.ok ? 200 : 422, { ok: intake.ok, registry, intake });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/connector-runs") {
      const connectorName = String(url.searchParams.get("connectorName") || "").trim() || null;
      const status = String(url.searchParams.get("status") || "").trim() || null;
      const limit = Number(url.searchParams.get("limit") || 100);
      const items = await defaultCueFoundationStore.listConnectorRuns({ connectorName, status, limit });
      sendJson(res, 200, { count: items.length, items });
      return;
    }

    if (req.method === "GET" && ["/api/flex/quote/open", "/api/flex/document/open"].includes(url.pathname)) {
      const documentNumber = String(url.searchParams.get("documentNumber") || "").trim();
      const intakeItemId = String(url.searchParams.get("intakeItemId") || "").trim();
      const documentType = String(url.searchParams.get("documentType") || "quote").trim() || "quote";
      const role = String(url.searchParams.get("role") || "linked").trim() || "linked";
      let elementId = String(url.searchParams.get("elementId") || "").trim();
      const learned = documentNumber
        ? await defaultCueFoundationStore.getLearnedFlexLink(documentNumber, intakeItemId || null)
        : null;
      if (learned?.flexUrl) {
        res.writeHead(302, { Location: learned.flexUrl, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      // A canonical quote UUID from the Intake Engine is safe to open with the
      // known quote view. Other financial document types need their own pasted
      // and verified URL because FLEX document numbers collide across types.
      if (!isFlexElementId(elementId) || documentType !== "quote") {
        const params = new URLSearchParams({ linkFlexQuote: documentNumber });
        if (intakeItemId) params.set("intakeItemId", intakeItemId);
        params.set("documentType", documentType);
        params.set("role", role);
        res.writeHead(302, {
          Location: `/command-center?${params}`,
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      res.writeHead(302, {
        Location: buildFlexQuoteUrl(elementId),
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/foundation/flex-links") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const documentNumber = String(body.documentNumber || "").trim();
      const documentType = String(body.documentType || "unknown").trim() || "unknown";
      let parsed;
      try {
        parsed = parseFlexQuoteUrl(body.flexUrl);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      let verifiedHeader;
      try {
        verifiedHeader = await fetchFlexHeaderData(parsed.elementId);
      } catch {
        sendJson(res, 400, { error: "CUE could not verify that FLEX document. Confirm the URL and try again." });
        return;
      }
      const verifiedDocumentNumber = String(buildShowContext(verifiedHeader.data, parsed.elementId)?.documentNumber || "").trim();
      if (!documentNumber || verifiedDocumentNumber.toLowerCase() !== documentNumber.toLowerCase()) {
        sendJson(res, 400, { error: `That FLEX URL belongs to ${verifiedDocumentNumber || "a different document"}, not ${documentNumber || "the requested quote"}.` });
        return;
      }
      const result = await defaultCueFoundationStore.linkFlexQuote({
        documentNumber,
        elementId: parsed.elementId,
        documentType,
        role: String(body.role || "linked").trim() || "linked",
        intakeItemId: String(body.intakeItemId || "").trim() || null,
        flexUrl: parsed.normalizedUrl,
        actorId: String(body.actorId || "command-center-user").trim(),
        rationale: body.rationale || null,
        source: "command_center",
      });
      sendJson(res, result.ok ? 200 : result.status || 400, { ...result, openUrl: parsed.normalizedUrl });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/decision-cards") {
      const showId = String(url.searchParams.get("showId") || "").trim() || null;
      const status = String(url.searchParams.get("status") || "").trim() || null;
      const items = await defaultCueFoundationStore.listDecisionCards({ showId, status });
      sendJson(res, 200, { count: items.length, items: items.slice(0, 200) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/show-registry") {
      const activeOnly = url.searchParams.get("activeOnly") !== "false";
      const items = await defaultCueFoundationStore.listCanonicalShows({ activeOnly });
      sendJson(res, 200, { count: items.length, items });
      return;
    }

    if (req.method === "GET" && /^\/api\/foundation\/show-registry\/[^/]+$/.test(url.pathname)) {
      const showId = decodeURIComponent(url.pathname.split("/")[4] || "");
      const item = await defaultCueFoundationStore.getCanonicalShow(showId);
      sendJson(res, item ? 200 : 404, item || { error: "Canonical show not found." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/summary") {
      const summary = await defaultCueFoundationStore.getSummary();
      sendJson(res, 200, summary);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/foundation/intake") {
      const status = String(url.searchParams.get("status") || "").trim() || null;
      const limit = Number(url.searchParams.get("limit") || 200);
      const items = await defaultCueFoundationStore.listIntakeItems({ status, limit });
      sendJson(res, 200, { count: items.length, items });
      return;
    }

    if (req.method === "POST" && /^\/api\/foundation\/decision-cards\/[^/]+\/decide$/.test(url.pathname)) {
      const cardId = decodeURIComponent(url.pathname.split("/")[4] || "");
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const result = await defaultCueFoundationStore.decide(cardId, {
        action: String(body.action || "").trim(),
        actorId: String(body.actorId || "").trim(),
        rationale: body.rationale || null,
        parameters: body.parameters || {},
        idempotencyKey: String(body.idempotencyKey || "").trim() || null,
      });
      sendJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "GET" && /^\/api\/foundation\/intake\/[^/]+$/.test(url.pathname)) {
      const intakeId = decodeURIComponent(url.pathname.split("/")[4] || "");
      const item = await defaultCueFoundationStore.getIntakeItem(intakeId);
      sendJson(res, item ? 200 : 404, item || { error: "Intake item not found." });
      return;
    }

    if (req.method === "GET" && /^\/api\/foundation\/shows\/[^/]+\/readiness$/.test(url.pathname)) {
      const showId = decodeURIComponent(url.pathname.split("/")[4] || "");
      const readiness = await defaultCueFoundationStore.getShowReadiness(showId);
      sendJson(res, 200, readiness);
      return;
    }

    if (req.method === "GET" && /^\/api\/foundation\/shows\/[^/]+\/state$/.test(url.pathname)) {
      const showId = decodeURIComponent(url.pathname.split("/")[4] || "");
      const state = await defaultCueFoundationStore.getShowState(showId);
      sendJson(res, state ? 200 : 404, state || { error: "Current show state not found." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/slack-operational-signals/status") {
      const status = await slackOperationalSignalsService.getSlackSignalSyncStatus();
      sendJson(res, 200, status);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/slack-operational-signals/show") {
      const showKey = String(url.searchParams.get("showKey") || "").trim();
      const showName = String(url.searchParams.get("showName") || "").trim();
      if (!showKey && !showName) {
        sendJson(res, 400, { error: "showKey or showName is required." });
        return;
      }
      const payload = await slackOperationalSignalsService.getSlackSignalsForShow(
        { showKey, showName },
        { allowStaleRefresh: false }
      );
      sendJson(res, 200, {
        showKey: showKey || null,
        showName: showName || null,
        ...payload,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/slack-operational-signals/review") {
      const queue = await slackOperationalSignalsService.getSlackNeedsReviewQueue();
      sendJson(res, 200, { count: queue.length, items: queue.slice(0, 100) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/slack-operational-signals/review/approve") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const signalId = String(body.signalId || "").trim();
      const showKey = String(body.showKey || "").trim();
      if (!signalId || !showKey) {
        sendJson(res, 400, { error: "signalId and showKey are required." });
        return;
      }
      const result = await slackOperationalSignalsService.approveSlackSignalMatch(
        signalId,
        showKey,
        { showName: body.showName || showKey, documentNumbers: body.documentNumbers || [] }
      );
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/slack-operational-signals/review/reject") {
      const rawBody = await readRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      const signalId = String(body.signalId || "").trim();
      if (!signalId) {
        sendJson(res, 400, { error: "signalId is required." });
        return;
      }
      const result = await slackOperationalSignalsService.rejectSlackSignalMatch(
        signalId,
        body.reason || null
      );
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/slack-operational-signals/general") {
      const queue = await slackOperationalSignalsService.getSlackGeneralOperationsQueue();
      sendJson(res, 200, { count: queue.length, items: queue.slice(0, 100) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/slack-operational-signals/rematch") {
      const result = await slackOperationalSignalsService.rematchAll(null, {
        expandQuotes: false,
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/find-quote") {
      const documentNumber = url.searchParams.get("documentNumber");

      if (!documentNumber) {
        sendJson(res, 400, {
          error: "Missing required query parameter: documentNumber",
        });
        return;
      }

      const result = await findFlexQuoteByDocumentNumber(documentNumber);

      sendJson(res, result.found ? 200 : 404, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/document-detail") {
      let elementId = url.searchParams.get("elementId");
      const documentNumber = url.searchParams.get("documentNumber");

      if (!elementId && documentNumber) {
        const quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber);

        if (!quoteLookup.found || !quoteLookup.elementId) {
          sendJson(res, 404, {
            error: `No FLEX quote found for documentNumber ${documentNumber}`,
            lookup: quoteLookup,
          });
          return;
        }

        elementId = quoteLookup.elementId;
      }

      if (!elementId) {
        sendJson(res, 400, {
          error: "Missing required query parameter: elementId or documentNumber",
        });
        return;
      }

      const intake = await fetchFlexShowIntake(elementId);
      const detail = buildFlexDocumentDetail(intake);

      sendJson(res, 200, {
        ...detail,
        lookup: documentNumber
          ? {
              documentNumber,
              resolvedElementId: elementId,
            }
          : null,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/event-folder") {
      const elementId = url.searchParams.get("elementId");
      if (!elementId) {
        sendJson(res, 400, {
          error: "Missing required query parameter: elementId",
        });
        return;
      }

      const includeChildDetails =
        String(url.searchParams.get("includeChildDetails") || "")
          .trim()
          .toLowerCase() === "true" ||
        url.searchParams.get("includeChildDetails") === "1";
      const includeRaw =
        String(url.searchParams.get("includeRaw") || "")
          .trim()
          .toLowerCase() === "true" ||
        url.searchParams.get("includeRaw") === "1";

      const treeResult = await fetchFlexElementTree(elementId);
      const payload = await buildFlexEventFolderRollup(treeResult, {
        elementId,
        includeChildDetails,
        includeRaw,
      });

      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/monthly-sales") {
      const year = url.searchParams.get("year");
      const month = url.searchParams.get("month");

      if (!year || !month) {
        sendJson(res, 400, {
          error: "Missing required query parameters: year and month",
        });
        return;
      }

      const result = await fetchFlexMonthlySales(year, month);

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/sales-goals-rollup") {
      const year = url.searchParams.get("year");

      if (!year) {
        sendJson(res, 400, {
          error: "Missing required query parameter: year",
        });
        return;
      }

      const result = await fetchFlexSalesGoalsRollup(year);

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flex/sales-goals-row") {
      const year = url.searchParams.get("year");

      if (!year) {
        sendJson(res, 400, {
          error: "Missing required query parameter: year",
        });
        return;
      }

      const result = await fetchFlexSalesGoalsRow(year);

      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/operational-summary") {
      if (!process.env.OPENAI_API_KEY) {
        sendJson(res, 500, {
          error: "Missing OPENAI_API_KEY in .env",
        });
        return;
      }

      const rawBody = await readRequestBody(req);
      const requestBody = JSON.parse(rawBody || "{}");
      const compactPayload = requestBody?.payload || {};
      const fallbackSummary = requestBody?.fallbackSummary || {};

      const modelConfig = selectCueModel(requestBody, compactPayload);
      console.log("[CUE OPS SUMMARY MODEL SELECT]", {
        requestedAiMode: modelConfig.requestedAiMode,
        currentModel: modelConfig.currentModel,
        advancedModel: modelConfig.advancedModel,
        selectedModel: modelConfig.model
      });

      const response = await openai.responses.create({
        model: modelConfig.model,
        input: [
          {
            role: "system",
            content:
              "You are CUE, an operational intelligence layer for Music Matters. Write like confident ops leadership: clear routing, decisive next moves, no filler. Return only valid JSON. Do not include markdown."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Generate the top dashboard CUE Operational Summary from this compact FLEX payload.",
              output_requirement: "Return only valid JSON. Do not include markdown.",
              rules: [
                "Be calm, specific, and operational.",
                "Do not sound like generic AI or a data dump; avoid stacked comma lists and wall-of-text sentences.",
                "Assessment: exactly 1–2 tight sentences; plain operational English.",
                "Recommended next steps: short, directive, task-like (verbs first); not passive review notes.",
                "Use the actual show data when useful.",
                "Keep it concise enough for a dashboard card.",
                "Do not overstate risk.",
                "Do not mention whether drivers are included, missing, present, or absent.",
                "If trucking or transportation lines exist (counts.truckingLines > 0 or trucking lines in payload), route trucking review to Brian Kee / Trucking Coordinator.",
                "If no Project Manager is assigned in showContext (null, empty, or Not assigned), include exactly this sentence verbatim as one of the recommended next steps: \"No PM is assigned — does this show need one?\"",
                "Separate staffing, trucking, timing, equipment, and PM coordination where relevant.",
                "Complexity should be Low, Medium, or High.",
                "Coordination Required should be a compact plus-separated label like: Staffing + Trucking + Warehouse + PM."
              ],
              required_schema: {
                assessment: "1-2 sentence operational assessment.",
                recommendedNextSteps: ["Action 1", "Action 2", "Action 3"],
                complexityLevel: "Low | Medium | High",
                coordinationRequired: "Staffing + Trucking"
              },
              compact_flex_payload: compactPayload
            })
          }
        ],
        text: {
          format: {
            type: "json_object",
          },
        },
      });

      const rawSummary = safeParseModelJson(response.output_text);
      const summary = normalizeOperationalSummaryShape(rawSummary, fallbackSummary);
      const summarySource = summary.source;
      const { source: _omitSource, ...summaryForClient } = summary;

      sendJson(res, 200, {
        model: modelConfig.model,
        summary: summaryForClient,
        source: summarySource
      });

      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze-flex-intake") {
      if (!process.env.OPENAI_API_KEY) {
        sendJson(res, 500, {
          error: "Missing OPENAI_API_KEY in .env",
        });
        return;
      }

      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody);

      // CUE_AI_REVIEW_RULES_V2
// Music Matters operational interpretation rules for CUE review cards.
const CUE_OPERATIONAL_RULES_V2 = `
CUE operational rules v2:

1. Quantity and Time Quantity interpretation:
   - Do not multiply Qty x Time Qty and call that headcount.
   - Qty usually means the number of people/items.
   - Time Qty usually means billing duration, day count, or time quantity.
   - Example: Audio Engineer - Patch, Qty 2, Time Qty 3 means 2 patch engineers over 3 billed days. It does not mean 6 patch engineers.
   - When summarizing staffing, say both clearly when useful: "2 patch engineers over 3 billed days."

2. Staffing interpretation:
   - Staffing review should focus on roles, headcount, dates, call times, and coverage.
   - Staffing should not own trucking line approval.
   - Staffing should not be asked to create or validate truck movements.

3. Trucking interpretation:
   - Trucking review belongs to Brian Kee / Trucking Coordinator.
   - Trucking review should focus on truck count/type, dispatch timing, site access, dock/staging, load-in, load-out, return logistics, and warehouse coordination.
   - Transportation line items at Music Matters usually include normal driver coverage.
   - Do not mention whether drivers are included, missing, present, absent, assumed, covered, or required.
   - Do not warn about missing driver labor when a truck/transportation line exists.

4. Project Manager interpretation:
   - If no Project Manager is assigned, ask once in measured language: "No PM is assigned — does this show need one?"
   - Do not repeatedly escalate missing PM as a risk.
   - Do not say "assign a PM" as a hard recommendation unless the payload clearly shows a major coordination burden.
   - Prefer: "Confirm whether PM ownership is needed."
   - If complexity signals are present, explain the rationale calmly.

5. Coordination vs risk:
   - Large shows, festivals, multiple trucks, large equipment scope, and multi-department work are not automatically risks.
   - Frame them as coordination-heavy unless there is a specific blocker, missing critical date, impossible timing, or conflicting data.
   - Use "needs_review" for coordination-heavy normal operations.
   - Use "at_risk" only when the payload supports a real operational risk.

6. Show context:
   - Use header dates as the planning source of truth when available.
   - Do not infer show timing from billing quantities if header dates are available.
   - If dates conflict, identify the conflict as data quality rather than guessing.

7. Tone:
   - Be concise, calm, and operational.
   - Write as if TJ, Brian Kee, Chelsea, David, or a PM will actually use the card.
   - Avoid dramatic language.
   - Prefer clear action routing: Staffing Coordinator, Brian Kee / Trucking Coordinator, Operations Review, PM if assigned.
`;
// CUE_MODEL_COMPARE_PATCH_SERVER
// Explicit current / advanced model selection.
// This block intentionally does NOT let OPENAI_MODEL override OPENAI_CURRENT_MODEL or OPENAI_ADVANCED_MODEL.
const cueAiRequestBody =
  typeof body !== "undefined"
    ? body
    : typeof requestBody !== "undefined"
      ? requestBody
      : typeof parsedBody !== "undefined"
        ? parsedBody
        : typeof data !== "undefined"
          ? data
          : {};

const cueAiPayload =
  typeof payload !== "undefined" && payload && typeof payload === "object"
    ? payload
    : {};

const requestedAiMode = String(
  cueAiRequestBody.aiMode ||
  cueAiRequestBody.mode ||
  cueAiPayload.aiMode ||
  cueAiPayload.mode ||
  "advanced"
).toLowerCase();

const currentModel = process.env.OPENAI_CURRENT_MODEL || "gpt-4.1-mini";
const advancedModel = process.env.OPENAI_ADVANCED_MODEL || "gpt-5.4";

const model = requestedAiMode === "current" ? currentModel : advancedModel;

console.log("[CUE AI MODEL SELECT]", {
  requestedAiMode,
  currentModel,
  advancedModel,
  selectedModel: model
});

      const response = await openai.responses.create({
        model,
        input: [
          {
            role: "system",
            content:
              'You are CUE AI, an operations assistant for Music Matters, a live event production company. Analyze FLEX show context and line-item data and return practical operations guidance. Be direct, structured, and conservative. AI recommends only; humans approve all staffing and trucking actions. Driver-related line items belong to trucking ownership, even if FLEX type.name is Labor. Do not assign drivers to the staffing workflow. IMPORTANT: Never mention driver assignment, driver confirmation, driver coverage, missing driver labor, or whether driver labor is present/absent for normal Transportation lines. Only discuss drivers if a FLEX line item explicitly names a driver. When transportation or truck line items are detected, trucking/Brian Kee handles driver assignment as part of normal trucking workflow. For trucking review cards, focus only on truck type, truck count, dispatch timing, dock timing, load-in/load-out, return logistics, vehicle/trailer plan, PM coordination, and warehouse coordination. Use header dates when available instead of guessing from billing quantity. For staffing counts, quantity is the headcount/role count. Do not multiply quantity by timeQty and call it positions. If referencing quantity multiplied by timeQty, call it person-days or billing units, not positions. Do not use Person Responsible as the staffing owner. Person Responsible is FLEX quote/account ownership context. Staffing review owner should be Staffing Coordinator unless a specific staffing owner exists. Trucking review owner should be Brian Kee / Trucking Coordinator. Show context owner should be Operations Review, or Project Manager if a projectManager is present. Project Manager logic: if no projectManager is assigned in FLEX, ask once whether this show needs a PM. Do not treat missing PM as an automatic risk. If a projectManager is assigned, do not ask whether additional PM resources or support are needed unless the payload explicitly indicates multiple PMs, PM support, or an actual blocker. When a PM is assigned and the show is complex, route coordination review to the assigned PM for alignment across staffing, trucking, warehouse, venue access, equipment scope, and load-in/load-out timing. If the show appears operationally complex, recommend PM review and explain the specific complexity signals. When equipment_summary indicates large PA, rigging, fiber/control, power, delay/fill, large equipment scope, multiple trucks, or significant warehouse/trucking coordination, create a coordination review card instead of a risk card. Use card_type "coordination", status "review_needed", and priority "medium" unless there is an actual blocker. Do not label normal operational complexity as a risk.',
          },
          {
            role: "user",
            content: JSON.stringify({
              operationalRules: CUE_OPERATIONAL_RULES_V2,
              task:
                "Analyze this FLEX intake payload and return CUE-ready operational review cards. Return only valid JSON matching the requested schema. Make the output practical, product-ready, and suitable for display in the CUE interface.",
              operating_principles: [
                "CUE is an operational execution layer for Music Matters.",
                "AI recommends only. Humans approve all staffing and trucking actions.",
                "Use show_context/header data for dates, venue, PM, client, and shipping method when available.",
                "Use equipment_summary to understand equipment scope, PM complexity, trucking/warehouse coordination, and whether the show has large PA, lighting, rigging, fiber/control, power, delay/fill, or video scope.",
                "Do not guess operational dates from timeQty when header dates are available.",
                "Driver-related labor belongs to trucking ownership, even if FLEX type.name is Labor.",
                "Do not assign drivers to the staffing workflow.",
                "Never mention driver assignment, driver confirmation, driver coverage, missing driver labor, or whether driver labor is present/absent for normal Transportation lines.",
                "Only discuss drivers if a FLEX line item explicitly names a driver.",
                "At Music Matters, truck and transportation line items route to trucking. Brian Kee/trucking handles driver assignment as part of normal trucking workflow.",
                "Staffing review should focus on non-driver labor roles.",
                "Trucking review should focus only on truck type, truck count, dispatch timing, dock timing, load-in/load-out, return logistics, vehicle/trailer plan, trucking ownership, PM coordination, and warehouse coordination.",
                "Do not recommend verifying whether separate driver labor lines are required or missing.",
                "Avoid over-focusing on finance unless a price/cost anomaly creates operational risk.",
                "For simple clean shows, say that clearly instead of inventing risks.",
                "For staffing and trucking cards, use status review_needed whenever line items exist and require human review, even if no risks are found. Use passed only for validation/check cards such as missing data or conflict checks.",
                "For staffing counts, quantity is the headcount/role count. Do not multiply quantity by timeQty and call it positions.",
                "If referencing quantity multiplied by timeQty, call it person-days or billing units, not positions.",
                "Do not use Person Responsible as the owner for staffing review cards. Person Responsible is FLEX quote/account ownership context.",
                "Staffing review owner should be Staffing Coordinator unless a specific staffing owner exists in the payload.",
                "Trucking review owner should always be Brian Kee / Trucking Coordinator.",
                "Show context owner should be Operations Review, or Project Manager if a projectManager is present.",
                "Project Manager logic: If projectManager is missing, ask once whether the show needs a PM. Do not repeatedly list missing PM as a generic risk.",
                "If a projectManager is assigned, do not ask whether additional PM resources or support are needed unless the payload explicitly indicates multiple PMs, PM support, or an actual blocker.",
                "When a projectManager is assigned and coordination is needed, route the coordination review to that PM for alignment across staffing, trucking, warehouse, venue access, equipment scope, and load-in/load-out timing.",
                "If the show appears operationally complex, explain why PM review may be recommended using specific scope signals such as multi-department work, large labor count, multiple trucks, outdoor/festival context, complex load-in/load-out, tight schedule, large equipment scope, or significant warehouse/trucking coordination.",
                "If the show does not appear complex, keep the PM question measured and simple: 'No PM is assigned — does this show need one?'",
                "When equipment_summary shows operational complexity, create a coordination review card instead of a risk card.",
                "Use card_type coordination for PM/warehouse/trucking/staffing alignment recommendations that are not actual risks.",
                "Operational complexity is not automatically a risk. Treat it as a coordination review unless there is a blocker, missing critical data, or confirmed conflict.",
                "Coordination review cards should focus on aligning PM, staffing, trucking, warehouse, venue access, load-in/load-out, and equipment scope.",
              ],
              required_schema: {
                summary: "string",
                cue_review_cards: [
                  {
                    card_type:
                      "show_context | staffing | trucking | coordination | missing_data | risk | next_actions",
                    title: "string",
                    owner: "string",
                    status: "passed | review_needed | warning | blocked",
                    priority: "low | medium | high",
                    summary: "string",
                    detected_items: [
                      {
                        name: "string",
                        quantity: "number | null",
                        timeQty: "number | null",
                        note: "string | null",
                        source_type: "string | null",
                        interpretation: "string",
                      },
                    ],
                    risks: ["string"],
                    recommended_actions: ["string"],
                  },
                ],
                questions_for_pm: ["string"],
                recommended_next_actions: ["string"],
              },
              flex_intake_payload: payload,
            }),
          },
        ],
        text: {
          format: {
            type: "json_object",
          },
        },
      });

      const rawAnalysis = safeParseModelJson(response.output_text);
      const analysis = normalizeCueAnalysis(rawAnalysis, payload);

      sendJson(res, 200, {
        model,
        analysis,
      });

      return;
    }


    if (
      (req.method === "GET" || req.method === "POST") &&
      url.pathname === "/api/active-shows/test-flex-match"
    ) {
      try {
        const documentNumber =
          url.searchParams.get("documentNumber") || "26-1777";

        const quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber);

        if (!quoteLookup.found || !quoteLookup.elementId) {
          sendJson(res, 404, {
            ok: false,
            error: `No FLEX quote found for ${documentNumber}`,
            quoteLookup,
          });
          return;
        }

        const intake = await fetchFlexShowIntake(quoteLookup.elementId);
        const detail = buildFlexDocumentDetail(intake);

        sendJson(res, 200, {
          ok: true,
          source: "flex",
          documentNumber,
          quoteLookup,
          showContext: detail.showContext,
          summary: detail.summary,
          counts: detail.counts,
          sections: detail.sections,
          laborItems: detail.laborItems,
          transportationItems: detail.transportationItems,
        });

        return;
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message || "Unable to test FLEX match.",
        });
        return;
      }
    }


    if (
      (req.method === "GET" || req.method === "POST") &&
      url.pathname === "/api/active-shows/trucking-sync"
    ) {
      try {
        let body = {};

        if (req.method === "POST") {
          const rawBody = await readRequestBody(req);
          body = rawBody ? JSON.parse(rawBody) : {};
        }

        const showId = body.showId || url.searchParams.get("showId") || "";
        const showName = body.showName || url.searchParams.get("showName") || "";
        const queryQuoteNumbers =
          url.searchParams.get("quoteNumbers") ||
          url.searchParams.get("quotes") ||
          "";

        const quoteNumbers = Array.isArray(body.quoteNumbers)
          ? body.quoteNumbers
          : String(queryQuoteNumbers)
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);

        const truckingResult = await matchTruckingRowsWithFallback({
          showId,
          showName,
          quoteNumbers,
        });

        const summary = summarizeTruckingRows(
          truckingResult.safeRows,
          quoteNumbers
        );

        const comparison = buildFlexVsTruckingComparison({
          quoteNumbers,
          truckingSummary: summary,
        });

        sendJson(res, 200, {
          ok: true,
          source: truckingResult.source,
          usedFallback: truckingResult.usedFallback,
          fallbackReason: truckingResult.fallbackReason || null,
          note: truckingResult.usedFallback
            ? "Using safe mock fallback because the live Weekly Runs sheet was not readable from this local server."
            : "Live data pulled from Trucking Schedule / Weekly Runs.",
          showId,
          showName,
          quoteNumbers,
          summary,
          comparison,
          safeRows: truckingResult.safeRows,
        });

        return;
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message || "Unable to sync trucking.",
        });
        return;
      }
    }

    sendJson(res, 404, {
      error: "Not found",
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error.message || "Unexpected server error",
    });
  }
});

server.listen(PORT, async () => {
  console.log(`CUE FLEX Intelligence Server running at http://localhost:${PORT}`);
  console.log(`CUE build: ${CUE_BUILD_LABEL}`);

  if (!CUE_PILOT_PASSWORD) {
    console.warn("WARNING: CUE_PILOT_PASSWORD is not set. Password gate is disabled for local development.");
  } else {
    console.log("Password gate enabled.");
  }

  if (SLACK_FIXTURE_MODE) {
    try {
      // Fixture module is loaded only when fixture mode is explicitly enabled.
      const { seedSlackOperationalFixtures } = await import(
        "./slack-operational-signals-fixtures.mjs"
      );
      const seeded = await seedSlackOperationalFixtures(slackOperationalSignalsService);
      console.log(
        `[CUE SLACK SIGNALS] Fixture mode enabled — seeded ${seeded.seeded} synthetic messages (${seeded.sourceLabel}).`
      );
    } catch (error) {
      console.warn(
        "[CUE SLACK SIGNALS] Fixture seed failed.",
        error?.message || error
      );
    }
  } else {
    try {
      const syncMinutes = Number(
        process.env.SLACK_OPERATIONAL_SYNC_INTERVAL_MINUTES || 0
      );
      const handle = slackOperationalSignalsService.startBackgroundSync(() =>
        slackMatchDeps.getCandidateShows()
      );
      if (handle) {
        console.log(
          `[CUE SLACK SIGNALS] Background sync enabled every ${syncMinutes} minutes.`
        );
      } else {
        console.warn(
          "[CUE SLACK SIGNALS] Background sync not enabled (set SLACK_OPERATIONAL_SYNC_INTERVAL_MINUTES >= 5)."
        );
      }
    } catch (error) {
      console.warn("[CUE SLACK SIGNALS] Background sync not started.", error?.message || error);
    }
  }
});
