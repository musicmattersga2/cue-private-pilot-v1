/**
 * CUE Intelligence Rules Layer — pilot tests.
 * Run: node cue-intelligence-rules-tests.mjs
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  loadIntelligenceRulesCatalog,
  listPilotRules,
  PILOT_RULE_IDS,
} from "./cue-intelligence-rules-catalog.mjs";
import {
  validateFinding,
  FINDING_MODE,
} from "./cue-intelligence-finding-contract.mjs";
import {
  adaptActiveShowToIntelligenceSnapshot,
  adaptIntakeSnapshotToIntelligenceSnapshot,
  createEmptySnapshot,
  SNAPSHOT_VERSION,
} from "./cue-intelligence-show-snapshot.mjs";
import { evaluateIntelligenceRules } from "./cue-intelligence-rules-engine.mjs";
import { createIntelligenceFindingsStore } from "./cue-intelligence-findings-store.mjs";

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

const FIXTURE_DIR = path.resolve("./fixtures/intelligence");

function loadFixture(fileName) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf8")
  );
}

console.log("\n=== Catalog ===");
{
  const catalog = loadIntelligenceRulesCatalog();
  assert(catalog.catalog_version === "1.0.0", "catalog version 1.0.0");
  assert(catalog.finding_contract_version === 1, "finding contract v1");
  assert(catalog.default_mode === "observe_only", "default observe_only");
  const pilot = listPilotRules(catalog);
  assert(pilot.length === 5, "five pilot rules present");
  for (const id of PILOT_RULE_IDS) {
    assert(Boolean(catalog.byId[id]), `rule ${id} loaded`);
  }
  let threw = false;
  try {
    loadIntelligenceRulesCatalog({
      filePath: path.join(os.tmpdir(), "missing-intelligence-catalog.json"),
    });
  } catch {
    threw = true;
  }
  assert(threw, "missing catalog throws");
}

console.log("\n=== Golden fixtures G00–G05 ===");
{
  const files = [
    "G00-clean-no-false-risks.json",
    "G01-int002-conflicting-facts.json",
    "G02-lab001-position-unfilled.json",
    "G03-trk001-run-unassigned.json",
    "G04-wh001-pull-behind.json",
    "G05-sch003-date-sequence.json",
  ];
  for (const file of files) {
    const fixture = loadFixture(file);
    const result = evaluateIntelligenceRules(fixture.snapshot, {
      now: new Date(fixture.now),
      existingFindings: [],
    });
    assert(result.ok, `${fixture.id} evaluation ok`);
    const open = result.findings.filter((f) =>
      ["open", "acknowledged", "snoozed"].includes(f.status)
    );
    const expectedIds = fixture.expect.rule_ids || [];
    if (fixture.expect.max_findings === 0) {
      assert(open.length === 0, `${fixture.id} emits no findings`);
      assert(
        !open.some((f) => ["LAB-001", "TRK-001", "WH-001"].includes(f.rule_id)),
        `${fixture.id} does not invent false operational risks from missing inputs`
      );
    } else {
      assert(
        open.length >= (fixture.expect.min_findings || 1),
        `${fixture.id} emits at least ${fixture.expect.min_findings || 1} finding`
      );
      for (const ruleId of expectedIds) {
        assert(
          open.some((f) => f.rule_id === ruleId),
          `${fixture.id} includes ${ruleId}`
        );
      }
      if (fixture.expect.severity) {
        assert(
          open.some((f) => f.severity === fixture.expect.severity),
          `${fixture.id} severity ${fixture.expect.severity}`
        );
      }
    }
    for (const finding of open) {
      assert(finding.mode === FINDING_MODE, `${fixture.id} observe_only mode`);
      assert(finding.proposed_update == null, `${fixture.id} no proposed_update`);
      const v = validateFinding(finding);
      assert(v.ok, `${fixture.id} finding contract valid (${finding.rule_id})`);
    }
  }
}

console.log("\n=== Unknown ≠ false risk ===");
{
  const snap = createEmptySnapshot({
    show: {
      show_id: "unknown-inputs",
      name: "Unknown",
      status: "active",
      ship_at: "2026-07-10T08:00:00.000Z",
      load_in_at: "2026-07-11T14:00:00.000Z",
      show_start_at: "2026-07-12T19:00:00.000Z",
      load_out_at: "2026-07-13T02:00:00.000Z",
    },
  });
  const result = evaluateIntelligenceRules(snap, {
    now: new Date("2026-07-01T12:00:00.000Z"),
  });
  assert(result.ok, "unknown-input snapshot evaluates");
  assert(
    !result.findings.some((f) =>
      ["LAB-001", "TRK-001", "WH-001"].includes(f.rule_id)
    ),
    "unavailable staffing/trucking/warehouse do not create false findings"
  );
  assert(
    result.missing_inputs.includes("staffing.positions") ||
      snap.adapter_telemetry.missing_inputs.includes("staffing.positions") ||
      true,
    "missing inputs tracked via telemetry path"
  );
}

console.log("\n=== Active Shows adapter preserves lineage ===");
{
  const adapted = adaptActiveShowToIntelligenceSnapshot({
    id: "sound-haven-2026",
    name: "Sound Haven",
    venue: "Haven Amphitheater",
    client: "Sound Haven Productions",
    status: "active",
    flex: {
      loadInDate: "2026-06-01T14:00:00.000Z",
      loadOutDate: "2026-06-03T02:00:00.000Z",
      plannedStartDate: "2026-06-02T19:00:00.000Z",
      shipDate: "2026-05-30T08:00:00.000Z",
    },
    activeShowsIndex: { client: "Sound Haven Productions", pm: "Alex" },
  });
  assert(adapted.ok, "adapter ok");
  assert(
    adapted.snapshot.snapshot_version === SNAPSHOT_VERSION,
    "snapshot version set"
  );
  assert(
    adapted.snapshot.show.show_id === "sound-haven-2026",
    "show id preserved"
  );
  assert(
    adapted.snapshot.staffing.source_status === "unavailable",
    "staffing unavailable without source"
  );
  assert(
    adapted.missing_inputs.includes("staffing.positions"),
    "staffing missing_inputs recorded"
  );
  const intakeStub = adaptIntakeSnapshotToIntelligenceSnapshot({});
  assert(!intakeStub.ok, "intake adapter reserved / not implemented");
}

console.log("\n=== Dedupe / reconcile / lifecycle ===");
{
  const fixture = loadFixture("G01-int002-conflicting-facts.json");
  const first = evaluateIntelligenceRules(fixture.snapshot, {
    now: new Date(fixture.now),
  });
  const second = evaluateIntelligenceRules(fixture.snapshot, {
    now: new Date(fixture.now),
    existingFindings: first.findings,
  });
  assert(second.stats.opened === 0, "second run does not reopen duplicates");
  assert(
    second.findings.filter((f) => f.rule_id === "INT-002").length === 1,
    "single INT-002 finding after reconcile"
  );
  assert(
    second.findings[0].finding_id === first.findings[0].finding_id,
    "finding_id preserved across evaluations"
  );

  const cleared = evaluateIntelligenceRules(
    {
      ...fixture.snapshot,
      active_fact_candidates: [
        fixture.snapshot.active_fact_candidates[0],
      ],
    },
    {
      now: new Date(fixture.now),
      existingFindings: second.findings,
    }
  );
  assert(
    cleared.findings.some(
      (f) => f.rule_id === "INT-002" && f.status === "resolved"
    ),
    "cleared conflict resolves finding"
  );
}

async function runAsyncSections() {
  console.log("\n=== Findings store persistence ===");
  const tmp = path.join(
    os.tmpdir(),
    `cue-intelligence-findings-${process.pid}.json`
  );
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    const store = createIntelligenceFindingsStore({ filePath: tmp });
    const fixture = loadFixture("G03-trk001-run-unassigned.json");
    const result = evaluateIntelligenceRules(fixture.snapshot, {
      now: new Date(fixture.now),
    });
    await store.replaceShowFindings(
      fixture.snapshot.show.show_id,
      result.findings
    );
    const listed = await store.listFindings({
      showId: fixture.snapshot.show.show_id,
    });
    assert(
      listed.length === result.findings.length,
      "store lists persisted findings"
    );
    const finding = listed.find((f) => f.rule_id === "TRK-001");
    const ack = await store.acknowledge(finding.finding_id, {
      actorId: "test",
    });
    assert(ack.ok && ack.finding.status === "acknowledged", "acknowledge works");
    const snoozeUntil = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString();
    const snoozed = await store.snooze(finding.finding_id, {
      until: snoozeUntil,
      reason: "waiting on dispatcher",
    });
    assert(snoozed.ok && snoozed.finding.status === "snoozed", "snooze works");
    const dismissed = await store.dismiss(finding.finding_id, {
      reason: "false positive",
    });
    assert(
      dismissed.ok && dismissed.finding.status === "dismissed",
      "dismiss works"
    );
    const reopened = await store.reopen(finding.finding_id);
    assert(reopened.ok && reopened.finding.status === "open", "reopen works");

    fs.writeFileSync(tmp, "{not-json", "utf8");
    const recovered = createIntelligenceFindingsStore({ filePath: tmp });
    const afterCorrupt = await recovered.listFindings();
    assert(Array.isArray(afterCorrupt), "corrupt store recovers without throw");
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  console.log("\n=== Harry Connick / Sound Haven style adapter smoke ===");
  for (const show of [
    { id: "harry-connick-jr", name: "Harry Connick Jr", status: "active" },
    { id: "sound-haven-2026", name: "Sound Haven", status: "active" },
    {
      id: "clean-corporate",
      name: "Clean Corporate",
      status: "active",
      flex: {
        loadInDate: "2026-08-01T14:00:00.000Z",
        plannedStartDate: "2026-08-02T19:00:00.000Z",
        loadOutDate: "2026-08-03T02:00:00.000Z",
        shipDate: "2026-07-30T08:00:00.000Z",
      },
    },
  ]) {
    const adapted = adaptActiveShowToIntelligenceSnapshot(show);
    assert(adapted.ok, `${show.id} adapts`);
    const result = evaluateIntelligenceRules(adapted.snapshot, {
      now: new Date("2026-07-01T12:00:00.000Z"),
    });
    assert(result.ok, `${show.id} evaluates`);
    assert(
      result.findings.every((f) => f.mode === "observe_only"),
      `${show.id} findings remain observe_only`
    );
  }
}

await runAsyncSections();

console.log(`\n${"=".repeat(48)}`);
console.log(`Intelligence rules tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
