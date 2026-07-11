/**
 * ASK-FLEX-004 unit tests for snapshot store + change detection.
 * Run: node ask-flex-004-snapshot-tests.mjs
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  buildShowKey,
  buildFullShowReviewSnapshot,
  computeSnapshotContentHash,
  compareFullShowSnapshots,
  normalizeFullShowSnapshotInput,
} from "./ask-flex-review-change-detection.mjs";
import { createReviewSnapshotStore } from "./ask-flex-review-snapshot-store.mjs";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function sampleResult(overrides = {}) {
  return {
    showName: "Sound Haven",
    overallStatus: "review_needed",
    complexityLevel: "Medium",
    confidence: "medium",
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
      majorFamilies: ["Audio", "Power"],
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
    ...overrides,
  };
}

function sampleSupporting(overrides = {}) {
  return {
    relatedQuotes: ["26-0401"],
    truckingSummary: {
      rowsFound: 4,
      maybeTruckRows: 2,
      needDriverRows: 0,
      infoSentFalse: 6,
      lpoSentFalse: 2,
      tbdRows: 1,
      status: "review_needed",
      quoteNumbersMatched: ["26-0401"],
      ...overrides,
    },
  };
}

async function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-flex-snap-"));
  const filePath = path.join(dir, "ask-flex-review-snapshots.json");
  const store = createReviewSnapshotStore({ filePath });
  try {
    await fn(store, filePath, dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

console.log("\nASK-FLEX-004 unit tests\n");

console.log("normalization / hash");
{
  const a = normalizeFullShowSnapshotInput(sampleResult(), {
    supportingData: sampleSupporting(),
    showName: "Sound Haven",
  });
  const b = normalizeFullShowSnapshotInput(sampleResult(), {
    supportingData: sampleSupporting(),
    showName: "Sound Haven",
    reviewedAt: "2099-01-01T00:00:00.000Z",
    buildLabel: "other@hash",
  });
  assert(a.showKey === "sound-haven-2026", `showKey is ${a.showKey}`);
  assert(
    computeSnapshotContentHash(a) === computeSnapshotContentHash(b),
    "hash stable across reviewedAt/buildLabel"
  );
  assert(buildShowKey("Sound Haven", { relatedQuotes: ["26-0401"] }) === "sound-haven-2026", "buildShowKey");
  assert(
    Array.isArray(a.relatedQuotes) && a.relatedQuotes[0] === "26-0401",
    "relatedQuotes normalized"
  );
  assert(a.trucking.maybeTruckCount === 2, "maybeTruckCount extracted");
  assert(a.trucking.infoSentFalseCount === 6, "infoSentFalseCount extracted");
}

console.log("\nstatus improve/worsen + trucking + issues + coverage");
{
  const previous = buildFullShowReviewSnapshot(sampleResult(), {
    supportingData: sampleSupporting(),
    showName: "Sound Haven",
    id: "prev",
  });
  const improved = buildFullShowReviewSnapshot(
    sampleResult({
      confirmedIssues: [],
      sourceCoverage: [
        { source: "FLEX", status: "connected" },
        { source: "Weekly Runs / Trucking", status: "connected" },
        { source: "Active Shows", status: "connected" },
      ],
    }),
    {
      supportingData: sampleSupporting({ maybeTruckRows: 1, infoSentFalse: 5 }),
      showName: "Sound Haven",
      id: "curr",
    }
  );
  const comparison = compareFullShowSnapshots(previous, improved);
  assert(comparison.hasChanges === true, "hasChanges true");
  assert(comparison.changeCount > 0, `changeCount=${comparison.changeCount}`);
  assert(
    comparison.improved.some((item) => /Maybe Truck/i.test(item.label)),
    "Maybe Truck decrease classified improved"
  );
  assert(
    comparison.improved.some((item) => /Info Sent false/i.test(item.label)),
    "Info Sent false decrease classified improved"
  );
  assert(
    comparison.resolvedIssues.some((item) => /Maybe Truck rows remain open/i.test(item.label)),
    "confirmed issue removal resolved"
  );
  assert(
    comparison.improved.some((item) => /Active Shows coverage/i.test(item.label)),
    "coverage fallback→connected improved"
  );

  const worsened = buildFullShowReviewSnapshot(
    sampleResult({
      overallStatus: "at_risk",
      confirmedIssues: ["Maybe Truck rows remain open", "NEED DRIVER appeared"],
    }),
    {
      supportingData: sampleSupporting({ maybeTruckRows: 3, needDriverRows: 1 }),
      showName: "Sound Haven",
      id: "worse",
    }
  );
  const worseCmp = compareFullShowSnapshots(previous, worsened);
  assert(
    worseCmp.worsened.some((item) => /overallStatus|Overall status/i.test(item.label)),
    "status worsening detected"
  );
  assert(
    worseCmp.worsened.some((item) => /NEED DRIVER/i.test(item.label)),
    "NEED DRIVER increase worsened"
  );
  assert(
    worseCmp.newIssues.some((item) => /NEED DRIVER appeared/i.test(item.label)),
    "new confirmed issue detected"
  );

  const same = compareFullShowSnapshots(previous, previous);
  assert(same.hasChanges === false, "no-change comparison");
  assert(/No operational changes/i.test(same.summary), "no-change summary text");
}

console.log("\nstore: duplicate / retention / atomic / corrupt recovery");
await withTempStore(async (store, filePath) => {
  const first = await store.saveFromReview(sampleResult(), {
    supportingData: sampleSupporting(),
    showName: "Sound Haven",
  });
  assert(first.saved === true && first.duplicate === false, "first snapshot saved");
  assert(first.previousSnapshotId == null, "no previous on first save");

  const dup = await store.saveFromReview(sampleResult(), {
    supportingData: sampleSupporting(),
    showName: "Sound Haven",
  });
  assert(dup.duplicate === true, "duplicate suppressed");
  assert(dup.snapshot.id === first.snapshot.id, "duplicate returns existing id");

  const changed = await store.saveFromReview(sampleResult(), {
    supportingData: sampleSupporting({ maybeTruckRows: 1 }),
    showName: "Sound Haven",
  });
  assert(changed.duplicate === false && changed.saved === true, "changed snapshot saved");
  assert(changed.hasChanges === true, "change detected vs prior");
  assert(
    changed.comparison?.improved?.some((item) => /Maybe Truck/i.test(item.label)),
    "store comparison marks Maybe Truck improved"
  );

  const list = await store.listSnapshots({ showKey: first.snapshot.showKey, limit: 10 });
  assert(list.length === 2, `distinct snapshots stored count=${list.length}`);

  // Retention per show
  const many = [];
  for (let i = 0; i < 25; i += 1) {
    many.push(
      buildFullShowReviewSnapshot(
        sampleResult({
          confirmedIssues: [`issue-${i}`],
        }),
        {
          supportingData: sampleSupporting({ maybeTruckRows: i }),
          showName: "Sound Haven",
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
          reviewedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        }
      )
    );
  }
  await store.replaceAllForTests(many);
  const afterRetention = await store.listSnapshots({
    showKey: "sound-haven-2026",
    limit: 100,
  });
  assert(afterRetention.length === 20, `per-show retention kept ${afterRetention.length}`);

  // Global retention
  const global = [];
  for (let i = 0; i < 520; i += 1) {
    global.push(
      buildFullShowReviewSnapshot(sampleResult({ confirmedIssues: [`g-${i}`] }), {
        supportingData: sampleSupporting({ maybeTruckRows: i % 7 }),
        showName: `Show ${i}`,
        year: 2026,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i)).toISOString(),
      })
    );
  }
  await store.replaceAllForTests(global);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(raw.snapshots.length === 500, `global retention kept ${raw.snapshots.length}`);

  // Atomic write path: file exists and is valid JSON after save
  await store.replaceAllForTests([
    buildFullShowReviewSnapshot(sampleResult(), {
      supportingData: sampleSupporting(),
      showName: "Sound Haven",
    }),
  ]);
  assert(fs.existsSync(filePath), "store file exists after atomic write");
  assert(Array.isArray(JSON.parse(fs.readFileSync(filePath, "utf8")).snapshots), "valid JSON store");

  // Malformed recovery
  fs.writeFileSync(filePath, "{not-json", "utf8");
  const recovered = await store.listSnapshots({ showKey: "sound-haven-2026", limit: 5 });
  assert(Array.isArray(recovered) && recovered.length === 0, "malformed store recovers empty");
  const backups = fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".corrupt-"));
  assert(backups.length >= 1, "corrupt backup created");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
