import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import "dotenv/config";

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.resolve("./cue-flex-intake-lab.html");
const ASK_FLEX_HTML_FILE = path.resolve("./ask-flex.html");
const CUE_PILOT_PASSWORD = process.env.CUE_PILOT_PASSWORD || "";
const CUE_PILOT_SESSION_SECRET =
  process.env.CUE_PILOT_SESSION_SECRET || "local-private-pilot-secret";


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
  const response = await fetch(url, {
    method: "GET",
    headers: buildFlexHeaders(),
  });

  const responseText = await response.text();

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `FLEX request failed: ${response.status} ${response.statusText}. ${
        typeof data === "string"
          ? data.slice(0, 1000)
          : JSON.stringify(data).slice(0, 1000)
      }`
    );
  }

  return data;
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
    showName: extractHeaderValue(headerData, "name"),
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

async function findFlexQuoteByDocumentNumber(documentNumber) {
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

  // FLEX global search may return only name/id for the match. Prefer any result that explicitly
  // carries the document number, otherwise use the first result returned for this exact search.
  const exactMatch =
    candidates.find(
      (candidate) =>
        String(candidate.documentNumber || "").trim().toLowerCase() ===
        normalizedDocumentNumber.toLowerCase()
    ) || candidates[0] || null;

  if (!exactMatch) {
    return {
      documentNumber: normalizedDocumentNumber,
      found: false,
      elementId: null,
      name: null,
      matches: [],
      requestUrl: searchResult.requestUrl,
      rawCount: results.length,
    };
  }

  return {
    documentNumber: normalizedDocumentNumber,
    found: true,
    elementId: exactMatch.elementId,
    name: exactMatch.name,
    type: exactMatch.type,
    matches: candidates.map((candidate) => ({
      elementId: candidate.elementId,
      name: candidate.name,
      documentNumber: candidate.documentNumber,
      type: candidate.type,
    })),
    requestUrl: searchResult.requestUrl,
    rawCount: results.length,
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

function classifyFlexAskIntent(question) {
  const text = String(question || "").toLowerCase();

  if (/\b(labor|crew|tech|technician|engineer|stagehand|operator|staffing)\b/i.test(text)) {
    return "document_labor";
  }

  if (/\b(transport|transportation|truck|trucking|delivery|pickup|pick up|freight)\b/i.test(text)) {
    return "document_transportation";
  }

  if (/\b(inventory|gear|equipment|rental|rentals|items|item list|what is on|what's on)\b/i.test(text)) {
    return "document_inventory";
  }

  if (/\b(total|price|cost|amount|balance|invoice total|quote total)\b/i.test(text)) {
    return "document_total";
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

  if (intent === "document_labor") {
    const laborSection = getSectionByCategoryOrName(detail, "labor", /labor/i);
    const laborTotal = laborSection?.total ?? totals.labor ?? 0;
    const items = summarizeItemsForAnswer(detail.laborItems, 50);

    return {
      answer: `${documentLabel}: labor total is ${formatUsd(laborTotal)} across ${items.length} labor line(s).`,
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
      answer: `${documentLabel}: transportation total is ${formatUsd(
        transportationTotal
      )} across ${items.length} transportation line(s).`,
      headline: "Transportation",
      total: transportationTotal,
      totalFormatted: formatUsd(transportationTotal),
      items,
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
      answer: `${documentLabel}: inventory/rental total is ${formatUsd(
        inventoryTotal
      )} across ${detail.counts?.inventoryItems || 0} inventory item(s), grouped into ${sections.length} section(s).`,
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
      answer: `${documentLabel}: invoice total is ${formatUsd(
        invoiceTotal
      )}. Category subtotal is ${formatUsd(categorySubtotal)}. Balance due is ${formatUsd(
        financials.balanceDue || 0
      )}.`,
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
    answer: `${documentLabel}: invoice total is ${formatUsd(
      financials.invoiceTotal || totals.document || 0
    )}. Rental is ${formatUsd(totals.rental || 0)}, labor is ${formatUsd(
      totals.labor || 0
    )}, and transportation is ${formatUsd(totals.transportation || 0)}.`,
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
  };

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

async function answerFlexAskQuestion(question) {
  const documentNumber = extractDocumentNumberFromQuestion(question);
  const intent = classifyFlexAskIntent(question);

  if (!documentNumber) {
    return {
      question,
      intent,
      needsClarification: true,
      answer:
        "I need a FLEX quote number like 26-1747 to answer that question in this first Ask FLEX version.",
    };
  }

  const quoteLookup = await findFlexQuoteByDocumentNumber(documentNumber);

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

  const intake = await fetchFlexShowIntake(quoteLookup.elementId);
  const detail = buildFlexDocumentDetail(intake);
  const result = buildFlexAskAnswer(intent, detail, question);

  return {
    question,
    intent,
    documentNumber,
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
        intent === "document_inventory" ? detail.inventoryItems : undefined,
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
    "/api/flex/find-quote",
    "/api/flex/ask",
    "/api/flex/ask-brief",
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
      const html = fs.readFileSync(ASK_FLEX_HTML_FILE, "utf8");

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });

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

      sendJson(res, 200, result);
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

    if (
      (url.pathname === "/api/flex/ask" || url.pathname === "/api/flex/ask-brief") &&
      (req.method === "GET" || req.method === "POST")
    ) {
      let question = url.searchParams.get("question");
      let format = url.searchParams.get("format") || "";

      if (url.pathname === "/api/flex/ask-brief") {
        format = "brief";
      }

      if (req.method === "POST") {
        const rawBody = await readRequestBody(req);
        const requestBody = JSON.parse(rawBody || "{}");
        question = requestBody.question || question;
        format = requestBody.format || format;
      }

      if (!question) {
        sendJson(res, 400, {
          error: "Missing required question. Use POST JSON { question } or GET ?question=...",
        });
        return;
      }

      const result = await answerFlexAskQuestion(question);

      if (String(format).toLowerCase() === "brief") {
        sendJson(res, 200, buildFlexAskBriefPayload(result));
        return;
      }

      sendJson(res, 200, result);
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

server.listen(PORT, () => {
    console.log(`CUE FLEX Intelligence Server running at http://localhost:${PORT}`);

  if (!CUE_PILOT_PASSWORD) {
    console.warn("WARNING: CUE_PILOT_PASSWORD is not set. Password gate is disabled for local development.");
  } else {
    console.log("Password gate enabled.");
  }
});




