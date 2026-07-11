/**
 * ASK-FLEX-004 — Local JSON-backed full-show review snapshot store.
 * Isolated persistence so it can later be replaced by Supabase/Postgres.
 */

import fs from "fs";
import path from "path";
import {
  buildFullShowReviewSnapshot,
  compareFullShowSnapshots,
} from "./ask-flex-review-change-detection.mjs";

const DEFAULT_STORE_PATH = path.resolve(
  process.env.ASK_FLEX_SNAPSHOT_PATH || "./data/ask-flex-review-snapshots.json"
);
const MAX_PER_SHOW = 20;
const MAX_TOTAL = 500;

let writeChain = Promise.resolve();

function emptyStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    snapshots: [],
  };
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDir(filePath);
      const initial = emptyStore();
      fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) {
      return recoverCorruptStore(filePath, "empty");
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.snapshots)) {
      return recoverCorruptStore(filePath, "malformed");
    }
    return {
      version: Number(parsed.version) || 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      snapshots: parsed.snapshots.filter((item) => item && typeof item === "object"),
    };
  } catch (error) {
    console.warn(
      "[CUE ASK FLEX SNAPSHOTS] Failed to read snapshot store; recovering empty store.",
      error?.message || error
    );
    return recoverCorruptStore(filePath, "read_error");
  }
}

function recoverCorruptStore(filePath, reason) {
  try {
    ensureDir(filePath);
    if (fs.existsSync(filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, backup);
      console.warn(
        `[CUE ASK FLEX SNAPSHOTS] Backed up corrupt store (${reason}) to ${path.basename(backup)}`
      );
    }
  } catch (error) {
    console.warn(
      "[CUE ASK FLEX SNAPSHOTS] Could not back up corrupt store.",
      error?.message || error
    );
  }
  const initial = emptyStore();
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf8");
  } catch (error) {
    console.warn(
      "[CUE ASK FLEX SNAPSHOTS] Could not rewrite empty store.",
      error?.message || error
    );
  }
  return initial;
}

function atomicWriteStore(filePath, store) {
  ensureDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    ...store,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function applyRetention(snapshots) {
  const byShow = new Map();
  const sorted = [...snapshots].sort(
    (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  const kept = [];
  for (const snap of sorted) {
    const key = String(snap.showKey || "unknown");
    const count = byShow.get(key) || 0;
    if (count >= MAX_PER_SHOW) continue;
    byShow.set(key, count + 1);
    kept.push(snap);
    if (kept.length >= MAX_TOTAL) break;
  }
  return kept;
}

export function createReviewSnapshotStore(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_STORE_PATH);

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

    async listSnapshots({ showKey = null, limit = 20 } = {}) {
      try {
        const store = safeReadStore(filePath);
        let list = store.snapshots;
        if (showKey) {
          list = list.filter((item) => item.showKey === showKey);
        }
        list = [...list].sort((a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
        );
        return list.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
      } catch (error) {
        console.warn(
          "[CUE ASK FLEX SNAPSHOTS] listSnapshots failed.",
          error?.message || error
        );
        return [];
      }
    },

    async getLatestSnapshots(showKey, count = 2) {
      const list = await api.listSnapshots({ showKey, limit: Math.max(count, 2) * 3 });
      // Prefer distinct content hashes.
      const distinct = [];
      const seen = new Set();
      for (const snap of list) {
        const hash = snap.contentHash || snap.id;
        if (seen.has(hash)) continue;
        seen.add(hash);
        distinct.push(snap);
        if (distinct.length >= count) break;
      }
      return distinct;
    },

    async getLatest(showKey) {
      const [latest] = await api.getLatestSnapshots(showKey, 1);
      return latest || null;
    },

    async saveFromReview(result, options = {}) {
      return withWriteLock(async () => {
        try {
          const snapshot = buildFullShowReviewSnapshot(result, options);
          const store = safeReadStore(filePath);
          const priorDistinct = [...store.snapshots]
            .filter((item) => item.showKey === snapshot.showKey)
            .sort((a, b) =>
              String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
            );
          const latest = priorDistinct[0] || null;

          if (latest && latest.contentHash === snapshot.contentHash) {
            const comparison = compareFullShowSnapshots(latest, latest);
            return {
              saved: true,
              duplicate: true,
              snapshot: latest,
              previousSnapshotId: priorDistinct[1]?.id || null,
              changeCount: 0,
              hasChanges: false,
              comparison,
              warning: null,
            };
          }

          const previousForCompare =
            priorDistinct.find((item) => item.contentHash !== snapshot.contentHash) ||
            null;
          const comparison = previousForCompare
            ? compareFullShowSnapshots(previousForCompare, snapshot)
            : null;

          store.snapshots = applyRetention([snapshot, ...store.snapshots]);
          atomicWriteStore(filePath, store);

          return {
            saved: true,
            duplicate: false,
            snapshot,
            previousSnapshotId: previousForCompare?.id || null,
            changeCount: comparison?.changeCount || 0,
            hasChanges: Boolean(comparison?.hasChanges),
            comparison,
            warning: null,
          };
        } catch (error) {
          console.warn(
            "[CUE ASK FLEX SNAPSHOTS] saveFromReview failed.",
            error?.message || error
          );
          return {
            saved: false,
            duplicate: false,
            snapshot: null,
            previousSnapshotId: null,
            changeCount: 0,
            hasChanges: false,
            comparison: null,
            warning: "Snapshot persistence unavailable for this review.",
          };
        }
      });
    },

    async compareLatest(showKey) {
      try {
        const [current, previous] = await api.getLatestSnapshots(showKey, 2);
        if (!current) {
          return {
            hasChanges: false,
            changeCount: 0,
            summary: "No saved reviews exist for this show yet.",
            insufficientHistory: true,
            snapshotsFound: 0,
          };
        }
        if (!previous) {
          return {
            hasChanges: false,
            changeCount: 0,
            summary: `Only one distinct saved review exists for ${
              current.showName || showKey
            }. Run a fresh full review after source data changes to create a comparison.`,
            insufficientHistory: true,
            snapshotsFound: 1,
            currentId: current.id,
            currentReviewedAt: current.reviewedAt,
            showName: current.showName,
            showKey: current.showKey,
          };
        }
        return {
          ...compareFullShowSnapshots(previous, current),
          insufficientHistory: false,
          snapshotsFound: 2,
        };
      } catch (error) {
        console.warn(
          "[CUE ASK FLEX SNAPSHOTS] compareLatest failed.",
          error?.message || error
        );
        return {
          hasChanges: false,
          changeCount: 0,
          summary: "Snapshot comparison is temporarily unavailable.",
          insufficientHistory: true,
          snapshotsFound: 0,
          warning: "Snapshot comparison unavailable.",
        };
      }
    },

    async replaceAllForTests(snapshots) {
      return withWriteLock(async () => {
        const store = emptyStore();
        store.snapshots = applyRetention(snapshots || []);
        atomicWriteStore(filePath, store);
        return store;
      });
    },
  };

  return api;
}

export const defaultReviewSnapshotStore = createReviewSnapshotStore();
