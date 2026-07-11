/**
 * Slack Operational Signals — local JSON-backed cache/store.
 */

import fs from "fs";
import path from "path";

const DEFAULT_PATH = path.resolve(
  process.env.SLACK_OPERATIONAL_CACHE_PATH || "./data/slack-operational-signals.json"
);
const MAX_MESSAGES = Number(process.env.SLACK_OPERATIONAL_MAX_CACHE_MESSAGES || 5000);

let writeChain = Promise.resolve();

function emptyStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    channels: {},
    users: {},
    messages: {},
    reviewQueue: [],
    generalQueue: [],
    sync: {
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncInProgress: false,
      lastError: null,
      lastTelemetry: null,
    },
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function recoverCorrupt(filePath, reason) {
  try {
    ensureDir(filePath);
    if (fs.existsSync(filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, backup);
      console.warn(
        `[CUE SLACK SIGNALS] Backed up corrupt store (${reason}) to ${path.basename(backup)}`
      );
    }
  } catch (error) {
    console.warn("[CUE SLACK SIGNALS] Corrupt backup failed.", error?.message || error);
  }
  const initial = emptyStore();
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf8");
  } catch (error) {
    console.warn("[CUE SLACK SIGNALS] Could not rewrite empty store.", error?.message || error);
  }
  return initial;
}

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDir(filePath);
      const initial = emptyStore();
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) return recoverCorrupt(filePath, "empty");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.messages !== "object") {
      return recoverCorrupt(filePath, "malformed");
    }
    return {
      ...emptyStore(),
      ...parsed,
      channels: parsed.channels || {},
      users: parsed.users || {},
      messages: parsed.messages || {},
      reviewQueue: Array.isArray(parsed.reviewQueue) ? parsed.reviewQueue : [],
      generalQueue: Array.isArray(parsed.generalQueue) ? parsed.generalQueue : [],
      sync: { ...emptyStore().sync, ...(parsed.sync || {}) },
    };
  } catch (error) {
    console.warn("[CUE SLACK SIGNALS] Read failed; recovering.", error?.message || error);
    return recoverCorrupt(filePath, "read_error");
  }
}

function atomicWrite(filePath, store) {
  ensureDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = { ...store, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function applyRetention(messages) {
  const entries = Object.values(messages || {});
  if (entries.length <= MAX_MESSAGES) return messages;
  const sorted = entries.sort((a, b) =>
    String(b.ts || "").localeCompare(String(a.ts || ""))
  );
  const kept = sorted.slice(0, MAX_MESSAGES);
  const out = {};
  for (const item of kept) out[item.messageKey] = item;
  return out;
}

function rebuildQueues(store) {
  const review = [];
  const general = [];
  for (const message of Object.values(store.messages || {})) {
    if (message.deleted) continue;
    const primary = (message.matches || [])[0];
    const state = primary?.matchState || message.matchState || null;
    if (state === "needs_review") {
      review.push({
        signalId: message.messageKey,
        showKey: primary?.showKey || null,
        showName: primary?.showName || null,
        confidence: primary?.confidenceBand || primary?.confidence || null,
        summary: message.operationalClassification?.summary || message.text,
        updatedAt: message.updatedAt,
      });
    } else if (state === "general_queue" || !primary) {
      if (!primary || primary.confidenceBand === "low" || primary.confidence === "low") {
        general.push({
          signalId: message.messageKey,
          summary: message.operationalClassification?.summary || message.text,
          categories: message.operationalClassification?.categories || [],
          updatedAt: message.updatedAt,
        });
      }
    }
  }
  store.reviewQueue = review
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 500);
  store.generalQueue = general
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 500);
  return store;
}

export function createSlackOperationalSignalsStore(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_PATH);

  const withWriteLock = async (fn) => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const api = {
    filePath,

    async read() {
      try {
        return safeRead(filePath);
      } catch (error) {
        console.warn("[CUE SLACK SIGNALS] read() failed.", error?.message || error);
        return emptyStore();
      }
    },

    async getChannelCursor(channelId) {
      const store = await api.read();
      return store.channels?.[channelId]?.latestTs || null;
    },

    async upsertMessages(messages, { channelMeta = null, advanceCursorTs = null } = {}) {
      return withWriteLock(async () => {
        try {
          const store = safeRead(filePath);
          let inserted = 0;
          let updated = 0;
          let duplicatesSkipped = 0;

          for (const message of messages || []) {
            if (!message?.messageKey) continue;
            const existing = store.messages[message.messageKey];
            if (
              existing &&
              existing.contentHash === message.contentHash &&
              existing.editedTs === message.editedTs
            ) {
              duplicatesSkipped += 1;
              // Still refresh matches/state if provided.
              if (message.matches) {
                existing.matches = message.matches;
                existing.matchState = message.matchState || existing.matchState;
              }
              continue;
            }
            if (existing) {
              store.messages[message.messageKey] = {
                ...existing,
                ...message,
                ingestedAt: existing.ingestedAt || message.ingestedAt,
              };
              updated += 1;
            } else {
              store.messages[message.messageKey] = message;
              inserted += 1;
            }
          }

          if (channelMeta?.channelId) {
            const prev = store.channels[channelMeta.channelId] || {};
            store.channels[channelMeta.channelId] = {
              ...prev,
              channelName: channelMeta.channelName || prev.channelName || channelMeta.channelId,
              lastSuccessfulSyncAt: new Date().toISOString(),
              lastError: null,
              latestTs:
                advanceCursorTs ||
                prev.latestTs ||
                null,
            };
          }

          store.messages = applyRetention(store.messages);
          rebuildQueues(store);
          atomicWrite(filePath, store);
          return { inserted, updated, duplicatesSkipped, store };
        } catch (error) {
          console.warn("[CUE SLACK SIGNALS] upsertMessages failed.", error?.message || error);
          return {
            inserted: 0,
            updated: 0,
            duplicatesSkipped: 0,
            warning: "Slack cache write unavailable.",
          };
        }
      });
    },

    async setChannelError(channelId, errorMessage) {
      return withWriteLock(async () => {
        const store = safeRead(filePath);
        store.channels[channelId] = {
          ...(store.channels[channelId] || {}),
          lastError: String(errorMessage || "error"),
        };
        atomicWrite(filePath, store);
        return store;
      });
    },

    async setSyncState(patch = {}) {
      return withWriteLock(async () => {
        const store = safeRead(filePath);
        store.sync = { ...store.sync, ...patch };
        atomicWrite(filePath, store);
        return store.sync;
      });
    },

    async upsertUser(userId, profile) {
      return withWriteLock(async () => {
        const store = safeRead(filePath);
        store.users[userId] = {
          displayName: profile?.displayName || null,
          realName: profile?.realName || null,
          updatedAt: new Date().toISOString(),
        };
        atomicWrite(filePath, store);
        return store.users[userId];
      });
    },

    async getMessage(messageKey) {
      const store = await api.read();
      return store.messages?.[messageKey] || null;
    },

    async listMessages({ showKey = null, includeDeleted = false } = {}) {
      const store = await api.read();
      let list = Object.values(store.messages || {});
      if (!includeDeleted) list = list.filter((m) => !m.deleted);
      if (showKey) {
        list = list.filter((m) =>
          (m.matches || []).some(
            (match) =>
              match.showKey === showKey &&
              ["auto_attached", "manually_approved"].includes(match.matchState)
          )
        );
      }
      return list.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    },

    async getReviewQueue() {
      const store = await api.read();
      return store.reviewQueue || [];
    },

    async getGeneralQueue() {
      const store = await api.read();
      return store.generalQueue || [];
    },

    async approveMatch(signalId, showKey, showMeta = {}) {
      return withWriteLock(async () => {
        const store = safeRead(filePath);
        const message = store.messages[signalId];
        if (!message) return { ok: false, error: "Signal not found." };
        const match = {
          showKey,
          showName: showMeta.showName || showKey,
          documentNumbers: showMeta.documentNumbers || [],
          confidence: "high",
          confidenceBand: "high",
          score: 999,
          reasons: ["Manually approved"],
          evidence: { manual: true },
          matchedEntities: {},
          matchState: "manually_approved",
        };
        message.matches = [
          match,
          ...(message.matches || []).filter((item) => item.showKey !== showKey),
        ];
        message.matchState = "manually_approved";
        message.manualDecision = {
          action: "approve",
          showKey,
          at: new Date().toISOString(),
        };
        rebuildQueues(store);
        atomicWrite(filePath, store);
        return { ok: true, message };
      });
    },

    async rejectMatch(signalId, reason = null) {
      return withWriteLock(async () => {
        const store = safeRead(filePath);
        const message = store.messages[signalId];
        if (!message) return { ok: false, error: "Signal not found." };
        message.matches = (message.matches || []).map((item) => ({
          ...item,
          matchState: "manually_rejected",
        }));
        message.matchState = "manually_rejected";
        message.manualDecision = {
          action: "reject",
          reason: reason || null,
          at: new Date().toISOString(),
        };
        rebuildQueues(store);
        atomicWrite(filePath, store);
        return { ok: true, message };
      });
    },

    async replaceAllForTests(nextStore) {
      return withWriteLock(async () => {
        const store = { ...emptyStore(), ...(nextStore || {}) };
        store.messages = applyRetention(store.messages || {});
        rebuildQueues(store);
        atomicWrite(filePath, store);
        return store;
      });
    },
  };

  return api;
}

export const defaultSlackSignalsStore = createSlackOperationalSignalsStore();
