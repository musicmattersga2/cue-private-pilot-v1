/**
 * Normalized Intelligence show snapshot contract + Active Shows adapter.
 * Does not mutate Intake spine or Active Shows source records.
 */

import crypto from "crypto";

export const SNAPSHOT_VERSION = "intelligence-show-snapshot.v1";

const MATERIAL_FACT_FIELDS = new Set([
  "show.ship_at",
  "show.load_in_at",
  "show.show_start_at",
  "show.load_out_at",
  "show.venue",
  "show.client",
  "show.status",
  "show.project_manager",
]);

export function createEmptySnapshot(partial = {}) {
  return {
    snapshot_id: partial.snapshot_id || null,
    snapshot_version: SNAPSHOT_VERSION,
    generated_at: partial.generated_at || new Date().toISOString(),
    show: {
      show_id: null,
      name: null,
      status: null,
      client: null,
      venue: null,
      ship_at: null,
      load_in_at: null,
      show_start_at: null,
      load_out_at: null,
      project_manager: null,
      source_refs: [],
      ...(partial.show || {}),
    },
    active_fact_candidates: Array.isArray(partial.active_fact_candidates)
      ? partial.active_fact_candidates
      : [],
    staffing: {
      source_status: "unavailable",
      positions: [],
      ...(partial.staffing || {}),
    },
    trucking: {
      source_status: "unavailable",
      runs: [],
      ...(partial.trucking || {}),
    },
    warehouse: {
      source_status: "unavailable",
      pull_required: null,
      pull_status: null,
      pull_progress: null,
      source_refs: [],
      ...(partial.warehouse || {}),
    },
    milestones: Array.isArray(partial.milestones) ? partial.milestones : [],
    adapter_telemetry: partial.adapter_telemetry || {
      missing_inputs: [],
      notes: [],
    },
  };
}

export function normalizeIsoTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function daysUntil(iso, now = new Date()) {
  const at = normalizeIsoTimestamp(iso);
  if (!at) return null;
  const ms = new Date(at).getTime() - now.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export function hoursUntil(iso, now = new Date()) {
  const at = normalizeIsoTimestamp(iso);
  if (!at) return null;
  return (new Date(at).getTime() - now.getTime()) / (1000 * 60 * 60);
}

export function isMaterialFactField(fieldPath) {
  return MATERIAL_FACT_FIELDS.has(String(fieldPath || ""));
}

function sourceRef(type, id, field = null) {
  return {
    source_type: type,
    source_id: id == null ? null : String(id),
    field_path: field,
  };
}

function pushFact(candidates, fieldPath, value, meta = {}) {
  if (value == null || value === "") return;
  candidates.push({
    field_path: fieldPath,
    normalized_value:
      fieldPath.endsWith("_at") || fieldPath.includes(".ship")
        ? normalizeIsoTimestamp(value) || String(value)
        : normalizeComparableValue(value),
    display_value: String(value),
    source_type: meta.source_type || "active_shows",
    source_id: meta.source_id || null,
    source_timestamp: meta.source_timestamp || null,
    source_reliability: meta.source_reliability || "medium",
    confidence: meta.confidence || "medium",
    active: meta.active !== false,
    superseded: meta.superseded === true,
  });
}

export function normalizeComparableValue(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  const iso = normalizeIsoTimestamp(value);
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(String(value))) return iso;
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?'"`]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Active Shows → Intelligence snapshot adapter.
 * Never invents staffing/trucking/warehouse when sources are absent.
 */
export function adaptActiveShowToIntelligenceSnapshot(show, options = {}) {
  const missing = [];
  const notes = [];
  if (!show || typeof show !== "object") {
    return {
      ok: false,
      snapshot: null,
      missing_inputs: ["show"],
      notes: ["Active Show record unavailable."],
    };
  }

  const showId = show.id || show.showKey || show.show_id || null;
  if (!showId) missing.push("show.show_id");

  const loadIn =
    normalizeIsoTimestamp(show?.flex?.loadInDate) ||
    normalizeIsoTimestamp(show?.activeShowsIndex?.loadIn) ||
    normalizeIsoTimestamp(show?.loadIn) ||
    null;
  const loadOut =
    normalizeIsoTimestamp(show?.flex?.loadOutDate) ||
    normalizeIsoTimestamp(show?.loadOut) ||
    null;
  const showStart =
    normalizeIsoTimestamp(show?.flex?.showStartDate) ||
    normalizeIsoTimestamp(show?.flex?.plannedStartDate) ||
    normalizeIsoTimestamp(show?.startDate) ||
    null;
  const shipAt =
    normalizeIsoTimestamp(show?.flex?.shipDate) ||
    normalizeIsoTimestamp(show?.shipAt) ||
    normalizeIsoTimestamp(show?.activeShowsIndex?.shipDate) ||
    null;

  const facts = [];
  const sourceId = `active-show:${showId}`;
  pushFact(facts, "show.venue", show.venue || show?.activeShowsIndex?.venue, {
    source_id: sourceId,
    source_type: "active_shows",
    source_reliability: "high",
    confidence: "high",
  });
  pushFact(
    facts,
    "show.client",
    show.client || show?.activeShowsIndex?.client,
    {
      source_id: sourceId,
      source_type: "active_shows",
      source_reliability: "high",
      confidence: "high",
    }
  );
  pushFact(facts, "show.status", show.readinessStatus || show.status, {
    source_id: sourceId,
    source_type: "active_shows",
    source_reliability: "medium",
    confidence: "medium",
  });
  pushFact(facts, "show.load_in_at", loadIn, {
    source_id: sourceId,
    source_type: show?.flex?.loadInDate ? "flex" : "active_shows",
    source_reliability: "high",
    confidence: "high",
  });
  pushFact(facts, "show.load_out_at", loadOut, {
    source_id: sourceId,
    source_type: "flex",
    source_reliability: "high",
    confidence: "high",
  });
  pushFact(facts, "show.show_start_at", showStart, {
    source_id: sourceId,
    source_type: "flex",
    source_reliability: "high",
    confidence: "high",
  });
  pushFact(facts, "show.ship_at", shipAt, {
    source_id: sourceId,
    source_type: shipAt ? "active_shows" : "unavailable",
    source_reliability: shipAt ? "medium" : "low",
    confidence: shipAt ? "medium" : "low",
  });

  // Optional explicit conflict candidates supplied by caller/tests.
  if (Array.isArray(options.extraFactCandidates)) {
    facts.push(...options.extraFactCandidates);
  }

  const milestones = [];
  if (shipAt) {
    milestones.push({
      milestone_id: "ship",
      type: "ship_at",
      at: shipAt,
      source_refs: [sourceRef("active_shows", sourceId, "show.ship_at")],
    });
  }
  if (loadIn) {
    milestones.push({
      milestone_id: "load_in",
      type: "load_in_at",
      at: loadIn,
      source_refs: [sourceRef("flex", sourceId, "show.load_in_at")],
    });
  }
  if (showStart) {
    milestones.push({
      milestone_id: "show_start",
      type: "show_start_at",
      at: showStart,
      source_refs: [sourceRef("flex", sourceId, "show.show_start_at")],
    });
  }
  if (loadOut) {
    milestones.push({
      milestone_id: "load_out",
      type: "load_out_at",
      at: loadOut,
      source_refs: [sourceRef("flex", sourceId, "show.load_out_at")],
    });
  }

  const staffing = options.staffing || {
    source_status: "unavailable",
    positions: [],
  };
  if (staffing.source_status === "unavailable") {
    missing.push("staffing.positions");
    notes.push("Staffing source unavailable on Active Shows adapter.");
  }

  const trucking = adaptTruckingFromActiveShow(show, options);
  if (trucking.source_status === "unavailable") {
    missing.push("trucking.runs");
    notes.push("Explicit trucking run records unavailable.");
  }

  const warehouse = options.warehouse || {
    source_status: "unavailable",
    pull_required: null,
    pull_status: null,
    pull_progress: null,
    source_refs: [],
  };
  if (warehouse.source_status === "unavailable") {
    missing.push("warehouse.pull_progress");
    notes.push("Warehouse pull source unavailable on Active Shows adapter.");
  }

  if (!shipAt) missing.push("show.ship_at");
  if (!loadIn) missing.push("show.load_in_at");

  const snapshot = createEmptySnapshot({
    snapshot_id: crypto
      .createHash("sha256")
      .update(`${showId}|${Date.now()}`)
      .digest("hex")
      .slice(0, 16),
    generated_at: new Date().toISOString(),
    show: {
      show_id: String(showId),
      name: show.name || show.showName || null,
      status: show.readinessStatus || show.status || null,
      client: show.client || show?.activeShowsIndex?.client || null,
      venue: show.venue || null,
      ship_at: shipAt,
      load_in_at: loadIn,
      show_start_at: showStart,
      load_out_at: loadOut,
      project_manager:
        show?.activeShowsIndex?.pm || show.projectManager || null,
      source_refs: [sourceRef("active_shows", sourceId)],
    },
    active_fact_candidates: facts,
    staffing,
    trucking,
    warehouse,
    milestones,
    adapter_telemetry: { missing_inputs: [...new Set(missing)], notes },
  });

  return {
    ok: true,
    snapshot,
    missing_inputs: snapshot.adapter_telemetry.missing_inputs,
    notes,
  };
}

function adaptTruckingFromActiveShow(show, options = {}) {
  if (options.trucking) return options.trucking;
  const summary = show?.truckingSync?.summary;
  const rows = Array.isArray(show?.truckingSync?.rows)
    ? show.truckingSync.rows
    : [];
  if (!summary && !rows.length) {
    return { source_status: "unavailable", runs: [] };
  }

  // Only emit explicit run rows — never invent from FLEX transportation lines.
  const runs = rows.map((row, index) => {
    const runId =
      row.runId ||
      row.id ||
      `${row.quote || "run"}:${row.date || index}:${row.when || index}`;
    const driver = String(row.driver || "").trim();
    const truck = String(row.truck || "").trim();
    const needDriver =
      /need\s*driver/i.test(String(row.notes || "")) ||
      /need\s*driver/i.test(driver) ||
      driver === "" ||
      /^tbd$/i.test(driver);
    const vehicleMissing = !truck || /^tbd$/i.test(truck);
    return {
      run_id: String(runId),
      required: true,
      status: needDriver || vehicleMissing ? "unassigned" : "assigned",
      driver_id: needDriver ? null : driver,
      driver_confirmed: !needDriver && Boolean(driver),
      vehicle_id: vehicleMissing ? null : truck,
      vehicle_confirmed: !vehicleMissing && Boolean(truck),
      departure_at: normalizeIsoTimestamp(row.date) || null,
      source_refs: [
        sourceRef("weekly_runs", runId, "trucking.runs"),
      ],
    };
  });

  return {
    source_status: runs.length ? "available" : "unavailable",
    runs,
  };
}

/**
 * Future Intake spine adapter seam — not implemented, documents the contract.
 */
export function adaptIntakeSnapshotToIntelligenceSnapshot(_intakeSnapshot) {
  return {
    ok: false,
    snapshot: null,
    missing_inputs: ["intake_snapshot"],
    notes: [
      "Intake snapshot adapter is reserved. Supply a normalized Intelligence snapshot or use adaptActiveShowToIntelligenceSnapshot.",
    ],
  };
}

export function assertSnapshotShape(snapshot) {
  if (!snapshot || snapshot.snapshot_version !== SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: `snapshot_version must be ${SNAPSHOT_VERSION}`,
    };
  }
  if (!snapshot.show?.show_id) {
    return { ok: false, error: "show.show_id is required" };
  }
  return { ok: true };
}
