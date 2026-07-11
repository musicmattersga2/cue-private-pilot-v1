/**
 * ASK-FLEX-003 — Conversational Follow-Up for Full Show Reviews
 *
 * Answers focused natural-language questions against the latest structured
 * full-show review in the current browser/session context.
 */

const QUOTE_NUMBER_RE = /\b\d{2}-\d{3,6}\b/;

const FOLLOWUP_LANGUAGE_RE =
  /\b(biggest issue|top\s+(?:three|3|things?)|brian|trucking coordinator|what should (?:the )?pm|show (?:me )?only|summarize|summary|confirmed|needs? confirmation|coverage gaps?|trucking items?|staffing items?|warehouse view|flex versus trucking|flex vs\.? trucking|source driving|preventing (?:the show from being )?clear|next actions?|what changed|executive summary|for chelsea|pm (?:do )?first|owner)\b/i;

const REFRESH_RE =
  /\b(refresh|recheck|pull again|rerun)\b/i;

const NEW_SHOW_REVIEW_RE =
  /\b(full (?:operational )?review|operational review|show review)\b.+\bof\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return asString(value).toLowerCase().replace(/\s+/g, " ");
}

function hasQuoteNumber(question) {
  QUOTE_NUMBER_RE.lastIndex = 0;
  return QUOTE_NUMBER_RE.test(String(question || ""));
}

function extractShowNameHint(question) {
  const text = String(question || "");
  const match = text.match(
    /\b(?:of|for|about)\s+([A-Za-z0-9][A-Za-z0-9 &'./-]{1,60})(?:\?|$)/i
  );
  return match ? asString(match[1]).replace(/[?.!,;:]+$/, "") : null;
}

function isClearlyNewShowRequest(question, contextShowName) {
  const text = String(question || "");
  if (!NEW_SHOW_REVIEW_RE.test(text) && !/\bfull (?:operational )?review of\b/i.test(text)) {
    return false;
  }
  const hinted = extractShowNameHint(text);
  if (!hinted || !contextShowName) return Boolean(hinted);
  return normalizeKey(hinted) !== normalizeKey(contextShowName);
}

export function isRefreshFollowupQuestion(question) {
  const text = String(question || "");
  if (REFRESH_RE.test(text)) return true;
  // Explicit "latest/current/live review|sources|data" refresh phrasing only.
  if (/\b(get|pull|fetch|load|use)\b.+\b(latest|current|live)\b.+\b(review|sources?|data)\b/i.test(text)) {
    return true;
  }
  if (/\b(latest|current|live)\b.+\b(review|sources?|data)\b.+\b(again|refresh|update|recheck)\b/i.test(text)) {
    return true;
  }
  if (/\b(update|reload)\s+(this\s+)?(review|show)\b/i.test(text)) return true;
  return false;
}

export function isShowOperationalFollowupQuestion(question, context = null) {
  const hasContext =
    context?.type === "full_show_review" &&
    (context.result || context.showName);
  if (!hasContext) return false;

  const text = String(question || "").trim();
  if (!text) return false;
  if (hasQuoteNumber(text)) return false;

  // Explicit full/new show review requests are never follow-ups.
  if (
    /\bfull (?:operational )?review\b/i.test(text) ||
    /\boperational review of\b/i.test(text) ||
    /\bshow review of\b/i.test(text)
  ) {
    return false;
  }

  if (isClearlyNewShowRequest(text, context.showName)) return false;

  if (FOLLOWUP_LANGUAGE_RE.test(text)) return true;
  if (isRefreshFollowupQuestion(text)) return true;

  // Soft follow-ups that still refer to the current review.
  if (/\b(this show|this review|the review|current status|the status)\b/i.test(text)) {
    return true;
  }

  return false;
}

export function classifyFullShowFollowupType(question) {
  const text = String(question || "").toLowerCase();

  if (/\bwhat changed|since the last|diff(?:erence)?\b/.test(text)) {
    return "change_since_last";
  }
  if (/\bbiggest issue|preventing .+ clear|why .+ (?:not )?clear|driving .+ status|source driving\b/.test(text)) {
    if (/\bsource driving|driving .+ status|why .+ status\b/.test(text)) {
      return "status_reason";
    }
    if (/\bpreventing .+ clear|why .+ (?:not )?clear\b/.test(text)) {
      return "status_reason";
    }
    return "biggest_issue";
  }
  if (/\bstatus reason|overall status|why .+ review|why .+ at[_ ]?risk\b/.test(text)) {
    return "status_reason";
  }
  if (/\bbrian|trucking coordinator\b/.test(text) && /\b(top|resolve|need|action|do)\b/.test(text)) {
    return "owner_actions";
  }
  if (/\b(pm|project manager).*(first|do|action|resolve)|what should (?:the )?pm\b/.test(text)) {
    return "pm_actions";
  }
  if (/\bstaffing\b/.test(text) && /\b(only|items?|view|coordinator|tj)\b/.test(text)) {
    return "staffing_only";
  }
  if (/\bwarehouse\b/.test(text) && /\b(only|items?|view|david)\b/.test(text)) {
    return "warehouse_only";
  }
  if (/\btrucking\b/.test(text) && /\b(only|items?|view|execution)\b/.test(text)) {
    return "trucking_only";
  }
  if (/\bbrian\b/.test(text)) return "owner_actions";
  if (/\bconfirmed\b/.test(text)) return "confirmed_issues";
  if (/\bneeds? confirmation|still need\b/.test(text)) return "needs_confirmation";
  if (/\bcoverage gaps?\b/.test(text)) return "coverage_gaps";
  if (/\bflex (?:versus|vs\.?) trucking|flex vs|trucking versus flex\b/.test(text)) {
    return "source_comparison";
  }
  if (/\bexecutive summary|summarize|for chelsea|five[- ]line|5[- ]line\b/.test(text)) {
    return "executive_summary";
  }
  if (/\bnext actions?\b/.test(text)) return "pm_actions";
  return "general_followup";
}

function sanitizeStoredResult(result) {
  if (!result || typeof result !== "object") return null;
  const safe = {
    showName: result.showName || result.showSummary?.showName || null,
    assessment: result.assessment || result.answer || null,
    answer: result.answer || result.assessment || null,
    overallStatus: result.overallStatus || null,
    statusReason: result.statusReason || null,
    complexityLevel: result.complexityLevel || null,
    confidence: result.confidence || null,
    sourceCoverage: asArray(result.sourceCoverage).map((item) => ({
      source: item?.source || null,
      status: item?.status || null,
      note: item?.note || null,
    })),
    coverageGaps: asArray(result.coverageGaps).map((item) =>
      typeof item === "string"
        ? item
        : {
            source: item?.source || null,
            status: item?.status || null,
            note: item?.note || null,
          }
    ),
    showSummary: result.showSummary
      ? {
          showName: result.showSummary.showName || null,
          client: result.showSummary.client || null,
          venue: result.showSummary.venue || null,
          dateRange: result.showSummary.dateRange || null,
          relatedQuotes: asArray(result.showSummary.relatedQuotes).slice(0, 12),
          projectManagers: asArray(result.showSummary.projectManagers).slice(0, 8),
        }
      : null,
    relatedWorkstreams: asArray(result.relatedWorkstreams || result.showSummary?.relatedWorkstreams)
      .slice(0, 12)
      .map((row) => ({
        documentNumber: row?.documentNumber || null,
        showName: row?.showName || null,
        client: row?.client || null,
        plannedStartDate: row?.plannedStartDate || null,
        plannedEndDate: row?.plannedEndDate || null,
        matchReason: row?.matchReason || null,
      })),
    flexScope: result.flexScope
      ? {
          assessment: result.flexScope.assessment || null,
          quoteCount: result.flexScope.quoteCount ?? null,
          relatedQuotes: asArray(result.flexScope.relatedQuotes).slice(0, 12),
          laborHeadcount: result.flexScope.laborHeadcount ?? null,
          transportationLineCount: result.flexScope.transportationLineCount ?? null,
          equipmentLineItemCount: result.flexScope.equipmentLineItemCount ?? null,
          findings: asArray(result.flexScope.findings).slice(0, 8),
        }
      : null,
    truckingExecution: result.truckingExecution
      ? {
          assessment: result.truckingExecution.assessment || null,
          runCount: result.truckingExecution.runCount ?? null,
          status: result.truckingExecution.status || null,
          findings: asArray(result.truckingExecution.findings).slice(0, 8),
          actions: asArray(result.truckingExecution.actions).slice(0, 6),
        }
      : null,
    staffing: result.staffing
      ? {
          assessment: result.staffing.assessment || null,
          sourceStatus: result.staffing.sourceStatus || null,
          findings: asArray(result.staffing.findings).slice(0, 6),
          actions: asArray(result.staffing.actions).slice(0, 4),
        }
      : null,
    warehouse: result.warehouse
      ? {
          assessment: result.warehouse.assessment || null,
          sourceStatus: result.warehouse.sourceStatus || null,
          findings: asArray(result.warehouse.findings).slice(0, 6),
          actions: asArray(result.warehouse.actions).slice(0, 4),
        }
      : null,
    crossSourceFindings: asArray(result.crossSourceFindings)
      .slice(0, 12)
      .map((item) => ({
        category: item?.category || null,
        severity: item?.severity || null,
        status: item?.status || null,
        area: item?.area || null,
        finding: item?.finding || null,
        evidence: item?.evidence || null,
        sources: asArray(item?.sources).slice(0, 6),
        owner: item?.owner || null,
        action: item?.action || null,
      })),
    confirmedIssues: asArray(result.confirmedIssues).slice(0, 12),
    needsConfirmation: asArray(result.needsConfirmation).slice(0, 12),
    recommendedNextActions: asArray(result.recommendedNextActions).slice(0, 8),
    supportingData: result.supportingData
      ? {
          truckingSummary: result.supportingData.truckingSummary || null,
          relatedQuotes: asArray(result.supportingData.relatedQuotes).slice(0, 12),
        }
      : null,
    cueBuildLabel: result.cueBuildLabel || null,
  };
  return safe;
}

export function sanitizeFullShowFollowupContext(context) {
  if (!context || typeof context !== "object") return null;
  if (context.type && context.type !== "full_show_review") return null;

  const result = sanitizeStoredResult(context.result);
  if (!result && !context.showName) return null;

  return {
    type: "full_show_review",
    showName: context.showName || result?.showName || null,
    reviewedAt: context.reviewedAt || context.timestamp || null,
    question: context.question || null,
    cueBuildLabel: context.cueBuildLabel || result?.cueBuildLabel || null,
    previousResult: context.previousResult
      ? sanitizeStoredResult(context.previousResult)
      : null,
    result,
  };
}

function severityRank(severity) {
  const key = String(severity || "").toLowerCase();
  if (key === "critical") return 4;
  if (key === "high") return 3;
  if (key === "medium") return 2;
  if (key === "low") return 1;
  return 0;
}

function statusRank(status) {
  const key = String(status || "").toLowerCase();
  if (key === "blocked") return 4;
  if (key === "at_risk") return 3;
  if (key === "review_needed") return 2;
  return 1;
}

function ownerMatches(ownerText, role) {
  const owner = normalizeKey(ownerText);
  if (role === "brian") {
    return (
      owner.includes("brian kee") ||
      owner.includes("brian") ||
      owner.includes("trucking coordinator")
    );
  }
  if (role === "pm") {
    return /\bpm\b/.test(owner) || owner.includes("project manager");
  }
  if (role === "staffing") {
    return owner.includes("staffing");
  }
  if (role === "warehouse") {
    return owner.includes("warehouse");
  }
  return false;
}

function areaMatches(area, role) {
  const value = normalizeKey(area);
  if (role === "brian") return value === "trucking" || value === "timing";
  if (role === "pm") return value === "pm" || value === "data" || value === "flex";
  if (role === "staffing") return value === "staffing";
  if (role === "warehouse") return value === "warehouse";
  return false;
}

function collectFindingItems(result) {
  return asArray(result?.crossSourceFindings)
    .filter((item) => item?.finding)
    .map((item, index) => ({
      priority: index + 1,
      area: item.area || null,
      owner: item.owner || null,
      finding: item.finding,
      evidence: item.evidence || null,
      action: item.action || null,
      source: asArray(item.sources).join(", ") || null,
      category: item.category || null,
      severity: item.severity || null,
      status: item.status || null,
    }));
}

function filterByOwner(items, role) {
  if (role === "brian") {
    // Require Brian/Trucking Coordinator ownership, or Trucking area.
    // Do not treat Timing-only / PM schedule items as Brian actions.
    return items.filter((item) => {
      if (ownerMatches(item.owner, "brian")) return true;
      return normalizeKey(item.area) === "trucking";
    });
  }
  return items.filter(
    (item) => ownerMatches(item.owner, role) || areaMatches(item.area, role)
  );
}

function prioritizeItems(items) {
  return [...items].sort((a, b) => {
    const statusDiff = statusRank(b.status) - statusRank(a.status);
    if (statusDiff) return statusDiff;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}

function makeItemFromText({
  finding,
  action = null,
  evidence = null,
  owner = null,
  area = null,
  source = null,
  priority = 1,
}) {
  return {
    priority,
    area,
    owner,
    finding,
    evidence,
    action,
    source,
  };
}

function buildBiggestIssue(result) {
  const confirmed = asArray(result.confirmedIssues);
  const findings = prioritizeItems(collectFindingItems(result));
  if (confirmed.length) {
    const match =
      findings.find((item) => normalizeKey(item.finding) === normalizeKey(confirmed[0])) ||
      null;
    return {
      answer: `The biggest confirmed issue is: ${confirmed[0]}`,
      items: [
        match ||
          makeItemFromText({
            finding: confirmed[0],
            area: "Trucking",
            evidence: result.statusReason || null,
          }),
      ].slice(0, 1),
    };
  }

  if (findings.length) {
    const top = findings[0];
    return {
      answer: `No confirmed operational blockers are present. The highest-priority open item is: ${top.finding}`,
      items: [top],
    };
  }

  return {
    answer:
      result.statusReason ||
      "No material cross-source findings are present in the current connected review.",
    items: [],
  };
}

function buildPmActions(result) {
  const findings = collectFindingItems(result);
  const quotes = asArray(
    result.showSummary?.relatedQuotes || result.flexScope?.relatedQuotes
  );
  const needs = asArray(result.needsConfirmation);
  const items = [];
  const seen = new Set();

  const pushUnique = (item) => {
    const key = normalizeKey(item.action || item.finding);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({
      ...item,
      owner: "PM",
      area: item.area || "PM",
      priority: items.length + 1,
    });
  };

  const alignment = findings.find(
    (item) =>
      item.category === "quote_trucking_alignment" ||
      /share that transportation|references .+ directly/i.test(item.finding || "")
  );
  if (alignment) {
    pushUnique({
      ...alignment,
      finding: alignment.finding,
      evidence: alignment.evidence || null,
      action:
        "Confirm whether related FLEX workstreams intentionally share the Weekly Runs transportation plan.",
      source: alignment.source || "FLEX, Trucking",
    });
  }

  const multiQuote = findings.find(
    (item) =>
      item.category === "flex_multi_quote" ||
      /multiple related flex quotes|workstreams are in scope/i.test(item.finding || "")
  );
  if (multiQuote || quotes.length >= 2) {
    pushUnique({
      finding:
        multiQuote?.finding ||
        `Multiple related FLEX quotes/workstreams are in scope (${quotes.join(", ")}).`,
      evidence:
        multiQuote?.evidence ||
        (quotes.length ? `Related quotes: ${quotes.join(", ")}.` : null),
      action:
        "Confirm which quote/package version is authoritative for each workstream before execution.",
      source: "FLEX",
      category: multiQuote?.category || "flex_multi_quote",
    });
  }

  const truckingAdminOpen =
    needs.filter((text) => /maybe truck|info sent|lpo|tbd/i.test(text)).length > 0 ||
    findings.some((item) =>
      /maybe truck|info sent|lpo sent|\btbd\b/i.test(
        `${item.finding || ""} ${item.category || ""}`
      )
    );
  if (truckingAdminOpen) {
    const evidenceBits = [
      ...needs.filter((text) => /maybe truck|info sent|lpo|tbd/i.test(text)).slice(0, 3),
      ...findings
        .filter((item) =>
          /maybe truck|info sent|lpo|\btbd\b/i.test(`${item.finding || ""} ${item.category || ""}`)
        )
        .map((item) => item.evidence)
        .filter(Boolean)
        .slice(0, 2),
    ];
    pushUnique({
      finding:
        "Trucking administration remains open in Weekly Runs (Maybe Truck / Info Sent / LPO Sent / TBD).",
      evidence: evidenceBits.join(" ") || null,
      action:
        "Oversee that Brian Kee / Trucking Coordinator resolves Maybe Truck, Info Sent, LPO Sent, and TBD items before treating the show as clear.",
      source: "Trucking",
    });
  }

  // Optional fourth/fifth fill: venue/PM visibility as coordination, not trucking admin.
  if (items.length < 3) {
    const scheduleOrPm = findings.find(
      (item) =>
        item.category === "flex_missing_schedule" ||
        item.category === "pm_visibility" ||
        /venue|schedule|no pm is visible/i.test(item.finding || "")
    );
    if (scheduleOrPm) {
      pushUnique({
        ...scheduleOrPm,
        action:
          scheduleOrPm.action ||
          "Confirm venue/schedule and PM visibility on the authoritative FLEX package.",
      });
    }
  }

  const ranked = items.slice(0, 3).map((item, index) => ({ ...item, priority: index + 1 }));
  if (!ranked.length) {
    return {
      answer: "No PM coordination actions are present in the current stored review.",
      items: [],
    };
  }

  return {
    answer: `Top ${ranked.length} PM coordination action${ranked.length === 1 ? "" : "s"} from the current review:`,
    items: ranked,
  };
}

function buildOwnerActions(result, role, label) {
  if (role === "pm") return buildPmActions(result);

  const findings = prioritizeItems(filterByOwner(collectFindingItems(result), role));
  const actions = [];
  const seen = new Set();

  for (const item of findings) {
    const action = asString(item.action);
    if (!action) continue;
    const key = normalizeKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({
      ...item,
      finding: item.finding,
      action,
    });
    if (actions.length >= 3) break;
  }

  if (actions.length < 3) {
    for (const actionText of asArray(result.recommendedNextActions)) {
      const key = normalizeKey(actionText);
      if (seen.has(key)) continue;
      const looksBrian =
        /truck|driver|lpo|info sent|tbd|maybe truck|transport/i.test(actionText) &&
        !/\bstaffing\b|\bwarehouse\b/i.test(actionText);
      if (role === "brian" && !looksBrian) continue;
      seen.add(key);
      actions.push(
        makeItemFromText({
          finding: actionText,
          action: actionText,
          owner: label,
          area: "Trucking",
          priority: actions.length + 1,
        })
      );
      if (actions.length >= 3) break;
    }
  }

  const ranked = actions.map((item, index) => ({ ...item, priority: index + 1 }));

  if (!ranked.length) {
    return {
      answer: `No ${label}-owned follow-up actions are present in the current stored review.`,
      items: [],
    };
  }

  return {
    answer: `Top ${ranked.length} thing${ranked.length === 1 ? "" : "s"} for ${label} to resolve from the current review:`,
    items: ranked,
  };
}

function buildTruckingOnly(result) {
  const trucking = result.truckingExecution || {};
  const findings = prioritizeItems(
    collectFindingItems(result).filter(
      (item) =>
        areaMatches(item.area, "brian") ||
        /trucking|maybe truck|info sent|lpo|need driver|tbd|transport/i.test(
          `${item.finding} ${item.category || ""}`
        )
    )
  ).slice(0, 5);

  const needs = asArray(result.needsConfirmation)
    .filter((text) =>
      /truck|maybe truck|info sent|lpo|tbd|transport|driver|weekly runs/i.test(text)
    )
    .slice(0, 5);

  const lines = [
    trucking.assessment || trucking.status || "Trucking execution summary unavailable.",
    Number(trucking.runCount || 0)
      ? `${trucking.runCount} Weekly Runs row(s) in the stored review.`
      : null,
  ].filter(Boolean);

  return {
    answer: lines.join(" "),
    items: findings.length
      ? findings
      : needs.map((text, index) =>
          makeItemFromText({
            priority: index + 1,
            area: "Trucking",
            finding: text,
            owner: "Brian Kee / Trucking Coordinator",
          })
        ),
  };
}

function buildDeptOnly(result, key, label) {
  const block = result[key] || {};
  const findings = asArray(block.findings).slice(0, 4);
  const actions = asArray(block.actions).slice(0, 3);
  const items = [
    ...findings.map((text, index) =>
      makeItemFromText({
        priority: index + 1,
        area: label,
        finding: text,
        source: label,
      })
    ),
    ...actions.map((text, index) =>
      makeItemFromText({
        priority: findings.length + index + 1,
        area: label,
        finding: text,
        action: text,
        source: label,
      })
    ),
  ].slice(0, 5);

  return {
    answer:
      asString(block.assessment) ||
      `${label} detail is limited in the stored review${
        block.sourceStatus ? ` (${block.sourceStatus})` : ""
      }.`,
    items,
  };
}

function buildConfirmed(result) {
  const confirmed = asArray(result.confirmedIssues);
  if (!confirmed.length) {
    return {
      answer:
        "No confirmed operational blockers are present in the current connected review.",
      items: [],
    };
  }
  return {
    answer: `${confirmed.length} confirmed operational issue${confirmed.length === 1 ? "" : "s"} in the current review.`,
    items: confirmed.map((text, index) =>
      makeItemFromText({
        priority: index + 1,
        finding: text,
        area: "Confirmed",
      })
    ),
  };
}

function buildNeedsConfirmation(result) {
  const needs = asArray(result.needsConfirmation);
  if (!needs.length) {
    return {
      answer: "No open confirmation items are listed in the current stored review.",
      items: [],
    };
  }
  return {
    answer: `${needs.length} item${needs.length === 1 ? "" : "s"} still need confirmation.`,
    items: needs.slice(0, 5).map((text, index) =>
      makeItemFromText({
        priority: index + 1,
        finding: text,
        area: "Needs Confirmation",
      })
    ),
  };
}

function buildCoverageGaps(result) {
  const gaps = asArray(result.coverageGaps);
  const coverage = asArray(result.sourceCoverage).filter((item) =>
    ["unavailable", "fallback", "partial"].includes(String(item?.status || "").toLowerCase())
  );

  const items = (gaps.length ? gaps : coverage).slice(0, 6).map((gap, index) => {
    if (typeof gap === "string") {
      return makeItemFromText({ priority: index + 1, finding: gap, area: "Coverage" });
    }
    return makeItemFromText({
      priority: index + 1,
      area: gap.source || "Coverage",
      finding: `${gap.source || "Source"} · ${gap.status || "unavailable"}`,
      evidence: gap.note || null,
      source: gap.source || null,
    });
  });

  return {
    answer: items.length
      ? "Source / coverage gaps from the current stored review:"
      : "No coverage gaps are listed in the current stored review.",
    items,
  };
}

function buildStatusReason(result) {
  const reason = asString(result.statusReason);
  const overall = asString(result.overallStatus) || "review_needed";
  const answer = reason
    ? `Current overall status is ${overall.replace(/_/g, " ")}. ${reason.replace(/^overallStatus is\s*/i, "This is driven by ")}`
    : `Current overall status is ${overall.replace(/_/g, " ")} based on the stored connected-source review.`;

  const items = prioritizeItems(collectFindingItems(result)).slice(0, 3);
  return { answer, items };
}

function buildSourceComparison(result) {
  const flex = result.flexScope || {};
  const trucking = result.truckingExecution || {};
  const active = asArray(result.sourceCoverage).find(
    (item) => normalizeKey(item.source) === "active shows"
  );

  const answer = [
    flex.assessment || "FLEX scope is available in the stored review.",
    trucking.assessment || trucking.status || "Trucking execution summary is limited.",
    active
      ? `Active Shows is ${active.status || "unknown"}: ${active.note || "contextual only unless confirmed by live sources."}`
      : "Active Shows context was not present in the stored review.",
  ].join(" ");

  const items = prioritizeItems(collectFindingItems(result))
    .filter((item) =>
      /flex|trucking|active shows|data/i.test(`${item.area} ${item.source || ""}`)
    )
    .slice(0, 4);

  return { answer, items };
}

function buildExecutiveSummary(result) {
  const show = result.showName || "This show";
  const status = String(result.overallStatus || "review_needed").replace(/_/g, " ");
  const complexity = result.complexityLevel || "—";
  const quotes = asArray(
    result.showSummary?.relatedQuotes || result.flexScope?.relatedQuotes
  );
  const trucking = result.truckingExecution || {};
  const summary = result.supportingData?.truckingSummary || {};
  const runCount = Number(trucking.runCount ?? summary.rowsFound ?? 0);
  const confirmed = asArray(result.confirmedIssues);
  const needs = asArray(result.needsConfirmation);
  const topAction = asArray(result.recommendedNextActions)[0] || null;

  const truckingBits = [];
  if (runCount > 0) truckingBits.push(`${runCount} Weekly Runs row(s)`);
  if (Number(summary.maybeTruckRows || 0) > 0) {
    truckingBits.push(`${summary.maybeTruckRows} Maybe Truck`);
  }
  if (Number(summary.infoSentFalse || 0) > 0 || Number(summary.lpoSentFalse || 0) > 0) {
    truckingBits.push("Info/LPO incomplete");
  }
  if (Number(summary.tbdRows || 0) > 0) truckingBits.push(`${summary.tbdRows} TBD`);

  const lines = [
    `${show}: overall ${status}; complexity ${complexity}.`,
    quotes.length
      ? `FLEX: ${quotes.length} related quote(s) (${quotes.slice(0, 4).join(", ")}).`
      : `FLEX: ${asString(result.flexScope?.assessment) || "limited scope detail in stored review."}`,
    truckingBits.length
      ? `Trucking: ${truckingBits.join("; ")}.`
      : `Trucking: ${asString(trucking.status || trucking.assessment) || "no trucking rows in stored review."}`,
    confirmed.length
      ? `Confirmed blockers: ${confirmed[0]}`
      : "Confirmed blockers: none in the current connected review.",
    topAction || needs[0]
      ? `Next focus: ${topAction || needs[0]}`
      : "Next focus: confirm open cross-source items before treating the show as clear.",
  ];

  while (lines.length < 5) {
    lines.push("Additional detail is limited in the stored review.");
  }

  return {
    answer: lines
      .slice(0, 5)
      .map((line, index) => `${index + 1}. ${line}`)
      .join("\n"),
    items: prioritizeItems(collectFindingItems(result)).slice(0, 3),
  };
}

function snapshotSignals(result) {
  const summary = result?.supportingData?.truckingSummary || {};
  return {
    overallStatus: result?.overallStatus || null,
    complexityLevel: result?.complexityLevel || null,
    relatedQuotes: asArray(result?.showSummary?.relatedQuotes || result?.flexScope?.relatedQuotes),
    truckingRows: Number(result?.truckingExecution?.runCount ?? summary.rowsFound ?? 0),
    maybeTruck: Number(summary.maybeTruckRows ?? 0),
    needDriver: Number(summary.needDriverRows ?? 0),
    infoSentFalse: Number(summary.infoSentFalse ?? 0),
    lpoSentFalse: Number(summary.lpoSentFalse ?? 0),
    tbd: Number(summary.tbdRows ?? 0),
    findingCategories: asArray(result?.crossSourceFindings)
      .map((item) => item.category)
      .filter(Boolean),
    confirmedIssues: asArray(result?.confirmedIssues),
    needsConfirmation: asArray(result?.needsConfirmation),
  };
}

function buildChangeSinceLast(context) {
  const previous = context.previousResult;
  const latest = context.result;
  if (!previous || !latest) {
    return {
      answer:
        "Change history is not available yet. Run a fresh review after source updates to create a second snapshot.",
      items: [],
    };
  }

  const before = snapshotSignals(previous);
  const after = snapshotSignals(latest);
  const changes = [];

  const pushChange = (label, a, b) => {
    const left = Array.isArray(a) ? a.join(", ") : a;
    const right = Array.isArray(b) ? b.join(", ") : b;
    if (String(left) === String(right)) return;
    changes.push(
      makeItemFromText({
        priority: changes.length + 1,
        area: "Change",
        finding: `${label}: ${left || "—"} → ${right || "—"}`,
      })
    );
  };

  pushChange("overallStatus", before.overallStatus, after.overallStatus);
  pushChange("complexityLevel", before.complexityLevel, after.complexityLevel);
  pushChange("relatedQuotes", before.relatedQuotes, after.relatedQuotes);
  pushChange("truckingRows", before.truckingRows, after.truckingRows);
  pushChange("maybeTruck", before.maybeTruck, after.maybeTruck);
  pushChange("needDriver", before.needDriver, after.needDriver);
  pushChange("infoSentFalse", before.infoSentFalse, after.infoSentFalse);
  pushChange("lpoSentFalse", before.lpoSentFalse, after.lpoSentFalse);
  pushChange("tbd", before.tbd, after.tbd);
  pushChange("findingCategories", before.findingCategories, after.findingCategories);
  pushChange("confirmedIssues", before.confirmedIssues, after.confirmedIssues);
  pushChange("needsConfirmation", before.needsConfirmation, after.needsConfirmation);

  if (!changes.length) {
    return {
      answer:
        "No material differences were detected between the previous and latest full-show snapshots in this session.",
      items: [],
    };
  }

  return {
    answer: `Detected ${changes.length} change${changes.length === 1 ? "" : "s"} between the previous and latest full-show snapshots in this session.`,
    items: changes.slice(0, 8),
  };
}

function buildGeneralFollowup(result, question) {
  if (/\bbrian\b/i.test(question)) return buildOwnerActions(result, "brian", "Brian Kee / Trucking Coordinator");
  if (/\bpm\b|project manager/i.test(question)) return buildOwnerActions(result, "pm", "PM");
  if (/\btrucking\b/i.test(question)) return buildTruckingOnly(result);
  if (/\bconfirmed\b/i.test(question)) return buildConfirmed(result);
  if (/\bconfirmation\b/i.test(question)) return buildNeedsConfirmation(result);
  if (/\bgap\b/i.test(question)) return buildCoverageGaps(result);
  return buildExecutiveSummary(result);
}

function buildDeterministicFollowup(question, context, followupType) {
  const result = context.result;
  switch (followupType) {
    case "biggest_issue":
      return buildBiggestIssue(result);
    case "owner_actions":
      return buildOwnerActions(result, "brian", "Brian Kee / Trucking Coordinator");
    case "pm_actions":
      return buildPmActions(result);
    case "trucking_only":
      return buildTruckingOnly(result);
    case "staffing_only":
      return buildDeptOnly(result, "staffing", "Staffing");
    case "warehouse_only":
      return buildDeptOnly(result, "warehouse", "Warehouse");
    case "confirmed_issues":
      return buildConfirmed(result);
    case "needs_confirmation":
      return buildNeedsConfirmation(result);
    case "coverage_gaps":
      return buildCoverageGaps(result);
    case "status_reason":
      return buildStatusReason(result);
    case "source_comparison":
      return buildSourceComparison(result);
    case "executive_summary":
      return buildExecutiveSummary(result);
    case "change_since_last":
      return buildChangeSinceLast(context);
    default:
      return buildGeneralFollowup(result, question);
  }
}

function headlineForType(followupType, showName) {
  const show = showName || "this show";
  const map = {
    biggest_issue: `Biggest issue · ${show}`,
    owner_actions: `Brian Kee follow-ups · ${show}`,
    pm_actions: `PM follow-ups · ${show}`,
    trucking_only: `Trucking view · ${show}`,
    staffing_only: `Staffing view · ${show}`,
    warehouse_only: `Warehouse view · ${show}`,
    confirmed_issues: `Confirmed issues · ${show}`,
    needs_confirmation: `Needs confirmation · ${show}`,
    coverage_gaps: `Coverage gaps · ${show}`,
    status_reason: `Status driver · ${show}`,
    source_comparison: `FLEX vs Trucking · ${show}`,
    executive_summary: `Executive summary · ${show}`,
    change_since_last: `Changes since last review · ${show}`,
    general_followup: `Follow-up · ${show}`,
  };
  return map[followupType] || `Follow-up · ${show}`;
}

async function maybeRewriteFollowupTone(payload, deps = {}) {
  // Keep executive_summary as exact multi-line deterministic copy (no model rewrite).
  const allowRewrite = payload.followupType === "general_followup";
  if (!allowRewrite) return payload;
  if (!process.env.OPENAI_API_KEY || !deps.openai?.responses?.create) return payload;

  try {
    const selectCueModel =
      typeof deps.selectCueModel === "function"
        ? deps.selectCueModel
        : () => ({ model: "gpt-4.1-mini" });
    const modelConfig = selectCueModel({}, payload);
    const response = await deps.openai.responses.create({
      model: modelConfig.model,
      input: [
        {
          role: "system",
          content:
            "Rewrite the answer in concise operating language. Do not add facts, change status, owners, evidence, or invent findings. Return only JSON: { answer: string }.",
        },
        {
          role: "user",
          content: JSON.stringify({
            followupType: payload.followupType,
            answer: payload.answer,
            items: payload.items,
            overallStatus: payload.supportingData?.overallStatus,
          }),
        },
      ],
      text: { format: { type: "json_object" } },
    });

    const parse =
      typeof deps.safeParseModelJson === "function"
        ? deps.safeParseModelJson
        : (text) => {
            try {
              return JSON.parse(text);
            } catch {
              return null;
            }
          };
    const raw = parse(response.output_text);
    const rewritten = asString(raw?.answer);
    if (rewritten) {
      return { ...payload, answer: rewritten };
    }
  } catch (error) {
    console.error("[CUE ASK FLEX FOLLOWUP] OpenAI rewrite failed; using deterministic answer.", error);
  }
  return payload;
}

export async function answerFullShowFollowup(question, rawContext, deps = {}) {
  const context = sanitizeFullShowFollowupContext(rawContext);

  if (!context?.result) {
    return {
      question,
      intent: "show_operational_followup",
      needsClarification: true,
      found: false,
      answer: "Run a full show review first, then ask a follow-up question.",
      headline: "Follow-up needs a full show review",
      usedStoredReview: false,
      refreshRequired: false,
      items: [],
    };
  }

  const followupType = classifyFullShowFollowupType(question);
  const built = buildDeterministicFollowup(question, context, followupType);
  const items = asArray(built.items)
    .slice(0, followupType === "owner_actions" || followupType === "pm_actions" ? 3 : 5)
    .map((item, index) => ({
      priority: item.priority || index + 1,
      area: item.area || null,
      owner: item.owner || null,
      finding: item.finding || null,
      evidence: item.evidence || null,
      action: item.action || null,
      source: item.source || null,
    }));

  let payload = {
    question,
    intent: "show_operational_followup",
    found: true,
    showName: context.showName || context.result.showName || null,
    followupType,
    answer: built.answer,
    headline: headlineForType(followupType, context.showName || context.result.showName),
    sourceReviewTimestamp: context.reviewedAt || null,
    usedStoredReview: true,
    refreshRequired: false,
    refreshed: Boolean(deps.refreshed),
    items,
    supportingData: {
      overallStatus: context.result.overallStatus || null,
      complexityLevel: context.result.complexityLevel || null,
      confidence: context.result.confidence || null,
      sourceCoverage: context.result.sourceCoverage || [],
      statusReason: context.result.statusReason || null,
    },
    cueBuildLabel: context.cueBuildLabel || context.result.cueBuildLabel || null,
  };

  payload = await maybeRewriteFollowupTone(payload, deps);
  return payload;
}
