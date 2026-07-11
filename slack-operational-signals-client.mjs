/**
 * Slack Operational Signals — rate-safe Slack Web API client.
 * Never logs Authorization headers or token values.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(baseMs) {
  const base = Math.max(0, Number(baseMs) || 0);
  return base + Math.floor(Math.random() * Math.min(750, Math.max(100, base * 0.25)));
}

function asString(value) {
  return String(value ?? "").trim();
}

export function createSlackOperationalSignalsClient(options = {}) {
  const token = asString(options.token || process.env.SLACK_BOT_TOKEN);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 4));
  const baseUrl = asString(options.baseUrl || "https://slack.com/api").replace(/\/$/, "");

  const telemetry = {
    rateLimitCount: 0,
    retryCount: 0,
    lastError: null,
  };

  function isConfigured() {
    return Boolean(token);
  }

  async function slackApi(method, params = {}, attempt = 0) {
    if (!token) {
      const error = new Error("Slack is not configured (missing SLACK_BOT_TOKEN).");
      error.code = "not_configured";
      throw error;
    }

    const url = new URL(`${baseUrl}/${method}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null || value === "") continue;
      query.set(key, String(value));
    }
    url.search = query.toString();

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (error) {
      telemetry.lastError = {
        method,
        kind: "network",
        message: asString(error?.message || error),
      };
      if (attempt < maxRetries) {
        telemetry.retryCount += 1;
        await sleep(jitterMs(500 * 2 ** attempt));
        return slackApi(method, params, attempt + 1);
      }
      throw error;
    }

    if (response.status === 429) {
      telemetry.rateLimitCount += 1;
      telemetry.retryCount += 1;
      const retryAfterSec = Number(response.headers.get("Retry-After") || 1);
      const waitMs = jitterMs(Math.max(1, retryAfterSec) * 1000);
      if (attempt >= maxRetries) {
        const error = new Error(`Slack rate limited on ${method}`);
        error.code = "rate_limited";
        error.retryAfterSec = retryAfterSec;
        throw error;
      }
      await sleep(waitMs);
      return slackApi(method, params, attempt + 1);
    }

    if (response.status >= 500) {
      telemetry.lastError = {
        method,
        kind: "http_5xx",
        status: response.status,
      };
      if (attempt < maxRetries) {
        telemetry.retryCount += 1;
        await sleep(jitterMs(600 * 2 ** attempt));
        return slackApi(method, params, attempt + 1);
      }
      const error = new Error(`Slack HTTP ${response.status} on ${method}`);
      error.code = "http_5xx";
      error.status = response.status;
      throw error;
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      const err = new Error(`Slack returned non-JSON for ${method}`);
      err.code = "invalid_json";
      throw err;
    }

    if (!body?.ok) {
      const apiError = asString(body?.error || "unknown_error");
      const error = new Error(`Slack API error on ${method}: ${apiError}`);
      error.code = apiError;
      error.slackError = apiError;
      if (
        ["invalid_auth", "not_authed", "missing_scope", "account_inactive", "token_revoked"].includes(
          apiError
        )
      ) {
        error.sourceUnavailable = true;
      }
      if (
        ["ratelimited", "rate_limited"].includes(apiError) &&
        attempt < maxRetries
      ) {
        telemetry.rateLimitCount += 1;
        telemetry.retryCount += 1;
        await sleep(jitterMs(1000 * 2 ** attempt));
        return slackApi(method, params, attempt + 1);
      }
      throw error;
    }

    return body;
  }

  async function conversationsHistory({
    channel,
    oldest = null,
    latest = null,
    cursor = null,
    limit = 200,
    inclusive = false,
  } = {}) {
    return slackApi("conversations.history", {
      channel,
      oldest: oldest || undefined,
      latest: latest || undefined,
      cursor: cursor || undefined,
      limit,
      inclusive: inclusive ? "true" : "false",
    });
  }

  async function conversationsReplies({
    channel,
    ts,
    cursor = null,
    limit = 200,
  } = {}) {
    return slackApi("conversations.replies", {
      channel,
      ts,
      cursor: cursor || undefined,
      limit,
    });
  }

  async function conversationsInfo(channel) {
    return slackApi("conversations.info", { channel });
  }

  async function usersInfo(user) {
    return slackApi("users.info", { user });
  }

  function getTelemetry() {
    return { ...telemetry };
  }

  function resetTelemetry() {
    telemetry.rateLimitCount = 0;
    telemetry.retryCount = 0;
    telemetry.lastError = null;
  }

  return {
    isConfigured,
    slackApi,
    conversationsHistory,
    conversationsReplies,
    conversationsInfo,
    usersInfo,
    getTelemetry,
    resetTelemetry,
    // test helpers
    _sleep: sleep,
    _jitterMs: jitterMs,
  };
}

export const defaultSlackClient = createSlackOperationalSignalsClient();
