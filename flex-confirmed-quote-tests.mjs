import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";
import {
  isConfirmedFlexQuoteStatus,
  normalizeConfirmedQuoteObservation,
} from "./flex-confirmed-quote.mjs";

const elementId = "826adc32-f11e-4d12-bd31-ecaa3f7bfe00";
const observedAt = "2026-07-14T08:00:00.000Z";
assert.equal(isConfirmedFlexQuoteStatus("Confirmed"), true);
assert.equal(isConfirmedFlexQuoteStatus("Inquiry"), false);
assert.equal(isConfirmedFlexQuoteStatus("Booked", { confirmedStatuses: ["Booked"] }), true);
assert.throws(() => normalizeConfirmedQuoteObservation({
  elementId,
  documentNumber: "26-1846",
  documentType: "pull_sheet",
  status: "Confirmed",
}), /Only FLEX quotes/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-confirmed-quote-"));
const store = createCueFoundationStore({ filePath: path.join(dir, "foundation.json") });
const base = {
  elementId,
  documentNumber: "26-1846",
  documentType: "quote",
  showName: "Live Nation Moonchild @ The Fox",
  client: "Live Nation",
  venue: "The Fox Theatre",
  plannedStartDate: "2026-07-18",
  sourceEventId: "flex-status-event-1",
};

const inquiry = await store.observeFlexQuoteStatus({ ...base, status: "Inquiry", observedAt });
assert.equal(inquiry.ok, true);
assert.equal(inquiry.triggered, false, "a non-confirmed quote does not create a show");
assert.equal(Object.keys((await store.read()).showRegistry).length, 0);

const confirmed = await store.observeFlexQuoteStatus({
  ...base,
  status: "Confirmed",
  changedAt: "2026-07-14T08:05:00.000Z",
  observedAt: "2026-07-14T08:06:00.000Z",
});
assert.equal(confirmed.ok, true);
assert.equal(confirmed.triggered, true);
assert.equal(confirmed.show.lifecycle.status, "provisional");
assert.equal(confirmed.show.lifecycle.stage, "awaiting_active_show_index");
assert.equal(confirmed.readiness.milestoneRollup.quote_confirmed.status, "ready");
assert.equal(confirmed.readiness.milestoneRollup.active_show_index.status, "not_started");

const retry = await store.observeFlexQuoteStatus({
  ...base,
  status: "Confirmed",
  observedAt: "2026-07-14T08:10:00.000Z",
});
assert.equal(retry.triggered, false);
assert.equal(retry.idempotent, true, "repeated confirmed observations do not trigger again");
let db = await store.read();
assert.equal(Object.values(db.events).filter(event => event.eventType === "flex.quote.confirmed").length, 1);
assert.equal(Object.values(db.decisionCards).filter(card => card.cardType === "show_onboarding").length, 1);

const onboardingCard = Object.values(db.decisionCards).find(card => card.cardType === "show_onboarding");
const onboardingReview = await store.decide(onboardingCard.id, {
  action: "accept_update",
  actorId: "test-operations-manager",
  rationale: "Initial ownership reviewed.",
  idempotencyKey: "review-confirmed-show-onboarding",
});
assert.equal(onboardingReview.event.eventType, "show.onboarding.reviewed");
assert.equal(onboardingReview.currentShowState.state.lifecycleStage, "awaiting_active_show_index", "reviewing onboarding must preserve the lifecycle projection");
assert.equal(onboardingReview.readiness.milestoneRollup.quote_confirmed.status, "ready");
assert.equal(onboardingReview.readiness.milestoneRollup.active_show_index.status, "not_started");
assert.equal(onboardingReview.readiness.milestoneRollup.onboarding_reviewed.status, "ready");

const emptyIndex = await store.syncCanonicalShowRegistry([], {
  source: "active_show_index",
  timestamp: "2026-07-14T08:15:00.000Z",
});
assert.equal(emptyIndex.reconciled, 0);
db = await store.read();
assert.equal(db.showRegistry[confirmed.show.id].lifecycle.status, "provisional", "a provisional FLEX-confirmed show survives until the Index sees it");

const canonicalShowId = "live-nation-moonchild-the-fox";
const indexResult = await store.syncCanonicalShowRegistry([{
  id: canonicalShowId,
  name: "Live Nation Moonchild @ The Fox",
  activeShowsIndex: { client: "Live Nation", owner: "Jon Summers" },
  readinessStatus: "Active",
  flex: {
    status: "Verified",
    primary: {
      documentNumber: "26-1846",
      elementId,
      documentType: "quote",
      role: "primary_show_quote",
      status: "Verified",
    },
    documents: [],
  },
}], {
  source: "active_show_index",
  timestamp: "2026-07-14T08:20:00.000Z",
});
assert.equal(indexResult.reconciled, 1);
assert.deepEqual(indexResult.reconciliations, [{
  provisionalShowId: confirmed.show.id,
  canonicalShowId,
}]);
db = await store.read();
assert.equal(db.showRegistry[confirmed.show.id], undefined, "the provisional ID is adopted instead of duplicated");
assert.equal(db.showIdRedirects[confirmed.show.id].toShowId, canonicalShowId);
assert.equal(db.showRegistry[canonicalShowId].flex.primaryShowQuote.documentNumber, "26-1846");
assert.equal(db.readiness[canonicalShowId].milestoneRollup.active_show_index.status, "ready");
assert.equal(db.showState[canonicalShowId].state.lifecycleStage, "active_show_index_tracking");
assert.equal(Object.values(db.events).filter(event => event.eventType === "flex.quote.confirmed" && event.showId === canonicalShowId).length, 1);
assert.equal(Object.values(db.decisionCards).find(card => card.cardType === "show_onboarding").resolution, "active_show_index_reconciled");

console.log(JSON.stringify({
  ok: true,
  quote: base.documentNumber,
  provisionalShowId: confirmed.show.id,
  canonicalShowId,
  confirmationEvents: Object.values(db.events).filter(event => event.eventType === "flex.quote.confirmed").length,
  reconciled: indexResult.reconciled,
}, null, 2));
