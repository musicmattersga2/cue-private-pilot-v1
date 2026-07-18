/**
 * Observe-only Intelligence Rules engine.
 * Evaluates a normalized show snapshot, reconciles findings, never mutates sources.
 */

import {
  loadIntelligenceRulesCatalog,
  listPilotRules,
} from "./cue-intelligence-rules-catalog.mjs";
import {
  validateFinding,
  buildIssueFingerprint,
  isActionableFinding,
} from "./cue-intelligence-finding-contract.mjs";
import { assertSnapshotShape } from "./cue-intelligence-show-snapshot.mjs";
import { EVALUATORS } from "./cue-intelligence-rule-evaluators.mjs";

const PILOT_RULE_IDS = ["INT-002", "LAB-001", "TRK-001", "WH-001", "SCH-003"];

function nowIso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

function isSnoozeActive(finding, at) {
  if (finding?.status !== "snoozed") return false;
  if (!finding.snooze_until) return true;
  return new Date(finding.snooze_until).getTime() > at.getTime();
}

function cloneFinding(finding) {
  return JSON.parse(JSON.stringify(finding));
}

/**
 * Reconcile newly evaluated findings against existing persisted findings.
 */
export function reconcileFindings(existing = [], evaluated = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const atIso = nowIso(now);
  const existingByDedupe = new Map();
  for (const finding of existing) {
    if (!finding?.dedupe_key) continue;
    existingByDedupe.set(finding.dedupe_key, cloneFinding(finding));
  }

  const next = [];
  const seen = new Set();
  const stats = {
    opened: 0,
    updated: 0,
    unchanged: 0,
    resolved: 0,
    left_snoozed: 0,
    left_dismissed: 0,
    reopened: 0,
  };

  for (const draft of evaluated) {
    const validation = validateFinding(draft);
    if (!validation.ok) {
      throw new Error(`Invalid evaluated finding: ${validation.error}`);
    }
    const finding = validation.finding;
    seen.add(finding.dedupe_key);
    const prior = existingByDedupe.get(finding.dedupe_key);

    if (!prior) {
      next.push({ ...finding, status: "open", first_detected_at: finding.first_detected_at || atIso });
      stats.opened += 1;
      continue;
    }

    if (prior.status === "dismissed") {
      // Same operational issue stays dismissed until a materially different fingerprint.
      if (prior.issue_fingerprint === finding.issue_fingerprint) {
        next.push({
          ...prior,
          last_evaluated_at: atIso,
        });
        stats.left_dismissed += 1;
        continue;
      }
    }

    if (isSnoozeActive(prior, now)) {
      next.push({
        ...prior,
        last_evaluated_at: atIso,
        severity: finding.severity,
        confidence: finding.confidence,
        evidence_refs: finding.evidence_refs,
        missing_inputs: finding.missing_inputs,
        summary: finding.summary,
        title: finding.title,
        recommended_action: finding.recommended_action,
        due_at: finding.due_at,
        issue_fingerprint: finding.issue_fingerprint,
        rule_version: finding.rule_version,
      });
      stats.left_snoozed += 1;
      continue;
    }

    const preservedStatus =
      prior.status === "acknowledged" || prior.status === "snoozed"
        ? prior.status === "snoozed"
          ? "open"
          : "acknowledged"
        : prior.status === "resolved" || prior.status === "superseded"
          ? "open"
          : prior.status === "dismissed"
            ? "open"
            : "open";

    if (
      prior.status === "resolved" ||
      prior.status === "superseded" ||
      (prior.status === "snoozed" && !isSnoozeActive(prior, now)) ||
      (prior.status === "dismissed" &&
        prior.issue_fingerprint !== finding.issue_fingerprint)
    ) {
      stats.reopened += 1;
    }

    const merged = {
      ...finding,
      finding_id: prior.finding_id,
      first_detected_at: prior.first_detected_at,
      status: preservedStatus === "acknowledged" ? "acknowledged" : "open",
      last_evaluated_at: atIso,
      resolution_reason: null,
      resolved_at: null,
      snooze_until:
        preservedStatus === "acknowledged" ? prior.snooze_until : null,
      snooze_reason:
        preservedStatus === "acknowledged" ? prior.snooze_reason : null,
    };

    const changed =
      prior.severity !== merged.severity ||
      prior.confidence?.label !== merged.confidence?.label ||
      prior.issue_fingerprint !== merged.issue_fingerprint ||
      prior.summary !== merged.summary ||
      prior.status !== merged.status;

    next.push(merged);
    if (changed) stats.updated += 1;
    else stats.unchanged += 1;
  }

  for (const prior of existing) {
    if (!prior?.dedupe_key || seen.has(prior.dedupe_key)) continue;

    if (prior.status === "dismissed") {
      next.push({ ...prior, last_evaluated_at: atIso });
      stats.left_dismissed += 1;
      continue;
    }
    if (isSnoozeActive(prior, now)) {
      next.push({ ...prior, last_evaluated_at: atIso });
      stats.left_snoozed += 1;
      continue;
    }
    if (["resolved", "superseded"].includes(prior.status)) {
      next.push({ ...prior, last_evaluated_at: atIso });
      continue;
    }

    next.push({
      ...prior,
      status: "resolved",
      resolution_reason: "condition_cleared",
      resolved_at: atIso,
      last_evaluated_at: atIso,
    });
    stats.resolved += 1;
  }

  return { findings: next, stats };
}

/**
 * Evaluate pilot rules against one Intelligence show snapshot.
 */
export function evaluateIntelligenceRules(showSnapshot, options = {}) {
  const shape = assertSnapshotShape(showSnapshot);
  if (!shape.ok) {
    return {
      ok: false,
      error: shape.error,
      findings: [],
      evaluated: [],
      telemetry: [],
      missing_inputs: [],
      stats: {},
    };
  }

  const catalog =
    options.catalog ||
    loadIntelligenceRulesCatalog(
      options.catalogPath ? { filePath: options.catalogPath } : {}
    );
  const ruleIds = Array.isArray(options.ruleIds) && options.ruleIds.length
    ? options.ruleIds
    : PILOT_RULE_IDS;
  const rules = listPilotRules(catalog).filter((rule) =>
    ruleIds.includes(rule.rule_id)
  );
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const evaluated = [];
  const telemetry = [];
  const missing_inputs = [
    ...(showSnapshot.adapter_telemetry?.missing_inputs || []),
  ];

  for (const rule of rules) {
    const evaluator = EVALUATORS[rule.rule_id];
    if (!evaluator) {
      telemetry.push({
        rule_id: rule.rule_id,
        reason: "evaluator_missing",
      });
      continue;
    }
    const result = evaluator(showSnapshot, rule, { ...options, now });
    for (const finding of result.findings || []) {
      // Ensure fingerprint is current after draft construction.
      finding.issue_fingerprint = buildIssueFingerprint({
        rule_id: finding.rule_id,
        show_id: finding.show_id,
        dedupe_key: finding.dedupe_key,
        evidence_refs: finding.evidence_refs,
        core_values: finding.core_values || null,
      });
      const validation = validateFinding(finding);
      if (!validation.ok) {
        telemetry.push({
          rule_id: rule.rule_id,
          reason: "invalid_finding",
          error: validation.error,
        });
        continue;
      }
      evaluated.push(validation.finding);
    }
    telemetry.push(...(result.telemetry || []));
    missing_inputs.push(...(result.missing_inputs || []));
  }

  const existing = Array.isArray(options.existingFindings)
    ? options.existingFindings.filter(
        (f) => f && f.show_id === showSnapshot.show.show_id
      )
    : [];
  const reconciled = reconcileFindings(existing, evaluated, { now });

  return {
    ok: true,
    show_id: showSnapshot.show.show_id,
    snapshot_id: showSnapshot.snapshot_id,
    evaluated_at: nowIso(now),
    mode: "observe_only",
    findings: reconciled.findings,
    evaluated,
    actionable: reconciled.findings.filter(isActionableFinding),
    telemetry,
    missing_inputs: [...new Set(missing_inputs)],
    stats: reconciled.stats,
    catalog_version: catalog.catalog_version,
  };
}

export { PILOT_RULE_IDS };
