const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? "").trim();
}

function nestedValue(value, paths = []) {
  for (const path of paths) {
    let cursor = value;
    for (const part of path.split(".")) {
      if (!cursor || typeof cursor !== "object") {
        cursor = null;
        break;
      }
      cursor = cursor[part];
    }
    if (
      cursor !== null
      && cursor !== undefined
      && typeof cursor !== "object"
      && text(cursor)
    ) return cursor;
  }
  return null;
}

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["events", "records", "quotes", "items", "results", "rows", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function cursorFromPayload(payload, fallback = null) {
  return nestedValue(payload, [
    "nextCursor",
    "cursorAfter",
    "nextPageToken",
    "pageInfo.endCursor",
    "meta.nextCursor",
    "paging.nextCursor",
  ]) || fallback;
}

export const FLEX_LIFECYCLE_CONNECTOR_NAME = "flex-confirmed-quote-lifecycle";

export const FLEX_LIFECYCLE_REQUIRED_FIELDS = Object.freeze([
  "elementId (FLEX UUID)",
  "documentNumber",
  "documentType or definitionName",
  "current status or status event",
  "status-change timestamp",
  "show name",
]);

export function normalizeFlexLifecycleCandidate(input = {}, options = {}) {
  const elementId = text(nestedValue(input, [
    "elementId", "quoteElementId", "financialDocumentId", "element.id", "id", "uuid",
  ])).toLowerCase();
  if (!UUID_PATTERN.test(elementId)) {
    return { ok: false, reason: "invalid_or_missing_element_id", raw: input };
  }
  const documentNumber = text(nestedValue(input, [
    "documentNumber", "quoteNumber", "docNumber", "number", "element.documentNumber",
  ])).toUpperCase() || null;
  const documentType = text(nestedValue(input, [
    "documentType", "elementType", "definitionName", "elementDefinitionName", "type",
  ])).toLowerCase() || null;
  const status = text(nestedValue(input, [
    "status", "currentStatus", "workflowStatus", "elementStatus", "status.name",
  ])) || null;
  const changedAt = text(nestedValue(input, [
    "changedAt", "statusChangedAt", "updatedAt", "modifiedAt", "eventTime", "occurredAt",
  ])) || null;
  const sourceEventId = text(nestedValue(input, [
    "sourceEventId", "statusEventId", "eventId", "changeId",
  ])) || null;
  return {
    ok: true,
    candidate: {
      elementId,
      documentNumber,
      documentType,
      status,
      changedAt,
      observedAt: text(options.observedAt) || new Date().toISOString(),
      sourceEventId,
      showName: text(nestedValue(input, ["showName", "name", "title", "element.name"])) || null,
      client: text(nestedValue(input, ["client", "clientName", "client.name"])) || null,
      venue: text(nestedValue(input, ["venue", "venueName", "venue.name"])) || null,
      plannedStartDate: text(nestedValue(input, ["plannedStartDate", "showStartDate", "startDate"])) || null,
      plannedEndDate: text(nestedValue(input, ["plannedEndDate", "showEndDate", "endDate"])) || null,
      parentElementId: text(nestedValue(input, ["parentElementId", "parentId", "parent.id"])) || null,
      raw: input,
    },
  };
}

export function normalizeFlexLifecycleFeed(payload, options = {}) {
  const candidates = [];
  const rejected = [];
  for (const record of recordsFromPayload(payload)) {
    const normalized = normalizeFlexLifecycleCandidate(record, options);
    if (normalized.ok) candidates.push(normalized.candidate);
    else rejected.push(normalized);
  }
  return {
    candidates,
    rejected,
    cursorAfter: text(cursorFromPayload(payload, options.cursorBefore || null)) || null,
    hasMore: Boolean(payload?.hasMore ?? payload?.pageInfo?.hasNextPage ?? payload?.meta?.hasMore),
  };
}

export function flexLifecycleUnavailable(reason, details = {}) {
  return {
    ok: true,
    available: false,
    authoritative: false,
    status: reason,
    observations: [],
    triggered: 0,
    idempotent: 0,
    requiredFields: [...FLEX_LIFECYCLE_REQUIRED_FIELDS],
    ...details,
  };
}

export async function runFlexLifecycleDiscovery(options = {}) {
  const connectorName = options.connectorName || FLEX_LIFECYCLE_CONNECTOR_NAME;
  const startedAt = options.startedAt || new Date().toISOString();
  const cursorBefore = options.cursorBefore ?? null;
  if (!options.endpointConfigured || typeof options.fetchFeed !== "function") {
    const result = flexLifecycleUnavailable("endpoint_not_configured", { connectorName, cursorBefore });
    if (options.checkpoint) await options.checkpoint({
      connectorName,
      connectorVersion: options.connectorVersion || "v1",
      sourceType: "flex",
      status: "unavailable",
      cursorBefore,
      cursorAfter: cursorBefore,
      startedAt,
      counts: { received: 0, observed: 0, triggered: 0, rejected: 0, failed: 0 },
      metadata: { reason: result.status, endpoint: options.endpoint || null },
    });
    return result;
  }

  let payload;
  try {
    payload = await options.fetchFeed(cursorBefore);
  } catch (error) {
    const result = {
      ...flexLifecycleUnavailable("endpoint_unavailable", {
        connectorName,
        cursorBefore,
        error: error?.message || String(error),
      }),
      ok: false,
      available: true,
      configured: true,
      connectorName,
      cursorBefore,
    };
    if (options.checkpoint) await options.checkpoint({
      connectorName,
      connectorVersion: options.connectorVersion || "v1",
      sourceType: "flex",
      status: "failed",
      cursorBefore,
      cursorAfter: cursorBefore,
      startedAt,
      counts: { received: 0, observed: 0, triggered: 0, rejected: 0, failed: 1 },
      errors: [{ message: result.error }],
      metadata: { reason: result.status, endpoint: options.endpoint || null },
    });
    return result;
  }

  const normalized = normalizeFlexLifecycleFeed(payload, {
    cursorBefore,
    observedAt: options.observedAt,
  });
  const observations = [];
  const rejected = [...normalized.rejected];
  const errors = [];
  for (const candidate of normalized.candidates) {
    try {
      const verified = options.verifyCandidate
        ? await options.verifyCandidate(candidate)
        : { ok: true, observation: candidate };
      if (!verified?.ok || !verified.observation) {
        rejected.push({
          ok: false,
          reason: verified?.reason || "candidate_not_authoritatively_verified",
          elementId: candidate.elementId,
        });
        continue;
      }
      const observed = options.observe
        ? await options.observe(verified.observation)
        : { ok: true, triggered: false, observation: verified.observation };
      if (!observed?.ok) throw new Error(observed?.error || "FLEX lifecycle observation failed.");
      observations.push(observed);
    } catch (error) {
      errors.push({ elementId: candidate.elementId, message: error?.message || String(error) });
    }
  }

  // Replays are idempotent, so a partial page deliberately retains the prior
  // cursor and retries the full page rather than silently skipping a failed event.
  const status = errors.length ? "partial" : "completed";
  const cursorAfter = errors.length ? cursorBefore : normalized.cursorAfter;
  const counts = {
    received: normalized.candidates.length + normalized.rejected.length,
    observed: observations.length,
    triggered: observations.filter(item => item.triggered).length,
    idempotent: observations.filter(item => item.idempotent).length,
    rejected: rejected.length,
    failed: errors.length,
  };
  if (options.checkpoint) await options.checkpoint({
    connectorName,
    connectorVersion: options.connectorVersion || "v1",
    sourceType: "flex",
    status,
    cursorBefore,
    cursorAfter,
    startedAt,
    counts,
    errors,
    metadata: { endpoint: options.endpoint || null, hasMore: normalized.hasMore },
  });
  return {
    ok: !errors.length,
    available: true,
    authoritative: true,
    status,
    connectorName,
    cursorBefore,
    cursorAfter,
    hasMore: normalized.hasMore,
    observations,
    rejected,
    errors,
    ...counts,
  };
}
