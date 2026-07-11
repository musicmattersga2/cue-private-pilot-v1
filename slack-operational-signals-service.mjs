/**
 * Slack Operational Signals — shared orchestration service for Ask FLEX + Active Shows.
 */

import { createSlackOperationalSignalsClient } from "./slack-operational-signals-client.mjs";
import { createSlackOperationalSignalsStore } from "./slack-operational-signals-store.mjs";
import {
  normalizeSlackMessage,
  isOperationallyRelevant,
  slackTsToIso,
} from "./slack-operational-signals-normalize.mjs";
import {
  matchSlackMessageToShows,
  pickPrimaryMatch,
} from "./slack-operational-signals-match.mjs";

function asString(value) {
  return String(value ?? "").trim();
}

function envFixtureModeEnabled() {
  const raw = String(process.env.SLACK_OPERATIONAL_FIXTURE_MODE || "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function isFixtureTaggedMessage(message) {
  return Boolean(
    message?.fixture ||
      String(message?.sourceLabel || "")
        .toLowerCase()
        .includes("fixture")
  );
}

function parseChannelIds(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusRank(status) {
  const order = {
    blocked: 0,
    at_risk: 1,
    needs_review: 2,
    info: 3,
    resolved: 4,
  };
  return order[String(status || "").toLowerCase()] ?? 50;
}

function toPublicSignal(message, match = null) {
  const primary = match || pickPrimaryMatch(message.matches || []) || null;
  const classification = message.operationalClassification || {};
  return {
    signalId: message.messageKey,
    categories: classification.categories || [],
    status: classification.status || "info",
    summary: classification.summary || message.text,
    originalMessage: message.text,
    channelId: message.channelId,
    channelName: message.channelName,
    authorName: message.authorName,
    timestamp: message.timestampIso || slackTsToIso(message.ts),
    permalink: message.permalink,
    confidence: primary?.confidenceBand || primary?.confidence || null,
    matchReasons: primary?.reasons || [],
    matchState: primary?.matchState || message.matchState || null,
    relatedQuotes: primary?.documentNumbers || message.extractedEntities?.quotes || [],
    showKey: primary?.showKey || null,
    showName: primary?.showName || null,
    unresolved: Boolean(classification.unresolved),
    resolutionSignal: Boolean(classification.resolutionSignal),
  };
}

export function createSlackOperationalSignalsService(options = {}) {
  const client =
    options.client ||
    createSlackOperationalSignalsClient({
      token: options.token || process.env.SLACK_BOT_TOKEN,
      fetchImpl: options.fetchImpl,
    });
  const store =
    options.store ||
    createSlackOperationalSignalsStore({
      filePath: options.filePath || process.env.SLACK_OPERATIONAL_CACHE_PATH,
    });

  const lookbackHours = Math.max(
    1,
    Number(
      options.lookbackHours ||
        process.env.SLACK_OPERATIONAL_SYNC_LOOKBACK_HOURS ||
        72
    )
  );
  const maxMessagesPerSync = Math.max(
    20,
    Number(
      options.maxMessagesPerSync ||
        process.env.SLACK_OPERATIONAL_MAX_MESSAGES_PER_SYNC ||
        300
    )
  );
  const channelIds =
    options.channelIds ||
    parseChannelIds(process.env.SLACK_OPERATIONAL_CHANNEL_IDS);

  let syncInProgress = false;
  let intervalHandle = null;

  function isConfigured() {
    return client.isConfigured() && channelIds.length > 0;
  }

  async function resolveAuthorName(userId, cacheUsers) {
    if (!userId) return "Unknown";
    if (cacheUsers?.[userId]?.displayName) return cacheUsers[userId].displayName;
    try {
      const info = await client.usersInfo(userId);
      const displayName =
        info?.user?.profile?.display_name ||
        info?.user?.real_name ||
        info?.user?.name ||
        userId;
      await store.upsertUser(userId, {
        displayName,
        realName: info?.user?.real_name || null,
      });
      return displayName;
    } catch {
      return userId;
    }
  }

  async function fetchChannelMessages(channelId, oldestTs) {
    const messages = [];
    let cursor = null;
    let fetched = 0;
    do {
      const page = await client.conversationsHistory({
        channel: channelId,
        oldest: oldestTs || undefined,
        cursor,
        limit: Math.min(200, maxMessagesPerSync - fetched),
        inclusive: false,
      });
      const batch = Array.isArray(page.messages) ? page.messages : [];
      messages.push(...batch);
      fetched += batch.length;
      cursor = page.response_metadata?.next_cursor || null;
      if (fetched >= maxMessagesPerSync) break;
    } while (cursor);
    return messages;
  }

  async function fetchThreadReplies(channelId, threadTs) {
    const replies = [];
    let cursor = null;
    do {
      const page = await client.conversationsReplies({
        channel: channelId,
        ts: threadTs,
        cursor,
        limit: 200,
      });
      const batch = Array.isArray(page.messages) ? page.messages : [];
      // Skip parent (first) when present.
      replies.push(...batch.filter((item) => item.ts !== threadTs));
      cursor = page.response_metadata?.next_cursor || null;
    } while (cursor);
    return replies;
  }

  async function syncSlackOperationalSignals(syncOptions = {}) {
    const startedAt = new Date().toISOString();
    const telemetry = {
      status: "ok",
      startedAt,
      completedAt: null,
      channelsRequested: 0,
      channelsSucceeded: 0,
      messagesFetched: 0,
      messagesInserted: 0,
      messagesUpdated: 0,
      duplicatesSkipped: 0,
      threadsFetched: 0,
      rateLimitCount: 0,
      retryCount: 0,
      errors: [],
    };

    if (syncInProgress) {
      telemetry.status = "skipped_in_progress";
      telemetry.completedAt = new Date().toISOString();
      return telemetry;
    }

    if (!isConfigured()) {
      telemetry.status = "unavailable";
      telemetry.errors.push("Slack not configured (token or channel IDs missing).");
      telemetry.completedAt = new Date().toISOString();
      await store.setSyncState({
        lastSyncAt: telemetry.completedAt,
        lastError: telemetry.errors[0],
        syncInProgress: false,
        lastTelemetry: telemetry,
      });
      return telemetry;
    }

    syncInProgress = true;
    await store.setSyncState({ syncInProgress: true, lastError: null });
    client.resetTelemetry?.();

    try {
      const candidateShows = syncOptions.candidateShows
        ? await Promise.resolve(syncOptions.candidateShows)
        : typeof options.getCandidateShows === "function"
          ? await options.getCandidateShows()
          : [];
      const knownShowNames = candidateShows.map((s) => s.showName || s.name).filter(Boolean);
      const knownClients = candidateShows.map((s) => s.client).filter(Boolean);
      const knownVenues = candidateShows.map((s) => s.venue).filter(Boolean);

      const storeSnap = await store.read();
      const lookbackOldest = String(
        Math.floor(Date.now() / 1000) - lookbackHours * 3600
      );

      for (const channelId of channelIds) {
        telemetry.channelsRequested += 1;
        try {
          let channelName = storeSnap.channels?.[channelId]?.channelName || channelId;
          try {
            const info = await client.conversationsInfo(channelId);
            channelName = info?.channel?.name || channelName;
          } catch {
            // Channel info is optional.
          }

          const cursorTs = storeSnap.channels?.[channelId]?.latestTs || null;
          const oldest = cursorTs || lookbackOldest;
          const rawMessages = await fetchChannelMessages(channelId, oldest);
          telemetry.messagesFetched += rawMessages.length;

          // Sort ascending so cursor advances safely.
          rawMessages.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

          const normalizedBatch = [];
          let maxPersistedTs = cursorTs;

          for (const raw of rawMessages) {
            const authorName = await resolveAuthorName(raw.user, storeSnap.users);
            let normalized = normalizeSlackMessage(raw, {
              channelId,
              channelName,
              authorName,
              knownShowNames,
              knownClients,
              knownVenues,
            });

            // Preserve manual decisions unless material edit (contentHash change).
            const existing = storeSnap.messages?.[normalized.messageKey];
            if (
              existing?.manualDecision &&
              existing.contentHash === normalized.contentHash
            ) {
              normalized.matches = existing.matches;
              normalized.matchState = existing.matchState;
              normalized.manualDecision = existing.manualDecision;
            } else if (!normalized.deleted && isOperationallyRelevant(normalized)) {
              // Thread parent context
              if (normalized.threadTs) {
                const parent = storeSnap.messages?.[`${channelId}:${normalized.threadTs}`];
                const parentMatch = pickPrimaryMatch(parent?.matches || []);
                if (parentMatch) {
                  normalized.threadParentMatch = parentMatch;
                }
              }

              // Material edit or first sighting: rematch cleanly (do not carry reject/approve).
              const matches = matchSlackMessageToShows(normalized, candidateShows);
              normalized.matches = matches;
              normalized.matchState = pickPrimaryMatch(matches)?.matchState || "general_queue";
              normalized.manualDecision = null;
            }

            // Fetch replies for operational parents / entity-bearing replies.
            if (
              !normalized.deleted &&
              Number(raw.reply_count || 0) > 0 &&
              isOperationallyRelevant(normalized)
            ) {
              try {
                const replies = await fetchThreadReplies(channelId, normalized.ts);
                telemetry.threadsFetched += 1;
                for (const reply of replies) {
                  const replyAuthor = await resolveAuthorName(reply.user, storeSnap.users);
                  let replyNorm = normalizeSlackMessage(reply, {
                    channelId,
                    channelName,
                    authorName: replyAuthor,
                    knownShowNames,
                    knownClients,
                    knownVenues,
                  });
                  replyNorm.threadParentMatch = pickPrimaryMatch(normalized.matches || []);
                  if (isOperationallyRelevant(replyNorm) || replyNorm.threadParentMatch) {
                    const replyMatches = matchSlackMessageToShows(
                      replyNorm,
                      candidateShows
                    );
                    replyNorm.matches = replyMatches;
                    replyNorm.matchState =
                      pickPrimaryMatch(replyMatches)?.matchState || "general_queue";
                    normalizedBatch.push(replyNorm);
                    if (!maxPersistedTs || replyNorm.ts > maxPersistedTs) {
                      maxPersistedTs = replyNorm.ts;
                    }
                  }
                }
              } catch (error) {
                telemetry.errors.push({
                  channelId,
                  phase: "thread",
                  message: asString(error?.message || error),
                });
              }
            }

            normalizedBatch.push(normalized);
            if (!maxPersistedTs || normalized.ts > maxPersistedTs) {
              maxPersistedTs = normalized.ts;
            }
          }

          // Persist batch, then advance cursor only after success.
          const writeResult = await store.upsertMessages(normalizedBatch, {
            channelMeta: { channelId, channelName },
            advanceCursorTs: maxPersistedTs || cursorTs,
          });
          telemetry.messagesInserted += writeResult.inserted || 0;
          telemetry.messagesUpdated += writeResult.updated || 0;
          telemetry.duplicatesSkipped += writeResult.duplicatesSkipped || 0;
          telemetry.channelsSucceeded += 1;
        } catch (error) {
          telemetry.status = "partial";
          telemetry.errors.push({
            channelId,
            message: asString(error?.message || error),
            code: error?.code || null,
          });
          await store.setChannelError(channelId, asString(error?.message || error));
          // Do not advance cursor on failure.
        }
      }

      const clientTelemetry = client.getTelemetry?.() || {};
      telemetry.rateLimitCount = clientTelemetry.rateLimitCount || 0;
      telemetry.retryCount = clientTelemetry.retryCount || 0;
      if (!telemetry.channelsSucceeded && telemetry.channelsRequested) {
        telemetry.status = "error";
      } else if (telemetry.errors.length && telemetry.channelsSucceeded) {
        telemetry.status = "partial";
      }

      telemetry.completedAt = new Date().toISOString();
      await store.setSyncState({
        syncInProgress: false,
        lastSyncAt: telemetry.completedAt,
        lastSuccessfulSyncAt:
          telemetry.status === "ok" || telemetry.status === "partial"
            ? telemetry.completedAt
            : storeSnap.sync?.lastSuccessfulSyncAt || null,
        lastError: telemetry.errors[0] || null,
        lastTelemetry: telemetry,
        // Live sync never inherits leftover fixture-mode cache flags.
        fixtureMode: false,
        sourceLabel: null,
      });
      return telemetry;
    } catch (error) {
      telemetry.status = "error";
      telemetry.errors.push(asString(error?.message || error));
      telemetry.completedAt = new Date().toISOString();
      await store.setSyncState({
        syncInProgress: false,
        lastSyncAt: telemetry.completedAt,
        lastError: telemetry.errors[0],
        lastTelemetry: telemetry,
      });
      return telemetry;
    } finally {
      syncInProgress = false;
    }
  }

  async function getSlackSignalSyncStatus() {
    const snap = await store.read();
    const lastSyncAt = snap.sync?.lastSyncAt || null;
    const ageSeconds = lastSyncAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(lastSyncAt)) / 1000))
      : null;
    const staleAfter = Number(process.env.SLACK_OPERATIONAL_STALE_SECONDS || 3600);
    const envFixture = envFixtureModeEnabled();
    const storeFixture = Boolean(snap.sync?.fixtureMode);
    // Fixture data is only authoritative when env fixture mode is explicitly on.
    // Leftover fixture cache must never look like live Slack.
    const fixtureMode = envFixture;
    const fixtureCacheIgnored = Boolean(!envFixture && storeFixture);
    const configured = isConfigured() || fixtureMode;
    let status;
    if (fixtureMode) {
      status = "fallback";
    } else if (!isConfigured()) {
      status = "unavailable";
    } else if (snap.sync?.syncInProgress) {
      status = "syncing";
    } else if (snap.sync?.lastError) {
      status = "partial";
    } else if (lastSyncAt) {
      status = "connected";
    } else {
      status = "unavailable";
    }
    const stale = ageSeconds == null ? true : ageSeconds > staleAfter;
    return {
      configured,
      status,
      lastSyncAt,
      lastSuccessfulSyncAt: snap.sync?.lastSuccessfulSyncAt || null,
      ageSeconds,
      stale,
      syncInProgress: Boolean(snap.sync?.syncInProgress || syncInProgress),
      lastError: snap.sync?.lastError || null,
      lastTelemetry: snap.sync?.lastTelemetry || null,
      channelCount: Object.keys(snap.channels || {}).length,
      messageCount: Object.keys(snap.messages || {}).length,
      fixtureMode,
      fixtureCacheIgnored,
      sourceLabel: fixtureMode ? "fixture/test data" : null,
      warning: fixtureCacheIgnored
        ? "Fixture/test cache present but fixture mode is disabled; not serving as live Slack."
        : stale && status === "connected"
          ? "Slack cache is stale."
          : null,
    };
  }

  async function maybeRefreshIfStale(syncOptions = {}) {
    const status = await getSlackSignalSyncStatus();
    if (!status.configured) return status;
    if (status.syncInProgress) return status;
    if (!status.stale && status.lastSuccessfulSyncAt) return status;
    await syncSlackOperationalSignals(syncOptions);
    return getSlackSignalSyncStatus();
  }

  async function getSlackSignalsForShow(showContext = {}, options = {}) {
    const showKey = asString(showContext.showKey || showContext.id);
    const showName = asString(showContext.showName || showContext.name);
    const docs = (showContext.documentNumbers || showContext.relatedQuotes || []).map(
      String
    );

    if (options.refresh) {
      await syncSlackOperationalSignals({
        candidateShows: options.candidateShows || [showContext],
      });
    } else if (options.allowStaleRefresh !== false) {
      await maybeRefreshIfStale({
        candidateShows: options.candidateShows || [showContext],
      });
    }

    const status = await getSlackSignalSyncStatus();
    const envFixture = envFixtureModeEnabled();
    const allRaw = await store.listMessages({ includeDeleted: false });
    // Never serve fixture-tagged messages unless fixture mode is explicitly enabled.
    const all = envFixture
      ? allRaw
      : allRaw.filter((message) => !isFixtureTaggedMessage(message));
    const matched = all.filter((message) => {
      const matches = message.matches || [];
      return matches.some((match) => {
        if (!["auto_attached", "manually_approved"].includes(match.matchState)) {
          return false;
        }
        if (showKey && match.showKey === showKey) return true;
        const matchName = asString(match.showName).toLowerCase();
        const wantName = showName.toLowerCase();
        if (
          wantName &&
          matchName &&
          (matchName === wantName ||
            matchName.includes(wantName) ||
            wantName.includes(matchName))
        ) {
          return true;
        }
        if (
          docs.length &&
          (match.documentNumbers || []).some((doc) => docs.includes(String(doc)))
        ) {
          return true;
        }
        // Also attach when message entities include this show's quotes.
        if (
          docs.length &&
          (message.extractedEntities?.quotes || []).some((doc) =>
            docs.includes(String(doc))
          )
        ) {
          return true;
        }
        return false;
      });
    });

    const signals = matched
      .map((message) => {
        const match =
          (message.matches || []).find(
            (item) =>
              ["auto_attached", "manually_approved"].includes(item.matchState) &&
              ((showKey && item.showKey === showKey) ||
                (showName &&
                  asString(item.showName).toLowerCase() === showName.toLowerCase()))
          ) || pickPrimaryMatch(message.matches || []);
        return toPublicSignal(message, match);
      })
      .sort((a, b) => {
        const rank = statusRank(a.status) - statusRank(b.status);
        if (rank !== 0) return rank;
        return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
      });

    const counts = {
      unresolvedCount: signals.filter((s) => s.unresolved || ["at_risk", "blocked", "needs_review"].includes(s.status)).length,
      atRiskCount: signals.filter((s) => s.status === "at_risk").length,
      blockedCount: signals.filter((s) => s.status === "blocked").length,
      resolvedCount: signals.filter((s) => s.status === "resolved").length,
      needsReviewCount: (await store.getReviewQueue()).filter((item) => {
        if (showKey) return item.showKey === showKey;
        if (showName) return asString(item.showName).toLowerCase() === showName.toLowerCase();
        return true;
      }).length,
    };

    const categories = {};
    for (const signal of signals) {
      for (const cat of signal.categories || []) {
        categories[cat] = (categories[cat] || 0) + 1;
      }
    }

    return {
      sourceStatus: status.status,
      lastSyncAt: status.lastSuccessfulSyncAt || status.lastSyncAt,
      matchedSignals: signals,
      ...counts,
      highConfidenceCount: signals.filter((s) => s.confidence === "high").length,
      categories,
      signals: signals.slice(0, options.limit || 50),
      stale: Boolean(status.stale),
      fixtureMode: Boolean(status.fixtureMode),
      sourceLabel: status.sourceLabel || null,
      warning: status.warning || null,
      cache: status,
    };
  }

  async function getSlackNeedsReviewQueue() {
    return store.getReviewQueue();
  }

  async function getSlackGeneralOperationsQueue() {
    return store.getGeneralQueue();
  }

  async function approveSlackSignalMatch(signalId, showKey, showMeta = {}) {
    return store.approveMatch(signalId, showKey, showMeta);
  }

  async function rejectSlackSignalMatch(signalId, reason = null) {
    return store.rejectMatch(signalId, reason);
  }

  async function rematchAll(candidateShows = []) {
    const snap = await store.read();
    const updated = [];
    for (const message of Object.values(snap.messages || {})) {
      if (message.deleted) continue;
      if (message.manualDecision && message.contentHash) {
        // Keep manual decisions unless caller forces later.
        updated.push(message);
        continue;
      }
      const matches = matchSlackMessageToShows(message, candidateShows);
      updated.push({
        ...message,
        matches,
        matchState: pickPrimaryMatch(matches)?.matchState || "general_queue",
        updatedAt: new Date().toISOString(),
      });
    }
    await store.upsertMessages(updated);
    return { rematched: updated.length };
  }

  function startBackgroundSync(getCandidateShows) {
    const minutes = Number(process.env.SLACK_OPERATIONAL_SYNC_INTERVAL_MINUTES || 0);
    if (!minutes || minutes < 5) return null;
    if (intervalHandle) return intervalHandle;
    const ms = minutes * 60 * 1000;
    intervalHandle = setInterval(() => {
      syncSlackOperationalSignals({
        candidateShows: typeof getCandidateShows === "function" ? getCandidateShows() : [],
      }).catch((error) => {
        console.warn("[CUE SLACK SIGNALS] Background sync failed.", error?.message || error);
      });
    }, ms);
    if (typeof intervalHandle.unref === "function") intervalHandle.unref();
    return intervalHandle;
  }

  return {
    isConfigured,
    syncSlackOperationalSignals,
    getSlackSignalsForShow,
    getSlackNeedsReviewQueue,
    getSlackGeneralOperationsQueue,
    approveSlackSignalMatch,
    rejectSlackSignalMatch,
    getSlackSignalSyncStatus,
    rematchAll,
    maybeRefreshIfStale,
    startBackgroundSync,
    store,
    client,
    toPublicSignal,
  };
}

export const defaultSlackOperationalSignalsService =
  createSlackOperationalSignalsService();
