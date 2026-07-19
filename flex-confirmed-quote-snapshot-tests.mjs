import assert from "node:assert/strict";
import {
  FLEX_CONFIRMED_QUOTE_FIELDS,
  FLEX_CONFIRMED_STATUS_ID,
  FLEX_MMP_QUOTE_DEFINITION_ID,
  FLEX_PEACHTREE_CORNERS_LOCATION_ID,
  buildFlexConfirmedQuoteListUrl,
  buildFlexStatusHistoryUrl,
  confirmedTransitionFromHistory,
  runFlexConfirmedQuoteSnapshot,
} from "./flex-confirmed-quote-snapshot.mjs";
import {
  FlexRequestError,
  fetchFlexJson,
  isSkippableFlexRequestError,
} from "./flex-request-client.mjs";

const baseUrl = "https://m2.flexrentalsolutions.com/f5";
const confirmedListUrl = buildFlexConfirmedQuoteListUrl(baseUrl, {
  cacheBust: 123,
  pageIndex: 2,
  pageSize: 50,
});
assert.equal(confirmedListUrl.pathname, "/f5/api/element-list/row-data");
assert.equal(confirmedListUrl.searchParams.get("definitionId"), FLEX_MMP_QUOTE_DEFINITION_ID);
assert.deepEqual(confirmedListUrl.searchParams.getAll("headerFieldTypeIds"), FLEX_CONFIRMED_QUOTE_FIELDS);
assert.equal(confirmedListUrl.searchParams.get("page"), "3");
assert.equal(confirmedListUrl.searchParams.get("start"), "100");
assert.equal(confirmedListUrl.searchParams.get("size"), "50");
assert.deepEqual(JSON.parse(confirmedListUrl.searchParams.get("filter")), [
  { property: "locationId", valueList: [FLEX_PEACHTREE_CORNERS_LOCATION_ID] },
  { property: "statusId", valueList: [FLEX_CONFIRMED_STATUS_ID], dateRangeFilter: false },
]);

const futureId = "11111111-1111-4111-8111-111111111111";
const oldId = "22222222-2222-4222-8222-222222222222";
const newId = "33333333-3333-4333-8333-333333333333";
const failingId = "44444444-4444-4444-8444-444444444444";
const relatedId = "55555555-5555-4555-8555-555555555555";
const statusUrl = buildFlexStatusHistoryUrl(baseUrl, futureId, { cacheBust: 456 });
assert.equal(statusUrl.pathname, `/f5/api/element-status-change/${futureId}`);
assert.equal(statusUrl.searchParams.get("page"), "1");
assert.equal(statusUrl.searchParams.get("start"), "0");

function quoteRow({ id, number, name, start, end }) {
  return {
    id,
    name,
    documentNumber: number,
    clientCompany: "Music Matters Client",
    calcStartDate: start,
    calcEndDate: end,
    statusId: { id: FLEX_CONFIRMED_STATUS_ID, name: "Confirmed" },
    locationId: { id: FLEX_PEACHTREE_CORNERS_LOCATION_ID, name: "Peachtree Corners" },
  };
}

function confirmedHistory(id, changedOn = "2026-07-14T12:00:00.000Z") {
  return [{
    id: `transition-${id}`,
    changedOn,
    changedByUserId: "user-1",
    changedByUserName: "Project Manager",
    previousStatusId: "inquiry-status",
    previousStatusName: "Inquiry",
    newStatusId: FLEX_CONFIRMED_STATUS_ID,
    newStatusName: "Confirmed",
  }];
}

assert.equal(confirmedTransitionFromHistory(confirmedHistory(futureId)).id, `transition-${futureId}`);

const future = quoteRow({
  id: futureId,
  number: "26-1846",
  name: "Live Nation Moonchild @ The Fox",
  start: "2026-07-20T12:00:00.000Z",
  end: "2026-07-21T12:00:00.000Z",
});
const old = quoteRow({
  id: oldId,
  number: "23-1880",
  name: "Historical Show",
  start: "2023-11-01T12:00:00.000Z",
  end: "2023-11-03T12:00:00.000Z",
});
const newlyConfirmed = quoteRow({
  id: newId,
  number: "26-1900",
  name: "Newly Confirmed Show",
  start: "2026-08-01T12:00:00.000Z",
  end: "2026-08-02T12:00:00.000Z",
});
const failing = quoteRow({
  id: failingId,
  number: "26-1901",
  name: "Status History Failure",
  start: "2026-08-03T12:00:00.000Z",
  end: "2026-08-04T12:00:00.000Z",
});
const related = quoteRow({
  id: relatedId,
  number: "26-1902",
  name: "Known Show Add On",
  start: "2026-08-05T12:00:00.000Z",
  end: "2026-08-06T12:00:00.000Z",
});

let state = null;
let saveCount = 0;
const observed = [];
const checkpoints = [];

function pagesFor(rows) {
  return ({ pageIndex }) => {
    const pageRows = pageIndex === 0 ? rows.slice(0, 1) : rows.slice(1);
    return {
      content: pageRows,
      number: pageIndex,
      totalPages: rows.length > 1 ? 2 : 1,
      totalElements: rows.length,
      last: rows.length <= 1 || pageIndex === 1,
    };
  };
}

async function run(rows, options = {}) {
  return runFlexConfirmedQuoteSnapshot({
    now: "2026-07-14T12:00:00.000Z",
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    fetchConfirmedPage: pagesFor(rows),
    fetchStatusHistory: async elementId => {
      if (options.failElementId === elementId) throw new Error("status history unavailable");
      return confirmedHistory(elementId);
    },
    observe: async observation => {
      observed.push(observation);
      return { ok: true, triggered: true, idempotent: false };
    },
    prepareObservation: options.prepareObservation,
    getState: async () => state,
    saveState: async (_connectorName, nextState) => {
      saveCount += 1;
      state = nextState;
    },
    checkpoint: async checkpoint => checkpoints.push(checkpoint),
  });
}

const baseline = await run([future, old], {
  startedAt: "2026-07-14T12:00:00.000Z",
  completedAt: "2026-07-14T12:00:01.000Z",
});
assert.equal(baseline.ok, true);
assert.equal(baseline.baseline, true);
assert.equal(baseline.received, 2);
assert.equal(baseline.candidateCount, 1, "baseline hydrates active/upcoming quotes without replaying all history");
assert.deepEqual(observed.map(item => item.elementId), [futureId]);
assert.equal(Object.keys(state.confirmedQuotes).length, 2, "baseline snapshot remembers every currently confirmed quote UUID");
assert.equal(state.confirmedQuotes[oldId].confirmedAt, null, "historical baseline rows stay unhydrated until needed");

const unchanged = await run([future, old], {
  startedAt: "2026-07-14T12:05:00.000Z",
  completedAt: "2026-07-14T12:05:01.000Z",
});
assert.equal(unchanged.ok, true);
assert.equal(unchanged.baseline, false);
assert.equal(unchanged.candidateCount, 0, "an unchanged snapshot is a no-op");
assert.equal(observed.length, 1);

const incremental = await run([future, old, newlyConfirmed], {
  startedAt: "2026-07-14T12:10:00.000Z",
  completedAt: "2026-07-14T12:10:01.000Z",
});
assert.equal(incremental.ok, true);
assert.deepEqual(incremental.newIds, [newId]);
assert.equal(incremental.candidateCount, 1);
assert.equal(observed.at(-1).elementId, newId);
assert.equal(observed.at(-1).sourceEventId, `transition-${newId}`);
assert.equal(observed.at(-1).changedAt, "2026-07-14T12:00:00.000Z");

const deferred = await run([future, old, newlyConfirmed, related], {
  startedAt: "2026-07-14T12:12:00.000Z",
  completedAt: "2026-07-14T12:12:01.000Z",
  prepareObservation: ({ quote }) => quote.elementId === relatedId
    ? { action: "defer", reason: "known_related_flex_document_attaches_to_parent_show", metadata: { canonicalShowId: "known-show" } }
    : { action: "observe" },
});
assert.equal(deferred.ok, true);
assert.equal(deferred.deferred.length, 1);
assert.equal(deferred.deferred[0].elementId, relatedId);
assert.equal(state.confirmedQuotes[relatedId].disposition, "deferred");
assert.equal(state.confirmedQuotes[relatedId].canonicalShowId, "known-show");
assert.equal(observed.some(item => item.elementId === relatedId), false, "known related documents never create a show observation");

const stateBeforeFailure = structuredClone(state);
const failed = await run([future, old, newlyConfirmed, related, failing], {
  startedAt: "2026-07-14T12:15:00.000Z",
  completedAt: "2026-07-14T12:15:01.000Z",
  failElementId: failingId,
});
assert.equal(failed.ok, false);
assert.equal(failed.status, "partial");
assert.equal(failed.errors.length, 1);
assert.deepEqual(state, stateBeforeFailure, "partial status-history failure never advances the durable snapshot");
assert.equal(saveCount, 4, "only successful runs advance state");
assert.equal(checkpoints.at(-1).status, "partial");
assert.equal(checkpoints.at(-1).metadata.snapshotAdvanced, false);

await assert.rejects(
  fetchFlexJson("https://flex.test/stalled-row-data", {
    timeoutMs: 1_000,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  }),
  error => {
    assert.ok(error instanceof FlexRequestError);
    assert.equal(error.code, "flex_request_timeout");
    assert.equal(error.retryable, true);
    assert.equal(isSkippableFlexRequestError(error), true);
    return true;
  },
  "a stalled FLEX document request aborts instead of hanging reconciliation",
);

await assert.rejects(
  fetchFlexJson("https://flex.test/inaccessible-row-data", {
    timeoutMs: 1_000,
    fetchImpl: async () => new Response(
      JSON.stringify({ exceptionCode: "FLEX_5000", exceptionMessage: "Access Denied" }),
      { status: 401, statusText: "Unauthorized" },
    ),
  }),
  error => {
    assert.equal(error.code, "flex_http_401");
    assert.equal(error.status, 401);
    assert.equal(isSkippableFlexRequestError(error), true);
    return true;
  },
  "an inaccessible FLEX document is classified as skippable",
);

console.log(JSON.stringify({
  ok: true,
  baselineHydrated: baseline.candidateCount,
  incrementalObserved: incremental.newIds.length,
  relatedDocumentsDeferred: deferred.deferred.length,
  snapshotSize: Object.keys(state.confirmedQuotes).length,
  partialReplaySafe: true,
  stalledRequestAborted: true,
  inaccessibleDocumentSkippable: true,
}, null, 2));
