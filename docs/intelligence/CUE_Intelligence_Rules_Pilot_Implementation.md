# CUE Intelligence Rules Pilot — Implementation

**Branch:** `feature/cue-intelligence-rules-pilot`  
**Status:** Observe-only pilot (do not merge until separately approved)  
**Source of truth:**

- `docs/intelligence/CUE_Intelligence_Rules_Layer_v1.md`
- `config/intelligence/cue-intelligence-rules.v1.json`

## Architecture

This is a modular component of the existing CUE repository — not a separate application, database, or competing show-truth layer.

```text
Active Shows / (future) Intake snapshot
        ↓
Intelligence snapshot adapter
        ↓
Observe-only rule engine (INT-002, LAB-001, TRK-001, WH-001, SCH-003)
        ↓
Findings store (JSON)
        ↓
Active Shows presentation (review actions only)
```

## Modules

| File | Role |
|---|---|
| `cue-intelligence-rules-catalog.mjs` | Load/validate catalog JSON |
| `cue-intelligence-finding-contract.mjs` | Finding shape, IDs, fingerprints, validation |
| `cue-intelligence-show-snapshot.mjs` | Snapshot contract + Active Shows adapter |
| `cue-intelligence-rule-evaluators.mjs` | Five deterministic pilot evaluators |
| `cue-intelligence-rules-engine.mjs` | Evaluate + reconcile findings |
| `cue-intelligence-findings-store.mjs` | Atomic JSON persistence |
| `cue-intelligence-rules-tests.mjs` | Unit + golden fixture tests |
| `fixtures/intelligence/G0x-*.json` | Golden snapshots |

## APIs (session auth; not on automation allowlist)

- `GET /api/intelligence-rules/catalog`
- `GET /api/intelligence-rules/findings?showId=&status=`
- `POST /api/intelligence-rules/evaluate` — `{ showId }` or `{ snapshot }`
- `POST /api/intelligence-rules/findings/:id/acknowledge|snooze|dismiss|reopen`

## Hard rules enforced

- Every finding has `mode: "observe_only"` and `proposed_update: null`
- Missing staffing/trucking/warehouse → telemetry / missing_inputs, not invented risks
- Trucking runs come only from explicit Weekly Runs rows (never FLEX transport lines alone)
- No Intake schema, matching, migration, or event-ledger edits on this branch
- Intake/Foundation feature branch is not merged or cherry-picked

## Tests

```bash
node cue-intelligence-rules-tests.mjs
```

## Runtime data

Findings persist to `data/cue-intelligence-findings.json` (gitignored).
