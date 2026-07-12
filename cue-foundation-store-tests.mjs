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
  matches: [{ showKey: "sound-haven", showName: "Sound Haven", score: 110, confidenceBand: "high", reasons: ["Exact show alias", "Date proximity"], matchState: "auto_attached" }],
};
const first = await store.syncSlackSnapshot({ messages: { [message.messageKey]: message } });
assert.equal(first.intakeCount, 1); assert.equal(first.openDecisionCount, 1);
const second = await store.syncSlackSnapshot({ messages: { [message.messageKey]: message } });
assert.equal(second.sourceRecordCount, 1, "sync idempotent");
const cards = await store.listDecisionCards({ status: "open" }); assert.equal(cards.length, 1);
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
assert.equal(lowIntake.status, "needs_match", "low-confidence candidate is not a confirmed match");
assert.equal(lowIntake.matchedShowId, null, "low-confidence candidate never attaches to a show");
