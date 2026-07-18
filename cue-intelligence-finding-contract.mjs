/**
 * Standard Intelligence finding contract — normalize, validate, IDs, fingerprints.
 * Findings never mutate show truth.
 */

import crypto from "crypto";

export const SEVERITIES = Object.freeze([
  "info",
  "watch",
  "needs_attention",
  "critical",
]);
export const CONFIDENCE_LABELS = Object.freeze(["low", "medium", "high"]);
export const LIFECYCLE_STATUSES = Object.freeze([
  "open",
  "acknowledged",
  "snoozed",
  "resolved",
  "dismissed",
  "superseded",
]);
export const FINDING_MODE = "observe_only";

const CONFIDENCE_SCORE = Object.freeze({
  high: 0.9,
  medium: 0.72,
  low: 0.45,
});

export function confidenceFromLabel(label, score = null) {
  const normalized = String(label || "").toLowerCase();
  if (!CONFIDENCE_LABELS.includes(normalized)) {
    throw new Error(`Invalid confidence label: ${label}`);
  }
  const numeric =
    score == null || !Number.isFinite(Number(score))
      ? CONFIDENCE_SCORE[normalized]
      : Number(score);
  return { label: normalized, score: numeric };
}

export function buildDedupeKey(template, vars = {}) {
  return String(template || "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
      vars[key] == null || vars[key] === "" ? "unknown" : String(vars[key])
    )
    .replace(/\s+/g, "_");
}

export function buildIssueFingerprint(parts = {}) {
  const payload = {
    rule_id: parts.rule_id || null,
    show_id: parts.show_id || null,
    dedupe_key: parts.dedupe_key || null,
    evidence_digest: digestEvidence(parts.evidence_refs || []),
    core_values: parts.core_values || null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24);
}

export function buildFindingId(dedupeKey, firstDetectedAt) {
  const stamp = String(firstDetectedAt || new Date().toISOString());
  return crypto
    .createHash("sha256")
    .update(`${dedupeKey}|${stamp}`)
    .digest("hex")
    .slice(0, 20);
}

function digestEvidence(refs) {
  const normalized = (Array.isArray(refs) ? refs : [])
    .map((ref) => ({
      source_type: ref?.source_type || null,
      source_id: ref?.source_id || null,
      field_path: ref?.field_path || null,
      value: ref?.normalized_value ?? ref?.display_value ?? null,
    }))
    .sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b), "en")
    );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

export function normalizeEvidenceRef(ref = {}) {
  return {
    source_type: ref.source_type ? String(ref.source_type) : null,
    source_id: ref.source_id != null ? String(ref.source_id) : null,
    field_path: ref.field_path ? String(ref.field_path) : null,
    display_value:
      ref.display_value != null ? String(ref.display_value) : null,
    normalized_value:
      ref.normalized_value !== undefined ? ref.normalized_value : null,
    source_timestamp: ref.source_timestamp || null,
    note: ref.note ? String(ref.note) : null,
  };
}

export function createFindingDraft(input = {}) {
  const now = new Date().toISOString();
  const confidence = confidenceFromLabel(
    input.confidence?.label || input.confidence_label || "medium",
    input.confidence?.score
  );
  const severity = String(input.severity || "watch").toLowerCase();
  const status = String(input.status || "open").toLowerCase();
  const evidence_refs = (input.evidence_refs || []).map(normalizeEvidenceRef);
  const missing_inputs = Array.isArray(input.missing_inputs)
    ? input.missing_inputs.map(String)
    : [];
  const dedupe_key = String(input.dedupe_key || "").trim();
  if (!dedupe_key) throw new Error("dedupe_key is required");

  const first_detected_at = input.first_detected_at || now;
  const finding_id =
    input.finding_id || buildFindingId(dedupe_key, first_detected_at);
  const issue_fingerprint =
    input.issue_fingerprint ||
    buildIssueFingerprint({
      rule_id: input.rule_id,
      show_id: input.show_id,
      dedupe_key,
      evidence_refs,
      core_values: input.core_values || null,
    });

  return {
    finding_id,
    rule_id: String(input.rule_id || ""),
    rule_version: Number(input.rule_version) || 1,
    show_id: String(input.show_id || ""),
    domain: String(input.domain || ""),
    title: String(input.title || ""),
    summary: String(input.summary || ""),
    severity,
    confidence,
    status,
    mode: FINDING_MODE,
    evidence_refs,
    missing_inputs,
    recommended_action: input.recommended_action
      ? String(input.recommended_action)
      : null,
    proposed_update: null,
    owner_role: String(input.owner_role || ""),
    first_detected_at,
    last_evaluated_at: input.last_evaluated_at || now,
    due_at: input.due_at || null,
    dedupe_key,
    issue_fingerprint,
    resolution_reason: input.resolution_reason || null,
    resolved_at: input.resolved_at || null,
    snooze_until: input.snooze_until || null,
    snooze_reason: input.snooze_reason || null,
    actionable: input.actionable !== false && severity !== "info",
  };
}

export function validateFinding(finding) {
  if (!finding || typeof finding !== "object") {
    return { ok: false, error: "Finding must be an object." };
  }
  const required = [
    "finding_id",
    "rule_id",
    "rule_version",
    "show_id",
    "domain",
    "title",
    "summary",
    "severity",
    "confidence",
    "status",
    "mode",
    "dedupe_key",
    "issue_fingerprint",
    "first_detected_at",
    "last_evaluated_at",
    "owner_role",
  ];
  for (const key of required) {
    if (finding[key] == null || finding[key] === "") {
      return { ok: false, error: `Missing required field: ${key}` };
    }
  }
  if (!SEVERITIES.includes(finding.severity)) {
    return { ok: false, error: `Invalid severity: ${finding.severity}` };
  }
  if (!LIFECYCLE_STATUSES.includes(finding.status)) {
    return { ok: false, error: `Invalid status: ${finding.status}` };
  }
  if (finding.mode !== FINDING_MODE) {
    return { ok: false, error: `Pilot must be ${FINDING_MODE}` };
  }
  if (!CONFIDENCE_LABELS.includes(finding.confidence?.label)) {
    return { ok: false, error: "Invalid confidence.label" };
  }
  if (!Array.isArray(finding.evidence_refs)) {
    return { ok: false, error: "evidence_refs must be an array" };
  }
  if (!Array.isArray(finding.missing_inputs)) {
    return { ok: false, error: "missing_inputs must be an array" };
  }
  if (
    finding.actionable !== false &&
    finding.status === "open" &&
    finding.severity !== "info" &&
    finding.evidence_refs.length === 0 &&
    finding.missing_inputs.length === 0
  ) {
    return {
      ok: false,
      error: "Actionable findings require evidence_refs or missing_inputs.",
    };
  }
  if (
    finding.actionable !== false &&
    ["needs_attention", "critical", "watch"].includes(finding.severity) &&
    !finding.recommended_action
  ) {
    return {
      ok: false,
      error: "Actionable findings require recommended_action.",
    };
  }
  if (finding.proposed_update != null) {
    return {
      ok: false,
      error: "Pilot findings must keep proposed_update null (observe_only).",
    };
  }
  return { ok: true, finding };
}

export function isActionableFinding(finding) {
  if (!finding) return false;
  if (finding.actionable === false) return false;
  if (finding.severity === "info") return false;
  if (["resolved", "dismissed", "superseded"].includes(finding.status)) {
    return false;
  }
  return true;
}
