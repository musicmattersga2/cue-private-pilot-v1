import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./command-center.html", import.meta.url), "utf8");

assert.match(
  html,
  /api\/foundation\/source-first\/sync/,
  "the Command Center must invoke the FLEX-first shared Intake pipeline",
);

assert.match(html, /Google Workspace review suggestions/, "Match Review includes a separate Google Workspace review section");
assert.match(html, /Human review required\. These suggestions are not authoritative matches, proposals, learned aliases, or operational updates\./,
  "the review-only warning is explicit");
assert.match(html, /intake-match-review\?provider=drive/, "the review projection defaults to Drive and remains separately selectable");
assert.match(html, /intake-match-review\/evidence/, "evidence is loaded only through the protected detail endpoint");
assert.match(html, />Reveal evidence</, "evidence disclosure requires an explicit reviewer action");
assert.match(html, /phase==='loading'.*phase==='unauthorized'.*phase==='unavailable'/s,
  "loading, unauthorized, and unavailable states are explicit");
assert.match(html, /No Google Workspace review suggestions are available/, "the empty state is explicit");
assert.match(html, /This suggestion is no longer eligible/, "stale suggestions are visibly disabled");
assert.match(html, /@media\(max-width:700px\).*review-heading.*review-auth-row/s,
  "the review surface has a narrow mobile layout");
assert.match(html, /<label for="reviewAccessKey">.*<input id="reviewAccessKey".*<button/s,
  "review access and actions use keyboard-accessible native controls");
assert.match(html, /autocomplete="off" spellcheck="false"/, "the access key input opts out of browser persistence helpers");
assert.doesNotMatch(html, /localStorage|sessionStorage|console\.log|console\.error/,
  "review credentials and evidence are not placed in browser storage or telemetry");
const reviewCardSource = html.match(/function reviewCard\(item\)\{([\s\S]*?)\nfunction reviewBody/)?.[1] || "";
assert(reviewCardSource, "review-card renderer is present");
for (const forbiddenControl of ["Accept", "Reject", "Defer", "Approve", "Confirm show", "Select match"]) {
  assert.equal(reviewCardSource.includes(`>${forbiddenControl}<`), false, `${forbiddenControl} is not exposed as a Google Workspace action`);
}

const serverSource = fs.readFileSync(new URL("./cue-flex-intelligence-server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /authorizeIntakeReview\(req\)/, "list and detail routes enforce dedicated review authorization");
assert.match(serverSource, /Cache-Control": "no-store, private"/, "review responses are not cacheable");
assert.doesNotMatch(serverSource.match(/function isAutomationAllowedPath[\s\S]*?\.includes\(pathname\);/)?.[0] || "", /intake-match-review/,
  "automation credentials cannot access the review endpoints");
assert.doesNotMatch(
  html,
  /await api\('\/api\/foundation\/slack\/sync'/,
  "the primary foundation sync must never bypass FLEX and the Active Show Index",
);
assert.match(html, /function syncStageSummary/, "operator feedback must be derived from actual source stages");
assert.match(html, /Gmail.*Drive.*Slack/, "the source-stage labels preserve source-first order");
assert.doesNotMatch(html, /Foundation synced: FLEX → Active Shows → Email\/Drive → Slack/, "disabled Google sources must not be reported as synchronized");
assert.match(
  html,
  /partialStages/,
  "the Command Center must report partial source completion instead of claiming a clean sync",
);
assert.match(
  html,
  /reportedPartial=Boolean\(data\?\.degraded\)&&Array\.isArray\(data\?\.partialStages\)/,
  "the Command Center must consume a structured partial result even when the API returns 502",
);
assert.match(
  html,
  /if\(!r\.ok&&!reportedPartial\)throw Error/,
  "non-partial API errors must still fail normally",
);

console.log(JSON.stringify({
  ok: true,
  syncEndpoint: "/api/foundation/source-first/sync",
  sourceOrder: ["flex", "active_show_index", "email_drive", "slack"],
  truthfulStageReporting: true,
}, null, 2));
