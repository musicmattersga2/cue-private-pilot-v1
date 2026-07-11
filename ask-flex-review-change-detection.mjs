/**
 * ASK-FLEX-004 — Deterministic full-show review change detection.
 * Normalizes snapshots, hashes operational content, and compares reviews.
 */

import crypto from "crypto";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return String(value ?? "").trim();
}

function uniqueSortedStrings(values) {
  return [
    ...new Set(
      asArray(values)
        .map((value) => asString(value))
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function uniquePreserveOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function normalizeCoverage(list) {
  return asArray(list)
    .map((item) => {
      if (typeof item === "string") {
        return { source: asString(item), status: "unavailable", note: null };
      }
      return {
        source: asString(item?.source),
        status: asString(item?.status).toLowerCase() || "unavailable",
        note: asString(item?.note) || null,
      };
    })
    .filter((item) => item.source)
    .sort((a, b) => a.source.localeCompare(b.source));
}

function yearFromQuotes(quotes) {
  for (const quote of asArray(quotes)) {
    const match = String(quote).match(/^(\d{2})-/);
    if (match) {
      const yy = Number(match[1]);
      if (Number.isFinite(yy)) return 2000 + yy;
    }
  }
  return null;
}

export function buildShowKey(showName, options = {}) {
  const base = asString(showName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const year =
    options.year ||
    yearFromQuotes(options.relatedQuotes) ||
    (options.dateHint ? new Date(options.dateHint).getUTCFullYear() : null) ||
    new Date().getUTCFullYear();
  if (!base) return `unknown-show-${year}`;
  return `${base}-${year}`;
}

function extractTruckingCounts(result, supportingData = {}) {
  const summary = supportingData?.truckingSummary || {};
  const trucking = result?.truckingExecution || {};
  let matchedQuoteCount = Array.isArray(summary.quoteNumbersMatched)
    ? summary.quoteNumbersMatched.length
    : Number(summary.matchedQuoteCount ?? 0);
  if (!matchedQuoteCount) {
    const findings = asArray(result?.truckingExecution?.findings).join(" ");
    const match = findings.match(/(\d+)\s+quote number(?:s)? matched/i);
    if (match) matchedQuoteCount = Number(match[1]);
  }
  return {
    rowCount: Number(trucking.runCount ?? summary.rowsFound ?? 0),
    matchedQuoteCount,
    maybeTruckCount: Number(summary.maybeTruckRows ?? 0),
    needDriverCount: Number(summary.needDriverRows ?? 0),
    infoSentFalseCount: Number(summary.infoSentFalse ?? 0),
    lpoSentFalseCount: Number(summary.lpoSentFalse ?? 0),
    tbdCount: Number(summary.tbdRows ?? 0),
    status: asString(trucking.status || summary.status) || null,
  };
}

export function normalizeFullShowSnapshotInput(result, options = {}) {
  const supportingData = options.supportingData || result?.supportingData || {};
  const showName =
    asString(options.showName || result?.showName || result?.showSummary?.showName) ||
    "Unknown Show";
  const relatedQuotes = uniqueSortedStrings(
    result?.showSummary?.relatedQuotes ||
      result?.flexScope?.relatedQuotes ||
      supportingData?.relatedQuotes ||
      []
  );
  const showKey =
    options.showKey ||
    buildShowKey(showName, {
      relatedQuotes,
      year: options.year,
      dateHint: result?.showSummary?.dateRange || null,
    });

  const flex = result?.flexScope || {};
  const trucking = extractTruckingCounts(result, supportingData);

  const activeCoverage = asArray(result?.sourceCoverage).find(
    (item) => asString(item?.source).toLowerCase() === "active shows"
  );
  const activeShows = {
    readinessStatus: asString(options.activeShows?.readinessStatus) || null,
    priority: asString(options.activeShows?.priority) || null,
    topIssue: asString(options.activeShows?.topIssue) || null,
    nextAction: asString(options.activeShows?.nextAction) || null,
    note: asString(activeCoverage?.note) || null,
    status: asString(activeCoverage?.status) || null,
  };

  const findingCategories = uniqueSortedStrings(
    asArray(result?.crossSourceFindings).map((item) => item?.category)
  );

  const coverageGaps = normalizeCoverage(result?.coverageGaps || []).map((item) => ({
    source: item.source,
    status: item.status,
    note: item.note,
  }));

  return {
    showKey,
    showName,
    reviewedAt: options.reviewedAt || new Date().toISOString(),
    buildLabel: options.buildLabel || null,
    source: "full_show_review",
    overallStatus: asString(result?.overallStatus).toLowerCase() || null,
    complexityLevel: asString(result?.complexityLevel) || null,
    confidence: asString(result?.confidence).toLowerCase() || null,
    relatedQuotes,
    sourceCoverage: normalizeCoverage(result?.sourceCoverage).map((item) => ({
      source: item.source,
      status: item.status,
    })),
    flex: {
      quoteCount: Number(flex.quoteCount ?? relatedQuotes.length ?? 0),
      laborHeadcount: Number(flex.laborHeadcount ?? 0),
      laborPersonDays: Number(flex.laborPersonDays ?? 0),
      transportationLineCount: Number(flex.transportationLineCount ?? 0),
      equipmentLineItemCount: Number(flex.equipmentLineItemCount ?? 0),
      majorFamilies: uniqueSortedStrings(flex.majorFamilies),
    },
    trucking,
    activeShows,
    findingCategories,
    confirmedIssues: uniqueSortedStrings(result?.confirmedIssues),
    needsConfirmation: uniqueSortedStrings(result?.needsConfirmation),
    coverageGaps,
    recommendedNextActions: uniquePreserveOrder(result?.recommendedNextActions),
  };
}

function hashPayload(content) {
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function computeSnapshotContentHash(normalized) {
  const forHash = {
    showKey: normalized.showKey,
    showName: normalized.showName,
    source: normalized.source,
    overallStatus: normalized.overallStatus,
    complexityLevel: normalized.complexityLevel,
    confidence: normalized.confidence,
    relatedQuotes: normalized.relatedQuotes,
    sourceCoverage: normalized.sourceCoverage,
    flex: normalized.flex,
    trucking: normalized.trucking,
    activeShows: {
      readinessStatus: normalized.activeShows?.readinessStatus || null,
      priority: normalized.activeShows?.priority || null,
      topIssue: normalized.activeShows?.topIssue || null,
      nextAction: normalized.activeShows?.nextAction || null,
      status: normalized.activeShows?.status || null,
    },
    findingCategories: normalized.findingCategories,
    confirmedIssues: normalized.confirmedIssues,
    needsConfirmation: normalized.needsConfirmation,
    coverageGaps: (normalized.coverageGaps || []).map((item) => ({
      source: item.source,
      status: item.status,
    })),
    recommendedNextActions: normalized.recommendedNextActions,
  };
  return hashPayload(forHash);
}

export function buildFullShowReviewSnapshot(result, options = {}) {
  const normalized = normalizeFullShowSnapshotInput(result, options);
  const contentHash = computeSnapshotContentHash(normalized);
  const now = new Date().toISOString();
  return {
    id: options.id || crypto.randomUUID(),
    ...normalized,
    createdAt: options.createdAt || now,
    reviewedAt: normalized.reviewedAt || now,
    contentHash,
  };
}

const STATUS_RANK = {
  clear: 0,
  review_needed: 1,
  at_risk: 2,
  blocked: 3,
};

function statusDelta(previous, current) {
  const a = STATUS_RANK[String(previous || "").toLowerCase()];
  const b = STATUS_RANK[String(current || "").toLowerCase()];
  if (a == null || b == null || a === b) return 0;
  return b - a;
}

function setDiff(previousList, currentList) {
  const prev = new Set(asArray(previousList).map((v) => asString(v).toLowerCase()));
  const curr = new Set(asArray(currentList).map((v) => asString(v).toLowerCase()));
  const added = asArray(currentList).filter((v) => !prev.has(asString(v).toLowerCase()));
  const removed = asArray(previousList).filter((v) => !curr.has(asString(v).toLowerCase()));
  return { added, removed };
}

function pushChange(bucket, item) {
  if (!item) return;
  bucket.push(item);
}

export function compareFullShowSnapshots(previous, current) {
  const improved = [];
  const worsened = [];
  const newIssues = [];
  const resolvedIssues = [];
  const changed = [];
  const unchangedSummary = [];

  if (!previous || !current) {
    return {
      hasChanges: false,
      changeCount: 0,
      improved,
      worsened,
      newIssues,
      resolvedIssues,
      changed,
      unchangedSummary: ["Insufficient snapshots to compare."],
      summary: "Only one distinct saved review is available for comparison.",
      previousId: previous?.id || null,
      currentId: current?.id || null,
      previousReviewedAt: previous?.reviewedAt || null,
      currentReviewedAt: current?.reviewedAt || null,
    };
  }

  if (previous.contentHash && current.contentHash && previous.contentHash === current.contentHash) {
    return {
      hasChanges: false,
      changeCount: 0,
      improved,
      worsened,
      newIssues,
      resolvedIssues,
      changed,
      unchangedSummary: ["Operational content is identical between the two latest distinct saved reviews."],
      summary:
        "No operational changes were detected between the two latest distinct saved reviews.",
      previousId: previous.id,
      currentId: current.id,
      previousReviewedAt: previous.reviewedAt,
      currentReviewedAt: current.reviewedAt,
    };
  }

  const statusMove = statusDelta(previous.overallStatus, current.overallStatus);
  if (statusMove < 0) {
    pushChange(improved, {
      field: "overallStatus",
      from: previous.overallStatus,
      to: current.overallStatus,
      label: `Overall status improved: ${previous.overallStatus} → ${current.overallStatus}`,
    });
  } else if (statusMove > 0) {
    pushChange(worsened, {
      field: "overallStatus",
      from: previous.overallStatus,
      to: current.overallStatus,
      label: `Overall status worsened: ${previous.overallStatus} → ${current.overallStatus}`,
    });
  } else {
    unchangedSummary.push(`overallStatus unchanged (${current.overallStatus || "—"})`);
  }

  if (asString(previous.complexityLevel) !== asString(current.complexityLevel)) {
    pushChange(changed, {
      field: "complexityLevel",
      from: previous.complexityLevel,
      to: current.complexityLevel,
      label: `Complexity changed: ${previous.complexityLevel || "—"} → ${current.complexityLevel || "—"}`,
    });
  }

  if (asString(previous.confidence) !== asString(current.confidence)) {
    pushChange(changed, {
      field: "confidence",
      from: previous.confidence,
      to: current.confidence,
      label: `Confidence changed: ${previous.confidence || "—"} → ${current.confidence || "—"}`,
    });
  }

  const countFields = [
    ["trucking.maybeTruckCount", "Maybe Truck"],
    ["trucking.needDriverCount", "NEED DRIVER"],
    ["trucking.infoSentFalseCount", "Info Sent false"],
    ["trucking.lpoSentFalseCount", "LPO Sent false"],
    ["trucking.tbdCount", "TBD"],
  ];

  for (const [path, label] of countFields) {
    const [root, key] = path.split(".");
    const before = Number(previous?.[root]?.[key] ?? 0);
    const after = Number(current?.[root]?.[key] ?? 0);
    if (before === after) continue;
    const entry = {
      field: path,
      from: before,
      to: after,
      label: `${label}: ${before} → ${after}`,
    };
    if (after < before) pushChange(improved, entry);
    else pushChange(worsened, entry);
  }

  const flexCountFields = [
    ["quoteCount", "FLEX quote count"],
    ["laborHeadcount", "Labor headcount"],
    ["laborPersonDays", "Labor person-days"],
    ["transportationLineCount", "Transportation lines"],
    ["equipmentLineItemCount", "Equipment line items"],
  ];
  for (const [key, label] of flexCountFields) {
    const before = Number(previous?.flex?.[key] ?? 0);
    const after = Number(current?.flex?.[key] ?? 0);
    if (before === after) continue;
    pushChange(changed, {
      field: `flex.${key}`,
      from: before,
      to: after,
      label: `${label}: ${before} → ${after}`,
    });
  }

  if (Number(previous?.trucking?.rowCount ?? 0) !== Number(current?.trucking?.rowCount ?? 0)) {
    pushChange(changed, {
      field: "trucking.rowCount",
      from: previous?.trucking?.rowCount,
      to: current?.trucking?.rowCount,
      label: `Trucking rows: ${previous?.trucking?.rowCount ?? 0} → ${current?.trucking?.rowCount ?? 0}`,
    });
  }

  if (asString(previous?.trucking?.status) !== asString(current?.trucking?.status)) {
    pushChange(changed, {
      field: "trucking.status",
      from: previous?.trucking?.status,
      to: current?.trucking?.status,
      label: `Trucking status: ${previous?.trucking?.status || "—"} → ${current?.trucking?.status || "—"}`,
    });
  }

  const quoteDiff = setDiff(previous.relatedQuotes, current.relatedQuotes);
  if (quoteDiff.added.length || quoteDiff.removed.length) {
    pushChange(changed, {
      field: "relatedQuotes",
      added: quoteDiff.added,
      removed: quoteDiff.removed,
      label: `Related quotes changed (+${quoteDiff.added.length}/-${quoteDiff.removed.length})`,
    });
  }

  const familyDiff = setDiff(previous?.flex?.majorFamilies, current?.flex?.majorFamilies);
  if (familyDiff.added.length || familyDiff.removed.length) {
    pushChange(changed, {
      field: "flex.majorFamilies",
      label: `Major equipment families changed (+${familyDiff.added.length}/-${familyDiff.removed.length})`,
    });
  }

  const confirmedDiff = setDiff(previous.confirmedIssues, current.confirmedIssues);
  for (const issue of confirmedDiff.added) {
    pushChange(newIssues, { field: "confirmedIssues", label: `New confirmed issue: ${issue}` });
    pushChange(worsened, { field: "confirmedIssues", label: `New confirmed issue: ${issue}` });
  }
  for (const issue of confirmedDiff.removed) {
    pushChange(resolvedIssues, {
      field: "confirmedIssues",
      label: `Resolved confirmed issue: ${issue}`,
    });
    pushChange(improved, {
      field: "confirmedIssues",
      label: `Resolved confirmed issue: ${issue}`,
    });
  }

  const needsDiff = setDiff(previous.needsConfirmation, current.needsConfirmation);
  for (const issue of needsDiff.added) {
    pushChange(newIssues, { field: "needsConfirmation", label: `New needs-confirmation: ${issue}` });
    pushChange(changed, { field: "needsConfirmation", label: `New needs-confirmation: ${issue}` });
  }
  for (const issue of needsDiff.removed) {
    pushChange(resolvedIssues, {
      field: "needsConfirmation",
      label: `Cleared needs-confirmation: ${issue}`,
    });
    pushChange(changed, {
      field: "needsConfirmation",
      label: `Cleared needs-confirmation: ${issue}`,
    });
  }

  const categoryDiff = setDiff(previous.findingCategories, current.findingCategories);
  if (categoryDiff.added.length || categoryDiff.removed.length) {
    pushChange(changed, {
      field: "findingCategories",
      label: `Finding categories changed (+${categoryDiff.added.length}/-${categoryDiff.removed.length})`,
    });
  }

  const actionDiff = setDiff(previous.recommendedNextActions, current.recommendedNextActions);
  if (actionDiff.added.length || actionDiff.removed.length) {
    pushChange(changed, {
      field: "recommendedNextActions",
      label: `Recommended actions changed (+${actionDiff.added.length}/-${actionDiff.removed.length})`,
    });
  }

  const prevCoverage = new Map(
    asArray(previous.sourceCoverage).map((item) => [asString(item.source).toLowerCase(), item])
  );
  for (const item of asArray(current.sourceCoverage)) {
    const key = asString(item.source).toLowerCase();
    const before = prevCoverage.get(key);
    if (!before) {
      pushChange(changed, {
        field: "sourceCoverage",
        label: `Source added: ${item.source} (${item.status})`,
      });
      continue;
    }
    if (asString(before.status) === asString(item.status)) continue;
    const from = asString(before.status).toLowerCase();
    const to = asString(item.status).toLowerCase();
    const entry = {
      field: "sourceCoverage",
      label: `${item.source} coverage: ${from} → ${to}`,
    };
    if (
      (from === "unavailable" || from === "fallback" || from === "partial") &&
      to === "connected"
    ) {
      pushChange(improved, entry);
    } else if (
      from === "connected" &&
      (to === "unavailable" || to === "fallback" || to === "partial")
    ) {
      pushChange(worsened, entry);
    } else {
      pushChange(changed, entry);
    }
  }

  for (const field of ["readinessStatus", "priority", "topIssue", "nextAction"]) {
    const before = asString(previous?.activeShows?.[field]);
    const after = asString(current?.activeShows?.[field]);
    if (before === after) continue;
    pushChange(changed, {
      field: `activeShows.${field}`,
      label: `Active Shows ${field} changed`,
      from: before || null,
      to: after || null,
    });
  }

  const changeCount =
    improved.length +
    worsened.length +
    newIssues.length +
    resolvedIssues.length +
    changed.length;

  let summary;
  if (!changeCount) {
    summary =
      "No operational changes were detected between the two latest distinct saved reviews.";
  } else {
    const bits = [];
    if (improved.length) bits.push(`${improved.length} improved`);
    if (worsened.length) bits.push(`${worsened.length} worsened`);
    if (newIssues.length) bits.push(`${newIssues.length} new`);
    if (resolvedIssues.length) bits.push(`${resolvedIssues.length} resolved`);
    if (changed.length) bits.push(`${changed.length} other`);
    summary = `Detected ${changeCount} operational change(s): ${bits.join(", ")}.`;
  }

  return {
    hasChanges: changeCount > 0,
    changeCount,
    improved,
    worsened,
    newIssues,
    resolvedIssues,
    changed,
    unchangedSummary,
    summary,
    previousId: previous.id,
    currentId: current.id,
    previousReviewedAt: previous.reviewedAt,
    currentReviewedAt: current.reviewedAt,
    showKey: current.showKey || previous.showKey,
    showName: current.showName || previous.showName,
  };
}

export function formatChangeComparisonItems(comparison, filter = "all") {
  const items = [];
  const push = (list, area) => {
    for (const entry of asArray(list)) {
      items.push({
        priority: items.length + 1,
        area,
        owner: null,
        finding: entry.label || JSON.stringify(entry),
        evidence: [
          entry.from != null ? `from: ${entry.from}` : null,
          entry.to != null ? `to: ${entry.to}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
        action: null,
        source: "Persisted snapshots",
      });
    }
  };

  if (filter === "all" || filter === "improved") push(comparison.improved, "Improved");
  if (filter === "all" || filter === "worsened") push(comparison.worsened, "Worsened");
  if (filter === "all" || filter === "new") push(comparison.newIssues, "New");
  if (filter === "all" || filter === "resolved") push(comparison.resolvedIssues, "Resolved");
  if (filter === "all" || filter === "changed") push(comparison.changed, "Changed");
  return items.slice(0, 12);
}
