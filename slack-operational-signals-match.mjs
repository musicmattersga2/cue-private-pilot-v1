/**
 * Slack Operational Signals — deterministic show matching + confidence bands.
 */

function asString(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set((values || []).map((v) => asString(v)).filter(Boolean))];
}

function parseLooseDate(value, referenceIso = null) {
  const text = asString(value);
  if (!text) return null;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return new Date(iso);

  const md = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (md) {
    const ref = referenceIso ? new Date(referenceIso) : new Date();
    let year = md[3] ? Number(md[3]) : ref.getUTCFullYear();
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, Number(md[1]) - 1, Number(md[2])));
  }

  const mon = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i
  );
  if (mon) {
    const months = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      sept: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const ref = referenceIso ? new Date(referenceIso) : new Date();
    const year = mon[3] ? Number(mon[3]) : ref.getUTCFullYear();
    return new Date(Date.UTC(year, months[mon[1].toLowerCase()], Number(mon[2])));
  }
  return null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function nearestShowDateDistance(show, messageIso, extractedDates) {
  const showYearHint =
    parseLooseDate(show.plannedStartDate || show.loadInDate || show.showStartDate)?.getUTCFullYear() ||
    null;
  const refs = unique([
    show.plannedStartDate,
    show.plannedEndDate,
    show.loadInDate,
    show.loadOutDate,
    show.showStartDate,
    show.timingDate,
    ...(show.truckingDates || []),
  ])
    .map((value) => parseLooseDate(value, messageIso))
    .filter(Boolean);

  const messageDates = [
    ...(extractedDates || []).map((d) => {
      const withShowYear =
        showYearHint && !/\d{4}/.test(String(d))
          ? `${d}, ${showYearHint}`
          : d;
      return parseLooseDate(withShowYear, messageIso);
    }),
  ].filter(Boolean);

  if (!refs.length || !messageDates.length) return null;

  let best = Infinity;
  for (const msgDate of messageDates) {
    for (const ref of refs) {
      const dist = daysBetween(msgDate, ref);
      if (dist != null && dist < best) best = dist;
    }
  }
  return Number.isFinite(best) ? best : null;
}

export function scoreMatchConfidence(score) {
  if (score >= 100) return "high";
  if (score >= 55) return "medium";
  return "low";
}

export function matchStateForConfidence(band, options = {}) {
  if (options.manualState) return options.manualState;
  if (band === "high") return "auto_attached";
  if (band === "medium") return "needs_review";
  return "general_queue";
}

/**
 * @param {object} message normalized slack message
 * @param {Array<object>} candidateShows
 */
export function matchSlackMessageToShows(message, candidateShows = []) {
  const entities = message?.extractedEntities || {};
  const textNorm = normalizeName(message?.text);
  const results = [];

  for (const show of candidateShows || []) {
    const reasons = [];
    const evidence = {};
    const matchedEntities = {};
    let score = 0;
    let weakSignals = 0;

    const showName = asString(show.showName || show.name);
    const showKey = asString(show.showKey || show.id || normalizeName(showName).replace(/\s+/g, "-"));
    const docs = unique(show.documentNumbers || show.relatedQuotes || []);
    const aliases = unique(show.aliases || []);
    const client = asString(show.client);
    const venue = asString(show.venue);
    const trucks = unique(show.truckNumbers || show.trucks || []);
    const trailers = unique(show.trailerNumbers || show.trailers || []);

    const quoteHits = (entities.quotes || []).filter((q) =>
      docs.map((d) => d.toLowerCase()).includes(String(q).toLowerCase())
    );
    if (quoteHits.length) {
      score += 100;
      reasons.push(`Exact quote match: ${quoteHits.join(", ")}`);
      evidence.quotes = quoteHits;
      matchedEntities.quotes = quoteHits;
    }

    const showNorm = normalizeName(showName);
    if (showNorm && showNorm.length >= 4 && textNorm.includes(showNorm)) {
      score += 70;
      reasons.push(`Exact normalized show name: ${showName}`);
      evidence.showName = showName;
      matchedEntities.showName = showName;
    } else {
      const aliasHit = aliases.find((alias) => {
        const a = normalizeName(alias);
        return a.length >= 3 && textNorm.includes(a);
      });
      if (aliasHit) {
        score += 45;
        weakSignals += 1;
        reasons.push(`Alias match: ${aliasHit}`);
        evidence.alias = aliasHit;
        matchedEntities.alias = aliasHit;
      }
    }

    if (client && normalizeName(client).length >= 4 && textNorm.includes(normalizeName(client))) {
      score += 25;
      weakSignals += 1;
      reasons.push(`Client match: ${client}`);
      evidence.client = client;
      matchedEntities.client = client;
    }

    if (venue && normalizeName(venue).length >= 4 && textNorm.includes(normalizeName(venue))) {
      score += 25;
      weakSignals += 1;
      reasons.push(`Venue match: ${venue}`);
      evidence.venue = venue;
      matchedEntities.venue = venue;
    }

    const truckHits = (entities.trucks || []).filter((t) =>
      trucks.map((x) => x.toLowerCase()).includes(String(t).toLowerCase())
    );
    const trailerHits = (entities.trailers || []).filter((t) =>
      trailers.map((x) => x.toLowerCase()).includes(String(t).toLowerCase())
    );
    if (truckHits.length || trailerHits.length) {
      score += 35;
      reasons.push(
        `Truck/trailer association: ${[...truckHits, ...trailerHits].join(", ")}`
      );
      evidence.trucks = truckHits;
      evidence.trailers = trailerHits;
      matchedEntities.trucks = truckHits;
      matchedEntities.trailers = trailerHits;
    }

    const dateDist = nearestShowDateDistance(
      show,
      message.timestampIso,
      entities.dates || []
    );
    if (dateDist != null) {
      if (dateDist <= 1) {
        score += 30;
        reasons.push("Date within 1 day of show schedule");
      } else if (dateDist <= 3) {
        score += 20;
        weakSignals += 1;
        reasons.push("Date within 3 days of show schedule");
      } else if (dateDist <= 7) {
        score += 10;
        weakSignals += 1;
        reasons.push("Date within 7 days of show schedule");
      }
      evidence.dateDistanceDays = Number(dateDist.toFixed(2));
    }

    const showDepts = unique(show.departments || []).map((d) => d.toLowerCase());
    const deptHits = (entities.departments || []).filter((d) =>
      showDepts.includes(String(d).toLowerCase())
    );
    if (deptHits.length) {
      score += 5;
      weakSignals += 1;
      reasons.push(`Department alignment: ${deptHits.join(", ")}`);
      evidence.departments = deptHits;
    }

    if (message.threadParentMatch?.showKey === showKey && message.threadParentMatch?.confidenceBand === "high") {
      score += 50;
      reasons.push("Thread parent already high-confidence matched");
      evidence.threadParent = message.threadParentMatch.showKey;
    }

    // Conflicting evidence penalties
    if (quoteHits.length === 0 && docs.length && (entities.quotes || []).length) {
      score -= 40;
      reasons.push("Conflicting quote numbers present");
    }
    if (
      client &&
      (entities.clientHints || []).length &&
      !(entities.clientHints || []).some((c) => normalizeName(c) === normalizeName(client))
    ) {
      score -= 20;
      reasons.push("Conflicting client evidence");
    }

    // Require more than one weak signal for automatic attachment when no strong signal.
    const hasStrong =
      quoteHits.length > 0 ||
      (showNorm && textNorm.includes(showNorm)) ||
      truckHits.length > 0 ||
      trailerHits.length > 0 ||
      message.threadParentMatch?.showKey === showKey;

    let confidenceBand = scoreMatchConfidence(score);
    if (confidenceBand === "high" && !hasStrong && weakSignals < 2) {
      confidenceBand = "medium";
      reasons.push("Downgraded: high score without strong signal / enough weak signals");
    }

    if (score <= 0 && !reasons.length) continue;

    results.push({
      showKey,
      showName,
      documentNumbers: docs,
      confidence: confidenceBand,
      confidenceBand,
      score,
      reasons,
      evidence,
      matchedEntities,
      matchState: matchStateForConfidence(confidenceBand),
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

export function pickPrimaryMatch(matches = []) {
  if (!matches.length) return null;
  return matches[0];
}
