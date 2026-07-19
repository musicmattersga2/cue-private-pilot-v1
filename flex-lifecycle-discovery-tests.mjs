import assert from "node:assert/strict";
import {
  FLEX_LIFECYCLE_REQUIRED_FIELDS,
  flexLifecycleUnavailable,
  normalizeFlexLifecycleFeed,
  runFlexLifecycleDiscovery,
} from "./flex-lifecycle-discovery.mjs";

const observedAt = "2026-07-14T12:00:00.000Z";
const feed = normalizeFlexLifecycleFeed({
  events: [{
    eventId: "status-change-1",
    element: {
      id: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
      documentNumber: "26-1846",
      name: "Live Nation Moonchild @ The Fox",
    },
    definitionName: "MMP Quote",
    status: { name: "Confirmed Quote" },
    statusChangedAt: "2026-07-14T11:58:00.000Z",
  }, {
    id: "not-a-flex-uuid",
    documentNumber: "26-0836",
  }],
  pageInfo: { endCursor: "cursor-2", hasNextPage: true },
}, { observedAt, cursorBefore: "cursor-1" });

assert.equal(feed.candidates.length, 1);
assert.equal(feed.rejected.length, 1);
assert.equal(feed.cursorAfter, "cursor-2");
assert.equal(feed.hasMore, true);
assert.deepEqual(feed.candidates[0], {
  elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
  documentNumber: "26-1846",
  documentType: "mmp quote",
  status: "Confirmed Quote",
  changedAt: "2026-07-14T11:58:00.000Z",
  observedAt,
  sourceEventId: "status-change-1",
  showName: "Live Nation Moonchild @ The Fox",
  client: null,
  venue: null,
  plannedStartDate: null,
  plannedEndDate: null,
  parentElementId: null,
  raw: feed.candidates[0].raw,
});

const unavailable = flexLifecycleUnavailable("endpoint_not_configured");
assert.equal(unavailable.ok, true);
assert.equal(unavailable.available, false);
assert.equal(unavailable.observations.length, 0);
assert.deepEqual(unavailable.requiredFields, FLEX_LIFECYCLE_REQUIRED_FIELDS);

const checkpoints = [];
const observed = [];
const discovery = await runFlexLifecycleDiscovery({
  endpointConfigured: true,
  endpoint: "/api/cue/quote-status-changes",
  cursorBefore: "cursor-1",
  observedAt,
  fetchFeed: async () => ({
    records: [feed.candidates[0]],
    nextCursor: "cursor-2",
  }),
  verifyCandidate: async candidate => ({ ok: true, observation: { ...candidate, documentType: "quote" } }),
  observe: async observation => {
    observed.push(observation);
    return { ok: true, triggered: true, observation };
  },
  checkpoint: async checkpoint => checkpoints.push(checkpoint),
});
assert.equal(discovery.ok, true);
assert.equal(discovery.triggered, 1);
assert.equal(discovery.cursorAfter, "cursor-2");
assert.equal(observed.length, 1);
assert.equal(checkpoints[0].status, "completed");

const partialCheckpoints = [];
const partial = await runFlexLifecycleDiscovery({
  endpointConfigured: true,
  cursorBefore: "cursor-safe",
  fetchFeed: async () => ({ records: [feed.candidates[0]], nextCursor: "cursor-unsafe" }),
  verifyCandidate: async () => { throw new Error("temporary FLEX failure"); },
  checkpoint: async checkpoint => partialCheckpoints.push(checkpoint),
});
assert.equal(partial.ok, false);
assert.equal(partial.cursorAfter, "cursor-safe", "a failed page never advances the lifecycle cursor");
assert.equal(partialCheckpoints[0].cursorAfter, "cursor-safe");

const unavailableCheckpoints = [];
const configuredUnavailable = await runFlexLifecycleDiscovery({
  endpointConfigured: true,
  cursorBefore: "cursor-replay",
  fetchFeed: async () => { throw new Error("configured FLEX feed timed out"); },
  checkpoint: async checkpoint => unavailableCheckpoints.push(checkpoint),
});
assert.equal(configuredUnavailable.ok, false, "a configured but unreachable feed is a real degraded sync");
assert.equal(configuredUnavailable.available, true, "the endpoint is configured even though the request failed");
assert.equal(configuredUnavailable.status, "endpoint_unavailable");
assert.equal(unavailableCheckpoints[0].status, "failed");
assert.equal(unavailableCheckpoints[0].cursorAfter, "cursor-replay", "an unreachable feed retains the replay cursor");

console.log(JSON.stringify({ ok: true, candidates: feed.candidates.length, cursorAfter: feed.cursorAfter, discovered: discovery.observed }));
