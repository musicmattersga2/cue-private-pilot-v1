import { createHash } from "node:crypto";

const MATCHER_VERSION = "google-workspace-review-preview-v1";
const GOOGLE_SOURCE_TYPES = new Set(["drive", "gmail", "email"]);
const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

function values(collection) {
  return collection && typeof collection === "object" ? Object.values(collection) : [];
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phrasePresent(text, phrase) {
  if (!phrase || phrase.length < 4) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

function stableId(kind, ...parts) {
  return `${kind}_${createHash("sha256").update([MATCHER_VERSION, ...parts].join("\u001f")).digest("hex").slice(0, 24)}`;
}

function currentSourceIds(sourceRecords) {
  const superseded = new Set();
  for (const source of sourceRecords) {
    if (source?.supersedesSourceRecordId) superseded.add(source.supersedesSourceRecordId);
  }
  return { superseded };
}

function isContentBearing(source) {
  const normalizedText = normalize(source?.normalizedText);
  const metadata = normalize([source?.payload?.name, source?.payload?.description].filter(Boolean).join(" "));
  if (!normalizedText) return false;
  if (!metadata) return normalizedText.length > 0;
  const remainder = normalizedText.replace(metadata, "").replace(/^file\s+/, "").trim();
  return remainder.length >= 24;
}

function aliasesFor(show) {
  return [...new Set([show?.name, ...(show?.aliases || []), ...(show?.normalizedAliases || [])]
    .map(item => normalize(typeof item === "string" ? item : item?.name || item?.value || item?.alias))
    .filter(item => item.length >= 4))];
}

function flexReferenceMatches(intake, flexDocuments, showIds) {
  const matched = new Set();
  for (const ref of intake?.flexDocumentRefs || []) {
    const records = flexDocuments.filter(document => {
      if (!document || !document.showIds?.length) return false;
      if (ref?.elementId && document.elementId === ref.elementId) return true;
      return Boolean(ref?.verified && ref?.documentNumber && document.documentNumber === ref.documentNumber);
    });
    const uniqueDocuments = records.length === 1 ? records : [];
    for (const document of uniqueDocuments) {
      for (const showId of document.showIds || []) if (showIds.has(showId)) matched.add(showId);
    }
  }
  return matched;
}

function supportSignals(show, evidence, source) {
  const signals = [];
  const operational = show?.operationalIdentity || {};
  if (phrasePresent(evidence, normalize(operational.client))) signals.push("client_support");
  if (phrasePresent(evidence, normalize(operational.venue))) signals.push("location_support");
  const dates = [show?.flex?.plannedStartDate, show?.flex?.plannedEndDate, show?.flex?.loadInDate, show?.flex?.loadOutDate]
    .map(value => String(value || "").slice(0, 10)).filter(Boolean);
  if (dates.some(date => String(source?.normalizedText || "").includes(date))) signals.push("date_support");
  if (source?.payload?.mimeType) signals.push("mime_context");
  return signals;
}

function candidateFor({ intake, source, show, signals, confidence, contentBearing }) {
  const candidateId = stableId("gwmc", intake.id, show.id);
  const facts = [...new Set(signals)].sort().map(signal => ({
    id: stableId("gwmf", candidateId, signal),
    candidateId,
    category: signal,
  }));
  return { id: candidateId, intakeItemId: intake.id, showId: show.id, confidence, contentBearing, facts };
}

function distribution(counts) {
  const result = { "0": 0, "1": 0, "2": 0, "3+": 0 };
  for (const count of counts) result[count >= 3 ? "3+" : String(count)] += 1;
  return result;
}

function emptyReasonCounts() {
  return {
    malformed_or_orphaned: 0,
    superseded_or_noncurrent: 0,
    already_authoritatively_matched: 0,
    no_supported_signal: 0,
    ambiguous_supported_signal: 0,
  };
}

export function buildGoogleWorkspaceMatchingPreview(db, { maxItems = 5000 } = {}) {
  if (!db || typeof db !== "object") throw new Error("invalid_fixture");
  const sources = values(db.sourceRecords);
  const sourceById = new Map(sources.map(source => [source?.id, source]));
  const shows = values(db.showRegistry).filter(show => show?.id && show?.name);
  const showById = new Map(shows.map(show => [show.id, show]));
  const showIds = new Set(showById.keys());
  const flexDocuments = values(db.flexDocumentRegistry);
  const { superseded } = currentSourceIds(sources);
  const allIntake = values(db.intakeItems);
  const googleIntake = allIntake.filter(intake => GOOGLE_SOURCE_TYPES.has(sourceById.get(intake?.sourceRecordId)?.sourceType));
  if (googleIntake.length > maxItems) throw new Error("preview_bound_exceeded");

  const reasons = emptyReasonCounts();
  const privateCandidates = [];
  const candidateCounts = [];
  let eligible = 0;
  let contentBearingEligible = 0;
  let metadataOnlyEligible = 0;
  let uniqueMatches = 0;
  let ambiguousMatches = 0;

  for (const intake of googleIntake.sort((a, b) => String(a?.id).localeCompare(String(b?.id)))) {
    const source = sourceById.get(intake?.sourceRecordId);
    if (!intake?.id || !intake?.sourceRecordId || !source?.id || !source?.sourceType || typeof source?.normalizedText !== "string") {
      reasons.malformed_or_orphaned += 1;
      continue;
    }
    if (intake.status === "superseded" || intake.supersededByIntakeItemId || superseded.has(source.id)) {
      reasons.superseded_or_noncurrent += 1;
      continue;
    }
    if (intake.matchedShowId && showById.has(intake.matchedShowId)) {
      reasons.already_authoritatively_matched += 1;
      continue;
    }

    eligible += 1;
    const contentBearing = isContentBearing(source);
    if (contentBearing) contentBearingEligible += 1;
    else metadataOnlyEligible += 1;
    const evidence = normalize([source.normalizedText, intake.summary].filter(Boolean).join(" "));
    const referenceMatches = flexReferenceMatches(intake, flexDocuments, showIds);
    if (intake.canonicalShowId && showById.has(intake.canonicalShowId)) referenceMatches.add(intake.canonicalShowId);
    const titleMatches = new Map();
    for (const show of shows) {
      const matchedAliases = aliasesFor(show).filter(alias => phrasePresent(evidence, alias));
      if (matchedAliases.length) titleMatches.set(show.id, matchedAliases);
    }
    const candidateShowIds = new Set([...referenceMatches, ...titleMatches.keys()]);
    candidateCounts.push(candidateShowIds.size);
    if (candidateShowIds.size === 0) {
      reasons.no_supported_signal += 1;
      continue;
    }
    if (candidateShowIds.size > 1) {
      ambiguousMatches += 1;
      reasons.ambiguous_supported_signal += 1;
    } else {
      uniqueMatches += 1;
    }
    for (const showId of [...candidateShowIds].sort()) {
      const show = showById.get(showId);
      const signals = [];
      if (referenceMatches.has(showId)) signals.push("verified_reference");
      if (titleMatches.has(showId)) signals.push("normalized_title_or_alias");
      signals.push(...supportSignals(show, evidence, source));
      let confidence = referenceMatches.has(showId) ? "high" : "medium";
      if (!contentBearing && confidence !== "high") confidence = "low";
      if (candidateShowIds.size > 1 && !referenceMatches.has(showId) && CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER.low) confidence = "low";
      privateCandidates.push(candidateFor({ intake, source, show, signals, confidence, contentBearing }));
    }
  }

  privateCandidates.sort((a, b) => a.id.localeCompare(b.id));
  const facts = privateCandidates.flatMap(candidate => candidate.facts).sort((a, b) => a.id.localeCompare(b.id));
  const candidateIds = new Set(privateCandidates.map(candidate => candidate.id));
  const factIds = new Set(facts.map(fact => fact.id));
  const confidenceBands = { high: 0, medium: 0, low: 0 };
  const evidenceSignals = {};
  let contentBearingCandidates = 0;
  let metadataOnlyCandidates = 0;
  for (const candidate of privateCandidates) {
    confidenceBands[candidate.confidence] += 1;
    if (candidate.contentBearing) contentBearingCandidates += 1;
    else metadataOnlyCandidates += 1;
    for (const fact of candidate.facts) evidenceSignals[fact.category] = (evidenceSignals[fact.category] || 0) + 1;
  }

  const report = {
    matcherVersion: MATCHER_VERSION,
    cohort: { total: googleIntake.length, eligible, excluded: googleIntake.length - eligible },
    exclusionsByReason: reasons,
    matches: {
      noCandidate: reasons.no_supported_signal,
      unique: uniqueMatches,
      ambiguous: ambiguousMatches,
      manualReviewVolume: uniqueMatches + ambiguousMatches,
    },
    candidateCountDistribution: distribution(candidateCounts),
    confidenceBands,
    evidenceSignalCategories: Object.fromEntries(Object.entries(evidenceSignals).sort(([a], [b]) => a.localeCompare(b))),
    evidenceMode: {
      eligibleContentBearing: contentBearingEligible,
      eligibleMetadataOnly: metadataOnlyEligible,
      candidateContentBearing: contentBearingCandidates,
      candidateMetadataOnly: metadataOnlyCandidates,
    },
    projections: { matchCandidates: privateCandidates.length, candidateFacts: facts.length },
    collisionChecks: {
      candidateIdCollisions: privateCandidates.length - candidateIds.size,
      candidateFactIdCollisions: facts.length - factIds.size,
    },
    mutations: { persisted: 0, proposals: 0, operationalUpdates: 0, providerRequests: 0 },
  };
  return { report, privateProjection: { candidates: privateCandidates, facts } };
}

export function sanitizedGoogleWorkspaceMatchingPreview(db, options) {
  return buildGoogleWorkspaceMatchingPreview(db, options).report;
}
