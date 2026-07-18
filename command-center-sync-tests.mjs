import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./command-center.html", import.meta.url), "utf8");

assert.match(
  html,
  /api\/foundation\/source-first\/sync/,
  "the Command Center must invoke the FLEX-first shared Intake pipeline",
);
assert.doesNotMatch(
  html,
  /await api\('\/api\/foundation\/slack\/sync'/,
  "the primary foundation sync must never bypass FLEX and the Active Show Index",
);
assert.match(
  html,
  /FLEX → Active Shows → Email\/Drive → Slack/,
  "the operator feedback must make source ordering visible",
);
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
}, null, 2));
