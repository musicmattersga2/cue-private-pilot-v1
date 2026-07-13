# CUE Canonical Show Registry v1

The Canonical Show Registry is the identity layer between operational planning and source evidence. It prevents Slack, email, Drive, staffing, trucking, Motive, or warehouse messages from inventing their own show identity.

## Authority order

1. **Active Show Index** defines the current operational show universe and lifecycle.
2. **FLEX** defines the authoritative document hierarchy for each show.
3. **Human confirmation** may select the primary FLEX show quote when automatic hierarchy resolution is incomplete or ambiguous.
4. **Evidence connectors** resolve signals against the persisted registry.
5. **Show Readiness Objects** consume only confirmed show evidence.

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

Shows present in the latest Active Show Index sync are `active`. Previously known shows missing from the new sync become `inactive`; their identity and audit trail remain available.

Matching candidates are generated from active registry records. Connectors may propose a match, but uncertain evidence remains in Match Review. Only a confirmed match may affect the Show Readiness Object.

## API

- `GET /api/foundation/show-registry` lists active canonical shows by default.
- `GET /api/foundation/show-registry?activeOnly=false` includes inactive records.
- `GET /api/foundation/show-registry/:showId` returns one canonical show.

The Active Shows response also includes a registry sync summary and each row's `canonicalIdentity`.
