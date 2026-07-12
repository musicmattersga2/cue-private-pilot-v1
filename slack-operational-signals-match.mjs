/**
 * Slack Operational Signals — deterministic show matching + confidence bands.
 * Improves candidate evidence (aliases, fuzzy, recency, channel) without lowering
 * global thresholds (high >= 100, medium >= 55).
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

const GENERIC_TOKENS = new Set([
  "festival",
  "stage",
  "show",
  "audio",
  "lighting",
  "video",
  "led",
  "wall",
  "rigging",
  "power",
  "staging",
  "main",
  "event",
  "tour",
  "production",
  "productions",
  "inc",
  "llc",
  "the",
  "and",
  "for",
  "with",
  "from",
  "package",
  "kit",
  "trailer",
  "truck",
  "warehouse",
  "live",
  "continuum",
]);

// Two-letter / common English tokens must never become acronym aliases.
const WEAK_ACRONYMS = new Set([
  "as",
  "em",
  "at",
  "on",
  "in",
  "to",
  "or",
  "an",
  "be",
  "we",
  "it",
  "if",
  "do",
  "so",
  "no",
  "ok",
  "pm",
  "am",
  "re",
  "me",
  "my",
  "us",
  "im",
  "is",
  "of",
  "by",
  "up",
]);

const WORKSTREAM_SUFFIX_RE =
  /\b(audio|lighting|video|led(?:\s*wall)?|rigging|power|staging|stage\s*[12]|main\s*stage|sl\d+|continuum)\b/gi;

/**
 * Distinctive conversational alias from a FLEX / Active Shows title.
 * Example: "Paul Simon LED Wall - 2026" → "paul simon"
 */
export function stripShowNameDecorations(showName) {
  let text = asString(showName).toLowerCase();
  if (!text) return "";
  text = text.replace(/\b20\d{2}\b/g, " ");
  text = text.replace(
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*[-–—]\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\b/g,
    " "
  );
  text = text.replace(WORKSTREAM_SUFFIX_RE, " ");
  text = text.replace(/[-–—|:]+/g, " ");
  return normalizeName(text);
}

export function buildShowNameAliases(showName, extraAliases = []) {
  const raw = asString(showName);
  const stripped = stripShowNameDecorations(raw);
  const aliases = unique([raw, stripped, ...(extraAliases || [])]);

  const tokens = stripped.split(/\s+/).filter((t) => t && !GENERIC_TOKENS.has(t));
  if (tokens.length >= 2) {
    const acronym = tokens.map((t) => t[0]).join("");
    if (
      acronym.length >= 3 &&
      acronym.length <= 6 &&
      !WEAK_ACRONYMS.has(acronym)
    ) {
      aliases.push(acronym);
    }
  }
  // Preserve first two distinctive tokens as shorthand ("sound haven").
  if (tokens.length >= 2) {
    aliases.push(tokens.slice(0, 2).join(" "));
  }
  if (tokens.length === 1 && tokens[0].length >= 4) {
    aliases.push(tokens[0]);
  }
  return unique(aliases.map((a) => normalizeName(a)).filter(Boolean));
}

function levenshtein(a, b) {
  const s = asString(a);
  const t = asString(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = Array.from({ length: s.length + 1 }, () =>
    new Array(t.length + 1).fill(0)
  );
  for (let i = 0; i <= s.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }
  return rows[s.length][t.length];
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

function signedDaysUntil(date) {
  if (!date) return null;
  const now = new Date();
  return (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
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

function channelWorkstreamBoost(channelName, show) {
  const channel = normalizeName(channelName);
  const depts = unique(show.departments || []).map((d) => normalizeName(d));
  const nameBlob = normalizeName(
    [show.showName || show.name, ...(show.aliases || [])].join(" ")
  );

  const rules = [
    { channel: /lighting|light/, tokens: ["lighting", "led", "lx"] },
    { channel: /video/, tokens: ["video", "led"] },
    { channel: /audio|warehouse/, tokens: ["audio", "warehouse"] },
    { channel: /rigging/, tokens: ["rigging"] },
    { channel: /logistics/, tokens: ["trucking", "logistics", "warehouse"] },
  ];

  for (const rule of rules) {
    if (!rule.channel.test(channel)) continue;
    const hit = rule.tokens.some(
      (token) => depts.includes(token) || nameBlob.includes(token)
    );
    if (hit) return { boost: 10, reason: `Channel context aligns (${channelName})` };
    // Logistics can boost show-level trucking even without dept tags.
    if (/logistics/.test(channel)) {
      return { boost: 5, reason: `Logistics channel show-level boost` };
    }
  }
  return { boost: 0, reason: null };
}

function recencyAdjustment(show) {
  const status = normalizeName(show.status || show.readinessStatus || "");
  const explicitDays = Number(
    String(show.daysOut ?? "").replace(/[^\d.-]/g, "")
  );
  let daysOut = Number.isFinite(explicitDays) ? explicitDays : null;
  if (daysOut == null) {
    const start = parseLooseDate(
      show.plannedStartDate || show.loadInDate || show.showStartDate
    );
    const signed = signedDaysUntil(start);
    if (signed != null) daysOut = signed;
  }

  const closed =
    /past|complete|closed|done|archiv/.test(status) ||
    (daysOut != null && daysOut < -14);
  if (closed) {
    return { delta: -25, reason: "Historical/closed show penalty" };
  }

  let delta = 0;
  const reasons = [];
  if (String(show.source || "").toLowerCase() === "active_shows") {
    delta += 10;
    reasons.push("Prefer current Active Shows candidate");
  }
  if (daysOut != null && daysOut >= 0 && daysOut <= 30) {
    delta += 20;
    reasons.push("Active/upcoming within 30 days");
  } else if (daysOut != null && daysOut > 30 && daysOut <= 60) {
    delta += 10;
    reasons.push("Upcoming within 60 days");
  }
  return { delta, reason: reasons.join("; ") || null };
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

function aliasHitsInText(textNorm, aliases) {
  const hits = [];
  for (const alias of aliases || []) {
    const a = normalizeName(alias);
    if (!a) continue;
    if (a.length >= 4 && textNorm.includes(a)) {
      hits.push({ alias: a, strength: "exact" });
      continue;
    }
    // Short acronyms (NMR) as whole tokens only — never 1–2 letter English crumbs.
    if (
      a.length >= 3 &&
      a.length <= 4 &&
      !/\s/.test(a) &&
      !WEAK_ACRONYMS.has(a)
    ) {
      const re = new RegExp(`(?:^|\\s)${a}(?:\\s|$)`);
      if (re.test(textNorm)) hits.push({ alias: a, strength: "acronym" });
    }
  }
  return hits;
}

function tokenOverlapScore(textNorm, aliasNorm) {
  const textTokens = new Set(
    textNorm.split(/\s+/).filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t))
  );
  const aliasTokens = aliasNorm
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
  if (!aliasTokens.length) return { overlap: [], score: 0 };
  const overlap = aliasTokens.filter((t) => textTokens.has(t));
  if (!overlap.length) return { overlap, score: 0 };
  const ratio = overlap.length / aliasTokens.length;
  if (ratio >= 1 && overlap.length >= 2) return { overlap, score: 65 };
  if (ratio >= 1 && overlap.length === 1 && overlap[0].length >= 6) {
    return { overlap, score: 55 };
  }
  // Distinctive leading token only ("Piedmont needs cable" vs "Piedmont Finals").
  if (
    overlap.includes(aliasTokens[0]) &&
    aliasTokens[0].length >= 6 &&
    textTokens.has(aliasTokens[0])
  ) {
    return { overlap: [aliasTokens[0]], score: 55 };
  }
  if (overlap.length >= 2) return { overlap, score: 45 };
  return { overlap, score: 0 };
}

function fuzzyNameHit(textNorm, aliasNorm) {
  if (!aliasNorm || aliasNorm.length < 6) return null;
  const window = aliasNorm.length + 2;
  const words = textNorm.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    for (let len = 1; len <= 4 && i + len <= words.length; len += 1) {
      const slice = words.slice(i, i + len).join(" ");
      if (Math.abs(slice.length - aliasNorm.length) > 3) continue;
      if (slice.length < 6) continue;
      if (slice.length > window + 3) continue;
      const dist = levenshtein(slice, aliasNorm);
      const maxDist = aliasNorm.length >= 10 ? 2 : 1;
      if (dist > 0 && dist <= maxDist) {
        return { slice, dist };
      }
    }
  }
  return null;
}

/**
 * @param {object} message normalized slack message
 * @param {Array<object>} candidateShows
 */
export function matchSlackMessageToShows(message, candidateShows = []) {
  const entities = message?.extractedEntities || {};
  const textNorm = normalizeName(message?.text);
  const results = [];
  const candidates = candidateShows || [];

  // Precompute alias uniqueness for short aliases.
  const aliasOwnerCounts = new Map();
  for (const show of candidates) {
    const aliases = buildShowNameAliases(
      show.showName || show.name,
      show.aliases || []
    );
    for (const alias of aliases) {
      aliasOwnerCounts.set(alias, (aliasOwnerCounts.get(alias) || 0) + 1);
    }
  }

  for (const show of candidates) {
    const reasons = [];
    const evidence = {};
    const matchedEntities = {};
    let score = 0;
    let weakSignals = 0;
    let parentShowOnly = false;

    const showName = asString(show.showName || show.name);
    const showKey = asString(
      show.showKey || show.id || normalizeName(showName).replace(/\s+/g, "-")
    );
    const docs = unique(show.documentNumbers || show.relatedQuotes || []);
    const aliases = buildShowNameAliases(showName, show.aliases || []);
    const client = asString(show.client);
    const venue = asString(show.venue);
    const trucks = unique(show.truckNumbers || show.trucks || []);
    const trailers = unique(show.trailerNumbers || show.trailers || []);

    const quoteHits = (entities.quotes || []).filter((q) =>
      docs.map((d) => d.toLowerCase()).includes(String(q).toLowerCase())
    );
    if (quoteHits.length) {
      // Exact quote is strong, but FLEX search can attach a quote number to the
      // wrong element. Require name/alias corroboration in the message before
      // granting full auto-attach credit for flex_quote_lookup candidates.
      const corroborationTokens = unique(
        [
          ...aliases,
          stripShowNameDecorations(showName),
          normalizeName(showName),
        ]
          .join(" ")
          .split(/\s+/)
          .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t))
      );
      const hasNameCorroboration =
        String(show.source || "").toLowerCase() !== "flex_quote_lookup" ||
        corroborationTokens.some((token) => textNorm.includes(token)) ||
        quoteHits.some((q) =>
          normalizeName(showName).includes(normalizeName(q))
        );

      if (hasNameCorroboration) {
        score += 100;
        reasons.push(`Exact quote match: ${quoteHits.join(", ")}`);
        evidence.quotes = quoteHits;
        matchedEntities.quotes = quoteHits;
      } else {
        score += 40;
        weakSignals += 1;
        reasons.push(
          `Unverified quote mapping: ${quoteHits.join(
            ", "
          )} (no name corroboration)`
        );
        evidence.unverifiedQuotes = quoteHits;
      }
    }

    const showNorm = normalizeName(showName);
    const stripped = stripShowNameDecorations(showName);
    let strongNameHit = false;

    if (showNorm && showNorm.length >= 4 && textNorm.includes(showNorm)) {
      score += 70;
      strongNameHit = true;
      reasons.push(`Exact normalized show name: ${showName}`);
      evidence.showName = showName;
      matchedEntities.showName = showName;
    } else if (stripped && stripped.length >= 4 && textNorm.includes(stripped)) {
      score += 70;
      strongNameHit = true;
      parentShowOnly = quoteHits.length === 0;
      reasons.push(`Exact normalized alias: ${stripped}`);
      evidence.alias = stripped;
      matchedEntities.alias = stripped;
    } else {
      // Distinctive multi-word phrase inside a longer title ("Paul Simon is loaded"
      // vs "Chastain: Paul Simon").
      const distinctiveTokens = (stripped || showNorm)
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
      let phraseHit = null;
      for (let i = 0; i < distinctiveTokens.length - 1; i += 1) {
        const phrase = `${distinctiveTokens[i]} ${distinctiveTokens[i + 1]}`;
        if (phrase.length >= 6 && textNorm.includes(phrase)) {
          phraseHit = phrase;
          break;
        }
      }
      if (phraseHit) {
        score += 70;
        strongNameHit = true;
        parentShowOnly = quoteHits.length === 0;
        reasons.push(`Exact normalized alias: ${phraseHit}`);
        evidence.alias = phraseHit;
        matchedEntities.alias = phraseHit;
      } else {
      const hits = aliasHitsInText(textNorm, aliases);
      const bestExact = hits.find((h) => h.strength === "exact");
      const bestAcronym = hits.find((h) => h.strength === "acronym");
      if (bestExact) {
        const uniqueAlias = (aliasOwnerCounts.get(bestExact.alias) || 0) <= 1;
        score += uniqueAlias ? 70 : 50;
        strongNameHit = uniqueAlias;
        parentShowOnly = quoteHits.length === 0;
        reasons.push(`Exact normalized alias: ${bestExact.alias}`);
        evidence.alias = bestExact.alias;
        matchedEntities.alias = bestExact.alias;
      } else if (bestAcronym) {
        const uniqueAlias = (aliasOwnerCounts.get(bestAcronym.alias) || 0) <= 1;
        if (uniqueAlias) {
          score += 60;
          strongNameHit = true;
          parentShowOnly = quoteHits.length === 0;
          reasons.push(`Acronym match: ${bestAcronym.alias}`);
          evidence.alias = bestAcronym.alias;
          matchedEntities.alias = bestAcronym.alias;
        } else {
          score += 35;
          weakSignals += 1;
          reasons.push(`Ambiguous acronym: ${bestAcronym.alias}`);
          evidence.alias = bestAcronym.alias;
        }
      } else {
        const overlap = tokenOverlapScore(textNorm, stripped || showNorm);
        if (overlap.score > 0) {
          score += overlap.score;
          if (overlap.score >= 65) strongNameHit = true;
          else weakSignals += 1;
          parentShowOnly = quoteHits.length === 0;
          reasons.push(`Token overlap: ${overlap.overlap.join(", ")}`);
          evidence.tokenOverlap = overlap.overlap;
          matchedEntities.alias = overlap.overlap.join(" ");
        } else {
          const fuzzy = fuzzyNameHit(textNorm, stripped || showNorm);
          if (fuzzy) {
            const uniqueFuzzy =
              candidates.filter((other) => {
                const otherAlias = stripShowNameDecorations(
                  other.showName || other.name
                );
                return (
                  otherAlias &&
                  levenshtein(otherAlias, stripped || showNorm) <= 2
                );
              }).length <= 1;
            if (uniqueFuzzy) {
              score += 55;
              strongNameHit = true;
              parentShowOnly = quoteHits.length === 0;
              reasons.push(
                `Fuzzy name match: "${fuzzy.slice}" ≈ "${stripped || showNorm}"`
              );
              evidence.fuzzy = fuzzy;
              matchedEntities.alias = stripped || showNorm;
            }
          }
        }
      }
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

    const channelBoost = channelWorkstreamBoost(message.channelName, show);
    if (channelBoost.boost) {
      score += channelBoost.boost;
      weakSignals += 1;
      reasons.push(channelBoost.reason);
      evidence.channel = message.channelName;
    }

    const recency = recencyAdjustment(show);
    if (recency.delta) {
      score += recency.delta;
      if (recency.reason) reasons.push(recency.reason);
      evidence.recencyDelta = recency.delta;
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

    const hasStrong =
      quoteHits.length > 0 ||
      strongNameHit ||
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
      // Preserve the candidate show's known FLEX documents for operator
      // context even when the message only identifies the parent show. The
      // workstreamUnspecified flag still prevents treating one child quote as
      // definitively selected.
      documentNumbers: docs,
      primaryDocumentNumber: show.primaryDocumentNumber || null,
      elementId: show.elementId || null,
      documentRefs: Array.isArray(show.documentRefs) ? show.documentRefs : [],
      quoteElements: Array.isArray(show.quoteElements) ? show.quoteElements : [],
      workstreamUnspecified: Boolean(parentShowOnly && quoteHits.length === 0),
      confidence: confidenceBand,
      confidenceBand,
      score,
      reasons,
      evidence,
      matchedEntities,
      matchState: matchStateForConfidence(confidenceBand),
      source: show.source || null,
    });
  }

  results.sort((a, b) => b.score - a.score);

  // Ambiguity: multiple plausible matches sharing the same shorthand/alias and
  // no exact quote → Needs Review (do not auto-attach).
  const top = results[0];
  if (top && !(top.evidence?.quotes || []).length && top.score >= 55) {
    const topAlias = normalizeName(
      top.evidence?.alias || top.matchedEntities?.alias || ""
    );
    const contenders = results.filter((item) => {
      if (item.score < 55) return false;
      const itemAlias = normalizeName(
        item.evidence?.alias || item.matchedEntities?.alias || ""
      );
      if (topAlias && itemAlias && topAlias === itemAlias) return true;
      // Close scores without a shared alias still count as ambiguous shorthand.
      return top.score - item.score <= 25;
    });
    if (contenders.length >= 2) {
      for (const item of contenders) {
        item.confidenceBand = "medium";
        item.confidence = "medium";
        item.matchState = "needs_review";
        item.reasons = unique([
          ...(item.reasons || []),
          `Ambiguous shorthand among multiple shows: ${contenders
            .map((c) => c.showName)
            .join(", ")}`,
        ]);
      }
    }
  }

  return results;
}

export function pickPrimaryMatch(matches = []) {
  if (!matches.length) return null;
  return matches[0];
}

export function debugMatchMessage(message, candidateShows = []) {
  const matches = matchSlackMessageToShows(message, candidateShows);
  const primary = pickPrimaryMatch(matches);
  return {
    extractedQuotes: message?.extractedEntities?.quotes || [],
    entities: message?.extractedEntities || {},
    candidateShowCount: (candidateShows || []).length,
    candidateQuoteNumbers: unique(
      (candidateShows || []).flatMap((s) => s.documentNumbers || [])
    ),
    matchScores: matches.map((m) => ({
      showName: m.showName,
      score: m.score,
      confidence: m.confidenceBand,
      matchState: m.matchState,
      reasons: m.reasons,
      documentNumbers: m.documentNumbers,
    })),
    primary,
    finalQueueDecision: primary?.matchState || "general_queue",
  };
}
