# CUE Canonical Show Registry v1

The Canonical Show Registry is the identity layer between operational planning and source evidence. It prevents Slack, email, Drive, staffing, trucking, Motive, or warehouse messages from inventing their own show identity.

## Authority order

1. **FLEX Confirmed Quote** creates the first provisional show awareness and starts readiness.
2. **Active Show Index** adopts that provisional show and defines its current operational lifecycle.
3. **FLEX** defines the authoritative document hierarchy for each show.
4. **Human confirmation** may select the primary FLEX show quote when automatic hierarchy resolution is incomplete or ambiguous.
5. **Evidence connectors** resolve signals against the persisted registry.
6. **Show Readiness Objects** consume only confirmed show evidence.

Slack is therefore a consumer of the registry, not its source of truth.

## Canonical show record

Each stable show ID stores:

- canonical name and normalized aliases;
- Active Show Index provenance and operational metadata;
- active or inactive lifecycle state;
- the canonical primary FLEX show quote;
- typed related FLEX documents, including pull sheets and child quotes;
- FLEX element UUIDs and parent UUIDs;
- identity confidence and hierarchy status;
- whether human confirmation is still required;
- explicit human overrides and audit provenance.

An absent or ambiguous primary quote is represented as unresolved. CUE must not fabricate a quote number or UUID.

## FLEX hierarchy rules

- A document number is not assumed to be a quote.
- Pull sheets and other child documents remain evidence attached to the show.
- When a verified child exposes a parent element UUID, CUE resolves that UUID before attempting fuzzy name search.
- A parent is promoted to the primary show quote only when FLEX explicitly identifies it as a quote.
- A verified primary quote survives a temporary FLEX refresh failure as `verified_stale`.
- A human-linked primary quote remains authoritative across later registry syncs until another explicit human decision replaces it.

The Moonchild case is the reference example: pull sheet `26-0836` is related evidence, while parent quote `26-1846` is the canonical show quote.

## Lifecycle and downstream use

A quote entering a configured confirmed status creates one `provisional` show with
the stage `awaiting_active_show_index`. CUE immediately records a
`flex.quote.confirmed` event, creates the first Show Readiness Object, and opens
one show-onboarding decision card. Repeated confirmed observations are
idempotent and do not create duplicate shows, events, or cards.

When the Active Show Index later contains the same verified quote UUID or quote
number, CUE adopts the provisional record into the Index's canonical show ID,
migrates its events and readiness state, records `show.identity.reconciled`, and
advances the stage to `active_show_index_tracking`.

Shows present in the latest Active Show Index sync are `active`. Previously known shows missing from the new sync become `inactive`; their identity and audit trail remain available. Provisional FLEX-confirmed shows are retained until the Index adopts them; a temporary Index delay must not erase the trigger.

Matching candidates are generated from active registry records. Connectors may propose a match, but uncertain evidence remains in Match Review. Only a confirmed match may affect the Show Readiness Object.

## API

- `GET /api/foundation/show-registry` lists active canonical shows by default.
- `GET /api/foundation/show-registry?activeOnly=false` includes inactive records.
- `GET /api/foundation/show-registry/:showId` returns one canonical show.
- `POST /api/foundation/source-first/sync` refreshes registry authority before
  processing email, Drive, and finally Slack evidence.
- `POST /api/foundation/flex/quote-status/observe` records one or more quote
  status observations and fires the lifecycle trigger once.
- `POST /api/foundation/flex/quote-status/poll` reads status from known FLEX
  quote UUIDs when the tenant exposes status through header data.
- `GET /api/foundation/flex/lifecycle/status` reports whether automatic FLEX
  lifecycle discovery is configured and shows its persisted checkpoint.
- `POST /api/foundation/flex/lifecycle/discover` polls the configured lifecycle
  feed when available; otherwise it runs the verified confirmed-MMP-quote
  snapshot connector and reads each candidate's authoritative status history.
- `GET /api/foundation/flex/confirmed-quotes` lists quote observations that have
  fired the lifecycle trigger.

Automatic discovery uses the authenticated FLEX APIs observed in the tenant.
The snapshot connector pages through the MMP Quote definition filtered to the
Confirmed status and Peachtree Corners location. It stores the complete set of
confirmed element UUIDs, compares that set with the last fully successful
snapshot, and reads `element-status-change/{elementUuid}` for new, changed, or
reconciliation candidates. The exact status-transition ID and `changedOn`
timestamp are the idempotency authority; scan time is never treated as the
confirmation time.

The initial baseline remembers every currently confirmed UUID but hydrates only
active/upcoming rows, avoiding a replay of years of historical shows. A partial
page or status-history failure never advances the durable snapshot. Periodic
full reconciliation catches missed or corrected records. If FLEX later exposes
a tenant-wide change feed, CUE may use it as the faster discovery transport;
the status-history verification and idempotency rules remain unchanged.

Known related documents in the Canonical Show Registry are deferred and
attached to their parent show rather than creating another show. Unknown rows
from the verified Confirmed MMP Quote list may create provisional awareness and
are reconciled by the Active Show Index. CUE never promotes a pull sheet,
invoice, manifest, or other related document merely because its number looks
like a quote.

The Active Shows response also includes a registry sync summary and each row's `canonicalIdentity`.

When the live Active Show Index is unavailable, CUE continues to read the last
persisted registry but does not sync fallback or generated rows into it. This
prevents a transient source outage from deactivating valid shows or polluting
canonical identity.
