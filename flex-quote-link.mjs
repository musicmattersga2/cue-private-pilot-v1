const DEFAULT_FLEX_WEB_BASE_URL = "https://m2.flexrentalsolutions.com/f5/ui/";
const DEFAULT_FLEX_QUOTE_VIEW_ID = "ca6b072c-b122-11df-b8d5-00e08175e43e";

export function isFlexElementId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

export function buildFlexQuoteUrl(elementId, options = {}) {
  const id = String(elementId || "").trim();
  if (!isFlexElementId(id)) throw new Error("A valid FLEX quote element ID is required.");

  const base = String(
    options.webBaseUrl || process.env.FLEX_WEB_BASE_URL || DEFAULT_FLEX_WEB_BASE_URL
  ).replace(/\/*$/, "/");
  const viewId = String(
    options.quoteViewId || process.env.FLEX_QUOTE_VIEW_ID || DEFAULT_FLEX_QUOTE_VIEW_ID
  ).trim();
  if (!isFlexElementId(viewId)) throw new Error("A valid FLEX quote view ID is required.");

  const url = new URL(base);
  if (url.protocol !== "https:") throw new Error("FLEX web base URL must use HTTPS.");
  return `${url.toString()}#fin-doc/${encodeURIComponent(id)}/doc-view/${encodeURIComponent(viewId)}/header`;
}

export function parseFlexQuoteUrl(value, options = {}) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("Enter a valid FLEX quote URL."); }
  const allowedBase = new URL(
    options.webBaseUrl || process.env.FLEX_WEB_BASE_URL || DEFAULT_FLEX_WEB_BASE_URL
  );
  const normalizePath = path => `${String(path || "").replace(/\/+$/, "")}/`;
  if (url.protocol !== "https:" || url.host !== allowedBase.host || normalizePath(url.pathname) !== normalizePath(allowedBase.pathname)) {
    throw new Error(`FLEX quote URL must use the authorized ${allowedBase.host}${allowedBase.pathname} location.`);
  }
  const fullMatch = url.hash.match(/^#fin-doc\/([0-9a-f-]{36})\/doc-view\/([0-9a-f-]{36})\/header$/i);
  const shortMatch = url.hash.match(/^#fin-doc\/([0-9a-f-]{36})\/?$/i);
  const match = fullMatch || shortMatch;
  if (!match || !isFlexElementId(match[1]) || (fullMatch && !isFlexElementId(match[2]))) {
    throw new Error("FLEX quote URL does not contain a valid financial-document element.");
  }
  return {
    elementId: match[1],
    quoteViewId: fullMatch ? match[2] : null,
    normalizedUrl: fullMatch
      ? buildFlexQuoteUrl(match[1], { webBaseUrl: allowedBase.toString(), quoteViewId: match[2] })
      : `${allowedBase.toString()}#fin-doc/${encodeURIComponent(match[1])}`,
  };
}

export function inferFlexDocumentType(value, fallback = "unknown") {
  const text = String(value || "").toLowerCase();
  if (/pull\s*sheet|pullsheet|\bps\b/.test(text)) return "pull_sheet";
  if (/event\s*folder/.test(text)) return "event_folder";
  if (/manifest|\bmn\b/.test(text)) return "manifest";
  if (/purchase\s*order|\blpo\b|\bpo\b/.test(text)) return "purchase_order";
  if (/invoice|\binv\b/.test(text)) return "invoice";
  if (/mmp\s*quote|sales\s*quote|\bquote\b|\bqt\b/.test(text)) return "quote";
  return fallback;
}

function normalizeIdentity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:mmp|quote|pull|sheet|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreFlexDocumentIdentity(candidate = {}, expected = {}) {
  const candidateName = normalizeIdentity(candidate.showName || candidate.name);
  const expectedName = normalizeIdentity(expected.showName || expected.name);
  const candidateClient = normalizeIdentity(candidate.client);
  const expectedClient = normalizeIdentity(expected.client);
  let score = 0;
  if (candidateName && expectedName) {
    if (candidateName === expectedName) score += 400;
    else if (candidateName.includes(expectedName) || expectedName.includes(candidateName)) score += 240;
    const expectedTokens = new Set(expectedName.split(" ").filter(token => token.length > 2));
    const candidateTokens = new Set(candidateName.split(" ").filter(token => token.length > 2));
    const overlap = [...expectedTokens].filter(token => candidateTokens.has(token)).length;
    if (expectedTokens.size) score += Math.round((overlap / expectedTokens.size) * 140);
  }
  if (candidateClient && expectedClient) {
    if (candidateClient === expectedClient) score += 100;
    else if (candidateClient.includes(expectedClient) || expectedClient.includes(candidateClient)) score += 60;
  }
  if (expected.documentType && candidate.documentType === expected.documentType) score += 50;
  return score;
}

export function selectFlexDocumentCandidate(candidates = [], expected = {}) {
  const available = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.elementId);
  if (!available.length) return { candidate: null, ambiguous: false, ranked: [] };
  // When the caller explicitly requests a quote (or another known FLEX type),
  // type is a constraint rather than a small scoring hint.  A quote and its
  // child pull sheet normally share the same show/client identity, so scoring
  // every type together creates a false ambiguity even after FLEX identified
  // the document definitions correctly.
  const typed = expected.documentType
    ? available.filter(candidate => candidate.documentType === expected.documentType)
    : [];
  const pool = typed.length ? typed : available;
  const ranked = pool
    .map(candidate => ({ ...candidate, identityScore: scoreFlexDocumentIdentity(candidate, expected) }))
    .sort((a, b) => b.identityScore - a.identityScore);
  if (ranked.length === 1) return { candidate: ranked[0], ambiguous: false, ranked };
  const hasExpectedIdentity = Boolean(expected.showName || expected.name || expected.client || expected.documentType);
  if (!hasExpectedIdentity) return { candidate: null, ambiguous: true, ranked };
  const gap = ranked[0].identityScore - ranked[1].identityScore;
  const confident = ranked[0].identityScore >= 220 && gap >= 60;
  return { candidate: confident ? ranked[0] : null, ambiguous: !confident, ranked };
}

export function selectPrimaryShowQuote(documents = [], expected = {}) {
  const verified = (Array.isArray(documents) ? documents : []).filter(document => document?.status === "Verified");
  const quotes = verified.filter(document => document.documentType === "quote");
  // An opaque child document must never become the show's canonical quote just
  // because it is the only FLEX document we have seen so far.  Pull sheets can
  // reuse a quote-like number and FLEX sometimes returns a generic definition
  // for them.  Only a verified quote, or an opaque root document with no known
  // parent, is eligible here.  The caller may still search by show identity to
  // replace that tentative root with an explicitly typed quote.
  const pool = quotes.length
    ? quotes
    : verified.filter(document => document.documentType === "unknown" && !document.parentElementId);
  if (!pool.length) return null;
  return [...pool]
    .map(document => ({
      ...document,
      identityScore: scoreFlexDocumentIdentity(document, expected) + (document.parentElementId ? 0 : 75),
    }))
    .sort((a, b) => b.identityScore - a.identityScore)[0] || null;
}

export const FLEX_QUOTE_LINK_DEFAULTS = {
  webBaseUrl: DEFAULT_FLEX_WEB_BASE_URL,
  quoteViewId: DEFAULT_FLEX_QUOTE_VIEW_ID,
};
