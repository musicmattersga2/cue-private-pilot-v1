import { randomUUID } from "node:crypto";

const DEFAULT_AGENT = "CUE Control Board Client";
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function controlBoardEndpoint(value) {
  const url = new URL(required(value, "CONTROL_BOARD_URL"));
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("CONTROL_BOARD_URL must use HTTPS outside local development");
  }
  if (url.username || url.password) throw new Error("CONTROL_BOARD_URL must not contain credentials");
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/api/control-board") || path.endsWith("/github-control-board")
    ? path
    : `${path}/api/control-board`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: "Control Board returned a non-JSON response" }; }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ControlBoardError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ControlBoardError";
    this.status = options.status || 0;
    this.code = options.code || "control_board_error";
    this.body = options.body || {};
  }
}

export function controlBoardConfigFromEnv(env = process.env) {
  const oidcAudience = String(env.CONTROL_BOARD_GITHUB_OIDC_AUDIENCE || "").trim();
  if (oidcAudience) {
    return {
      baseUrl: required(env.CONTROL_BOARD_URL, "CONTROL_BOARD_URL"),
      oidcAudience,
      oidcRequestUrl: required(env.ACTIONS_ID_TOKEN_REQUEST_URL, "ACTIONS_ID_TOKEN_REQUEST_URL"),
      oidcRequestToken: required(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
      agent: String(env.CONTROL_BOARD_AGENT || DEFAULT_AGENT).trim() || DEFAULT_AGENT,
    };
  }
  return {
    baseUrl: required(env.CONTROL_BOARD_URL, "CONTROL_BOARD_URL"),
    serviceId: required(env.CONTROL_BOARD_SERVICE_ID, "CONTROL_BOARD_SERVICE_ID"),
    serviceSecret: required(env.CONTROL_BOARD_SERVICE_SECRET, "CONTROL_BOARD_SERVICE_SECRET"),
    sitesToken: required(env.CONTROL_BOARD_SITES_TOKEN, "CONTROL_BOARD_SITES_TOKEN"),
    agent: String(env.CONTROL_BOARD_AGENT || DEFAULT_AGENT).trim() || DEFAULT_AGENT,
  };
}

export class ControlBoardClient {
  constructor(options = {}) {
    this.endpoint = controlBoardEndpoint(options.baseUrl);
    this.oidcAudience = String(options.oidcAudience || "").trim();
    this.oidcRequestUrl = String(options.oidcRequestUrl || "").trim();
    this.oidcRequestToken = String(options.oidcRequestToken || "").trim();
    this.serviceId = String(options.serviceId || "").trim().toLowerCase();
    this.serviceSecret = String(options.serviceSecret || "");
    this.sitesToken = String(options.sitesToken || "");
    if (this.oidcAudience) {
      required(this.oidcRequestUrl, "oidcRequestUrl");
      required(this.oidcRequestToken, "oidcRequestToken");
    } else {
      required(this.serviceId, "serviceId");
      if (!SERVICE_ID_PATTERN.test(this.serviceId)) throw new Error("serviceId is invalid");
      required(this.serviceSecret, "serviceSecret");
      required(this.sitesToken, "sitesToken");
    }
    this.agent = String(options.agent || DEFAULT_AGENT).trim().slice(0, 200) || DEFAULT_AGENT;
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") throw new Error("A fetch implementation is required");
    this.maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 2)));
    this.retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 200));
    this.requestTimeoutMs = Math.max(250, Math.min(30_000, Number(options.requestTimeoutMs || 5_000)));
  }

  async oidcToken() {
    const url = new URL(this.oidcRequestUrl);
    url.searchParams.set("audience", this.oidcAudience);
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${this.oidcRequestToken}`, accept: "application/json" },
    });
    const body = safeJson(await response.text());
    if (!response.ok || typeof body.value !== "string" || !body.value) {
      throw new Error("GitHub did not issue an OIDC identity token");
    }
    return body.value;
  }

  async headers(hasBody = false) {
    const authorization = this.oidcAudience
      ? `Bearer ${await this.oidcToken()}`
      : `Bearer ${this.serviceId}.${this.serviceSecret}`;
    return {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      authorization,
      ...(!this.oidcAudience ? { "oai-sites-authorization": `Bearer ${this.sitesToken}` } : {}),
      "x-cue-agent": this.agent,
    };
  }

  async request(method, body) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let lastNetworkError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      timeout.unref?.();
      try {
        response = await this.fetch(this.endpoint, {
          method,
          headers: await this.headers(serialized !== undefined),
          signal: controller.signal,
          ...(serialized === undefined ? {} : { body: serialized }),
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt < this.maxAttempts) {
          if (this.retryDelayMs) await sleep(this.retryDelayMs);
          continue;
        }
        throw new ControlBoardError("Control Board request could not be completed", {
          code: "network_error",
          body: { cause: error instanceof Error ? error.message : "Network request failed" },
        });
      } finally {
        clearTimeout(timeout);
      }

      const parsed = safeJson(await response.text());
      if (response.ok) return parsed;
      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxAttempts) {
        if (this.retryDelayMs) await sleep(this.retryDelayMs);
        continue;
      }
      throw new ControlBoardError(String(parsed.error || `Control Board returned ${response.status}`), {
        status: response.status,
        code: String(parsed.code || "control_board_error"),
        body: parsed,
      });
    }
    throw new ControlBoardError("Control Board request could not be completed", {
      code: "network_error",
      body: { cause: lastNetworkError instanceof Error ? lastNetworkError.message : "Network request failed" },
    });
  }

  read() {
    return this.request("GET");
  }

  async mutate(action, payload = {}, options = {}) {
    const expectedVersion = options.expectedVersion ?? (await this.read()).boardVersion;
    if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
      throw new Error("A positive expectedVersion is required");
    }
    const idempotencyKey = String(options.idempotencyKey || randomUUID());
    const mutation = {
      ...payload,
      action,
      expectedVersion: Number(expectedVersion),
      idempotencyKey,
    };
    return this.request("POST", mutation);
  }

  async updateStep(stepId, status, values = {}, options = {}) {
    if (options.expectedVersion !== undefined) {
      if (values.notes === undefined || values.completedAt === undefined) {
        throw new Error("notes and completedAt are required with an explicit expectedVersion");
      }
      return this.mutate("update_step", { ...values, stepId, status }, options);
    }

    const board = await this.read();
    const previous = board.steps?.[stepId] || {};
    return this.mutate("update_step", {
      stepId,
      status,
      notes: values.notes === undefined ? String(previous.notes || "") : values.notes,
      completedAt: values.completedAt === undefined ? String(previous.completedAt || "") : values.completedAt,
    }, { ...options, expectedVersion: board.boardVersion });
  }

  setFocus(stepId, options = {}) {
    return this.mutate("set_focus", { stepId }, options);
  }

  startWorkstream(values, options = {}) {
    return this.mutate("start_workstream", values, options);
  }

  updateWorkstream(id, status, values = {}, options = {}) {
    return this.mutate("update_workstream", { ...values, id, status }, options);
  }

  importState(steps, currentFocus, options = {}) {
    return this.mutate("import_state", { steps, ...(currentFocus ? { currentFocus } : {}) }, options);
  }
}

export function createControlBoardClientFromEnv(env = process.env, options = {}) {
  return new ControlBoardClient({ ...controlBoardConfigFromEnv(env), ...options });
}
