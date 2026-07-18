/**
 * Deterministic evaluators for the five Intelligence pilot rules.
 * Pure observation — no source mutation, no OpenAI by default.
 */

import {
  buildDedupeKey,
  createFindingDraft,
  confidenceFromLabel,
} from "./cue-intelligence-finding-contract.mjs";
import {
  daysUntil,
  hoursUntil,
  isMaterialFactField,
  normalizeComparableValue,
  normalizeIsoTimestamp,
} from "./cue-intelligence-show-snapshot.mjs";

function baseFinding(rule, showId, overrides) {
  return createFindingDraft({
    rule_id: rule.rule_id,
    rule_version: rule.version,
    show_id: showId,
    domain: rule.domain,
    owner_role: rule.owner_role,
    mode: "observe_only",
    proposed_update: null,
    ...overrides,
  });
}

function activeFacts(snapshot) {
  return (snapshot.active_fact_candidates || []).filter(
    (fact) => fact && fact.active !== false && fact.superseded !== true
  );
}

function reliabilityRank(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "high" || raw === "structured") return 3;
  if (raw === "medium") return 2;
  return 1;
}

function isReliable(fact) {
  return reliabilityRank(fact.source_reliability) >= 2;
}

/**
 * INT-002 — Conflicting current facts (deterministic v1).
 */
export function evaluateInt002(snapshot, rule, options = {}) {
  const findings = [];
  const telemetry = [];
  const showId = snapshot.show.show_id;
  const now = options.now || new Date();
  const byField = new Map();

  for (const fact of activeFacts(snapshot)) {
    if (!isMaterialFactField(fact.field_path)) continue;
    if (!byField.has(fact.field_path)) byField.set(fact.field_path, []);
    byField.get(fact.field_path).push(fact);
  }

  for (const [fieldPath, facts] of byField.entries()) {
    const reliable = facts.filter(isReliable);
    if (reliable.length < 2) {
      telemetry.push({
        rule_id: "INT-002",
        field_path: fieldPath,
        reason: "insufficient_reliable_candidates",
      });
      continue;
    }

    const groups = new Map();
    for (const fact of reliable) {
      const key = normalizeComparableValue(fact.normalized_value);
      if (key == null || key === "") continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fact);
    }

    if (groups.size < 2) {
      telemetry.push({
        rule_id: "INT-002",
        field_path: fieldPath,
        reason: "values_equivalent_after_normalization",
      });
      continue;
    }

    const groupList = [...groups.values()];
    const left = groupList[0][0];
    const right = groupList[1][0];
    const bothStructured =
      reliabilityRank(left.source_reliability) >= 3 &&
      reliabilityRank(right.source_reliability) >= 3;
    const confidenceLabel = bothStructured ? "high" : "medium";
    if (confidenceLabel === "low") {
      telemetry.push({
        rule_id: "INT-002",
        field_path: fieldPath,
        reason: "confidence_too_low",
      });
      continue;
    }

    const dedupe_key = buildDedupeKey(rule.dedupe_key_template, {
      show_id: showId,
      field_path: fieldPath,
    });

    findings.push(
      baseFinding(rule, showId, {
        title: "Conflicting current facts",
        summary: `Active sources disagree on ${fieldPath}: "${left.display_value}" vs "${right.display_value}".`,
        severity: rule.default_severity || "needs_attention",
        confidence: confidenceFromLabel(confidenceLabel),
        evidence_refs: [
          {
            source_type: left.source_type,
            source_id: left.source_id,
            field_path: fieldPath,
            display_value: left.display_value,
            normalized_value: left.normalized_value,
            source_timestamp: left.source_timestamp,
          },
          {
            source_type: right.source_type,
            source_id: right.source_id,
            field_path: fieldPath,
            display_value: right.display_value,
            normalized_value: right.normalized_value,
            source_timestamp: right.source_timestamp,
          },
        ],
        missing_inputs: [],
        recommended_action:
          "Review both values and accept the current operational fact.",
        dedupe_key,
        core_values: {
          field_path: fieldPath,
          values: [left.normalized_value, right.normalized_value],
        },
        last_evaluated_at: now.toISOString(),
      })
    );
  }

  return { findings, telemetry, missing_inputs: [] };
}

/**
 * LAB-001 — Required position unfilled.
 */
export function evaluateLab001(snapshot, rule, options = {}) {
  const findings = [];
  const telemetry = [];
  const missing_inputs = [];
  const showId = snapshot.show.show_id;
  const now = options.now || new Date();
  const staffing = snapshot.staffing || {};
  const cfg = {
    watchDays: options.labWatchDays ?? 7,
    criticalHours: options.labCriticalHours ?? 24,
    ...options.labConfig,
  };

  if (staffing.source_status === "unavailable") {
    missing_inputs.push("staffing.positions");
    telemetry.push({
      rule_id: "LAB-001",
      reason: "staffing_source_unavailable",
    });
    return { findings, telemetry, missing_inputs };
  }

  const status = String(snapshot.show.status || "").toLowerCase();
  const showActive =
    !status ||
    /active|published|confirmed|booked|green|magenta|ready|review|open/.test(
      status
    );
  if (!showActive || /cancel|past|closed|complete/.test(status)) {
    return { findings, telemetry, missing_inputs };
  }

  const loadIn = snapshot.show.load_in_at;
  const days = daysUntil(loadIn, now);
  const hours = hoursUntil(loadIn, now);
  if (days == null) {
    missing_inputs.push("show.load_in_at");
    telemetry.push({
      rule_id: "LAB-001",
      reason: "load_in_unavailable_no_proximity",
    });
    if (!options.emitDataGapObservations) {
      return { findings, telemetry, missing_inputs };
    }
  }

  for (const position of staffing.positions || []) {
    if (!position?.required) continue;
    const pStatus = String(position.status || "").toLowerCase();
    if (/removed|canceled|cancelled/.test(pStatus)) continue;
    if (/confirmed|filled|assigned/.test(pStatus)) continue;
    if (position.assigned_person_id && /confirmed|filled/.test(pStatus)) {
      continue;
    }

    let severity = "watch";
    if (days != null && days <= cfg.watchDays) severity = "needs_attention";
    if (hours != null && hours <= cfg.criticalHours) {
      severity = position.critical === true ? "critical" : "needs_attention";
    }

    // Outside staffing window (more than watchDays): still watch if unfilled.
    if (days != null && days > cfg.watchDays) severity = "watch";

    const dedupe_key = buildDedupeKey(rule.dedupe_key_template, {
      show_id: showId,
      position_id: position.position_id,
    });

    findings.push(
      baseFinding(rule, showId, {
        title: "Required position unfilled",
        summary: `Required ${position.role || "position"} (${position.position_id}) is not confirmed${
          days == null ? "" : ` with ${days.toFixed(1)} days to load-in`
        }.`,
        severity,
        confidence: confidenceFromLabel("high"),
        evidence_refs: [
          {
            source_type: "staffing",
            source_id: position.position_id,
            field_path: "staffing.positions.status",
            display_value: position.status || "unfilled",
            normalized_value: position.status || "unfilled",
          },
          ...(loadIn
            ? [
                {
                  source_type: "show",
                  source_id: showId,
                  field_path: "show.load_in_at",
                  display_value: loadIn,
                  normalized_value: loadIn,
                },
              ]
            : []),
        ],
        missing_inputs: loadIn ? [] : ["show.load_in_at"],
        recommended_action: "Assign or confirm the required position.",
        dedupe_key,
        due_at: loadIn,
        core_values: {
          position_id: position.position_id,
          status: position.status || null,
        },
        last_evaluated_at: now.toISOString(),
      })
    );
  }

  return { findings, telemetry, missing_inputs };
}

/**
 * TRK-001 — Required run unassigned.
 */
export function evaluateTrk001(snapshot, rule, options = {}) {
  const findings = [];
  const telemetry = [];
  const missing_inputs = [];
  const showId = snapshot.show.show_id;
  const now = options.now || new Date();
  const trucking = snapshot.trucking || {};
  const cfg = {
    watchHours: options.trkWatchHours ?? 72,
    criticalHours: options.trkCriticalHours ?? 12,
  };

  if (trucking.source_status === "unavailable") {
    missing_inputs.push("trucking.runs");
    telemetry.push({
      rule_id: "TRK-001",
      reason: "trucking_source_unavailable",
    });
    return { findings, telemetry, missing_inputs };
  }

  for (const run of trucking.runs || []) {
    if (!run?.required) continue;
    const status = String(run.status || "").toLowerCase();
    if (/cancel/.test(status)) continue;

    const driverOk = run.driver_confirmed === true && Boolean(run.driver_id);
    const vehicleOk =
      run.vehicle_confirmed === true && Boolean(run.vehicle_id);
    if (driverOk && vehicleOk) continue;

    const departure = run.departure_at || snapshot.show.ship_at || null;
    const hours = hoursUntil(departure, now);
    let severity = rule.default_severity || "needs_attention";
    let confidenceLabel = "high";

    if (hours == null) {
      missing_inputs.push(`trucking.runs.${run.run_id}.departure_at`);
      severity = "needs_attention";
      confidenceLabel = "medium";
      telemetry.push({
        rule_id: "TRK-001",
        run_id: run.run_id,
        reason: "departure_missing_explicit_unassigned",
      });
    } else if (hours > cfg.watchHours) {
      severity = "watch";
    } else if (hours <= cfg.criticalHours) {
      severity = "critical";
    } else {
      severity = "needs_attention";
    }

    const dedupe_key = buildDedupeKey(rule.dedupe_key_template, {
      show_id: showId,
      run_id: run.run_id,
    });

    findings.push(
      baseFinding(rule, showId, {
        title: "Required run unassigned",
        summary: `Required run ${run.run_id} is missing ${[
          !driverOk ? "confirmed driver" : null,
          !vehicleOk ? "confirmed vehicle" : null,
        ]
          .filter(Boolean)
          .join(" and ")}.`,
        severity,
        confidence: confidenceFromLabel(confidenceLabel),
        evidence_refs: [
          {
            source_type: "weekly_runs",
            source_id: run.run_id,
            field_path: "trucking.runs.status",
            display_value: run.status || "unassigned",
            normalized_value: run.status || "unassigned",
          },
          {
            source_type: "weekly_runs",
            source_id: run.run_id,
            field_path: "trucking.runs.driver_confirmed",
            display_value: String(Boolean(driverOk)),
            normalized_value: Boolean(driverOk),
          },
          {
            source_type: "weekly_runs",
            source_id: run.run_id,
            field_path: "trucking.runs.vehicle_confirmed",
            display_value: String(Boolean(vehicleOk)),
            normalized_value: Boolean(vehicleOk),
          },
        ],
        missing_inputs: departure
          ? []
          : [`trucking.runs.${run.run_id}.departure_at`],
        recommended_action:
          "Confirm the required driver and vehicle assignment.",
        dedupe_key,
        due_at: departure,
        core_values: {
          run_id: run.run_id,
          driver_confirmed: Boolean(driverOk),
          vehicle_confirmed: Boolean(vehicleOk),
        },
        last_evaluated_at: now.toISOString(),
      })
    );
  }

  return { findings, telemetry, missing_inputs: [...new Set(missing_inputs)] };
}

/**
 * WH-001 — Pull progress behind milestone.
 */
export function evaluateWh001(snapshot, rule, options = {}) {
  const findings = [];
  const telemetry = [];
  const missing_inputs = [];
  const showId = snapshot.show.show_id;
  const now = options.now || new Date();
  const warehouse = snapshot.warehouse || {};
  const shipAt = snapshot.show.ship_at;

  if (warehouse.pull_required !== true) {
    return { findings, telemetry, missing_inputs };
  }
  if (!shipAt) {
    missing_inputs.push("show.ship_at");
    telemetry.push({ rule_id: "WH-001", reason: "ship_at_missing" });
    return { findings, telemetry, missing_inputs };
  }
  if (warehouse.source_status === "unavailable") {
    missing_inputs.push("warehouse.pull_progress");
    telemetry.push({
      rule_id: "WH-001",
      reason: "warehouse_source_unavailable",
    });
    return { findings, telemetry, missing_inputs };
  }
  if (
    warehouse.pull_progress == null ||
    !Number.isFinite(Number(warehouse.pull_progress))
  ) {
    missing_inputs.push("warehouse.pull_progress");
    telemetry.push({
      rule_id: "WH-001",
      reason: "pull_progress_unavailable",
    });
    return { findings, telemetry, missing_inputs };
  }

  const progress = Number(warehouse.pull_progress);
  const days = daysUntil(shipAt, now);
  const hours = hoursUntil(shipAt, now);
  let target = null;
  if (hours != null && hours <= 4) target = 100;
  else if (days != null && days <= 1) target = 90;
  else if (days != null && days <= 3) target = 60;
  else if (days != null && days <= 7) target = 25;
  else {
    telemetry.push({
      rule_id: "WH-001",
      reason: "outside_milestone_window",
      days,
    });
    return { findings, telemetry, missing_inputs };
  }

  if (progress >= target) {
    return { findings, telemetry, missing_inputs };
  }

  const gap = target - progress;
  let severity = "watch";
  if (gap >= 25) severity = "needs_attention";
  if (hours != null && hours <= 4 && progress < 100) severity = "critical";

  const dedupe_key = buildDedupeKey(rule.dedupe_key_template, {
    show_id: showId,
  });

  findings.push(
    baseFinding(rule, showId, {
      title: "Pull progress behind milestone",
      summary: `Warehouse pull is at ${progress}% vs ${target}% target for the current ship window.`,
      severity,
      confidence: confidenceFromLabel("high"),
      evidence_refs: [
        {
          source_type: "warehouse",
          source_id: showId,
          field_path: "warehouse.pull_progress",
          display_value: String(progress),
          normalized_value: progress,
        },
        {
          source_type: "warehouse",
          source_id: showId,
          field_path: "warehouse.pull_status",
          display_value: String(warehouse.pull_status || ""),
          normalized_value: warehouse.pull_status || null,
        },
        {
          source_type: "show",
          source_id: showId,
          field_path: "show.ship_at",
          display_value: shipAt,
          normalized_value: shipAt,
        },
        {
          source_type: "rule",
          source_id: "WH-001",
          field_path: "milestone.target_percent",
          display_value: String(target),
          normalized_value: target,
          note: `Evaluated at ${now.toISOString()}`,
        },
      ],
      missing_inputs: [],
      recommended_action:
        "Review warehouse pull progress against the current ship milestone.",
      dedupe_key,
      due_at: shipAt,
      core_values: { progress, target },
      last_evaluated_at: now.toISOString(),
    })
  );

  return { findings, telemetry, missing_inputs };
}

/**
 * SCH-003 — Date sequence invalid.
 */
export function evaluateSch003(snapshot, rule, options = {}) {
  const findings = [];
  const telemetry = [];
  const showId = snapshot.show.show_id;
  const now = options.now || new Date();

  const orderedTypes = [
    "ship_at",
    "load_in_at",
    "show_start_at",
    "load_out_at",
  ];
  const present = [];

  // Prefer milestone array; fall back to show fields.
  const fromMilestones = (snapshot.milestones || [])
    .map((m) => ({
      type: m.type,
      at: normalizeIsoTimestamp(m.at),
      source_refs: m.source_refs || [],
      milestone_id: m.milestone_id,
    }))
    .filter((m) => m.at && orderedTypes.includes(m.type));

  if (fromMilestones.length) {
    present.push(...fromMilestones);
  } else {
    for (const type of orderedTypes) {
      const at = normalizeIsoTimestamp(snapshot.show[type]);
      if (at) {
        present.push({
          type,
          at,
          source_refs: [
            {
              source_type: "show",
              source_id: showId,
              field_path: `show.${type}`,
              display_value: at,
              normalized_value: at,
            },
          ],
          milestone_id: type,
        });
      }
    }
  }

  // Duplicate milestone disagreement
  const byType = new Map();
  for (const m of present) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type).push(m);
  }
  for (const [type, items] of byType.entries()) {
    const unique = new Set(items.map((i) => i.at));
    if (unique.size > 1) {
      const [a, b] = items;
      const pair = `${type}_conflict`;
      findings.push(
        baseFinding(rule, showId, {
          title: "Date sequence invalid",
          summary: `Duplicate ${type} milestones disagree (${a.at} vs ${b.at}).`,
          severity: "critical",
          confidence: confidenceFromLabel("high"),
          evidence_refs: [
            ...(a.source_refs || []),
            ...(b.source_refs || []),
          ].map((ref) => ({
            source_type: ref.source_type,
            source_id: ref.source_id,
            field_path: ref.field_path || type,
            display_value: ref.display_value || null,
            normalized_value: ref.normalized_value || null,
          })),
          missing_inputs: [],
          recommended_action:
            "Correct or approve an exception to the invalid milestone sequence.",
          dedupe_key: buildDedupeKey(rule.dedupe_key_template, {
            show_id: showId,
            milestone_pair: pair,
          }),
          core_values: { type, values: [...unique] },
          last_evaluated_at: now.toISOString(),
        })
      );
    }
  }

  const earliestByType = orderedTypes
    .map((type) => {
      const items = byType.get(type) || [];
      if (!items.length) return null;
      return items.slice().sort((a, b) => a.at.localeCompare(b.at))[0];
    })
    .filter(Boolean);

  for (let i = 0; i < earliestByType.length - 1; i += 1) {
    for (let j = i + 1; j < earliestByType.length; j += 1) {
      const left = earliestByType[i];
      const right = earliestByType[j];
      const leftIdx = orderedTypes.indexOf(left.type);
      const rightIdx = orderedTypes.indexOf(right.type);
      if (leftIdx < 0 || rightIdx < 0 || leftIdx >= rightIdx) continue;
      if (left.at <= right.at) continue;

      const pair = `${left.type}>${right.type}`;
      findings.push(
        baseFinding(rule, showId, {
          title: "Date sequence invalid",
          summary: `${left.type} (${left.at}) occurs after ${right.type} (${right.at}).`,
          severity: "critical",
          confidence: confidenceFromLabel("high"),
          evidence_refs: [
            {
              source_type: "show",
              source_id: showId,
              field_path: `show.${left.type}`,
              display_value: left.at,
              normalized_value: left.at,
            },
            {
              source_type: "show",
              source_id: showId,
              field_path: `show.${right.type}`,
              display_value: right.at,
              normalized_value: right.at,
            },
          ],
          missing_inputs: [],
          recommended_action:
            "Correct or approve an exception to the invalid milestone sequence.",
          dedupe_key: buildDedupeKey(rule.dedupe_key_template, {
            show_id: showId,
            milestone_pair: pair,
          }),
          core_values: {
            earlier: left.type,
            later: right.type,
            earlier_at: left.at,
            later_at: right.at,
          },
          last_evaluated_at: now.toISOString(),
        })
      );
    }
  }

  if (!findings.length) {
    telemetry.push({
      rule_id: "SCH-003",
      reason: "sequence_valid_or_insufficient_milestones",
      present: earliestByType.map((m) => m.type),
    });
  }

  return { findings, telemetry, missing_inputs: [] };
}

export const EVALUATORS = Object.freeze({
  "INT-002": evaluateInt002,
  "LAB-001": evaluateLab001,
  "TRK-001": evaluateTrk001,
  "WH-001": evaluateWh001,
  "SCH-003": evaluateSch003,
});
