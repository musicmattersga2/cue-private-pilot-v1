import crypto from "node:crypto";

export const INTAKE_MATCH_REVIEW_PERMISSION = "intake_match_review";
export const INTAKE_REVIEW_COOKIE = "cue_intake_review_auth";
const MAX_SESSION_AGE_SECONDS = 60 * 60 * 8;

function clean(value) {
  return String(value || "").trim();
}

function isProtectedValue(value) {
  const text = clean(value);
  return text.length >= 24 && !/(replace|placeholder|example|changeme)/i.test(text);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const header = String(req?.headers?.cookie || "");
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

function parseReviewers(raw) {
  if (!clean(raw)) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("invalid_reviewer_configuration");
  return parsed.map(item => ({ id: clean(item?.id), accessKey: clean(item?.accessKey) }));
}

function readConfiguration(env) {
  try {
    const owner = {
      id: clean(env.CUE_INTAKE_REVIEW_OWNER_ID),
      accessKey: clean(env.CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY),
    };
    const reviewers = parseReviewers(env.CUE_INTAKE_REVIEWERS_JSON);
    const sessionSecret = clean(env.CUE_INTAKE_REVIEW_SESSION_SECRET);
    const principals = [owner, ...reviewers];
    const uniqueIds = new Set(principals.map(item => item.id));
    const uniqueKeys = new Set(principals.map(item => item.accessKey));
    const valid = owner.id
      && principals.every(item => item.id && isProtectedValue(item.accessKey))
      && uniqueIds.size === principals.length
      && uniqueKeys.size === principals.length
      && isProtectedValue(sessionSecret);
    return valid ? { valid: true, principals, sessionSecret } : { valid: false, principals: [], sessionSecret: "" };
  } catch {
    return { valid: false, principals: [], sessionSecret: "" };
  }
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createIntakeReviewAuthorization({ env = process.env, now = () => Date.now() } = {}) {
  const configuration = readConfiguration(env);

  function sign(payload) {
    return crypto.createHmac("sha256", configuration.sessionSecret).update(payload).digest("base64url");
  }

  function resolveAccessKey(accessKey) {
    if (!configuration.valid || !isProtectedValue(accessKey)) return null;
    return configuration.principals.find(item => safeEqual(item.accessKey, accessKey)) || null;
  }

  function issueSession({ accessKey, pilotConfigured, pilotAuthorized }) {
    if (!pilotConfigured || !pilotAuthorized || !configuration.valid) {
      return { ok: false, status: 403, code: "review_permission_required" };
    }
    const principal = resolveAccessKey(accessKey);
    if (!principal) return { ok: false, status: 403, code: "review_permission_required" };
    const payload = encoded({
      v: 1,
      sub: principal.id,
      permission: INTAKE_MATCH_REVIEW_PERMISSION,
      exp: Math.floor(now() / 1000) + MAX_SESSION_AGE_SECONDS,
    });
    return { ok: true, token: `${payload}.${sign(payload)}` };
  }

  function authorizeRequest(req, { pilotConfigured, pilotAuthorized }) {
    if (!pilotConfigured || !pilotAuthorized || !configuration.valid) {
      return { ok: false, status: 403, code: "review_permission_required" };
    }
    const token = cookieValue(req, INTAKE_REVIEW_COOKIE);
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !safeEqual(sign(payload), signature)) {
      return { ok: false, status: 403, code: "review_permission_required" };
    }
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const principal = configuration.principals.find(item => item.id === claims.sub);
      if (!principal
        || claims.v !== 1
        || claims.permission !== INTAKE_MATCH_REVIEW_PERMISSION
        || !Number.isInteger(claims.exp)
        || claims.exp <= Math.floor(now() / 1000)) {
        return { ok: false, status: 403, code: "review_permission_required" };
      }
      return { ok: true, permission: INTAKE_MATCH_REVIEW_PERMISSION };
    } catch {
      return { ok: false, status: 403, code: "review_permission_required" };
    }
  }

  function sessionCookie(token, { secure = false } = {}) {
    return `${INTAKE_REVIEW_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/foundation/intake-match-review; Max-Age=${MAX_SESSION_AGE_SECONDS}${secure ? "; Secure" : ""}`;
  }

  function clearCookie({ secure = false } = {}) {
    return `${INTAKE_REVIEW_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/foundation/intake-match-review; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  return {
    configured: configuration.valid,
    issueSession,
    authorizeRequest,
    sessionCookie,
    clearCookie,
  };
}
