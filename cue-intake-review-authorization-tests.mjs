import assert from "node:assert/strict";
import { createIntakeReviewAuthorization, INTAKE_MATCH_REVIEW_PERMISSION } from "./cue-intake-review-authorization.mjs";

const validEnv = {
  CUE_INTAKE_REVIEW_OWNER_ID: "owner",
  CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY: "owner-access-key-that-is-long-enough",
  CUE_INTAKE_REVIEWERS_JSON: JSON.stringify([{ id: "reviewer", accessKey: "reviewer-access-key-that-is-long-enough" }]),
  CUE_INTAKE_REVIEW_SESSION_SECRET: "session-signing-secret-that-is-long-enough",
};
const now = () => 2_000_000_000_000;
const request = (cookie = "", headers = {}) => ({ headers: { cookie, ...headers } });

function authorizedCookie(accessKey, env = validEnv) {
  const auth = createIntakeReviewAuthorization({ env, now });
  const issued = auth.issueSession({ accessKey, pilotConfigured: true, pilotAuthorized: true });
  assert.equal(issued.ok, true);
  return { auth, cookie: `cue_intake_review_auth=${encodeURIComponent(issued.token)}` };
}

{
  const { auth, cookie } = authorizedCookie(validEnv.CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY);
  assert.deepEqual(auth.authorizeRequest(request(cookie), { pilotConfigured: true, pilotAuthorized: true }), {
    ok: true, permission: INTAKE_MATCH_REVIEW_PERMISSION,
  });
}

{
  const { auth, cookie } = authorizedCookie("reviewer-access-key-that-is-long-enough");
  assert.equal(auth.authorizeRequest(request(cookie), { pilotConfigured: true, pilotAuthorized: true }).ok, true);
}

for (const env of [
  {},
  { ...validEnv, CUE_INTAKE_REVIEW_SESSION_SECRET: "" },
  { ...validEnv, CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY: "replace-with-owner-access-key" },
  { ...validEnv, CUE_INTAKE_REVIEWERS_JSON: "not-json" },
  { ...validEnv, CUE_INTAKE_REVIEWERS_JSON: JSON.stringify([{ id: "owner", accessKey: "another-review-access-key-long-enough" }]) },
]) {
  const auth = createIntakeReviewAuthorization({ env, now });
  assert.equal(auth.configured, false);
  assert.equal(auth.authorizeRequest(request(), { pilotConfigured: true, pilotAuthorized: true }).code, "review_permission_required");
}

{
  const auth = createIntakeReviewAuthorization({ env: validEnv, now });
  for (const gate of [
    { pilotConfigured: false, pilotAuthorized: true },
    { pilotConfigured: true, pilotAuthorized: false },
  ]) {
    assert.equal(auth.issueSession({ accessKey: validEnv.CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY, ...gate }).ok, false);
  }
  assert.equal(auth.issueSession({ accessKey: "service-token-that-is-not-authorized", pilotConfigured: true, pilotAuthorized: true }).code, "review_permission_required");
  for (const serviceIdentity of ["codex-desktop", "cursor", "chatgpt-mcp", "github-actions", "automation"]) {
    assert.equal(auth.authorizeRequest(request("", {
      "x-cue-actor-id": "owner",
      "x-cue-role": "owner",
      "x-control-board-service-id": serviceIdentity,
      authorization: "Bearer service-credential",
    }), { pilotConfigured: true, pilotAuthorized: true }).ok, false, `${serviceIdentity} cannot forge review authority`);
  }
}

{
  const { auth, cookie } = authorizedCookie(validEnv.CUE_INTAKE_REVIEW_OWNER_ACCESS_KEY);
  const tampered = `${cookie}x`;
  assert.equal(auth.authorizeRequest(request(tampered), { pilotConfigured: true, pilotAuthorized: true }).ok, false);
  const expiredAuth = createIntakeReviewAuthorization({ env: validEnv, now: () => now() + 9 * 60 * 60 * 1000 });
  assert.equal(expiredAuth.authorizeRequest(request(cookie), { pilotConfigured: true, pilotAuthorized: true }).ok, false);
  assert.match(auth.sessionCookie("opaque", { secure: true }), /HttpOnly; SameSite=Strict;.*; Secure/);
  assert.match(auth.clearCookie(), /Max-Age=0/);
}

console.log("cue-intake-review-authorization tests passed");
