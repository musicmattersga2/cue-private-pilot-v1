import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Relay numeric configuration is invalid");
  }
  return parsed;
}

function upstreamEndpoint(value) {
  const url = new URL(required(value, "CONTROL_BOARD_UPSTREAM_URL"));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/api/control-board"
  ) {
    throw new Error("CONTROL_BOARD_UPSTREAM_URL must be the credential-free HTTPS Control Board API URL");
  }
  if (!url.hostname.endsWith(".chatgpt.site")) {
    throw new Error("CONTROL_BOARD_UPSTREAM_URL must use the approved ChatGPT Site host");
  }
  url.pathname = "/api/control-board";
  return url.toString();
}

export function relayConfigFromEnv(env = process.env) {
  const serviceId = required(env.RELAY_SERVICE_ID ?? "chatgpt-mcp", "RELAY_SERVICE_ID").toLowerCase();
  if (!SERVICE_ID_PATTERN.test(serviceId)) throw new Error("RELAY_SERVICE_ID is invalid");

  const sitesAuthSha256 = required(env.RELAY_SITES_AUTH_SHA256, "RELAY_SITES_AUTH_SHA256").toLowerCase();
  if (!SHA256_PATTERN.test(sitesAuthSha256)) throw new Error("RELAY_SITES_AUTH_SHA256 must be a SHA-256 hex digest");

  return {
    upstreamUrl: upstreamEndpoint(env.CONTROL_BOARD_UPSTREAM_URL),
    serviceId,
    sitesAuthSha256,
    maxBodyBytes: positiveInteger(env.RELAY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 1024 * 1024),
    timeoutMs: positiveInteger(env.RELAY_UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 30_000),
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesSha256(value, expectedHex) {
  const actual = sha256(value);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function responseHeaders() {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders() });
}

function cleanAgent(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return normalized || "ChatGPT MCP via Render relay";
}

function authenticatedHeaders(request, config) {
  const sitesAuthorization = String(request.headers.get("oai-sites-authorization") ?? "").trim();
  if (!sitesAuthorization.startsWith("Bearer ") || !matchesSha256(sitesAuthorization, config.sitesAuthSha256)) {
    return null;
  }

  const authorization = String(request.headers.get("authorization") ?? "").trim();
  const prefix = `Bearer ${config.serviceId}.`;
  if (!authorization.startsWith(prefix) || authorization.length <= prefix.length + 31 || /\s/.test(authorization.slice(7))) {
    return null;
  }

  return {
    authorization,
    sitesAuthorization,
    agent: cleanAgent(request.headers.get("x-cue-agent")),
  };
}

async function requestBody(request, config) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > config.maxBodyBytes) {
    return { error: jsonResponse(413, { error: "Request body is too large", code: "payload_too_large" }) };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > config.maxBodyBytes) {
    return { error: jsonResponse(413, { error: "Request body is too large", code: "payload_too_large" }) };
  }

  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
  } catch {
    return { error: jsonResponse(400, { error: "A JSON object body is required", code: "invalid_json" }) };
  }
  return { text };
}

async function upstreamResponse(response) {
  const type = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) {
    return jsonResponse(502, {
      error: "The canonical Control Board returned a non-JSON response",
      code: "upstream_non_json",
      upstreamStatus: response.status,
    });
  }

  const text = await response.text();
  try {
    JSON.parse(text);
  } catch {
    return jsonResponse(502, {
      error: "The canonical Control Board returned invalid JSON",
      code: "upstream_invalid_json",
      upstreamStatus: response.status,
    });
  }

  return new Response(text, { status: response.status, headers: responseHeaders() });
}

export async function handleRelayRequest(request, config, fetcher = fetch) {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse(200, { status: "ready", service: "cue-control-board-relay" });
  }

  if (url.pathname !== "/api/control-board" || url.search) {
    return jsonResponse(404, { error: "Not found", code: "not_found" });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed", code: "method_not_allowed" });
  }

  const authenticated = authenticatedHeaders(request, config);
  if (!authenticated) {
    return jsonResponse(401, { error: "Relay authentication required", code: "unauthorized" });
  }

  let body;
  if (request.method === "POST") {
    if (!String(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return jsonResponse(415, { error: "Content-Type must be application/json", code: "unsupported_media_type" });
    }
    const read = await requestBody(request, config);
    if (read.error) return read.error;
    body = read.text;
  }

  try {
    const response = await fetcher(config.upstreamUrl, {
      method: request.method,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: authenticated.authorization,
        "oai-sites-authorization": authenticated.sitesAuthorization,
        "x-cue-agent": authenticated.agent,
        "x-cue-relay": "render-v1",
        "user-agent": "cue-control-board-relay/1.0",
      },
      ...(body === undefined ? {} : { body }),
    });
    return await upstreamResponse(response);
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    return jsonResponse(timeout ? 504 : 502, {
      error: timeout ? "The canonical Control Board timed out" : "The canonical Control Board could not be reached",
      code: timeout ? "upstream_timeout" : "upstream_unavailable",
    });
  }
}
