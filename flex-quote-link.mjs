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

export const FLEX_QUOTE_LINK_DEFAULTS = {
  webBaseUrl: DEFAULT_FLEX_WEB_BASE_URL,
  quoteViewId: DEFAULT_FLEX_QUOTE_VIEW_ID,
};
