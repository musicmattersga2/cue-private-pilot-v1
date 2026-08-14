const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR = "flex-confirmed-quote-snapshot";
export const FLEX_MMP_QUOTE_DEFINITION_ID = "9bfb850c-b117-11df-b8d5-00e08175e43e";
export const FLEX_CONFIRMED_STATUS_ID = "9d67fccc-aee7-11df-b8d5-00e08175e43e";
export const FLEX_PEACHTREE_CORNERS_LOCATION_ID = "2f49c62c-b139-11df-b8d5-00e08175e43e";

export const FLEX_CONFIRMED_QUOTE_FIELDS = Object.freeze([
  "name",
  "documentNumber",
  "parentElementName",
  "clientCompany",
  "departmentId",
  "corporateIdentityId",
  "personResponsibleId",
  "projectManagerId",
  "createdByUserId",
  "calcStartDate",
  "customField1Value",
  "calcEndDate",
  "totalPrice",
  "statusId",
  "locationId",
  "pickupLocationId",
  "returnLocationId",
]);

function text(value) {
  return String(value ?? "").trim();
}

function dateValue(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function objectName(value) {
  if (value && typeof value === "object") return text(value.name || value.displayName || value.label) || null;
  return text(value) || null;
}

function objectId(value) {
  if (value && typeof value === "object") return text(value.id || value.uuid) || null;
  return UUID_PATTERN.test(text(value)) ? text(value).toLowerCase() : null;
}

function stableQuoteFingerprint(quote) {
  return JSON.stringify([
    quote.elementId,
    quote.documentNumber,
    quote.showName,
    quote.statusId,
    quote.plannedStartDate,
    quote.plannedEndDate,
    quote.client,
    quote.locationId,
  ]);
}

export function buildFlexConfirmedQuoteListUrl(baseUrl, options = {}) {
  const url = new URL("api/element-list/row-data", `${text(baseUrl).replace(/\/$/, "")}/`);
  const definitionId = text(options.definitionId) || FLEX_MMP_QUOTE_DEFINITION_ID;
  const confirmedStatusId = text(options.confirmedStatusId) || FLEX_CONFIRMED_STATUS_ID;
  const locationId = text(options.locationId) || FLEX_PEACHTREE_CORNERS_LOCATION_ID;
  const pageSize = Math.max(1, Math.min(Number(options.pageSize) || 50, 500));
  const pageIndex = Math.max(0, Number(options.pageIndex) || 0);
  url.searchParams.set("_dc", String(options.cacheBust || Date.now()));
  url.searchParams.set("definitionId", definitionId);
  for (const field of options.fields || FLEX_CONFIRMED_QUOTE_FIELDS) {
    url.searchParams.append("headerFieldTypeIds", field);
  }
  url.searchParams.set("filter", JSON.stringify([
    { property: "locationId", valueList: [locationId] },
    { property: "statusId", valueList: [confirmedStatusId], dateRangeFilter: false },
  ]));
  // FLEX uses a zero-based offset/page payload even though its UI request sends
  // page=1 for the first page. Preserve that verified request convention.
  url.searchParams.set("page", String(pageIndex + 1));
  url.searchParams.set("start", String(pageIndex * pageSize));
  url.searchParams.set("size", String(pageSize));
  return url;
}

export function buildFlexStatusHistoryUrl(baseUrl, elementId, options = {}) {
  const normalizedId = text(elementId).toLowerCase();
  if (!UUID_PATTERN.test(normalizedId)) throw new Error("A valid FLEX quote element ID is required.");
  const url = new URL(`api/element-status-change/${encodeURIComponent(normalizedId)}`, `${text(baseUrl).replace(/\/$/, "")}/`);
  url.searchParams.set("_dc", String(options.cacheBust || Date.now()));
  url.searchParams.set("page", String(Math.max(1, Number(options.page) || 1)));
  url.searchParams.set("start", String(Math.max(0, Number(options.start) || 0)));
  url.searchParams.set("limit", String(Math.max(1, Math.min(Number(options.limit) || 100, 500))));
  return url;
}

export function normalizeFlexConfirmedQuoteRow(row = {}) {
  const elementId = text(row.id || row.elementId).toLowerCase();
  if (!UUID_PATTERN.test(elementId)) return { ok: false, reason: "invalid_or_missing_element_id", raw: row };
  const documentNumber = text(row.documentNumber).toUpperCase();
  if (!/^\d{2}-\d{3,6}$/.test(documentNumber)) {
    return { ok: false, reason: "invalid_or_missing_document_number", elementId, raw: row };
  }
  const quote = {
    elementId,
    documentNumber,
    documentType: "quote",
    showName: text(row.name || row.displayName).replace(/^\s*Qt\s+/i, "") || documentNumber,
    client: text(row.clientCompany) || null,
    plannedStartDate: dateValue(row.calcStartDate),
    plannedEndDate: dateValue(row.calcEndDate),
    status: objectName(row.statusId) || text(row.status) || "Confirmed",
    statusId: objectId(row.statusId) || null,
    locationId: objectId(row.locationId) || null,
    locationName: objectName(row.locationId),
    accountManager: objectName(row.personResponsibleId),
    projectManager: objectName(row.projectManagerId),
    createdBy: objectName(row.createdByUserId),
    parentElementName: text(row.parentElementName) || null,
    parentElementId: text(row.parentId).toLowerCase() || null,
    totalPrice: Number.isFinite(Number(row.totalPrice)) ? Number(row.totalPrice) : null,
    raw: row,
  };
  return { ok: true, quote: { ...quote, fingerprint: stableQuoteFingerprint(quote) } };
}

export function normalizeFlexConfirmedQuotePage(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload.content) ? payload.content : [];
  const quotes = [];
  const rejected = [];
  for (const row of rows) {
    const normalized = normalizeFlexConfirmedQuoteRow(row);
    if (normalized.ok) quotes.push(normalized.quote);
    else rejected.push(normalized);
  }
  const pageIndex = Math.max(0, Number(payload.number) || 0);
  const totalPages = Math.max(1, Number(payload.totalPages) || 1);
  return {
    quotes,
    rejected,
    pageIndex,
    totalPages,
    totalElements: Number(payload.totalElements ?? rows.length) || rows.length,
    hasMore: payload.last === false || pageIndex + 1 < totalPages,
  };
}

export function normalizeFlexStatusTransition(input = {}) {
  const id = text(input.id || input.eventId);
  const changedAt = dateValue(input.changedOn || input.changedAt);
  const newStatus = text(input.newStatusName || input.newStatus?.name || input.status);
  if (!id || !changedAt || !newStatus) return { ok: false, reason: "incomplete_status_transition", raw: input };
  return {
    ok: true,
    transition: {
      id,
      changedAt,
      changedByUserId: text(input.changedByUserId) || null,
      changedByUserName: text(input.changedByUserName) || null,
      previousStatusId: text(input.previousStatusId) || null,
      previousStatus: text(input.previousStatusName) || null,
      newStatusId: text(input.newStatusId) || null,
      newStatus,
      raw: input,
    },
  };
}

export function confirmedTransitionFromHistory(payload = [], options = {}) {
  const records = Array.isArray(payload) ? payload : Array.isArray(payload.content) ? payload.content : [];
  const confirmedStatusId = text(options.confirmedStatusId) || FLEX_CONFIRMED_STATUS_ID;
  const transitions = records
    .map(normalizeFlexStatusTransition)
    .filter(item => item.ok)
    .map(item => item.transition)
    .filter(item => item.newStatusId === confirmedStatusId || /\bconfirmed\b/i.test(item.newStatus))
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  return transitions[0] || null;
}

export function shouldHydrateBaselineQuote(quote, options = {}) {
  if (options.activeElementIds?.has?.(quote.elementId)) return true;
  if (options.activeDocumentNumbers?.has?.(quote.documentNumber)) return true;
  const nowMs = Date.parse(options.now || new Date().toISOString());
  const lookbackDays = Math.max(0, Number(options.lookbackDays) || 30);
  const endMs = Date.parse(quote.plannedEndDate || quote.plannedStartDate || "");
  return Number.isFinite(endMs) && endMs >= nowMs - lookbackDays * 86400000;
}

function emptySnapshot(connectorName) {
  return {
    version: 1,
    connectorName,
    strategy: "confirmed_quote_snapshot",
    baselineCompletedAt: null,
    lastSuccessfulAt: null,
    lastFullReconciliationAt: null,
    confirmedQuotes: {},
  };
}

export async function runFlexConfirmedQuoteSnapshot(options = {}) {
  const connectorName = options.connectorName || FLEX_CONFIRMED_QUOTE_SNAPSHOT_CONNECTOR;
  const startedAt = options.startedAt || new Date().toISOString();
  const previous = { ...emptySnapshot(connectorName), ...(await options.getState?.(connectorName) || {}) };
  const baseline = !previous.baselineCompletedAt;
  const reconcile = Boolean(options.fullReconciliation) || baseline;
  const pages = [];
  const allQuotes = [];
  const rejected = [];
  let pageIndex = 0;
  try {
    do {
      const payload = await options.fetchConfirmedPage({ pageIndex });
      const page = normalizeFlexConfirmedQuotePage(payload);
      pages.push({ pageIndex: page.pageIndex, received: page.quotes.length, rejected: page.rejected.length });
      allQuotes.push(...page.quotes);
      rejected.push(...page.rejected);
      if (!page.hasMore) break;
      pageIndex += 1;
      if (pageIndex >= (options.maxPages || 500)) throw new Error("FLEX confirmed quote pagination exceeded its safety limit.");
    } while (true);
  } catch (error) {
    const result = { ok: false, status: "failed", connectorName, baseline, error: error?.message || String(error), pages, received: allQuotes.length };
    await options.checkpoint?.({ connectorName, connectorVersion: "confirmed-snapshot-v1", sourceType: "flex", status: "failed", startedAt, cursorBefore: previous.lastSuccessfulAt, cursorAfter: previous.lastSuccessfulAt, counts: { received: allQuotes.length, failed: 1 }, errors: [{ message: result.error }], metadata: { baseline, strategy: previous.strategy } });
    return result;
  }

  const current = Object.fromEntries(allQuotes.map(quote => [quote.elementId, quote]));
  const newIds = allQuotes.filter(quote => !previous.confirmedQuotes?.[quote.elementId]).map(quote => quote.elementId);
  const changedIds = allQuotes.filter(quote => previous.confirmedQuotes?.[quote.elementId]?.fingerprint && previous.confirmedQuotes[quote.elementId].fingerprint !== quote.fingerprint).map(quote => quote.elementId);
  const removedIds = Object.keys(previous.confirmedQuotes || {}).filter(elementId => !current[elementId]);
  const candidates = allQuotes.filter(quote => {
    if (!baseline && newIds.includes(quote.elementId)) return true;
    if (!baseline && changedIds.includes(quote.elementId)) return true;
    if (baseline) return shouldHydrateBaselineQuote(quote, options);
    return reconcile && shouldHydrateBaselineQuote(quote, options);
  });

  const observations = [];
  const deferred = [];
  const errors = [];
  for (const quote of candidates) {
    try {
      const history = await options.fetchStatusHistory(quote.elementId);
      const transition = confirmedTransitionFromHistory(history, { confirmedStatusId: options.confirmedStatusId });
      if (!transition) throw new Error(`No authoritative Confirmed transition found for ${quote.documentNumber}.`);
      const prepared = options.prepareObservation
        ? await options.prepareObservation({ quote, transition, previous })
        : { action: "observe", observation: {} };
      if (prepared?.action === "defer") {
        deferred.push({
          elementId: quote.elementId,
          documentNumber: quote.documentNumber,
          transition,
          reason: text(prepared.reason) || "related_document_not_show_authority",
          metadata: prepared.metadata || {},
        });
        continue;
      }
      if (prepared?.action && prepared.action !== "observe") {
        throw new Error(`Unsupported confirmed-quote disposition '${prepared.action}' for ${quote.documentNumber}.`);
      }
      const preparedObservation = prepared?.observation || {};
      const observed = await options.observe({
        ...quote,
        ...preparedObservation,
        status: transition.newStatus,
        changedAt: transition.changedAt,
        observedAt: startedAt,
        source: "flex_confirmed_quote_snapshot",
        sourceEventId: transition.id,
        metadata: {
          ...(preparedObservation.metadata || {}),
          statusId: transition.newStatusId || quote.statusId,
          changedByUserId: transition.changedByUserId,
          changedByUserName: transition.changedByUserName,
          discoveryStrategy: "confirmed_quote_snapshot",
        },
      });
      if (!observed?.ok) throw new Error(observed?.error || `Failed to observe ${quote.documentNumber}.`);
      observations.push({ elementId: quote.elementId, documentNumber: quote.documentNumber, transition, result: observed });
    } catch (error) {
      errors.push({ elementId: quote.elementId, documentNumber: quote.documentNumber, message: error?.message || String(error) });
    }
  }

  if (errors.length) {
    const result = { ok: false, status: "partial", connectorName, baseline, received: allQuotes.length, candidateCount: candidates.length, observations, deferred, rejected, errors, newIds, changedIds, removedIds, pages };
    await options.checkpoint?.({ connectorName, connectorVersion: "confirmed-snapshot-v1", sourceType: "flex", status: "partial", startedAt, cursorBefore: previous.lastSuccessfulAt, cursorAfter: previous.lastSuccessfulAt, counts: { received: allQuotes.length, observed: observations.length, deferred: deferred.length, rejected: rejected.length, failed: errors.length }, errors, metadata: { baseline, snapshotAdvanced: false, pages } });
    return result;
  }

  const completedAt = options.completedAt || new Date().toISOString();
  const confirmedQuotes = {};
  for (const quote of allQuotes) {
    const observed = observations.find(item => item.elementId === quote.elementId);
    const deferredItem = deferred.find(item => item.elementId === quote.elementId);
    confirmedQuotes[quote.elementId] = {
      ...(previous.confirmedQuotes?.[quote.elementId] || {}),
      elementId: quote.elementId,
      documentNumber: quote.documentNumber,
      showName: quote.showName,
      plannedStartDate: quote.plannedStartDate,
      plannedEndDate: quote.plannedEndDate,
      fingerprint: quote.fingerprint,
      statusId: quote.statusId,
      firstSeenAt: previous.confirmedQuotes?.[quote.elementId]?.firstSeenAt || completedAt,
      lastSeenAt: completedAt,
      confirmationEventId: observed?.transition?.id || previous.confirmedQuotes?.[quote.elementId]?.confirmationEventId || null,
      confirmedAt: observed?.transition?.changedAt || previous.confirmedQuotes?.[quote.elementId]?.confirmedAt || null,
      disposition: deferredItem ? "deferred" : observed ? "observed" : previous.confirmedQuotes?.[quote.elementId]?.disposition || "snapshot_only",
      dispositionReason: deferredItem?.reason || previous.confirmedQuotes?.[quote.elementId]?.dispositionReason || null,
      canonicalShowId: deferredItem?.metadata?.canonicalShowId || observed?.result?.show?.id || previous.confirmedQuotes?.[quote.elementId]?.canonicalShowId || null,
    };
  }
  const next = {
    ...previous,
    baselineCompletedAt: previous.baselineCompletedAt || completedAt,
    lastSuccessfulAt: completedAt,
    lastFullReconciliationAt: reconcile ? completedAt : previous.lastFullReconciliationAt,
    confirmedQuotes,
    counts: { confirmed: allQuotes.length, hydrated: observations.length, deferred: deferred.length },
  };
  await options.saveState(connectorName, next);
  await options.checkpoint?.({ connectorName, connectorVersion: "confirmed-snapshot-v1", sourceType: "flex", status: "completed", startedAt, finishedAt: completedAt, cursorBefore: previous.lastSuccessfulAt, cursorAfter: completedAt, counts: { received: allQuotes.length, observed: observations.length, deferred: deferred.length, triggered: observations.filter(item => item.result.triggered).length, idempotent: observations.filter(item => item.result.idempotent).length, rejected: rejected.length, failed: 0 }, metadata: { baseline, snapshotAdvanced: true, newCount: newIds.length, changedCount: changedIds.length, removedCount: removedIds.length, pages } });
  return { ok: true, status: "completed", connectorName, baseline, received: allQuotes.length, candidateCount: candidates.length, observations, deferred, rejected, errors: [], newIds, changedIds, removedIds, snapshot: next, pages };
}
