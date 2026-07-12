import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { createCueFoundationStore } from "./cue-foundation-store.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-foundation-"));
const store = createCueFoundationStore({ filePath: path.join(dir, "foundation.json") });
const message = {
  messageKey: "CLOG:1783821000.0001", channelId: "CLOG", channelName: "logistics", userId: "U1", authorName: "Brian",
  text: "Sound Haven may need a third box truck. Please confirm.", contentHash: "h1", timestampIso: "2026-07-12T01:50:00.000Z", ingestedAt: "2026-07-12T01:51:00.000Z",
  operationalClassification: { categories: ["trucking","unresolved_issue"], status: "needs_review", summary: "Possible third box truck", unresolved: true },
  extractedEntities: { trucks: [], quotes: [] }, matchState: "needs_review",
  matches: [{ showKey: "sound-haven", showName: "Sound Haven", documentNumbers: ["26-1421"], elementId: "element-sound-haven", quoteElements: [{ documentNumber: "26-1421", elementId: "element-sound-haven" }], score: 110, confidenceBand: "high", reasons: ["Exact show alias", "Date proximity"], matchState: "auto_attached" }],
};
const first = await store.syncSlackSnapshot({ messages: { [message.messageKey]: message } });
assert.equal(first.intakeCount, 1); assert.equal(first.openDecisionCount, 1);
const second = await store.syncSlackSnapshot({ messages: { [message.messageKey]: message } });
assert.equal(second.sourceRecordCount, 1, "sync idempotent");
const cards = await store.listDecisionCards({ status: "open" }); assert.equal(cards.length, 1);
assert.deepEqual(cards[0].intake.flexDocumentNumbers, ["26-1421"], "FLEX quote number follows show match into Intake");
assert.equal(cards[0].intake.flexQuoteElements[0].elementId, "element-sound-haven", "FLEX element identity follows quote into Intake");
const result = await store.decide(cards[0].id, { action: "accept_update", actorId: "brian-kee", idempotencyKey: "accept-1" });
assert(result.ok); assert(result.event); assert.equal(result.readiness.showId, "sound-haven");
assert.equal(result.readiness.overallStatus, "at_risk", "accepted requirement is not fulfilled readiness");
const retry = await store.decide(cards[0].id, { action: "accept_update", actorId: "brian-kee", idempotencyKey: "accept-1" });
assert(retry.ok && retry.idempotent, "decision retry idempotent");
console.log(JSON.stringify({ ok: true, first, cardId: cards[0].id, eventType: result.event.eventType, readiness: result.readiness.overallStatus }, null, 2));

const routineStore = createCueFoundationStore({ filePath: path.join(dir, "routine.json") });
const routine = { ...message, messageKey: "CLOG:1783821001.0001", contentHash: "h2", text: "5301 is loaded with Frost motors.", operationalClassification: { categories: ["trucking", "warehouse", "equipment", "resolution"], status: "resolved", summary: "5301 is loaded with Frost motors.", unresolved: false }, matchState: "needs_review" };
const routineResult = await routineStore.syncSlackSnapshot({ messages: { [routine.messageKey]: routine } });
assert.equal(routineResult.openDecisionCount, 0, "routine state confirmation does not clutter decisions");

const unmatchedStore = createCueFoundationStore({ filePath: path.join(dir, "unmatched.json") });
const unmatched = { ...message, messageKey: "CGENERAL:1783821002.0001", contentHash: "h3", text: "Can someone receive the delivery?", matches: [], matchState: "general_queue", operationalClassification: { categories: ["trucking"], status: "needs_review", summary: "Can someone receive the delivery?", unresolved: true } };
const unmatchedResult = await unmatchedStore.syncSlackSnapshot({ messages: { [unmatched.messageKey]: unmatched } });
assert.equal(unmatchedResult.intakeCount, 1, "unmatched operational signal retained in Intake");
assert.equal(unmatchedResult.openDecisionCount, 0, "unmatched chatter does not flood My Decisions");

const lowStore = createCueFoundationStore({ filePath: path.join(dir, "low.json") });
const low = { ...unmatched, messageKey: "CGENERAL:1783821003.0001", contentHash: "h4", matches: [{ showKey: "fifa-final", showName: "FIFA Final", score: 25, confidenceBand: "low", matchState: "general_queue", reasons: ["Department alignment", "Active/upcoming"] }] };
await lowStore.syncSlackSnapshot({ messages: { [low.messageKey]: low } });
const lowDb = await lowStore.read();
const lowIntake = Object.values(lowDb.intakeItems)[0];
assert.equal(lowIntake.status, "routed", "low-confidence operational signal routes by scope instead of forcing a show match");
assert.equal(lowIntake.scope, "warehouse_shop", "shop delivery signal routes to warehouse/shop");
assert.equal(lowIntake.matchedShowId, null, "low-confidence candidate never attaches to a show");

const orderingStore = createCueFoundationStore({ filePath: path.join(dir, "ordering.json") });
const unordered = { ...message, messageKey: "CLOG:1783821004.0001", contentHash: "h5", matches: [
  { showKey: "wrong-low", score: 25, confidenceBand: "low", matchState: "general_queue", reasons: ["Recency only"] },
  { showKey: "sound-haven", score: 125, confidenceBand: "high", matchState: "auto_attached", reasons: ["Exact quote"] },
] };
await orderingStore.syncSlackSnapshot({ messages: { [unordered.messageKey]: unordered } });
const orderingDb = await orderingStore.read();
const orderingIntake = Object.values(orderingDb.intakeItems)[0];
assert.equal(orderingIntake.matchedShowId, "sound-haven", "strongest selected match wins regardless of array order");

const matchStore = createCueFoundationStore({ filePath: path.join(dir, "match-decision.json") });
const candidate = { ...message, messageKey: "CLOG:1783821005.0001", contentHash: "h6", matches: [{ showKey: "paul-simon", score: 75, confidenceBand: "medium", matchState: "needs_review", reasons: ["Chastain alias"] }] };
await matchStore.syncSlackSnapshot({ messages: { [candidate.messageKey]: candidate } });
const matchCards = await matchStore.listDecisionCards({ status: "open" });
assert.equal(matchCards[0].cardType, "show_match_review", "candidate creates match-review card");
const matchDecision = await matchStore.decide(matchCards[0].id, { action: "link_show", actorId: "pm-user", idempotencyKey: "link-1", parameters: { showId: "paul-simon", alias: "Chastain Paul" } });
assert(matchDecision.ok && matchDecision.event, "show match decision is recorded");
const matchDb = await matchStore.read();
assert.equal(Object.values(matchDb.intakeItems)[0].matchedShowId, "paul-simon", "confirmed show persisted to Intake");
assert.equal(matchDb.learnedAliases["chastain paul"].showId, "paul-simon", "confirmed alias learned");

const qualityStore = createCueFoundationStore({ filePath: path.join(dir, "quality.json") });
const birthday = { ...unmatched, messageKey: "CGENERAL:1783821006.0001", contentHash: "h7", text: "Happy birthday! Hope you have a blast.", operationalClassification: { categories: ["general_operations"], status: "informational", summary: "Happy birthday!", unresolved: false } };
const guardrails = { ...message, messageKey: "CLOG:1783821007.0001", contentHash: "h8", text: "<@U47> We need two guardrails for LiteFlair.", operationalClassification: { categories: ["general_operations"], status: "at_risk", summary: "<@U47> We need two guardrails for LiteFlair.", unresolved: true } };
const authorDirectoryMessage = { ...unmatched, messageKey: "CGENERAL:1783821008.0001", contentHash: "h9", userId: "U47", authorName: "Aaron", text: "Kewl", operationalClassification: { categories: ["general_operations"], status: "informational", summary: "Kewl", unresolved: false } };
await qualityStore.syncSlackSnapshot({ messages: { [birthday.messageKey]: birthday, [guardrails.messageKey]: guardrails, [authorDirectoryMessage.messageKey]: authorDirectoryMessage } });
const qualityDb = await qualityStore.read();
assert.equal(Object.keys(qualityDb.intakeItems).length, 1, "social chatter excluded from operational Intake");
const qualityIntake = Object.values(qualityDb.intakeItems)[0];
assert.equal(qualityIntake.category, "equipment", "equipment language overrides broad cached category");
assert.match(qualityIntake.summary, /@Aaron/, "Slack mention resolves from cached author directory when users.info data is absent");
await qualityStore.syncSlackSnapshot({ messages: { [birthday.messageKey]: birthday } });
const reconciledDb = await qualityStore.read();
assert.equal(Object.keys(reconciledDb.intakeItems).length, 0, "stale derived Intake is reconciled when no longer operational");
