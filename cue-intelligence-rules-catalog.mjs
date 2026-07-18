/**
 * CUE Intelligence Rules catalog loader.
 * Loads config/intelligence/cue-intelligence-rules.v1.json and validates pilot rules.
 */

import fs from "fs";
import path from "path";

const DEFAULT_CATALOG_PATH = path.resolve(
  "./config/intelligence/cue-intelligence-rules.v1.json"
);

const PILOT_RULE_IDS = ["INT-002", "LAB-001", "TRK-001", "WH-001", "SCH-003"];
const ALLOWED_DOMAINS = [
  "intake",
  "labor",
  "trucking",
  "warehouse",
  "equipment",
  "schedule",
  "communication",
  "financial",
];
const ALLOWED_OWNER_ROLES = [
  "project_manager",
  "staffing",
  "trucking",
  "warehouse",
  "finance",
  "admin",
  "executive",
];
const ALLOWED_MODES = ["deterministic", "hybrid", "ai_assisted"];
const ALLOWED_SEVERITIES = ["info", "watch", "needs_attention", "critical"];

export function loadIntelligenceRulesCatalog(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_CATALOG_PATH);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return validateIntelligenceRulesCatalog(parsed, { filePath });
}

export function validateIntelligenceRulesCatalog(catalog, meta = {}) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("Intelligence rules catalog must be an object.");
  }
  if (!catalog.catalog_version) {
    throw new Error("catalog_version is required.");
  }
  if (Number(catalog.finding_contract_version) !== 1) {
    throw new Error(
      `Unsupported finding_contract_version: ${catalog.finding_contract_version}`
    );
  }
  if (!Array.isArray(catalog.rules) || !catalog.rules.length) {
    throw new Error("catalog.rules must be a non-empty array.");
  }

  const byId = new Map();
  for (const rule of catalog.rules) {
    if (!rule?.rule_id || !Number.isFinite(Number(rule.version))) {
      throw new Error("Each rule requires rule_id and numeric version.");
    }
    if (byId.has(rule.rule_id)) {
      throw new Error(`Duplicate rule_id in catalog: ${rule.rule_id}`);
    }
    if (!ALLOWED_DOMAINS.includes(rule.domain)) {
      throw new Error(`Unsupported domain on ${rule.rule_id}: ${rule.domain}`);
    }
    if (!ALLOWED_OWNER_ROLES.includes(rule.owner_role)) {
      throw new Error(
        `Unsupported owner_role on ${rule.rule_id}: ${rule.owner_role}`
      );
    }
    if (!ALLOWED_MODES.includes(rule.mode)) {
      throw new Error(`Unsupported mode on ${rule.rule_id}: ${rule.mode}`);
    }
    if (!ALLOWED_SEVERITIES.includes(rule.default_severity)) {
      throw new Error(
        `Unsupported default_severity on ${rule.rule_id}: ${rule.default_severity}`
      );
    }
    if (!rule.dedupe_key_template) {
      throw new Error(`dedupe_key_template required on ${rule.rule_id}`);
    }
    byId.set(rule.rule_id, Object.freeze({ ...rule }));
  }

  const missingPilot = PILOT_RULE_IDS.filter((id) => !byId.has(id));
  if (missingPilot.length) {
    throw new Error(
      `Pilot catalog missing required rules: ${missingPilot.join(", ")}`
    );
  }

  return Object.freeze({
    catalog_version: String(catalog.catalog_version),
    status: catalog.status || "pilot",
    finding_contract_version: 1,
    default_mode: catalog.default_mode || "observe_only",
    filePath: meta.filePath || null,
    rules: Object.freeze([...byId.values()]),
    byId: Object.freeze(Object.fromEntries(byId)),
    pilotRuleIds: Object.freeze([...PILOT_RULE_IDS]),
  });
}

export function getRuleDefinition(catalog, ruleId) {
  return catalog?.byId?.[ruleId] || null;
}

export function listPilotRules(catalog) {
  return PILOT_RULE_IDS.map((id) => getRuleDefinition(catalog, id)).filter(
    Boolean
  );
}

export { PILOT_RULE_IDS, DEFAULT_CATALOG_PATH };
