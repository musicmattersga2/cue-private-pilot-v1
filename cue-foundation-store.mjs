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
  const original = String(value ?? "");
  let decoded = original;
  if (/[Ââ]/.test(original)) {
    const candidate = Buffer.from(original, "latin1").toString("utf8");
    if (!candidate.includes("�")) decoded = candidate;
  }
  return decoded
    .replace(/â€™|â/g, "'")
    .replace(/â|â/g, '"')
    .replace(/â|â/g, "-")
    .replace(/âs\b/g, "'s")
    .replace(/â¢/g, "•")
    .replace(/â(?=\s|$)/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/Â/g, "")
    .trim();
}
function id(prefix, value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}
function blank() {
  return { version: 1, updatedAt: now(), sourceRecords: {}, intakeItems: {}, matchCandidates: {}, candidateFacts: {}, proposedUpdates: {}, decisionCards: {}, decisions: {}, events: {}, showState: {}, readiness: {}, learnedAliases: {}, learnedFlexLinks: {} };
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
function primaryMatch(message) {
  const rank = { manually_approved: 0, auto_attached: 1, needs_review: 2, general_queue: 3, manually_rejected: 4 };
  return [...(message.matches || [])]
    .sort((a, b) => {
      const stateDelta = (rank[a?.matchState] ?? 9) - (rank[b?.matchState] ?? 9);
      if (stateDelta !== 0) return stateDelta;
      return Number(b?.score || 0) - Number(a?.score || 0);
    })[0] || null;
}
function isReviewable(message) {
  if (!message || message.deleted || message.matchState === "excluded_system") return false;
  const cats = message.operationalClassification?.categories || [];
  if (!cats.length) return false;
  const text = cleanText(message.text).toLowerCase();
  if (/birthday|barcade|happy birthday|thanks for the wishes|tame impala|hope you have a blast/.test(text)) return false;
  const operational = /flex|quote|pull\s*sheet|pack|prep|load|truck|trailer|driver|delivery|return|rental|cross.?rent|short|missing|equipment|audio|lighting|video|rigging|motor|cable|truss|steel|shackle|guardrail|hazer|earbud|galaxy|staffing|meeting|warehouse|dock|bol|shipment|pickup|client|venue|spec sheet|pixel map|inventory|bar.?code/i.test(text);
  if (cats.length === 1 && cats[0] === "general_operations" && !operational) return false;
  if (text.length < 18 && !operational) return false;
  return true;
}
function domainOf(message) {
  const cats = message.operationalClassification?.categories || [];
  const text = cleanText(message.text);
  if (/missing items?|shortage|need .+ more|followspots?|hazer|galaxy|earbuds?|cat6|cables?|guardrails?|shackles?|pear rings?|truss|steel/i.test(text)) return "equipment";
  if (/pull(?:ed|ing|\s+sheet)?|prep|pack|loaded|warehouse/i.test(text)) return "warehouse";
  if (cats.includes("trucking") || cats.includes("dock") || cats.includes("bol")) return "trucking";
  if (cats.includes("staffing")) return "staffing";
  if (cats.includes("warehouse")) return "warehouse";
  if (cats.includes("equipment")) return "equipment";
  if (cats.includes("schedule")) return "schedule";
  return "operations";
}
function scopeOf(message, match, domain) {
  const text = cleanText(message.text).toLowerCase();
  const score = Number(match?.score || 0);
  if (["auto_attached", "manually_approved", "needs_review"].includes(match?.matchState) || (match?.showKey && score >= 45)) return "show_specific";
  if (domain === "staffing" || /staffing meeting|crew call|labor coordinator|availability/.test(text)) return "staffing";
  if (/vendor|supplier|source|buy|purchase|does anyone know a company|cross.?rent|subrent/.test(text)) return "procurement_vendor";
  if (/inventory|in stock|bar.?code|longest length|how many|flex does not have dims|weights and dims/.test(text)) return "inventory";
  if (/warehouse|at the shop|shop now|receive the delivery|pack(?:ed|ing)?|prep(?:ped|ping)?|pull sheet/.test(text)) return "warehouse_shop";
  if (domain === "trucking" || /truck|driver|delivery|shipment|pickup|return|on the road|logistics/.test(text)) return "trucking_logistics";
  return "company_operations";
}
function cardTypeOf(message) {
  const text = String(message.text || "");
  const classification = message.operationalClassification || {};
  if (/\b(?:could|can|would)\s+(?:i|we|you)|\bplease\b|\bmake sure\b|\bneed someone\b/i.test(text)) return "task_request";
  if (classification.status === "blocked" || classification.status === "at_risk" || /missing items?|shortage|waiting on|may need|maybe|tbd/i.test(text)) return "risk_review";
  if (classification.status === "resolved" || /\bis\s+(?:getting\s+)?loaded\b|\bis ready\b|\bready to prep\b/i.test(text)) return "state_confirmation";
  return "signal_review";
}
function sourceFlexDocumentType(message) {
  const text = cleanText(message?.text || "").toLowerCase();
  if (/pull\s*sheet|pullsheet/.test(text)) return "pull_sheet";
  if (/event\s*folder/.test(text)) return "event_folder";
  if (/manifest/.test(text)) return "manifest";
  if (/purchase\s*order|\blpo\b/.test(text)) return "purchase_order";
  if (/invoice/.test(text)) return "invoice";
  if (/\bquote\b/.test(text)) return "quote";
  return "unknown";
}
function shouldCreateDecisionCard(message, matchState) {
  const type = cardTypeOf(message);
  const match = primaryMatch(message);
  const confirmedMatch = ["auto_attached", "manually_approved"].includes(match?.matchState);
  const candidateNeedsReview = match?.matchState === "needs_review";
  // General/unmatched communication remains searchable Intake evidence. It
  // must not flood the show-focused My Decisions queue.
  if (!match?.showKey || (!confirmedMatch && !candidateNeedsReview)) return false;
  // Routine affirmative state is evidence/current-state input, not a decision.
  if (type === "state_confirmation") return false;
  // Ambiguous show candidates require a human match decision.
  if (candidateNeedsReview) return true;
  // High-confidence matched requests/risks still require operational treatment.
  return ["task_request", "risk_review"].includes(type) && confirmedMatch;
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
      const activeIntakeIds = new Set();
      // Slack may deny users.info for mentioned people even though those same
      // people have authored messages already in the local cache. Build one
      // deterministic directory from both sources before normalizing evidence.
      const mentionUsers = { ...(snapshot.users || {}) };
      for (const cachedMessage of Object.values(snapshot.messages || {})) {
        const userId = String(cachedMessage?.userId || "").trim();
        const authorName = cleanText(cachedMessage?.authorName || "");
        if (!userId || !authorName || authorName === userId || /^unknown$/i.test(authorName)) continue;
        mentionUsers[userId] = {
          ...(mentionUsers[userId] || {}),
          displayName: mentionUsers[userId]?.displayName || authorName,
        };
      }
      for (const message of Object.values(snapshot.messages || {})) {
        if (!isReviewable(message)) continue;
        const sourceId = id("src", `slack:${message.messageKey}:${message.contentHash}`);
        const intakeId = id("intake", sourceId);
        activeIntakeIds.add(intakeId);
        const match = primaryMatch(message); const domain = domainOf(message); const scope = scopeOf(message, match, domain);
        const resolveMentions = value => cleanText(value).replace(/<@([A-Z0-9]+)>/gi, (_, userId) => `@${mentionUsers[userId]?.displayName || mentionUsers[userId]?.realName || "Slack user"}`);
        const cleanedText = resolveMentions(message.text);
        const cleanedSummary = resolveMentions(message.operationalClassification?.summary || message.text);
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
        const confirmedMatch = ["auto_attached", "manually_approved"].includes(match?.matchState);
        const candidateNeedsReview = match?.matchState === "needs_review";
        const learnedForIntake = Object.values(db.learnedFlexLinks || {}).filter((item) => (item.intakeItemIds || []).includes(intakeId) && item.source !== "flex_header_verification" && item.status !== "quarantined");
        const exactMessageQuotes = [...new Set((message.extractedEntities?.quotes || []).map(String).filter(Boolean))];
        const mentionedDocumentType = sourceFlexDocumentType(message);
        // A quote number written in the source message is direct evidence. Keep
        // it even when the proposed Active Shows record has incomplete or
        // different workstream metadata. This does not confirm the show match.
        const flexDocumentNumbers = [...new Set([...exactMessageQuotes, ...(match?.documentNumbers || []).map(String).filter(Boolean), ...learnedForIntake.map(item => item.documentNumber)])];
        // Only an authoritative Active Shows/FLEX hierarchy or an explicit
        // human primary link may establish the primary show quote. A number in
        // Slack can identify a pull sheet, manifest, or colliding document and
        // therefore remains mentioned evidence until its role is verified.
        const primaryFlexDocumentNumber = learnedForIntake.find(item => item.role === "primary_show_quote")?.documentNumber || match?.primaryDocumentNumber || null;
        const sourceMentionedFlexDocuments = exactMessageQuotes.map(documentNumber => ({ documentNumber, documentType: mentionedDocumentType, role: "mentioned_source", elementId: null, source: "slack" }));
        const flexDocumentRefs = [
          ...(match?.documentRefs || []),
          ...learnedForIntake.map(item => ({ documentNumber: item.documentNumber, elementId: item.elementId, documentType: item.documentType || "unknown", role: item.role || "linked", flexUrl: item.flexUrl || null, source: item.source || "command_center" })),
          ...sourceMentionedFlexDocuments,
        ]
          .filter(ref => ref?.documentNumber)
          .map(ref => ({ ...ref, role: ref.documentNumber === primaryFlexDocumentNumber && ref.role !== "mentioned_source" ? "primary_show_quote" : ref.role || "related" }))
          .filter((ref, index, refs) => {
            if (ref.role === "mentioned_source") return index === refs.findIndex(candidate => candidate.documentNumber === ref.documentNumber && candidate.role === "mentioned_source");
            return index === refs.findIndex(candidate => candidate.documentNumber === ref.documentNumber && candidate.documentType === ref.documentType && candidate.role !== "mentioned_source");
          });
        const flexQuoteElements = flexDocumentRefs.map(ref => ({ documentNumber: ref.documentNumber, elementId: ref.elementId || null, documentType: ref.documentType || "unknown" }));
        const status = confirmedMatch ? "matched" : candidateNeedsReview ? "needs_review" : scope === "show_specific" ? "needs_match" : "routed";
        db.intakeItems[intakeId] = {
          id: intakeId, sourceRecordId: sourceId, status, category: domain, scope,
          urgency: message.operationalClassification?.status === "blocked" ? "urgent" : "normal",
          impact: message.operationalClassification?.status === "blocked" ? "critical" : message.operationalClassification?.status === "at_risk" ? "material" : "minor",
          summary: cleanedSummary,
          matchedShowId: confirmedMatch ? match.showKey : null,
          candidateShowId: candidateNeedsReview ? match.showKey : null,
          matchedShowName: match?.showName || null,
          flexDocumentNumbers,
          primaryFlexDocumentNumber,
          sourceMentionedFlexDocuments,
          flexDocumentRefs,
          flexElementId: match?.elementId || null,
          flexQuoteElements,
          matchConfidence: match?.score ?? null,
          matchReasons: match?.reasons || [], createdAt: db.intakeItems[intakeId]?.createdAt || now(), updatedAt: now(),
        };
        for (const [rank, candidate] of (message.matches || []).entries()) {
          const candidateId = id("match", `${intakeId}:${candidate.showKey}`);
          db.matchCandidates[candidateId] = { id: candidateId, intakeItemId: intakeId, candidateEntityType: "show", candidateEntityId: candidate.showKey, candidateEntityName: candidate.showName || null, documentNumbers: candidate.documentNumbers || [], primaryDocumentNumber: candidate.primaryDocumentNumber || null, elementId: candidate.elementId || null, documentRefs: candidate.documentRefs || [], quoteElements: candidate.quoteElements || [], score: Number(candidate.score || 0), reasons: candidate.reasons || [], rank: rank + 1, selected: ["auto_attached","manually_approved"].includes(candidate.matchState), matcherVersion: "slack-match-v1" };
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
            showId: confirmedMatch ? match.showKey : null,
            candidateShowId: candidateNeedsReview ? match.showKey : null,
            cardType: candidateNeedsReview ? "show_match_review" : cardType,
            domain,
            headline: cleanedSummary,
            impact: cardType === "risk_review" && db.intakeItems[intakeId].impact === "minor" ? "material" : db.intakeItems[intakeId].impact,
            updatedAt: now(),
          });
        }
        if (db.decisionCards[cardId]?.status === "open" && cardEligible) {
          Object.assign(db.decisionCards[cardId], {
            showId: confirmedMatch ? match.showKey : null,
            candidateShowId: candidateNeedsReview ? match.showKey : null,
            cardType: candidateNeedsReview ? "show_match_review" : cardType,
          });
        }
      }
      // Reconcile derived Intake: raw messages remain in the Slack source cache,
      // while non-operational chatter is removed from the operational Intake layer.
      for (const [intakeId, intake] of Object.entries(db.intakeItems)) {
        const source = db.sourceRecords[intake.sourceRecordId];
        if (source?.sourceType !== "slack" || activeIntakeIds.has(intakeId)) continue;
        delete db.intakeItems[intakeId];
        for (const [key, value] of Object.entries(db.matchCandidates)) if (value.intakeItemId === intakeId) delete db.matchCandidates[key];
        for (const [key, value] of Object.entries(db.candidateFacts)) if (value.intakeItemId === intakeId) delete db.candidateFacts[key];
        for (const [key, value] of Object.entries(db.proposedUpdates)) if (value.intakeItemId === intakeId) delete db.proposedUpdates[key];
        for (const [key, value] of Object.entries(db.decisionCards)) if (value.intakeItemId === intakeId && value.status === "open") delete db.decisionCards[key];
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
      const intake = db.intakeItems[card.intakeItemId];
      if (intake) { intake.status = input.action === "snooze" ? "snoozed" : "decided"; intake.decidedAt = now(); }
      if (["link_show", "choose_another_show"].includes(input.action)) {
        const selectedShowId = String(input.parameters?.showId || card.candidateShowId || "").trim();
        if (!selectedShowId) return { ok: false, status: 400, error: "showId is required for a show match decision." };
        card.showId = selectedShowId;
        card.candidateShowId = null;
        if (intake) {
          intake.matchedShowId = selectedShowId;
          intake.candidateShowId = null;
          intake.status = "matched";
          intake.matchConfidence = 999;
          intake.matchReasons = ["Manually confirmed in Command Center"];
        }
        const alias = cleanText(input.parameters?.alias || "");
        if (alias) {
          const key = alias.toLowerCase();
          db.learnedAliases[key] = { alias, showId: selectedShowId, confirmedBy: input.actorId, confirmedAt: now(), sourceRecordId: card.sourceRecordId };
        }
      }
      let event = null;
      if (["accept_update","supporting_evidence","create_task","create_issue","create_risk","link_show","choose_another_show"].includes(input.action)) {
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

  async function linkFlexQuote(input = {}) {
    return locked(async () => {
      const db = readFile(filePath);
      const documentNumber = cleanText(input.documentNumber || "");
      const elementId = cleanText(input.elementId || "");
      const actorId = cleanText(input.actorId || "");
      const documentType = cleanText(input.documentType || "unknown") || "unknown";
      const role = cleanText(input.role || "linked") || "linked";
      if (!/^\d{2}-\d{3,6}$/.test(documentNumber)) return { ok: false, status: 400, error: "A valid FLEX document number is required." };
      if (!/^[0-9a-f-]{36}$/i.test(elementId)) return { ok: false, status: 400, error: "A valid FLEX element ID is required." };
      if (!actorId) return { ok: false, status: 400, error: "actorId is required." };
      const storageKey = `${documentNumber}:${input.intakeItemId || elementId}`;
      const previous = db.learnedFlexLinks[storageKey] || {};
      const intakeItemIds = [...new Set([...(previous.intakeItemIds || []), input.intakeItemId].filter(Boolean))];
      const learned = { documentNumber, elementId, documentType, role, flexUrl: input.flexUrl || null, actorId, rationale: input.rationale || null, source: input.source || "command_center", intakeItemIds, confirmedAt: now() };
      db.learnedFlexLinks[storageKey] = learned;
      const intake = input.intakeItemId ? db.intakeItems[input.intakeItemId] : null;
      if (intake) {
        intake.flexDocumentNumbers = [...new Set([...(intake.flexDocumentNumbers || []), documentNumber])];
        const shouldBecomePrimary = role === "primary_show_quote"
          || (!intake.primaryFlexDocumentNumber && documentType === "quote");
        if (shouldBecomePrimary) intake.primaryFlexDocumentNumber = documentNumber;
        intake.flexDocumentRefs = [
          ...(intake.flexDocumentRefs || []).filter((item) => !(item.documentNumber === documentNumber && item.documentType === documentType && item.role !== "mentioned_source")),
          { documentNumber, elementId, documentType, role, flexUrl: input.flexUrl || null, source: input.source || "command_center" },
        ];
        if (documentType === "quote") {
          intake.flexQuoteElements = [
            ...(intake.flexQuoteElements || []).filter((item) => item.documentNumber !== documentNumber),
            { documentNumber, elementId },
          ];
        }
        intake.updatedAt = now();
      }
      const eventId = id("event", `flex-link:${documentNumber}:${elementId}:${actorId}`);
      db.events[eventId] = { id: eventId, eventType: "intake.flex_quote.linked", showId: intake?.matchedShowId || intake?.candidateShowId || null, domain: intake?.category || "operations", entityType: "flex_quote", entityId: elementId, occurredAt: now(), effectiveAt: now(), recordedAt: now(), actorType: actorId.startsWith("system:") ? "system" : "user", actorId, sourceType: input.source || "command_center", sourceRecordId: intake?.sourceRecordId || null, intakeItemId: intake?.id || null, newValue: learned, idempotencyKey: eventId };
      writeFile(filePath, db);
      return { ok: true, learned, intake: intake || null, event: db.events[eventId] };
    });
  }

  return {
    filePath,
    read: async () => readFile(filePath),
    syncSlackSnapshot,
    listDecisionCards: async ({ showId = null, status = null } = {}) => {
      const db = readFile(filePath);
      return Object.values(db.decisionCards)
        .filter(x => (!showId || x.showId === showId || x.candidateShowId === showId) && (!status || x.status === status))
        .map(card => ({ ...card, intake: db.intakeItems[card.intakeItemId] || null, sourceRecord: db.sourceRecords[card.sourceRecordId] || null, matchCandidates: Object.values(db.matchCandidates).filter(x => x.intakeItemId === card.intakeItemId).sort((a,b) => b.score - a.score).slice(0,5) }))
        .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    listIntakeItems: async ({ status = null, limit = 200 } = {}) => {
      const db = readFile(filePath);
      return Object.values(db.intakeItems)
        .filter(x => !status || x.status === status)
        .map(item => ({ ...item, sourceRecord: db.sourceRecords[item.sourceRecordId] || null }))
        .sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)));
    },
    getSummary: async () => {
      const db = readFile(filePath);
      const intake = Object.values(db.intakeItems);
      const cards = Object.values(db.decisionCards);
      const count = (items, predicate) => items.filter(predicate).length;
      return { updatedAt: db.updatedAt, intakeTotal: intake.length, matched: count(intake,x=>x.status==="matched"), candidateSignals: count(intake,x=>x.status==="needs_review"), needsMatch: count(intake,x=>x.status==="needs_match"), routedEvidence: count(intake,x=>x.status==="routed"), evidenceOnly: count(intake,x=>!cards.some(c=>c.intakeItemId===x.id && ["open","assigned","waiting","escalated"].includes(c.status))), openDecisions: count(cards,x=>x.status==="open"&&x.cardType!=="show_match_review"), matchDecisions: count(cards,x=>x.status==="open"&&x.cardType==="show_match_review"), waitingDecisions: count(cards,x=>x.status==="waiting"), learnedAliases: Object.keys(db.learnedAliases || {}).length };
    },
    getIntakeItem: async (intakeId) => { const db = readFile(filePath); const item = db.intakeItems[intakeId]; if (!item) return null; return { ...item, sourceRecord: db.sourceRecords[item.sourceRecordId] || null, matches: Object.values(db.matchCandidates).filter(x => x.intakeItemId === intakeId), facts: Object.values(db.candidateFacts).filter(x => x.intakeItemId === intakeId), decisionCards: Object.values(db.decisionCards).filter(x => x.intakeItemId === intakeId) }; },
    getShowReadiness: async (showId) => readFile(filePath).readiness[showId] || { showId, overallStatus: "not_started", overallScore: 0, domainRollup: {}, milestoneRollup: {}, blockers: [], warnings: [], nextActions: [], rulesetVersion: "pilot-v1", evaluatedAt: now() },
    getShowState: async (showId) => readFile(filePath).showState[showId] || null,
    getLearnedFlexLink: async (documentNumber, intakeItemId = null) => {
      const db = readFile(filePath);
      return Object.values(db.learnedFlexLinks || {}).find(item => item.documentNumber === String(documentNumber || "").trim() && item.source !== "flex_header_verification" && item.status !== "quarantined" && (!intakeItemId || (item.intakeItemIds || []).includes(intakeItemId))) || null;
    },
    linkFlexQuote,
    decide,
  };
}

export const defaultCueFoundationStore = createCueFoundationStore();
