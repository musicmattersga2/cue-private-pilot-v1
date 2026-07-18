/**
 * Local JSON store for Intelligence findings (observe-only pilot).
 * Pattern mirrors ask-flex-review-snapshot-store: atomic write, corrupt recovery.
 */

import fs from "fs";
import path from "path";
import { validateFinding } from "./cue-intelligence-finding-contract.mjs";

const DEFAULT_STORE_PATH = path.resolve(
  process.env.CUE_INTELLIGENCE_FINDINGS_PATH ||
    "./data/cue-intelligence-findings.json"
);

let writeChain = Promise.resolve();

function emptyStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    findings: [],
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function recoverCorruptStore(filePath, reason) {
  try {
    ensureDir(filePath);
    if (fs.existsSync(filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${filePath}.corrupt-${stamp}`;
      fs.renameSync(filePath, backup);
      console.warn(
        `[CUE INTELLIGENCE FINDINGS] Backed up corrupt store (${reason}) to ${path.basename(backup)}`
      );
    }
  } catch (error) {
    console.warn(
      "[CUE INTELLIGENCE FINDINGS] Could not back up corrupt store.",
      error?.message || error
    );
  }
  const initial = emptyStore();
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf8");
  } catch (error) {
    console.warn(
      "[CUE INTELLIGENCE FINDINGS] Could not rewrite empty store.",
      error?.message || error
    );
  }
  return initial;
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
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.findings)) {
      return recoverCorruptStore(filePath, "malformed");
    }
    return {
      version: Number(parsed.version) || 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      findings: parsed.findings.filter((item) => item && typeof item === "object"),
    };
  } catch (error) {
    console.warn(
      "[CUE INTELLIGENCE FINDINGS] Failed to read findings store; recovering.",
      error?.message || error
    );
    return recoverCorruptStore(filePath, "read_error");
  }
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

export function createIntelligenceFindingsStore(options = {}) {
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

    async listFindings({
      showId = null,
      status = null,
      ruleId = null,
      limit = 200,
    } = {}) {
      try {
        const store = safeReadStore(filePath);
        let list = store.findings;
        if (showId) {
          list = list.filter((item) => item.show_id === String(showId));
        }
        if (status) {
          const statuses = String(status)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          list = list.filter((item) => statuses.includes(item.status));
        }
        if (ruleId) {
          list = list.filter((item) => item.rule_id === String(ruleId));
        }
        list = [...list].sort((a, b) =>
          String(b.last_evaluated_at || "").localeCompare(
            String(a.last_evaluated_at || "")
          )
        );
        return list.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)));
      } catch (error) {
        console.warn(
          "[CUE INTELLIGENCE FINDINGS] listFindings failed.",
          error?.message || error
        );
        return [];
      }
    },

    async getFinding(findingId) {
      const store = safeReadStore(filePath);
      return (
        store.findings.find((item) => item.finding_id === String(findingId)) ||
        null
      );
    },

    async replaceShowFindings(showId, findings) {
      return withWriteLock(async () => {
        const store = safeReadStore(filePath);
        const sid = String(showId);
        const validated = [];
        for (const finding of findings || []) {
          const result = validateFinding(finding);
          if (!result.ok) {
            throw new Error(
              `Cannot persist invalid finding: ${result.error}`
            );
          }
          if (result.finding.show_id !== sid) {
            throw new Error("Finding show_id does not match replace target.");
          }
          validated.push(result.finding);
        }
        const retained = store.findings.filter((item) => item.show_id !== sid);
        const next = {
          version: store.version || 1,
          findings: [...retained, ...validated],
        };
        atomicWriteStore(filePath, next);
        return validated;
      });
    },

    async upsertFindings(findings) {
      return withWriteLock(async () => {
        const store = safeReadStore(filePath);
        const byId = new Map(
          store.findings.map((item) => [item.finding_id, item])
        );
        for (const finding of findings || []) {
          const result = validateFinding(finding);
          if (!result.ok) {
            throw new Error(
              `Cannot persist invalid finding: ${result.error}`
            );
          }
          byId.set(result.finding.finding_id, result.finding);
        }
        const next = {
          version: store.version || 1,
          findings: [...byId.values()],
        };
        atomicWriteStore(filePath, next);
        return findings;
      });
    },

    async updateFindingLifecycle(findingId, patch = {}) {
      return withWriteLock(async () => {
        const store = safeReadStore(filePath);
        const index = store.findings.findIndex(
          (item) => item.finding_id === String(findingId)
        );
        if (index < 0) {
          return { ok: false, error: "Finding not found." };
        }
        const current = store.findings[index];
        const nextFinding = {
          ...current,
          ...patch,
          finding_id: current.finding_id,
          rule_id: current.rule_id,
          show_id: current.show_id,
          dedupe_key: current.dedupe_key,
          mode: "observe_only",
          proposed_update: null,
          last_evaluated_at:
            patch.last_evaluated_at || new Date().toISOString(),
        };
        const result = validateFinding(nextFinding);
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        store.findings[index] = result.finding;
        atomicWriteStore(filePath, store);
        return { ok: true, finding: result.finding };
      });
    },

    async acknowledge(findingId, { actorId = null, note = null } = {}) {
      return api.updateFindingLifecycle(findingId, {
        status: "acknowledged",
        resolution_reason: note || null,
        acknowledged_by: actorId || null,
        acknowledged_at: new Date().toISOString(),
      });
    },

    async snooze(
      findingId,
      { until, reason = null, actorId = null } = {}
    ) {
      if (!until) {
        return { ok: false, error: "snooze until is required." };
      }
      return api.updateFindingLifecycle(findingId, {
        status: "snoozed",
        snooze_until: new Date(until).toISOString(),
        snooze_reason: reason || null,
        snoozed_by: actorId || null,
      });
    },

    async dismiss(findingId, { reason = null, actorId = null } = {}) {
      return api.updateFindingLifecycle(findingId, {
        status: "dismissed",
        resolution_reason: reason || "dismissed_by_operator",
        resolved_at: new Date().toISOString(),
        dismissed_by: actorId || null,
      });
    },

    async reopen(findingId, { reason = null } = {}) {
      return api.updateFindingLifecycle(findingId, {
        status: "open",
        resolution_reason: reason || null,
        resolved_at: null,
        snooze_until: null,
        snooze_reason: null,
      });
    },
  };

  return api;
}

export const defaultIntelligenceFindingsStore =
  createIntelligenceFindingsStore();
