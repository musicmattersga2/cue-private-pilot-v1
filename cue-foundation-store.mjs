/**
 * CUE Foundation compatibility store.
 *
 * Production target: PostgreSQL tables in migrations/20260712_cue_foundation_v1.sql.
 * Pilot target: atomic JSON persistence that proves the canonical lifecycle without
 * breaking the existing Slack Operational Signals cache or Active Shows UI.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const DEFAULT_PATH = path.resolve(
  process.env.CUE_FOUNDATION_STORE_PATH || "./data/cue-foundation-v1.json"
);
let writeChain = Promise.resolve();

function now() { return new Date().toISOString(); }
function cleanText(value) {
  return String(value ?? "")
    .replace(/â€™|â/g, "'")
    .replace(/â|â/g, '"')
    .replace(/â|â/g, "-")
    .replace(/âs\b/g, "'s")
    .replace(/Â/g, "")
    .trim();
}
function id(prefix, value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}
function blank() {
  return { version: 1, updatedAt: now(), sourceRecords: {}, intakeItems: {}, matchCandidates: {}, candidateFacts: {}, proposedUpdates: {}, decisionCards: {}, decisions: {}, events: {}, showState: {}, readiness: {} };
}
function readFile(filePath) {
  if (!fs.existsSync(filePath)) return blank();
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) }; }
  catch { return blank(); }
}
function writeFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...data, updatedAt: now() }, null, 2));
  fs.renameSync(tmp, filePath);
}
function primaryMatch(message) { return (message.matches || [])[0] || null; }
function isReviewable(message) {
  if (!message || message.deleted || message.matchState === "excluded_system") return false;
  return Boolean(message.operationalClassification?.categories?.length);
}
function domainOf(message) {
  const cats = message.operationalClassification?.categories || [];
  const text = String(message.text || "");
  if (cats.includes("equipment") && /missing items?|shortage|need .+ more|followspots?|hazer|galaxy|earbuds?|cat6|cables?/i.test(text)) return "equipment";
  if (cats.includes("warehouse") && /pull(?:ed|ing|\s+sheet)?|prep|pack|loaded|warehouse/i.test(text)) return "warehouse";
  if (cats.includes("trucking") || cats.includes("dock") || cats.includes("bol")) return "trucking";
  if (cats.includes("staffing")) return "staffing";
  if (cats.includes("warehouse")) return "warehouse";
  if (cats.includes("equipment")) return "equipment";
  if (cats.includes("schedule")) return "schedule";
  return "operations";
}
function cardTypeOf(message) {
  const text = String(message.text || "");
  const classification = message.operationalClassification || {};
  if (/\b(?:could|can|would)\s+(?:i|we|you)|\bplease\b|\bmake sure\b|\bneed someone\b/i.test(text)) return "task_request";
  if (classification.status === "blocked" || classification.status === "at_risk" || /missing items?|shortage|waiting on|may need|maybe|tbd/i.test(text)) return "risk_review";
  if (classification.status === "resolved" || /\bis\s+(?:getting\s+)?loaded\b|\bis ready\b|\bready to prep\b/i.test(text)) return "state_confirmation";
  return "signal_review";
}
function shouldCreateDecisionCard(message, matchState) {
  const type = cardTypeOf(message);
  // Routine affirmative state is preserved as Intake/evidence. It becomes a
  // decision only when CUE genuinely cannot determine the show.
  if (type === "state_confirmation") return !primaryMatch(message);
  return matchState === "needs_review" || ["task_request", "risk_review"].includes(type);
}
function readinessStatusFor(openCards, events) {
  const statuses = openCards.map((x) => x.impact);
  if (statuses.includes("critical")) return "blocked";
  if (statuses.includes("material")) return "at_risk";
  if (openCards.length) return "in_progress";
  // Accepting a requirement is not the same as satisfying it. Until the native
  // owning module emits fulfillment (for example trucking.run.assigned), the
  // affected gate remains at risk.
  if (events.some((x) => /\.signal\.accepted$/.test(x.eventType))) return "at_risk";
  if (events.length) return "ready";
  return "not_started";
}

export function createCueFoundationStore(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_PATH);
  const locked = (fn) => { const p = writeChain.then(fn, fn); writeChain = p.then(() => undefined, () => undefined); return p; };

  async function syncSlackSnapshot(snapshot = {}) {
    return locked(async () => {
      const db = readFile(filePath); let created = 0; let updated = 0;
      for (const message of Object.values(snapshot.messages || {})) {
        if (!isReviewable(message)) continue;
        const sourceId = id("src", `slack:${message.messageKey}:${message.contentHash}`);
        const intakeId = id("intake", sourceId);
        const match = primaryMatch(message); const domain = domainOf(message);
        const cleanedText = cleanText(message.text);
        const cleanedSummary = cleanText(message.operationalClassification?.summary || message.text);
        const sourceRecord = {
          id: sourceId, sourceType: "slack", externalId: message.messageKey,
          externalParentId: message.threadTs ? `${message.channelId}:${message.threadTs}` : null,
          externalRevisionId: message.editedTs || null, sourceUrl: message.permalink || null,
          authorExternalId: message.userId || null, observedAt: message.timestampIso || null,
          ingestedAt: message.ingestedAt || now(), contentHash: message.contentHash,
          normalizedText: cleanedText, connectorVersion: "slack-operational-signals-v1",
          payload: { channelId: message.channelId, channelName: message.channelName, authorName: message.authorName, classification: message.operationalClassification, entities: message.extractedEntities },
        };
        if (db.sourceRecords[sourceId]) updated += 1; else created += 1;
        db.sourceRecords[sourceId] = sourceRecord;
        const status = match?.matchState === "needs_review" || !match ? "needs_review" : "matched";
        db.intakeItems[intakeId] = {
          id: intakeId, sourceRecordId: sourceId, status, category: domain,
          urgency: message.operationalClassification?.status === "blocked" ? "urgent" : "normal",
          impact: message.operationalClassification?.status === "blocked" ? "critical" : message.operationalClassification?.status === "at_risk" ? "material" : "minor",
          summary: cleanedSummary,
          matchedShowId: match?.showKey || null, matchConfidence: match?.score ?? null,
          matchReasons: match?.reasons || [], createdAt: db.intakeItems[intakeId]?.createdAt || now(), updatedAt: now(),
        };
        for (const [rank, candidate] of (message.matches || []).entries()) {
          const candidateId = id("match", `${intakeId}:${candidate.showKey}`);
          db.matchCandidates[candidateId] = { id: candidateId, intakeItemId: intakeId, candidateEntityType: "show", candidateEntityId: candidate.showKey, score: Number(candidate.score || 0), reasons: candidate.reasons || [], rank: rank + 1, selected: ["auto_attached","manually_approved"].includes(candidate.matchState), matcherVersion: "slack-match-v1" };
        }
        const factId = id("fact", `${intakeId}:${domain}`);
        db.candidateFacts[factId] = { id: factId, intakeItemId: intakeId, factType: `slack.${domain}.signal`, value: { text: cleanedText, categories: message.operationalClassification?.categories || [], entities: message.extractedEntities || {} }, confidence: match?.confidenceBand || match?.confidence || null, evidenceSpan: { sourceRecordId: sourceId, text: cleanedText }, extractionVersion: "slack-rules-v1" };
        const cardId = id("card", intakeId);
        const cardType = cardTypeOf(message);
        const cardEligible = shouldCreateDecisionCard(message, status);
        if (!cardEligible && db.decisionCards[cardId]?.status === "open") {
          delete db.decisionCards[cardId];
        }
        if (!db.decisionCards[cardId] && cardEligible) {
          db.decisionCards[cardId] = { id: cardId, intakeItemId: intakeId, showId: match?.showKey || null, status: "open", cardType, domain, headline: cleanedSummary, explanation: cardType === "task_request" ? `CUE found a ${domain} request that needs an owner or disposition.` : cardType === "risk_review" ? `CUE found a ${domain} risk or unresolved condition that may affect readiness.` : `CUE needs a human to confirm this signal's show and operational treatment.`, recommendation: cardType === "task_request" ? "Create and assign the task, use as evidence, or reject it." : cardType === "risk_review" ? "Confirm the risk, owner and readiness impact." : match ? "Confirm the show match, then choose how CUE should treat the signal." : "Choose the correct show or mark this as not relevant.", urgency: db.intakeItems[intakeId].urgency, impact: cardType === "risk_review" && db.intakeItems[intakeId].impact === "minor" ? "material" : db.intakeItems[intakeId].impact, confidence: match?.confidenceBand || null, sourceRecordId: sourceId, createdAt: now(), updatedAt: now() };
        } else if (db.decisionCards[cardId]?.status === "open" && cardEligible) {
          Object.assign(db.decisionCards[cardId], {
            showId: match?.showKey || null,
            cardType,
            domain,
            headline: cleanedSummary,
            impact: cardType === "risk_review" && db.intakeItems[intakeId].impact === "minor" ? "material" : db.intakeItems[intakeId].impact,
            updatedAt: now(),
          });
        }
      }
      writeFile(filePath, db); return { created, updated, sourceRecordCount: Object.keys(db.sourceRecords).length, intakeCount: Object.keys(db.intakeItems).length, openDecisionCount: Object.values(db.decisionCards).filter(x => x.status === "open").length };
    });
  }

  async function decide(cardId, input = {}) {
    return locked(async () => {
      const db = readFile(filePath); const card = db.decisionCards[cardId];
      if (!card) return { ok: false, status: 404, error: "Decision card not found." };
      const allowed = ["accept_update","supporting_evidence","create_task","create_issue","create_risk","link_show","choose_another_show","merge","request_confirmation","snooze","ignore_once","reject_incorrect","not_relevant"];
      if (!allowed.includes(input.action)) return { ok: false, status: 400, error: "Unsupported decision action." };
      if (!input.actorId) return { ok: false, status: 400, error: "actorId is required." };
      const decisionId = id("decision", `${cardId}:${input.idempotencyKey || `${input.actorId}:${input.action}`}`);
      if (db.decisions[decisionId]) return { ok: true, idempotent: true, decision: db.decisions[decisionId], readiness: db.readiness[card.showId] || null };
      const decision = { id: decisionId, decisionCardId: cardId, action: input.action, actorId: input.actorId, rationale: input.rationale || null, parameters: input.parameters || {}, decidedAt: now() };
      db.decisions[decisionId] = decision; card.status = input.action === "snooze" ? "waiting" : "decided"; card.updatedAt = now();
      const intake = db.intakeItems[card.intakeItemId]; if (intake) { intake.status = input.action === "snooze" ? "snoozed" : "decided"; intake.decidedAt = now(); }
      let event = null;
      if (["accept_update","supporting_evidence","create_task","create_issue","create_risk"].includes(input.action)) {
        const eventId = id("event", decisionId); event = { id: eventId, eventType: input.action === "accept_update" ? `${card.domain}.signal.accepted` : `intake.${input.action}.recorded`, showId: card.showId, domain: card.domain, entityType: "intake_signal", entityId: card.intakeItemId, occurredAt: now(), effectiveAt: now(), recordedAt: now(), actorType: "user", actorId: input.actorId, sourceType: "slack", sourceRecordId: card.sourceRecordId, intakeItemId: card.intakeItemId, decisionId, newValue: { action: input.action, parameters: input.parameters || {} }, idempotencyKey: decisionId };
        db.events[eventId] = event;
      }
      if (card.showId) {
        const showEvents = Object.values(db.events).filter(x => x.showId === card.showId);
        db.showState[card.showId] = { showId: card.showId, projectionName: "operational", lastEventId: event?.id || db.showState[card.showId]?.lastEventId || null, state: { acceptedSignalCount: showEvents.length, lastDecision: decision }, projectedAt: now() };
        const openCards = Object.values(db.decisionCards).filter(x => x.showId === card.showId && ["open","assigned","waiting","escalated"].includes(x.status));
        const status = readinessStatusFor(openCards, showEvents);
        db.readiness[card.showId] = { showId: card.showId, overallStatus: status, overallScore: status === "ready" ? 100 : status === "at_risk" ? 55 : status === "blocked" ? 20 : 70, domainRollup: { [card.domain]: { status, openDecisionCount: openCards.filter(x => x.domain === card.domain).length } }, milestoneRollup: { ready_to_dispatch: { status: card.domain === "trucking" ? status : "not_started" } }, blockers: openCards.filter(x => x.impact === "critical").map(x => x.id), warnings: openCards.filter(x => x.impact !== "critical").map(x => x.id), nextActions: openCards.map(x => ({ decisionCardId: x.id, headline: x.headline })), rulesetVersion: "pilot-v1", lastEventId: event?.id || null, evaluatedAt: now() };
      }
      writeFile(filePath, db); return { ok: true, decision, event, currentShowState: db.showState[card.showId] || null, readiness: db.readiness[card.showId] || null };
    });
  }

  return {
    filePath,
    read: async () => readFile(filePath),
    syncSlackSnapshot,
    listDecisionCards: async ({ showId = null, status = null } = {}) => Object.values(readFile(filePath).decisionCards).filter(x => (!showId || x.showId === showId) && (!status || x.status === status)).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    getIntakeItem: async (intakeId) => { const db = readFile(filePath); const item = db.intakeItems[intakeId]; if (!item) return null; return { ...item, sourceRecord: db.sourceRecords[item.sourceRecordId] || null, matches: Object.values(db.matchCandidates).filter(x => x.intakeItemId === intakeId), facts: Object.values(db.candidateFacts).filter(x => x.intakeItemId === intakeId), decisionCards: Object.values(db.decisionCards).filter(x => x.intakeItemId === intakeId) }; },
    getShowReadiness: async (showId) => readFile(filePath).readiness[showId] || { showId, overallStatus: "not_started", overallScore: 0, domainRollup: {}, milestoneRollup: {}, blockers: [], warnings: [], nextActions: [], rulesetVersion: "pilot-v1", evaluatedAt: now() },
    getShowState: async (showId) => readFile(filePath).showState[showId] || null,
    decide,
  };
}

export const defaultCueFoundationStore = createCueFoundationStore();
