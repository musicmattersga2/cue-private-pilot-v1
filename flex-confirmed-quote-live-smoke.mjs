import "dotenv/config";
import {
  FLEX_CONFIRMED_STATUS_ID,
  FLEX_MMP_QUOTE_DEFINITION_ID,
  FLEX_PEACHTREE_CORNERS_LOCATION_ID,
  buildFlexConfirmedQuoteListUrl,
  buildFlexStatusHistoryUrl,
  confirmedTransitionFromHistory,
  normalizeFlexConfirmedQuotePage,
} from "./flex-confirmed-quote-snapshot.mjs";

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function requiredEnvironment(name) {
  const value = text(process.env[name]);
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and configure local FLEX read access.`);
  return value;
}

function safeEndpoint(url) {
  return `${url.origin}${url.pathname}`;
}

async function fetchJson(url, headers, timeoutMs) {
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`FLEX returned HTTP ${response.status} for ${safeEndpoint(url)}.`);
  }
  const contentType = text(response.headers.get("content-type")).toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new Error(`FLEX returned a non-JSON response for ${safeEndpoint(url)}.`);
  }
  return response.json();
}

async function main() {
  const baseUrl = requiredEnvironment("FLEX_BASE_URL").replace(/\/$/, "");
  const base = new URL(`${baseUrl}/`);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("FLEX_BASE_URL must use HTTPS unless the connector targets localhost.");
  }

  const authHeader = requiredEnvironment("FLEX_AUTH_HEADER");
  const authValue = requiredEnvironment("FLEX_AUTH_VALUE");
  if (/\r|\n/.test(authHeader) || /\r|\n/.test(authValue)) {
    throw new Error("FLEX authentication configuration contains an invalid line break.");
  }

  const definitionId = text(process.env.CUE_FLEX_MMP_QUOTE_DEFINITION_ID) || FLEX_MMP_QUOTE_DEFINITION_ID;
  const confirmedStatusId = text(process.env.CUE_FLEX_CONFIRMED_STATUS_ID) || FLEX_CONFIRMED_STATUS_ID;
  const locationId = text(process.env.CUE_FLEX_LOCATION_ID) || FLEX_PEACHTREE_CORNERS_LOCATION_ID;
  const pageSize = positiveInteger(process.env.CUE_FLEX_SMOKE_PAGE_SIZE, 5, 25);
  const timeoutMs = positiveInteger(process.env.CUE_FLEX_SMOKE_TIMEOUT_MS, 20000, 60000);
  const headers = { Accept: "application/json", [authHeader]: authValue };

  const listUrl = buildFlexConfirmedQuoteListUrl(baseUrl, {
    definitionId,
    confirmedStatusId,
    locationId,
    pageIndex: 0,
    pageSize,
  });
  const listPayload = await fetchJson(listUrl, headers, timeoutMs);
  const page = normalizeFlexConfirmedQuotePage(listPayload);
  if (!page.quotes.length) {
    throw new Error("FLEX returned no valid confirmed MMP Quotes for the configured definition, status, and location.");
  }

  const quote = page.quotes[0];
  const historyUrl = buildFlexStatusHistoryUrl(baseUrl, quote.elementId, { limit: 100 });
  const historyPayload = await fetchJson(historyUrl, headers, timeoutMs);
  const transition = confirmedTransitionFromHistory(historyPayload, { confirmedStatusId });
  if (!transition) {
    throw new Error(`FLEX returned no authoritative Confirmed transition for ${quote.documentNumber}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "read_only",
    connector: "flex-confirmed-quote-snapshot",
    endpoints: {
      confirmedQuotes: safeEndpoint(listUrl),
      statusHistory: safeEndpoint(historyUrl),
    },
    filters: { definitionId, confirmedStatusId, locationId },
    page: {
      validQuotes: page.quotes.length,
      rejectedRows: page.rejected.length,
      totalElements: page.totalElements,
      totalPages: page.totalPages,
    },
    sample: {
      elementId: quote.elementId,
      documentNumber: quote.documentNumber,
      showName: quote.showName,
      plannedStartDate: quote.plannedStartDate,
      confirmedAt: transition.changedAt,
      confirmationEventId: transition.id,
      changedBy: transition.changedByUserName,
    },
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    mode: "read_only",
    error: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});

