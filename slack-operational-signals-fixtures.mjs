/**
 * Synthetic Slack Operational Signals fixtures for local E2E validation.
 * Never used against production Slack. Label all seeded data as fixture/test.
 */

import { normalizeSlackMessage } from "./slack-operational-signals-normalize.mjs";
import { matchSlackMessageToShows } from "./slack-operational-signals-match.mjs";

export const SLACK_FIXTURE_CANDIDATE_SHOWS = [
  {
    showKey: "sound-haven",
    id: "sound-haven",
    showName: "Sound Haven",
    name: "Sound Haven",
    client: "Sound Haven Productions",
    venue: "Haven Amphitheater",
    documentNumbers: ["26-1421", "26-0162", "26-1566", "26-1827"],
    aliases: ["SH"],
    truckNumbers: ["T-12"],
    trailerNumbers: ["TR-9"],
    plannedStartDate: "2026-06-01",
    plannedEndDate: "2026-06-03",
    departments: ["audio", "rigging", "trucking", "warehouse"],
  },
  {
    showKey: "sweetwater",
    id: "sweetwater",
    showName: "Sweetwater",
    name: "Sweetwater",
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

export const SLACK_FIXTURE_RAW_MESSAGES = [
  {
    ts: "1710000001.000100",
    text: "26-1421 load-out maybe truck still unresolved",
    user: "U_FIXTURE_ALEX",
    reply_count: 1,
  },
  {
    ts: "1710000001.000200",
    thread_ts: "1710000001.000100",
    text: "Maybe truck resolved — not needed for 26-1421",
    user: "U_FIXTURE_ALEX",
  },
  {
    ts: "1710000002.000100",
    text: "Sound Haven rigging pull is complete",
    user: "U_FIXTURE_SAM",
  },
  {
    ts: "1710000003.000100",
    text: "Sweetwater Music Hall load-in on Jul 10 needs confirmation",
    user: "U_FIXTURE_PAT",
  },
  {
    ts: "1710000004.000100",
    text: "Truck T-12 assigned for Sound Haven load-out",
    user: "U_FIXTURE_ALEX",
  },
  {
    ts: "1710000005.000100",
    text: "Dock 4 assigned for 26-0401",
    user: "U_FIXTURE_RILEY",
  },
  {
    ts: "1710000006.000100",
    text: "BOL sent for Sweetwater truck",
    user: "U_FIXTURE_RILEY",
  },
  {
    ts: "1710000007.000100",
    text: "Audio pull complete, waiting on cable package",
    user: "U_FIXTURE_JORDAN",
  },
  {
    ts: "1710000008.000100",
    text: "Need two more motors for Sound Haven",
    user: "U_FIXTURE_SAM",
  },
  {
    ts: "1710000009.000100",
    text: "Maybe truck resolved — not needed for 26-1421",
    user: "U_FIXTURE_ALEX",
  },
  {
    ts: "1710000010.000100",
    text: "Need another truck next week",
    user: "U_FIXTURE_PAT",
  },
  {
    ts: "1710000011.000100",
    text: "Haven amphitheater needs another cable package on Jun 2",
    user: "U_FIXTURE_JORDAN",
  },
];

const AUTHOR_NAMES = {
  U_FIXTURE_ALEX: "Fixture Alex",
  U_FIXTURE_SAM: "Fixture Sam",
  U_FIXTURE_PAT: "Fixture Pat",
  U_FIXTURE_RILEY: "Fixture Riley",
  U_FIXTURE_JORDAN: "Fixture Jordan",
};

/**
 * Seed the Slack store with synthetic matched messages for E2E validation.
 */
export async function seedSlackOperationalFixtures(service, options = {}) {
  const channelId = options.channelId || "C_FIXTURE_OPS";
  const channelName = options.channelName || "fixture-ops";
  const candidates = options.candidateShows || SLACK_FIXTURE_CANDIDATE_SHOWS;
  const now = new Date().toISOString();

  const normalized = [];
  for (const raw of SLACK_FIXTURE_RAW_MESSAGES) {
    const message = normalizeSlackMessage(raw, {
      channelId,
      channelName,
      authorName: AUTHOR_NAMES[raw.user] || "Fixture User",
      knownShowNames: candidates.map((s) => s.showName),
      knownClients: candidates.map((s) => s.client),
      knownVenues: candidates.map((s) => s.venue),
      ingestedAt: now,
    });

    if (message.threadTs) {
      const parent = normalized.find((item) => item.ts === message.threadTs);
      const parentMatch = parent?.matches?.[0] || null;
      if (parentMatch) message.threadParentMatch = parentMatch;
    }

    const matches = matchSlackMessageToShows(message, candidates);
    message.matches = matches;
    message.matchState = matches[0]?.matchState || "general_queue";
    message.fixture = true;
    message.sourceLabel = "fixture/test data";
    normalized.push(message);
  }

  await service.store.replaceAllForTests({
    version: 1,
    channels: {
      [channelId]: {
        latestTs: normalized[normalized.length - 1]?.ts || null,
        lastSuccessfulSyncAt: now,
        channelName,
        lastError: null,
        fixture: true,
      },
    },
    users: Object.fromEntries(
      Object.entries(AUTHOR_NAMES).map(([id, displayName]) => [
        id,
        { displayName, realName: displayName, updatedAt: now },
      ])
    ),
    messages: Object.fromEntries(normalized.map((item) => [item.messageKey, item])),
    reviewQueue: [],
    generalQueue: [],
    sync: {
      lastSyncAt: now,
      lastSuccessfulSyncAt: now,
      syncInProgress: false,
      lastError: null,
      lastTelemetry: {
        status: "ok",
        startedAt: now,
        completedAt: now,
        channelsRequested: 1,
        channelsSucceeded: 1,
        messagesFetched: normalized.length,
        messagesInserted: normalized.length,
        messagesUpdated: 0,
        duplicatesSkipped: 0,
        threadsFetched: 1,
        rateLimitCount: 0,
        retryCount: 0,
        errors: [],
        fixtureMode: true,
      },
      fixtureMode: true,
      sourceLabel: "fixture/test data",
    },
  });

  // Rebuild queues via upsert of empty batch (triggers rebuildQueues).
  await service.store.upsertMessages([], {
    channelMeta: { channelId, channelName },
    advanceCursorTs: normalized[normalized.length - 1]?.ts || null,
  });

  return {
    seeded: normalized.length,
    channelId,
    channelName,
    sourceLabel: "fixture/test data",
    fixtureMode: true,
  };
}
