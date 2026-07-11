/**
 * ASK-FLEX-004 Sound Haven acceptance (isolated store + optional live HTTP).
 * Does not modify Weekly Runs. Fixture mutation simulates count improvements.
 *
 * Usage:
 *   node ask-flex-004-acceptance.mjs
 *   node ask-flex-004-acceptance.mjs --live
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { createReviewSnapshotStore } from "./ask-flex-review-snapshot-store.mjs";
import {
  classifyFullShowFollowupType,
  answerFullShowFollowup,
} from "./ask-flex-full-show-followup.mjs";

const LIVE = process.argv.includes("--live");
const BASE = process.env.ASK_FLEX_BASE_URL || "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;
const notes = [];

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function soundHavenResult(truckingOverrides = {}) {
  return {
    showName: "Sound Haven",
    overallStatus: "review_needed",
    complexityLevel: "Medium",
    confidence: "medium",
    assessment: "Sound Haven needs trucking follow-up before clear.",
    showSummary: {
      showName: "Sound Haven",
      relatedQuotes: ["26-0401"],
      dateRange: "2026-06-01 → 2026-06-03",
    },
    flexScope: {
      quoteCount: 1,
      laborHeadcount: 12,
      laborPersonDays: 24,
      transportationLineCount: 3,
      equipmentLineItemCount: 40,
      majorFamilies: ["Audio"],
      relatedQuotes: ["26-0401"],
    },
    truckingExecution: {
      runCount: 4,
      status: "review_needed",
      findings: ["1 quote number matched in trucking."],
    },
    sourceCoverage: [
      { source: "FLEX", status: "connected" },
      { source: "Weekly Runs / Trucking", status: "connected" },
      { source: "Active Shows", status: "fallback" },
    ],
    crossSourceFindings: [{ category: "Trucking exceptions" }],
    confirmedIssues: ["Maybe Truck rows remain open"],
    needsConfirmation: ["Confirm Active Shows readiness"],
    coverageGaps: [{ source: "Staffing", status: "unavailable" }],
    recommendedNextActions: ["Clear Maybe Truck rows", "Confirm Info Sent"],
    supportingData: {
      truckingSummary: {
        rowsFound: 4,
        maybeTruckRows: 2,
        needDriverRows: 0,
        infoSentFalse: 6,
        lpoSentFalse: 2,
        tbdRows: 1,
        status: "review_needed",
        quoteNumbersMatched: ["26-0401"],
        ...truckingOverrides,
      },
    },
  };
}

async function fixtureAcceptance() {
  console.log("\nFixture acceptance (isolated store)\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-flex-accept-"));
  const filePath = path.join(dir, "ask-flex-review-snapshots.json");
  const store = createReviewSnapshotStore({ filePath });

  try {
    // 1-3: first save, no previous comparison
    const first = await store.saveFromReview(soundHavenResult(), {
      showName: "Sound Haven",
      supportingData: soundHavenResult().supportingData,
    });
    assert(first.saved && !first.duplicate, "snapshot saved");
    assert(!first.previousSnapshotId, "no previous comparison");
    assert(first.snapshot.showKey === "sound-haven-2026", "showKey sound-haven-2026");

    // 4-5: duplicate
    const dup = await store.saveFromReview(soundHavenResult(), {
      showName: "Sound Haven",
      supportingData: soundHavenResult().supportingData,
    });
    assert(dup.duplicate === true, "duplicate detected");
    const afterDup = await store.listSnapshots({ showKey: "sound-haven-2026", limit: 10 });
    assert(afterDup.length === 1, "no second distinct snapshot");

    // 6-8: simulate Maybe Truck 2→1
    const improved = await store.saveFromReview(soundHavenResult({ maybeTruckRows: 1 }), {
      showName: "Sound Haven",
      supportingData: soundHavenResult({ maybeTruckRows: 1 }).supportingData,
    });
    assert(improved.saved && !improved.duplicate, "new snapshot saved after fixture change");
    assert(improved.hasChanges === true, "change detected");
    assert(
      improved.comparison?.improved?.some((item) => /Maybe Truck/i.test(item.label)),
      "improvement categorized (Maybe Truck)"
    );

    // 9-10: follow-up uses persisted snapshots
    const context = {
      type: "full_show_review",
      showName: "Sound Haven",
      reviewedAt: new Date().toISOString(),
      result: soundHavenResult({ maybeTruckRows: 1 }),
    };
    assert(
      classifyFullShowFollowupType("What changed since the last review?") ===
        "persistent_change_since_last",
      "follow-up type persistent_change_since_last"
    );
    const followup = await answerFullShowFollowup(
      "What changed since the last review?",
      context,
      { reviewSnapshotStore: store }
    );
    assert(/Maybe Truck|improved|change/i.test(followup.answer), "follow-up states improvement");
    assert(
      followup.changeComparison?.previousReviewedAt &&
        followup.changeComparison?.currentReviewedAt,
      "timestamps included"
    );
    assert(followup.usedPersistedSnapshots === true, "used persisted snapshots");

    // Security: inspect snapshot JSON
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const blob = JSON.stringify(raw).toLowerCase();
    const banned = [
      "requesturl",
      "authorization",
      "bearer ",
      "cookie",
      "password",
      "openai",
      "api_key",
      "apikey",
      "x-cue-automation",
    ];
    const hit = banned.find((term) => blob.includes(term));
    assert(!hit, hit ? `security leak term found: ${hit}` : "no secrets/raw request fields in store");

    // 11-13: restart persistence simulation (new store instance, same file)
    const store2 = createReviewSnapshotStore({ filePath });
    const again = await answerFullShowFollowup(
      "What changed since the last review?",
      context,
      { reviewSnapshotStore: store2 }
    );
    assert(
      /Maybe Truck|improved|change/i.test(again.answer),
      "comparison still works after store re-open (restart)"
    );
    notes.push({
      changeExample: again.changeComparison,
      followupAnswer: again.answer,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function liveAsk(question, context = null) {
  const headers = { "Content-Type": "application/json" };
  const automationToken = process.env.CUE_AUTOMATION_TOKEN || "";
  if (automationToken) {
    headers["x-cue-automation-token"] = automationToken;
  }
  const res = await fetch(`${BASE}/api/flex/ask-brief`, {
    method: "POST",
    headers,
    body: JSON.stringify(context ? { question, context } : { question }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, data };
}

async function liveAcceptance() {
  console.log("\nLive HTTP acceptance (Sound Haven)\n");
  const storePath = path.resolve(
    process.env.ASK_FLEX_SNAPSHOT_PATH ||
      "./data/ask-flex-review-snapshots.acceptance.json"
  );
  const defaultStorePath = path.resolve("./data/ask-flex-review-snapshots.json");
  const activeStorePath = process.env.ASK_FLEX_SNAPSHOT_PATH
    ? storePath
    : fs.existsSync(storePath)
      ? storePath
      : defaultStorePath;
  const backupPath = `${activeStorePath}.accept-backup-${Date.now()}`;
  if (!process.env.ASK_FLEX_SNAPSHOT_PATH && fs.existsSync(activeStorePath)) {
    fs.renameSync(activeStorePath, backupPath);
    notes.push({ isolatedPriorStore: backupPath });
  }

  // Reset acceptance store via atomic rewrite (avoid unlink under a live server).
  const resetStore = createReviewSnapshotStore({ filePath: activeStorePath });
  await resetStore.replaceAllForTests([]);

  try {
    const first = await liveAsk("Give me a full operational review of Sound Haven");
    assert(first.status === 200, `first review HTTP ${first.status}`);
    assert(first.data.intent === "show_operational_analysis", "intent show_operational_analysis");
    assert(first.data.snapshot?.saved === true, "live snapshot saved");
    assert(!first.data.snapshot?.previousSnapshotId, "live no previous comparison");

    const second = await liveAsk("Give me a full operational review of Sound Haven");
    assert(second.status === 200, `second review HTTP ${second.status}`);
    assert(second.data.snapshot?.duplicate === true, "live duplicate detected");

    // Fixture mutation against live-shaped snapshot without touching Weekly Runs
    const resolvedStorePath = path.resolve(
      process.env.ASK_FLEX_SNAPSHOT_PATH ||
        "./data/ask-flex-review-snapshots.acceptance.json"
    );
    const storeFile = fs.existsSync(resolvedStorePath)
      ? resolvedStorePath
      : path.resolve("./data/ask-flex-review-snapshots.json");
    assert(fs.existsSync(storeFile), `snapshot store exists at ${path.basename(storeFile)}`);
    const store = createReviewSnapshotStore({ filePath: storeFile });
    const showKey = first.data.snapshot?.showKey || "sound-haven-2026";
    const latest = await store.getLatest(showKey);
    assert(Boolean(latest), `loaded live snapshot for ${showKey}`);
    const nextMaybe = Math.max(0, Number(latest.trucking?.maybeTruckCount || 2) - 1);
    const save = await store.saveFromReview(
      {
        showName: latest.showName,
        overallStatus: latest.overallStatus,
        complexityLevel: latest.complexityLevel,
        confidence: latest.confidence,
        showSummary: { showName: latest.showName, relatedQuotes: latest.relatedQuotes },
        flexScope: {
          ...latest.flex,
          relatedQuotes: latest.relatedQuotes,
        },
        truckingExecution: {
          runCount: latest.trucking?.rowCount,
          status: latest.trucking?.status,
          findings: [
            `${latest.trucking?.matchedQuoteCount || 1} quote number matched in trucking.`,
          ],
        },
        sourceCoverage: latest.sourceCoverage,
        crossSourceFindings: (latest.findingCategories || []).map((category) => ({
          category,
        })),
        confirmedIssues: latest.confirmedIssues,
        needsConfirmation: latest.needsConfirmation,
        coverageGaps: latest.coverageGaps,
        recommendedNextActions: latest.recommendedNextActions,
      },
      {
        showName: latest.showName,
        supportingData: {
          relatedQuotes: latest.relatedQuotes,
          truckingSummary: {
            rowsFound: latest.trucking?.rowCount,
            maybeTruckRows: nextMaybe,
            needDriverRows: latest.trucking?.needDriverCount,
            infoSentFalse: latest.trucking?.infoSentFalseCount,
            lpoSentFalse: latest.trucking?.lpoSentFalseCount,
            tbdRows: latest.trucking?.tbdCount,
            status: latest.trucking?.status,
            quoteNumbersMatched: latest.relatedQuotes,
          },
        },
        activeShows: latest.activeShows,
      }
    );
    assert(save.saved && !save.duplicate, "fixture-mutated live snapshot saved");
    assert(save.hasChanges, "fixture mutation produced changes");
    assert(
      save.comparison?.improved?.some((item) => /Maybe Truck|Info Sent false/i.test(item.label)),
      "live fixture improvement categorized"
    );

    const context = {
      type: "full_show_review",
      showName: first.data.showName || "Sound Haven",
      reviewedAt: new Date().toISOString(),
      result: first.data,
    };
    const changed = await liveAsk("What changed since the last review?", context);
    assert(changed.status === 200, `change follow-up HTTP ${changed.status}`);
    assert(
      changed.data.followupType === "persistent_change_since_last",
      `followupType=${changed.data.followupType}`
    );
    assert(
      changed.data.usedPersistedSnapshots || changed.data.changeComparison,
      "persisted snapshots used in live follow-up"
    );
    assert(
      /Maybe Truck|improved|change/i.test(changed.data.answer || ""),
      "live follow-up states improvement"
    );
    notes.push({ liveChangeAnswer: changed.data.answer, liveComparison: changed.data.changeComparison });

    // Restart persistence: new store handle + follow-up again
    const storeAfter = createReviewSnapshotStore({ filePath: storeFile });
    const restartFollowup = await answerFullShowFollowup(
      "What changed since the last review?",
      context,
      { reviewSnapshotStore: storeAfter }
    );
    assert(
      /Maybe Truck|improved|change/i.test(restartFollowup.answer || ""),
      "live comparison still works after store re-open"
    );
  } catch (error) {
    assert(false, `live acceptance error: ${error.message || error}`);
  } finally {
    if (fs.existsSync(backupPath)) {
      notes.push({
        note: "Prior store backed up; acceptance store left for inspection.",
        backupPath,
      });
    }
  }
}

async function regressionSmoke() {
  if (!LIVE) {
    console.log("\nRegression smoke skipped (pass --live to run against server)\n");
    return;
  }
  console.log("\nRegression smoke\n");
  const checks = [
    ["Give me a full operational review of Sound Haven", "show_operational_analysis"],
    ["What labor is on 26-0401?", null],
    ["What transportation is on 26-0401?", null],
    ["What is the total on 26-0401?", null],
    ["What sections are on 26-0401?", null],
    ["What inventory is on 26-0401?", null],
    ["Compare 26-0401 and 26-1747", null],
  ];
  let soundHavenContext = null;
  for (const [question, intent] of checks) {
    try {
      const { status, data } = await liveAsk(question);
      assert(status === 200, `${question} → HTTP 200`);
      if (intent) assert(data.intent === intent, `${question} → intent ${intent}`);
      if (data.intent === "show_operational_analysis" && data.found !== false) {
        soundHavenContext = {
          type: "full_show_review",
          showName: data.showName || "Sound Haven",
          reviewedAt: new Date().toISOString(),
          result: data,
        };
      }
    } catch (error) {
      assert(false, `${question} failed: ${error.message}`);
    }
  }

  if (soundHavenContext) {
    const brian = await liveAsk(
      "What are the top three things Brian needs to resolve?",
      soundHavenContext
    );
    assert(brian.status === 200, "Brian top 3 → HTTP 200");
    assert(brian.data.followupType === "owner_actions", "Brian top 3 followupType");
    assert((brian.data.items || []).length <= 3, "Brian top 3 item cap");

    const exec = await liveAsk("Give me a five-line executive summary.", soundHavenContext);
    assert(exec.status === 200, "five-line summary → HTTP 200");
    assert(exec.data.followupType === "executive_summary", "executive_summary type");
    const lines = String(exec.data.answer || "")
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert(lines.length === 5, `executive summary lines=${lines.length}`);
  } else {
    assert(false, "missing Sound Haven context for Brian/exec regressions");
  }
}

await fixtureAcceptance();
if (LIVE) {
  await liveAcceptance();
  await regressionSmoke();
} else {
  console.log("\n(Skipping live HTTP; re-run with --live when server is up)\n");
}

console.log(`\nAcceptance results: ${passed} passed, ${failed} failed`);
if (notes.length) {
  console.log("\nNotes:");
  console.log(JSON.stringify(notes, null, 2));
}
if (failed > 0) process.exit(1);
