const DEFAULT_FLEX_REQUEST_TIMEOUT_MS = 30_000;
const MIN_FLEX_REQUEST_TIMEOUT_MS = 1_000;
const MAX_FLEX_REQUEST_TIMEOUT_MS = 120_000;

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FLEX_REQUEST_TIMEOUT_MS;
  return Math.max(MIN_FLEX_REQUEST_TIMEOUT_MS, Math.min(parsed, MAX_FLEX_REQUEST_TIMEOUT_MS));
}

export function getFlexRequestTimeoutMs(env = process.env) {
  return boundedTimeout(env.CUE_FLEX_REQUEST_TIMEOUT_MS);
}

export class FlexRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "FlexRequestError";
    this.code = options.code || "flex_request_failed";
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.retryable = Boolean(options.retryable);
  }
}

function responseSummary(data) {
  const value = typeof data === "string" ? data : JSON.stringify(data);
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1_000);
}

export async function fetchFlexJson(url, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs ?? getFlexRequestTimeoutMs());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: options.headers || {},
      signal: controller.signal,
    });
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }

    if (!response.ok) {
      const summary = responseSummary(data);
      throw new FlexRequestError(
        `FLEX request failed: ${response.status} ${response.statusText}.${summary ? ` ${summary}` : ""}`,
        {
          code: `flex_http_${response.status}`,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        }
      );
    }

    return data;
  } catch (error) {
    if (error instanceof FlexRequestError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new FlexRequestError(`FLEX request timed out after ${timeoutMs}ms.`, {
        code: "flex_request_timeout",
        retryable: true,
        cause: error,
      });
    }
    throw new FlexRequestError(`FLEX network request failed: ${error?.message || String(error)}`, {
      code: "flex_network_error",
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function isSkippableFlexRequestError(error) {
  const code = String(error?.code || "");
  if (code === "flex_request_timeout" || code === "flex_network_error") return true;
  const status = Number(error?.status);
  return [401, 403, 404, 408, 409, 423, 429].includes(status) || status >= 500;
}
