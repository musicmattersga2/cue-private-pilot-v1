# CUE Shared Intake Contract

This increment establishes one connector-neutral path from operational sources
to CUE Source Records and Intake Items. The PostgreSQL schema remains the
production contract; `cue-foundation-store.mjs` is the JSON pilot implementation.

## Identity authority

1. The Active Show Index owns the operational show identity and lifecycle.
2. FLEX owns financial-document identity and the show/document hierarchy.
3. Native CUE modules (staffing, trucking, warehouse) own their domain events.
4. Motive, email, Drive documents, and Slack contribute evidence.
5. A human decision may confirm or correct any proposed association.

A connector can attach a record automatically only when it supplies an existing
canonical show ID or a verified FLEX document that maps to exactly one canonical
show. A show name, client name, date, channel, or quote-like number is only a
hint and remains in `needs_match` until matching or human review resolves it.

The Active Show Index uses `sourceType: "drive"` and
`connectorName: "active-show-index"`; this preserves the production source-type
enum while assigning that specific spreadsheet identity-authority status.

## Supported source types

`flex`, `slack`, `email`, `drive`, `motive`, `cue_staffing`,
`cue_trucking`, `cue_warehouse`, `manual`, and `system`.

## Connector envelope

Every connector sends one or more records to the authenticated internal endpoint:

`POST /api/foundation/source-records/ingest`

```json
{
  "connectorName": "motive-dispatch",
  "connectorVersion": "1.0.0",
  "cursorBefore": "previous-cursor",
  "cursorAfter": "next-cursor",
  "records": [
    {
      "sourceType": "motive",
      "externalId": "dispatch-42",
      "externalRevisionId": "7",
      "sourceUrl": "https://example.invalid/dispatch/42",
      "observedAt": "2026-07-13T12:00:00Z",
      "normalizedText": "Truck 5301 dispatched.",
      "summary": "Truck 5301 dispatched.",
      "category": "trucking",
      "flexDocumentRefs": [
        {
          "documentNumber": "26-1790",
          "elementId": "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
          "documentType": "quote",
          "verified": true
        }
      ],
      "payload": {}
    }
  ]
}
```

Connector runs and their counts are available at:

`GET /api/foundation/connector-runs`

## Lifecycle guarantees

- Exact connector replays are deduplicated by source type, external ID, and
  content hash.
- Material edits create a new immutable Source Record with
  `supersedesSourceRecordId` pointing to the previous revision.
- Connector cursors advance only after the batch is persisted.
- Invalid records are reported on the connector run; valid records in the same
  batch are retained and the run is marked `partial`.
- Typed FLEX references remain typed. A mentioned pull sheet never silently
  replaces the canonical primary show quote.
- Proposed updates enter the shared proposal collection and do not write to an
  operational source of truth without an authorized decision.
