/**
 * Slack Operational Signals — normalize messages, extract entities, classify.
 */

const QUOTE_RE = /\b(\d{2}-\d{3,6})\b/g;
const TRUCK_RE = /\b(?:truck|unit|rig)\s*#?\s*([A-Za-z0-9-]{2,12})\b/gi;
const TRAILER_RE = /\b(?:trailer|trl)\s*#?\s*([A-Za-z0-9-]{2,12})\b/gi;
const DOCK_RE = /\bdock\s*#?\s*([A-Za-z0-9-]{1,8})\b/gi;
const DATE_RE =
  /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/gi;

const DEPT_TERMS = {
  audio: /\baudio\b/i,
  lighting: /\blight(?:ing|s)?\b/i,
  video: /\bvideo\b/i,
  led: /\bled\b/i,
  rigging: /\brigging\b/i,
  power: /\bpower\b/i,
  staging: /\bstaging\b/i,
  warehouse: /\bwarehouse|pull(?:ed|ing)?|pack(?:ed|ing)?\b/i,
  trucking: /\btruck(?:ing)?|load[- ]?(?:in|out)|trailer|driver|dock\b/i,
};

function asString(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function slackTsToIso(ts) {
  const num = Number(String(ts || "").split(".")[0]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Date(num * 1000).toISOString();
}

export function buildMessageKey(channelId, ts) {
  return `${asString(channelId)}:${asString(ts)}`;
}

export function computeMessageContentHash(parts) {
  const payload = JSON.stringify({
    text: asString(parts?.text),
    editedTs: asString(parts?.editedTs) || null,
    subtype: asString(parts?.subtype) || null,
    deleted: Boolean(parts?.deleted),
    threadTs: asString(parts?.threadTs) || null,
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash * 31 + payload.charCodeAt(i)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

export function extractSlackEntities(text, options = {}) {
  const raw = asString(text);
  const quotes = uniqueStrings([...(raw.matchAll(QUOTE_RE) || [])].map((m) => m[1]));
  const trucks = uniqueStrings([...(raw.matchAll(TRUCK_RE) || [])].map((m) => m[1]));
  const trailers = uniqueStrings([...(raw.matchAll(TRAILER_RE) || [])].map((m) => m[1]));
  const docks = uniqueStrings([...(raw.matchAll(DOCK_RE) || [])].map((m) => m[1]));
  const dates = uniqueStrings([...(raw.matchAll(DATE_RE) || [])].map((m) => m[0]));

  const departments = Object.entries(DEPT_TERMS)
    .filter(([, re]) => re.test(raw))
    .map(([name]) => name);

  const showHints = uniqueStrings(options.knownShowNames || [])
    .filter((name) => {
      const n = name.toLowerCase();
      return n.length >= 4 && raw.toLowerCase().includes(n);
    });

  const clientHints = uniqueStrings(options.knownClients || []).filter((name) => {
    const n = name.toLowerCase();
    return n.length >= 4 && raw.toLowerCase().includes(n);
  });

  const venueHints = uniqueStrings(options.knownVenues || []).filter((name) => {
    const n = name.toLowerCase();
    return n.length >= 4 && raw.toLowerCase().includes(n);
  });

  return {
    quotes,
    trucks,
    trailers,
    docks,
    dates,
    departments,
    showHints,
    clientHints,
    venueHints,
    hasBol: /\bbol\b|bill of lading/i.test(raw),
    hasLoadIn: /\bload[- ]?in\b/i.test(raw),
    hasLoadOut: /\bload[- ]?out\b/i.test(raw),
    readinessTerms: uniqueStrings(
      ["ready", "pulled", "packed", "loaded", "confirmed", "complete"].filter((term) =>
        new RegExp(`\\b${term}\\b`, "i").test(raw)
      )
    ),
    unresolvedTerms: uniqueStrings(
      ["tbd", "need", "missing", "waiting", "maybe", "not sent", "blocked", "hold"].filter(
        (term) => new RegExp(`\\b${term.replace(/\s+/g, "[- ]")}\\b`, "i").test(raw)
      )
    ),
    resolutionTerms: uniqueStrings(
      ["resolved", "confirmed", "assigned", "sent", "complete", "fixed", "not needed"].filter(
        (term) => new RegExp(`\\b${term.replace(/\s+/g, "[- ]")}\\b`, "i").test(raw)
      )
    ),
  };
}

export function classifyOperationalMessage(text, entities = {}) {
  const raw = asString(text);
  const categories = new Set();
  const facts = [];

  if (/\btruck|trailer|driver|load[- ]?(?:in|out)|maybe truck/i.test(raw) || entities.trucks?.length) {
    categories.add("trucking");
  }
  if (/\bwarehouse|pull|pack(?:ed|ing)?|cable package/i.test(raw)) {
    categories.add("warehouse");
  }
  if (/\bequipment|motor|shortage|substitut|need .+ more/i.test(raw)) {
    categories.add("equipment");
  }
  if (entities.docks?.length || /\bdock\b/i.test(raw)) {
    categories.add("dock");
  }
  if (entities.hasBol) {
    categories.add("bol");
  }
  if (/\bstaff|crew|labor|tech\b/i.test(raw)) {
    categories.add("staffing");
  }
  if (entities.hasLoadIn || entities.hasLoadOut || entities.dates?.length) {
    categories.add("schedule");
  }
  if (entities.readinessTerms?.length) {
    categories.add("readiness");
  }

  const unresolved =
    Boolean(entities.unresolvedTerms?.length) ||
    /\bmaybe truck|still unresolved|waiting on|missing\b/i.test(raw);
  const resolutionSignal =
    Boolean(entities.resolutionTerms?.length) ||
    /\bresolved|not needed|fixed|complete\b/i.test(raw);

  if (unresolved) categories.add("unresolved_issue");
  if (resolutionSignal) categories.add("resolution");
  if (!categories.size) categories.add("general_operations");

  let status = "info";
  if (/\bblocked|cannot (?:load|ship|pull)|hard stop\b/i.test(raw)) {
    status = "blocked";
  } else if (resolutionSignal && !unresolved) {
    status = "resolved";
  } else if (
    /\bat risk|shortage|need .+ more|maybe truck|not sent|missing\b/i.test(raw) ||
    unresolved
  ) {
    status = /\bmaybe|tbd|waiting|confirm\b/i.test(raw) ? "needs_review" : "at_risk";
  } else if (/\btbd|waiting|confirm|maybe\b/i.test(raw)) {
    status = "needs_review";
  }

  if (entities.quotes?.length) {
    facts.push(`Quotes: ${entities.quotes.join(", ")}`);
  }
  if (entities.docks?.length) facts.push(`Dock: ${entities.docks.join(", ")}`);
  if (entities.hasBol) facts.push("BOL referenced");
  if (entities.trucks?.length) facts.push(`Truck/unit: ${entities.trucks.join(", ")}`);

  const summary = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;

  return {
    categories: [...categories],
    status,
    summary,
    extractedFacts: facts,
    unresolved: unresolved && status !== "resolved",
    resolutionSignal,
  };
}

export function normalizeSlackMessage(rawMessage, context = {}) {
  const channelId = asString(context.channelId || rawMessage?.channel);
  const ts = asString(rawMessage?.ts);
  const editedTs = asString(rawMessage?.edited?.ts || rawMessage?.edited_ts) || null;
  const threadTs = asString(rawMessage?.thread_ts) || null;
  const subtype = asString(rawMessage?.subtype) || null;
  const deleted =
    Boolean(rawMessage?.deleted) ||
    subtype === "message_deleted" ||
    Boolean(rawMessage?.hidden && subtype === "message_deleted");
  const text = asString(rawMessage?.text);
  const userId = asString(rawMessage?.user || rawMessage?.bot_id) || null;
  const authorName =
    asString(context.authorName) ||
    asString(rawMessage?.username) ||
    asString(rawMessage?.user_profile?.display_name) ||
    userId ||
    "Unknown";

  const entities = extractSlackEntities(text, context);
  const classification = classifyOperationalMessage(text, entities);
  const contentHash = computeMessageContentHash({
    text,
    editedTs,
    subtype,
    deleted,
    threadTs,
  });

  return {
    messageKey: buildMessageKey(channelId, ts),
    channelId,
    channelName: asString(context.channelName) || channelId,
    ts,
    editedTs,
    threadTs: threadTs && threadTs !== ts ? threadTs : null,
    userId,
    authorName,
    text,
    permalink: asString(context.permalink || rawMessage?.permalink) || null,
    subtype,
    deleted,
    ingestedAt: context.ingestedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contentHash,
    timestampIso: slackTsToIso(ts),
    extractedEntities: entities,
    operationalClassification: classification,
    matches: Array.isArray(rawMessage?.matches) ? rawMessage.matches : [],
  };
}

export function isOperationallyRelevant(normalized) {
  if (!normalized || normalized.deleted) return false;
  if (isSlackSystemNoise(normalized)) return false;
  const cats = normalized.operationalClassification?.categories || [];
  if (!cats.length || (cats.length === 1 && cats[0] === "general_operations")) {
    const entities = normalized.extractedEntities || {};
    return Boolean(
      entities.quotes?.length ||
        entities.showHints?.length ||
        entities.trucks?.length ||
        entities.docks?.length ||
        entities.hasBol
    );
  }
  return true;
}

/**
 * Channel joins, deleted placeholders, and Slackbot admin noise.
 * Kept in cache for audit, but excluded from operational queues.
 */
export function isSlackSystemNoise(message) {
  if (!message) return false;
  if (message.deleted) return true;
  const subtype = asString(message.subtype).toLowerCase();
  if (
    [
      "channel_join",
      "channel_leave",
      "channel_archive",
      "channel_unarchive",
      "group_join",
      "group_leave",
      "channel_name",
      "channel_purpose",
      "channel_topic",
      "message_deleted",
      "bot_add",
      "bot_remove",
    ].includes(subtype)
  ) {
    return true;
  }
  const text = asString(message.text);
  if (/has joined the channel/i.test(text)) return true;
  if (/^this message was deleted\.?$/i.test(text)) return true;
  const author = asString(message.authorName || message.userId).toUpperCase();
  if (author === "USLACKBOT" && (!text || text.length < 8 || /joined|left|archived|purpose|topic/i.test(text))) {
    return true;
  }
  return false;
}
