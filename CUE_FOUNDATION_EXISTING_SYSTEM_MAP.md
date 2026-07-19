# CUE Foundation — Existing System Map

| Existing component | Disposition | Foundation destination |
|---|---|---|
| `slack-operational-signals-client.mjs` | Reuse | Slack connector transport, pagination, retry and rate-limit telemetry |
| `slack-operational-signals-normalize.mjs` | Refactor gradually | SourceRecord normalization plus CandidateFact extraction |
| `slack-operational-signals-match.mjs` | Reuse/refactor | MatchCandidate creation; preserve score and reasons |
| `slack-operational-signals-store.mjs` | Migrate | JSON cache remains evidence adapter during pilot; production records move to foundation tables |
| Slack `reviewQueue` | Retire after migration | IntakeItem + DecisionCard; matching decision separated from operational disposition |
| Slack approve/reject endpoints | Compatibility only | New generic Decision Card endpoint becomes canonical |
| `slack-operational-signals-service.mjs` | Reuse | Connector orchestration; foundation sync runs after successful cache sync |
| Active Shows Slack payload | Reuse | Transitional product projection; eventually reads CurrentShowState + ShowReadiness |
| `ask-flex-full-show-review.mjs` | Refactor later | Ask CUE consumer of projections/readiness, not direct source aggregation |
| `ask-flex-review-snapshot-store.mjs` | Migrate later | Operational Event Ledger and current-state snapshots |
| `ask-flex-review-change-detection.mjs` | Reuse/refactor | ProposedUpdate comparison and changed-after-send rules |
| FLEX header/row adapters in server | Reuse | FLEX SourceRecords and derived Intake change events |
| Active Shows Index Google Sheet | Migrate | Canonical Show Registry/source link import; not raw evidence storage |

## First migration posture

- Additive only. Existing Slack and Active Shows routes remain functional.
- `cue-foundation-store.mjs` proves canonical object separation using atomic JSON.
- PostgreSQL migration is the production target; JSON is not the final system of record.
- New generic endpoints expose Decision Cards, Intake detail, Current Show State and Show Readiness.
- No automatic outbound messaging, FLEX write-back, staff assignment or driver assignment.

