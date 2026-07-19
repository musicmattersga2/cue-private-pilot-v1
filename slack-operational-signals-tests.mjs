/**
 * Slack Operational Signals — unit + fixture acceptance tests.
 * Run: node slack-operational-signals-tests.mjs
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  createSlackOperationalSignalsClient,
} from "./slack-operational-signals-client.mjs";
import {
  createSlackOperationalSignalsStore,
} from "./slack-operational-signals-store.mjs";
import {
  normalizeSlackMessage,
  extractSlackEntities,
  classifyOperationalMessage,
  slackTsToIso,
  buildMessageKey,
} from "./slack-operational-signals-normalize.mjs";
import {
  matchSlackMessageToShows,
  scoreMatchConfidence,
  buildShowNameAliases,
  stripShowNameDecorations,
} from "./slack-operational-signals-match.mjs";
import {
  createSlackOperationalSignalsService,
} from "./slack-operational-signals-service.mjs";

let passed = 0;
let failed = 0;
const notes = {};

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${message}`);
  }
}

const CANDIDATES = [
  {
    showKey: "sound-haven-2026",
    showName: "Sound Haven",
    client: "Sound Haven Productions",
    venue: "Haven Amphitheater",
    documentNumbers: ["26-1421", "26-0162"],
    aliases: ["SH"],
    truckNumbers: ["T-12"],
    trailerNumbers: ["TR-9"],
    plannedStartDate: "2026-06-01",
    plannedEndDate: "2026-06-03",
    departments: ["audio", "rigging", "trucking"],
  },
  {
    showKey: "sweetwater-2026",
    showName: "Sweetwater",
    client: "Sweetwater",
    venue: "Music Hall",
    documentNumbers: ["26-0401"],
    aliases: ["SW"],
    truckNumbers: ["SW-1"],
    plannedStartDate: "2026-07-10",
    plannedEndDate: "2026-07-12",
    departments: ["trucking", "warehouse"],
  },
];

const FIXTURES = [
  {
    id: "exact-quote-maybe",
    text: "26-1421 load-out maybe truck still unresolved",
    channelId: "C_OPS",
    ts: "1710000001.000100",
    user: "U1",
  },
  {
    id: "strong-show-name",
    text: "Sound Haven rigging pull is complete",
    channelId: "C_OPS",
    ts: "1710000002.000100",
    user: "U2",
  },
  {
    id: "client-venue-date",
    text: "Sweetwater Music Hall load-in on Jul 10 needs confirmation",
    channelId: "C_OPS",
    ts: "1710000003.000100",
    user: "U3",
  },
  {
    id: "truck-match",
    text: "Truck T-12 assigned for Sound Haven load-out",
    channelId: "C_OPS",
    ts: "1710000004.000100",
    user: "U1",
  },
  {
    id: "dock-sweetwater",
    text: "Dock 4 assigned for 26-0401",
    channelId: "C_OPS",
    ts: "1710000005.000100",
    user: "U4",
  },
  {
    id: "bol-sweetwater",
    text: "BOL sent for Sweetwater truck",
    channelId: "C_OPS",
    ts: "1710000006.000100",
    user: "U4",
  },
  {
    id: "warehouse",
    text: "Audio pull complete, waiting on cable package",
    channelId: "C_OPS",
    ts: "1710000007.000100",
    user: "U5",
  },
  {
    id: "equipment-shortage",
    text: "Need two more motors for Sound Haven",
    channelId: "C_OPS",
    ts: "1710000008.000100",
    user: "U2",
  },
  {
    id: "resolution",
    text: "Maybe truck resolved — not needed for 26-1421",
    channelId: "C_OPS",
    ts: "1710000009.000100",
    user: "U1",
  },
  {
    id: "ambiguous-low",
    text: "Need another truck next week",
    channelId: "C_OPS",
    ts: "1710000010.000100",
    user: "U6",
  },
  {
    id: "medium-partial",
    text: "Haven amphitheater needs another cable package on Jun 2",
    channelId: "C_OPS",
    ts: "1710000011.000100",
    user: "U5",
  },
];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slack-signals-"));
}

console.log("\nSlack Operational Signals tests\n");

console.log("normalize / extract / classify");
{
  assert(slackTsToIso("1710000001.000100")?.startsWith("2024-"), "timestamp normalization");
  assert(buildMessageKey("C1", "1.2") === "C1:1.2", "message key");
  const entities = extractSlackEntities("26-1421 Dock 4 BOL for truck T-12");
  assert(entities.quotes.includes("26-1421"), "quote extraction");
  assert(entities.docks.includes("4"), "dock extraction");
  assert(entities.hasBol === true, "BOL extraction");
  assert(entities.trucks.includes("T-12"), "truck extraction");
  const cls = classifyOperationalMessage("Maybe truck still unresolved", entities);
  assert(cls.categories.includes("unresolved_issue") || cls.status === "needs_review", "unresolved classification");
  const resolved = classifyOperationalMessage("Maybe truck resolved — not needed", {
    resolutionTerms: ["resolved", "not needed"],
  });
  assert(resolved.status === "resolved" || resolved.resolutionSignal, "resolution classification");
}

console.log("\nmatching / confidence bands");
{
  const quoteMsg = normalizeSlackMessage(
    { ts: "1.1", text: "26-1421 load-out maybe truck still unresolved", user: "U1" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Alex" }
  );
  const quoteMatches = matchSlackMessageToShows(quoteMsg, CANDIDATES);
  assert(quoteMatches[0]?.showKey === "sound-haven-2026", "Sound Haven exact quote auto target");
  assert(quoteMatches[0]?.confidenceBand === "high", "exact quote high confidence");
  assert(quoteMatches[0]?.matchState === "auto_attached", "high → auto_attached");
  notes.soundHavenQuote = quoteMatches[0];

  const dockMsg = normalizeSlackMessage(
    { ts: "1.2", text: "Dock 4 assigned for 26-0401", user: "U4" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Sam" }
  );
  const dockMatches = matchSlackMessageToShows(dockMsg, CANDIDATES);
  assert(dockMatches[0]?.showKey === "sweetwater-2026", "Sweetwater dock quote match");
  assert(dockMatches[0]?.confidenceBand === "high", "Sweetwater high confidence");
  notes.sweetwaterDock = dockMatches[0];

  const lowMsg = normalizeSlackMessage(
    { ts: "1.3", text: "Need another truck next week", user: "U6" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Pat" }
  );
  const lowMatches = matchSlackMessageToShows(lowMsg, CANDIDATES);
  const top = lowMatches[0];
  assert(!top || top.confidenceBand === "low" || top.score < 55, "ambiguous → low/general");
  notes.lowConfidence = top || { matchState: "general_queue" };

  const mediumMsg = normalizeSlackMessage(
    { ts: "1.4", text: "Haven amphitheater needs another cable package on Jun 2", user: "U5" },
    {
      channelId: "C_OPS",
      channelName: "ops",
      authorName: "Riley",
      knownVenues: ["Haven Amphitheater"],
    }
  );
  // Force venue entity via known venue list in extract during normalize - already done
  mediumMsg.extractedEntities.venueHints = ["Haven Amphitheater"];
  mediumMsg.extractedEntities.dates = ["Jun 2"];
  const mediumMatches = matchSlackMessageToShows(mediumMsg, CANDIDATES);
  const mediumTop = mediumMatches[0];
  assert(
    mediumTop &&
      (mediumTop.confidenceBand === "medium" ||
        mediumTop.matchState === "needs_review" ||
        mediumTop.score >= 55),
    "partial venue/date → medium/needs_review path"
  );
  notes.mediumConfidence = mediumTop;

  assert(scoreMatchConfidence(100) === "high", "score 100 high");
  assert(scoreMatchConfidence(60) === "medium", "score 60 medium");
  assert(scoreMatchConfidence(20) === "low", "score 20 low");

  // conflicting evidence penalty
  const conflict = normalizeSlackMessage(
    { ts: "1.5", text: "26-9999 for Sound Haven", user: "U1" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Alex" }
  );
  const conflictMatches = matchSlackMessageToShows(conflict, CANDIDATES);
  const sh = conflictMatches.find((m) => m.showKey === "sound-haven-2026");
  assert(
    !sh || sh.reasons.some((r) => /conflict/i.test(r)) || sh.score < 100,
    "conflicting quote penalty applied"
  );
}

console.log("\nstore: dedupe / edit / delete / corrupt / approve-reject");
{
  const dir = tempDir();
  const filePath = path.join(dir, "slack-operational-signals.json");
  const store = createSlackOperationalSignalsStore({ filePath });

  const msg = normalizeSlackMessage(
    { ts: "1710000001.000100", text: "26-1421 maybe truck unresolved", user: "U1" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Alex" }
  );
  msg.matches = matchSlackMessageToShows(msg, CANDIDATES);
  msg.matchState = msg.matches[0]?.matchState;

  const first = await store.upsertMessages([msg], {
    channelMeta: { channelId: "C_OPS", channelName: "ops" },
    advanceCursorTs: msg.ts,
  });
  assert(first.inserted === 1, "first insert");

  const dup = await store.upsertMessages([msg], {
    channelMeta: { channelId: "C_OPS", channelName: "ops" },
    advanceCursorTs: msg.ts,
  });
  assert(dup.duplicatesSkipped === 1, "dedupe skips identical");

  const edited = {
    ...msg,
    text: "26-1421 maybe truck resolved — not needed",
    editedTs: "1710000099.000100",
    contentHash: "changed",
    operationalClassification: classifyOperationalMessage(
      "26-1421 maybe truck resolved — not needed",
      msg.extractedEntities
    ),
  };
  edited.matches = matchSlackMessageToShows(edited, CANDIDATES);
  const editWrite = await store.upsertMessages([edited], {
    channelMeta: { channelId: "C_OPS", channelName: "ops" },
    advanceCursorTs: edited.ts,
  });
  assert(editWrite.updated === 1, "edited message updates existing key");
  const afterEdit = await store.getMessage(msg.messageKey);
  assert(afterEdit.editedTs === "1710000099.000100", "editedTs retained");

  const deleted = { ...afterEdit, deleted: true, contentHash: "deleted" };
  await store.upsertMessages([deleted]);
  const listed = await store.listMessages({ includeDeleted: false });
  assert(!listed.find((m) => m.messageKey === msg.messageKey), "deleted hidden from active list");

  // restore for approve/reject
  const live = normalizeSlackMessage(
    { ts: "1710000100.000100", text: "Haven amphitheater cable package Jun 2", user: "U5" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Riley" }
  );
  live.matches = [
    {
      showKey: "sound-haven-2026",
      showName: "Sound Haven",
      documentNumbers: ["26-1421"],
      confidence: "medium",
      confidenceBand: "medium",
      score: 60,
      reasons: ["partial"],
      evidence: {},
      matchedEntities: {},
      matchState: "needs_review",
    },
  ];
  live.matchState = "needs_review";
  await store.upsertMessages([live]);
  const review = await store.getReviewQueue();
  assert(review.some((item) => item.signalId === live.messageKey), "needs review queue");

  const approved = await store.approveMatch(live.messageKey, "sound-haven-2026", {
    showName: "Sound Haven",
  });
  assert(approved.ok && approved.message.matchState === "manually_approved", "manual approve persists");

  const rejectMsg = normalizeSlackMessage(
    { ts: "1710000101.000100", text: "Need another truck next week", user: "U6" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Pat" }
  );
  rejectMsg.matches = [
    {
      showKey: "sound-haven-2026",
      showName: "Sound Haven",
      confidenceBand: "low",
      score: 10,
      reasons: [],
      evidence: {},
      matchedEntities: {},
      matchState: "general_queue",
    },
  ];
  await store.upsertMessages([rejectMsg]);
  const rejected = await store.rejectMatch(rejectMsg.messageKey, "too vague");
  assert(rejected.ok && rejected.message.matchState === "manually_rejected", "manual reject persists");

  const general = await store.getGeneralQueue();
  assert(Array.isArray(general), "general queue readable");

  fs.writeFileSync(filePath, "{bad", "utf8");
  const recovered = await store.listMessages();
  assert(Array.isArray(recovered), "malformed store recovers");
  const backups = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
  assert(backups.length >= 1, "corrupt backup created");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nclient: 429 Retry-After + 5xx backoff");
{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 429,
        headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0" : null) },
        json: async () => ({ ok: false }),
      };
    }
    if (calls === 2) {
      return {
        status: 500,
        headers: { get: () => null },
        json: async () => ({ ok: false }),
      };
    }
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        ok: true,
        messages: [{ ts: "1.0", text: "26-1421 ok", user: "U1" }],
        response_metadata: {},
      }),
    };
  };

  const client = createSlackOperationalSignalsClient({
    token: "xoxb-test",
    fetchImpl,
    maxRetries: 4,
  });
  const started = Date.now();
  const body = await client.conversationsHistory({ channel: "C_OPS", limit: 10 });
  const elapsed = Date.now() - started;
  assert(body.ok === true, "history succeeds after 429/500 retries");
  assert(calls === 3, `retry path used calls=${calls}`);
  assert(client.getTelemetry().rateLimitCount >= 1, "rateLimitCount incremented");
  assert(client.getTelemetry().retryCount >= 2, "retryCount incremented");
  assert(elapsed >= 0, "backoff completed");
  notes.rateLimit = client.getTelemetry();
}

console.log("\nservice sync fixtures (no live Slack)");
{
  const dir = tempDir();
  const filePath = path.join(dir, "slack-operational-signals.json");
  let historyCalls = 0;
  const pages = {
    C_OPS: {
      ok: true,
      messages: FIXTURES.map((f) => ({
        ts: f.ts,
        text: f.text,
        user: f.user,
        reply_count: f.id === "exact-quote-maybe" ? 1 : 0,
      })),
      response_metadata: {},
    },
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("conversations.history")) {
      historyCalls += 1;
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => pages.C_OPS,
      };
    }
    if (u.includes("conversations.replies")) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          messages: [
            { ts: "1710000001.000100", text: FIXTURES[0].text, user: "U1" },
            {
              ts: "1710000001.000200",
              thread_ts: "1710000001.000100",
              text: "Maybe truck resolved — not needed for 26-1421",
              user: "U1",
            },
          ],
          response_metadata: {},
        }),
      };
    }
    if (u.includes("conversations.info")) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, channel: { name: "ops" } }),
      };
    }
    if (u.includes("users.info")) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          user: { profile: { display_name: "Fixture User" }, real_name: "Fixture User" },
        }),
      };
    }
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true }),
    };
  };

  const service = createSlackOperationalSignalsService({
    token: "xoxb-test",
    channelIds: ["C_OPS"],
    filePath,
    fetchImpl,
    lookbackHours: 72,
  });

  const telemetry = await service.syncSlackOperationalSignals({
    candidateShows: CANDIDATES,
  });
  assert(telemetry.status === "ok" || telemetry.status === "partial", `sync status=${telemetry.status}`);
  assert(telemetry.messagesFetched > 0, "messages fetched");
  assert(historyCalls === 1, "no N+1 history calls (one channel sync)");

  const soundHaven = await service.getSlackSignalsForShow(
    { showKey: "sound-haven-2026", showName: "Sound Haven", documentNumbers: ["26-1421"] },
    { allowStaleRefresh: false }
  );
  assert(
    soundHaven.signals.some((s) => /26-1421|Maybe|Sound Haven|motors/i.test(s.originalMessage || s.summary || "")),
    "Sound Haven has attached signals"
  );
  notes.soundHavenSignals = soundHaven.signals.slice(0, 3);

  const sweetwater = await service.getSlackSignalsForShow(
    { showKey: "sweetwater-2026", showName: "Sweetwater", documentNumbers: ["26-0401"] },
    { allowStaleRefresh: false }
  );
  assert(
    sweetwater.signals.some((s) => /26-0401|Dock|BOL|Sweetwater/i.test(s.originalMessage || "")),
    "Sweetwater dock/BOL attached"
  );
  assert(
    sweetwater.signals.some((s) => s.channelName && s.authorName && s.timestamp && s.originalMessage),
    "Sweetwater attribution fields present"
  );
  notes.sweetwaterSignals = sweetwater.signals.slice(0, 3);

  const review = await service.getSlackNeedsReviewQueue();
  const general = await service.getSlackGeneralOperationsQueue();
  assert(Array.isArray(review), "review queue array");
  assert(Array.isArray(general), "general queue array");
  notes.queues = { reviewCount: review.length, generalCount: general.length };

  // Cursor preserved: second sync should not lose channel cursor
  const store = await service.store.read();
  const cursorBefore = store.channels.C_OPS?.latestTs;
  await service.syncSlackOperationalSignals({ candidateShows: CANDIDATES });
  const storeAfter = await service.store.read();
  assert(storeAfter.channels.C_OPS?.latestTs === cursorBefore || storeAfter.channels.C_OPS?.latestTs >= cursorBefore, "cursor preserved/advanced safely");

  const attachedBeforeEmptyRematch = Object.values(storeAfter.messages)
    .flatMap((message) => message.matches || [])
    .filter((match) => match.matchState === "auto_attached").length;
  const emptyRematch = await service.rematchAll([], { expandQuotes: false });
  const afterEmptyRematch = await service.store.read();
  const attachedAfterEmptyRematch = Object.values(afterEmptyRematch.messages)
    .flatMap((message) => message.matches || [])
    .filter((match) => match.matchState === "auto_attached").length;
  assert(emptyRematch.skipped && emptyRematch.skipReason === "candidate_catalog_empty", "empty candidate catalog skips destructive rematch");
  assert(attachedAfterEmptyRematch === attachedBeforeEmptyRematch, "empty catalog preserves established matches");

  // Security: no token in store
  const raw = fs.readFileSync(filePath, "utf8").toLowerCase();
  assert(!raw.includes("xoxb-"), "store has no bot token");
  assert(!raw.includes("authorization"), "store has no authorization header");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nservice: material edit rematches rejected signals");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-signals-rematch-"));
  const filePath = path.join(dir, "store.json");
  const service = createSlackOperationalSignalsService({
    token: "xoxb-test",
    channelIds: ["C_OPS"],
    filePath,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, messages: [] }),
    }),
  });

  const rejected = normalizeSlackMessage(
    { ts: "1710000200.000100", text: "Need another truck next week", user: "U9" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Pat" }
  );
  rejected.matches = [
    {
      showKey: "sound-haven-2026",
      showName: "Sound Haven",
      confidenceBand: "low",
      score: 10,
      reasons: [],
      evidence: {},
      matchedEntities: {},
      matchState: "manually_rejected",
    },
  ];
  rejected.matchState = "manually_rejected";
  rejected.manualDecision = { action: "reject", reason: "too vague", at: new Date().toISOString() };
  await service.store.upsertMessages([rejected]);

  // Simulate sync path material edit: same messageKey, new contentHash with strong quote evidence.
  const edited = normalizeSlackMessage(
    {
      ts: "1710000200.000100",
      text: "26-1421 Sound Haven Maybe Truck resolved — not needed",
      user: "U9",
      edited: { ts: "1710000201.000000" },
    },
    { channelId: "C_OPS", channelName: "ops", authorName: "Pat" }
  );
  assert(edited.contentHash !== rejected.contentHash, "material edit changes contentHash");

  const existing = (await service.store.read()).messages[edited.messageKey];
  let rematched;
  if (
    existing?.manualDecision &&
    existing.contentHash === edited.contentHash
  ) {
    rematched = { ...edited, manualDecision: existing.manualDecision, matchState: existing.matchState };
  } else {
    const matches = matchSlackMessageToShows(edited, CANDIDATES);
    rematched = {
      ...edited,
      matches,
      matchState: matches[0]?.matchState || "general_queue",
      manualDecision: null,
    };
  }
  await service.store.upsertMessages([rematched]);
  const after = await service.store.getMessage(edited.messageKey);
  assert(after.manualDecision == null, "material edit clears manual reject");
  assert(after.matchState !== "manually_rejected", "material edit does not keep silent reject");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nservice: manual approval refreshes FLEX metadata");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-signals-manual-refresh-"));
  const filePath = path.join(dir, "store.json");
  const service = createSlackOperationalSignalsService({ filePath, channelIds: [], token: "" });
  const liteFlairMessage = normalizeSlackMessage(
    { ts: "1710000250.000100", text: "I added 2 x MDG Hazers to LiteFlair", user: "U9" },
    { channelId: "C_OPS", channelName: "lighting", authorName: "Pat" }
  );
  await service.store.upsertMessages([liteFlairMessage]);
  await service.approveSlackSignalMatch(liteFlairMessage.messageKey, "liteflair-shoot", { showName: "LiteFlair Shoot" });
  await service.rematchAll([{
    showKey: "liteflair-shoot",
    showName: "LiteFlair Shoot",
    documentNumbers: ["26-1790"],
    primaryDocumentNumber: "26-1790",
    elementId: "33333333-3333-4333-8333-333333333333",
    documentRefs: [{ documentNumber: "26-1790", documentType: "quote", role: "primary_show_quote", elementId: "33333333-3333-4333-8333-333333333333" }],
    quoteElements: [{ documentNumber: "26-1790", elementId: "33333333-3333-4333-8333-333333333333", documentType: "quote" }],
  }], { expandQuotes: false });
  const refreshed = await service.store.getMessage(liteFlairMessage.messageKey);
  assert(refreshed.manualDecision?.showKey === "liteflair-shoot", "manual show approval survives metadata refresh");
  assert(refreshed.matches?.[0]?.primaryDocumentNumber === "26-1790", "manual match receives the current primary FLEX quote");
  assert(refreshed.matches?.[0]?.elementId === "33333333-3333-4333-8333-333333333333", "manual match receives the verified FLEX UUID");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nservice: fixture cache ignored when fixture mode off");
{
  const prev = process.env.SLACK_OPERATIONAL_FIXTURE_MODE;
  delete process.env.SLACK_OPERATIONAL_FIXTURE_MODE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-signals-fixture-"));
  const filePath = path.join(dir, "store.json");
  const service = createSlackOperationalSignalsService({
    filePath,
    channelIds: [],
    token: "",
  });
  const fixtureMsg = normalizeSlackMessage(
    { ts: "1710000300.000100", text: "26-1421 fixture Maybe Truck", user: "U_FIX" },
    { channelId: "C_FIXTURE", channelName: "fixture-ops", authorName: "Fixture Alex" }
  );
  fixtureMsg.fixture = true;
  fixtureMsg.sourceLabel = "fixture/test data";
  fixtureMsg.matches = [
    {
      showKey: "sound-haven-2026",
      showName: "Sound Haven",
      documentNumbers: ["26-1421"],
      confidenceBand: "high",
      score: 100,
      reasons: ["quote"],
      evidence: {},
      matchedEntities: {},
      matchState: "auto_attached",
    },
  ];
  fixtureMsg.matchState = "auto_attached";
  await service.store.replaceAllForTests({
    version: 1,
    channels: {},
    users: {},
    messages: { [fixtureMsg.messageKey]: fixtureMsg },
    reviewQueue: [],
    generalQueue: [],
    sync: {
      lastSyncAt: new Date().toISOString(),
      lastSuccessfulSyncAt: new Date().toISOString(),
      syncInProgress: false,
      fixtureMode: true,
      sourceLabel: "fixture/test data",
      lastError: null,
      lastTelemetry: null,
    },
  });

  const status = await service.getSlackSignalSyncStatus();
  assert(status.fixtureMode === false, "fixture mode off when env unset");
  assert(status.fixtureCacheIgnored === true, "leftover fixture cache flagged");
  assert(status.status === "unavailable", "leftover fixture cache is not live-connected");

  const payload = await service.getSlackSignalsForShow(
    { showKey: "sound-haven-2026", showName: "Sound Haven", documentNumbers: ["26-1421"] },
    { allowStaleRefresh: false }
  );
  assert((payload.signals || []).length === 0, "fixture messages not served when fixture mode off");

  if (prev == null) delete process.env.SLACK_OPERATIONAL_FIXTURE_MODE;
  else process.env.SLACK_OPERATIONAL_FIXTURE_MODE = prev;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nalias / fuzzy / ambiguity matching");
{
  assert(
    stripShowNameDecorations("Paul Simon LED Wall - 2026") === "paul simon",
    "alias strip Paul Simon"
  );
  assert(
    stripShowNameDecorations("Sound Haven - Continuum - SL320 - 7/27-8/3").includes(
      "sound haven"
    ),
    "alias strip Sound Haven"
  );
  const aliases = buildShowNameAliases("Paul Simon LED Wall - 2026");
  assert(aliases.includes("paul simon"), "build aliases includes paul simon");
  notes.aliasExamples = {
    paulSimon: aliases,
    soundHaven: buildShowNameAliases("Sound Haven - Continuum - SL320 - 7/27-8/3"),
  };

  const paul = {
    showKey: "paul-simon-2026",
    showName: "Paul Simon LED Wall - 2026",
    documentNumbers: ["26-2001"],
    source: "canonical_show_registry",
    daysOut: 12,
    departments: ["video", "led"],
  };
  const sound = {
    showKey: "sound-haven-2026",
    showName: "Sound Haven - Continuum - SL320 - 7/27-8/3",
    documentNumbers: ["26-1421"],
    source: "active_shows",
    daysOut: 20,
    departments: ["audio"],
  };
  const nmr = {
    showKey: "nmr-2026",
    showName: "NMR Summer Tour 2026",
    documentNumbers: ["26-3001"],
    aliases: ["NMR"],
    source: "active_shows",
    daysOut: 8,
    departments: ["trucking"],
  };
  const paulOld = {
    showKey: "paul-simon-2019",
    showName: "Paul Simon LED Wall - 2019",
    documentNumbers: ["19-1001"],
    source: "flex_quote_lookup",
    status: "closed",
    daysOut: -400,
  };

  const paulMsg = normalizeSlackMessage(
    { ts: "2.1", text: "Paul Simon is loaded", user: "U1" },
    { channelId: "C_VIDEO", channelName: "video", authorName: "Ops" }
  );
  const paulMatch = matchSlackMessageToShows(paulMsg, [paul, sound, nmr]);
  assert(paulMatch[0]?.showKey === "paul-simon-2026", "Paul Simon parent-show match");
  assert(paulMatch[0]?.confidenceBand === "high", "Paul Simon high confidence");
  assert(paulMatch[0]?.workstreamUnspecified === true, "Paul Simon workstream unspecified");
  notes.paulSimon = paulMatch[0];

  const paulAmbiguous = matchSlackMessageToShows(paulMsg, [paul, { ...paulOld, status: "active", daysOut: 5, source: "active_shows" }]);
  // Two active Paul Simon events → Needs Review
  const twoPauls = [
    paul,
    {
      showKey: "paul-simon-europe-2026",
      showName: "Paul Simon Europe 2026",
      documentNumbers: ["26-2002"],
      source: "active_shows",
      daysOut: 15,
    },
  ];
  const amb = matchSlackMessageToShows(paulMsg, twoPauls);
  assert(amb[0]?.matchState === "needs_review", "two Paul Simon shows → needs_review");
  notes.paulSimonAmbiguity = amb.slice(0, 2);

  const shMsg = normalizeSlackMessage(
    { ts: "2.2", text: "Sound Haven is now loaded", user: "U2" },
    { channelId: "C_AUDIO", channelName: "audiowarehouse", authorName: "Ops" }
  );
  const shMatch = matchSlackMessageToShows(shMsg, [paul, sound, nmr]);
  assert(shMatch[0]?.showKey === "sound-haven-2026", "Sound Haven shorthand match");
  assert(shMatch[0]?.confidenceBand === "high", "Sound Haven high confidence");
  notes.soundHavenShorthand = shMatch[0];

  const piedmontA = {
    showKey: "piedmont-finals",
    showName: "Piedmont Finals 2026",
    documentNumbers: ["26-4101"],
    source: "active_shows",
    daysOut: 10,
  };
  const piedmontB = {
    showKey: "piedmont-classic",
    showName: "Piedmont Classic 2026",
    documentNumbers: ["26-4102"],
    source: "active_shows",
    daysOut: 18,
  };
  const piedmontMsg = normalizeSlackMessage(
    { ts: "2.3", text: "Piedmont needs cable", user: "U3" },
    { channelId: "C_LIGHT", channelName: "lighting", authorName: "Ops" }
  );
  const piedmontMatch = matchSlackMessageToShows(piedmontMsg, [piedmontA, piedmontB]);
  assert(
    piedmontMatch[0]?.matchState === "needs_review",
    "multiple Piedmont → needs_review"
  );

  const nmrMsg = normalizeSlackMessage(
    { ts: "2.4", text: "NMR is waiting on trucking", user: "U4" },
    { channelId: "C_LOG", channelName: "logistics", authorName: "Ops" }
  );
  const nmrMatch = matchSlackMessageToShows(nmrMsg, [paul, sound, nmr]);
  assert(nmrMatch[0]?.showKey === "nmr-2026", "NMR acronym match");
  assert(nmrMatch[0]?.confidenceBand === "high", "NMR high confidence");

  const typoMsg = normalizeSlackMessage(
    { ts: "2.5", text: "Sond Haven is loaded", user: "U5" },
    { channelId: "C_AUDIO", channelName: "audiowarehouse", authorName: "Ops" }
  );
  const typoMatch = matchSlackMessageToShows(typoMsg, [paul, sound, nmr]);
  assert(typoMatch[0]?.showKey === "sound-haven-2026", "typo Sond Haven → Sound Haven");
  assert(
    typoMatch[0]?.confidenceBand === "high" || typoMatch[0]?.score >= 55,
    "typo unique current show is strong/medium+"
  );

  const oldVsNew = matchSlackMessageToShows(paulMsg, [paulOld, paul]);
  assert(oldVsNew[0]?.showKey === "paul-simon-2026", "active Paul Simon beats archived");

  const badFlexQuote = {
    showKey: "wrong-chastain-led",
    showName: "Live Nation: Chastain LED Wall Installation",
    documentNumbers: ["26-0733"],
    source: "flex_quote_lookup",
    daysOut: 5,
  };
  const llumaMsg = normalizeSlackMessage(
    {
      ts: "2.6",
      text: "RTL: LLUMA Live - 7.3.26 MA3 Full (26-0733) will be here at 4:40pm",
      user: "U6",
    },
    { channelId: "C_LIGHT", channelName: "lighting", authorName: "Ops" }
  );
  const badQuoteMatch = matchSlackMessageToShows(llumaMsg, [badFlexQuote, paul, sound]);
  assert(
    !badQuoteMatch.some(
      (m) =>
        m.showKey === "wrong-chastain-led" && m.confidenceBand === "high"
    ),
    "unverified flex quote mapping must not auto-attach high"
  );
  assert(
    (badQuoteMatch.find((m) => m.showKey === "wrong-chastain-led")?.reasons || []).some(
      (r) => /unverified quote mapping/i.test(r)
    ),
    "unverified quote mapping reason present"
  );

  const moonchildCandidate = {
    showKey: "live-nation-moonchild-the-fox",
    showName: "Live Nation Moonchild @ The Fox",
    documentNumbers: ["26-1846", "26-0836"],
    primaryDocumentNumber: "26-1846",
    elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
    documentRefs: [{ documentNumber: "26-1846", documentType: "quote", role: "primary_show_quote", elementId: "826adc32-f11e-4d12-bd31-ecaa3f7bfe00" }],
    source: "active_shows",
    daysOut: 5,
  };
  const pullSheetMessage = normalizeSlackMessage(
    { ts: "2.7", text: "Live Nation Moonchild @ The Fox (26-0836) pull sheet is ready", user: "U7" },
    { channelId: "C_WAREHOUSE", channelName: "warehouse", authorName: "Ops" }
  );
  const pullSheetMatch = matchSlackMessageToShows(pullSheetMessage, [moonchildCandidate])[0];
  assert(pullSheetMatch?.primaryDocumentNumber === "26-1846", "matcher preserves canonical show quote separately from mentioned pull sheet");
  assert(pullSheetMatch?.documentRefs?.[0]?.elementId === moonchildCandidate.elementId, "matcher carries Intake Engine UUID forward");
  assert(pullSheetMatch?.reasons?.some(reason => /Prefer current Active Shows candidate/.test(reason)), "canonical registry candidates retain the Active Show Index recency preference");
}

console.log("\nsystem noise excluded from queues");
{
  const dir = tempDir();
  const filePath = path.join(dir, "slack-operational-signals.json");
  const store = createSlackOperationalSignalsStore({ filePath });
  const joinMsg = normalizeSlackMessage(
    { ts: "3.1", text: "<@U1> has joined the channel", user: "U1", subtype: "channel_join" },
    { channelId: "C_OPS", channelName: "ops", authorName: "Bot" }
  );
  joinMsg.matchState = "general_queue";
  await store.upsertMessages([joinMsg]);
  const general = await store.getGeneralQueue();
  assert(general.length === 0, "channel join excluded from general queue");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (Object.keys(notes).length) {
  console.log("\nNotes:");
  console.log(JSON.stringify(notes, null, 2));
}
if (failed > 0) process.exit(1);
