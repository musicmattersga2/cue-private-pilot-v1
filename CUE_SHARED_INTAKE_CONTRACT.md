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

## Provider adapters

The generic endpoint remains available for native CUE modules and future
connectors. Email, Drive, and the Active Show Index also have typed adapter
endpoints so provider payloads do not leak into the canonical schema:

- `POST /api/foundation/email/ingest` accepts `messages` (or one `message`).
- `POST /api/foundation/drive/ingest` accepts `files` (or one `file`).
- `POST /api/foundation/active-show-index/ingest` accepts `rows` (or one
  `row`) plus `sheetId`, `sheetName`, and connector cursor metadata.

The adapters are transport-neutral. They expect an authorized Gmail or Drive
sync process to retrieve provider data and then normalize it; they do not own
OAuth credentials or make provider API calls themselves.

### Email example

```json
{
  "cursorBefore": "history-100",
  "cursorAfter": "history-101",
  "messages": [
    {
      "id": "gmail-message-id",
      "threadId": "gmail-thread-id",
      "historyId": "101",
      "subject": "LiteFlair trucking update",
      "text": "Quote 26-1790 needs another truck.",
      "from": { "email": "pm@example.com" },
      "internalDate": "1784000000000",
      "permalink": "https://mail.google.com/..."
    }
  ]
}
```

### Drive example

```json
{
  "cursorAfter": "drive-change-token",
  "files": [
    {
      "id": "drive-file-id",
      "headRevisionId": "revision-id",
      "name": "Warehouse checklist",
      "mimeType": "application/vnd.google-apps.document",
      "modifiedTime": "2026-07-14T01:00:00Z",
      "webViewLink": "https://drive.google.com/...",
      "extractedText": "Dock two opens at 8am."
    }
  ]
}
```

### Active Show Index example

```json
{
  "sheetId": "google-sheet-id",
  "sheetName": "Active Shows",
  "revisionId": "sheet-revision",
  "rows": [
    {
      "showId": "liteflair-shoot",
      "showName": "LiteFlair Shoot",
      "rowNumber": 17,
      "client": "LiteFlair",
      "venue": "Studio A",
      "keyDocs": "Primary quote 26-1790",
      "primaryFlexDocument": {
        "documentNumber": "26-1790",
        "elementId": "826adc32-f11e-4d12-bd31-ecaa3f7bfe00",
        "documentType": "quote",
        "role": "primary_show_quote",
        "verified": true
      }
    }
  ]
}
```

The Active Show Index endpoint first refreshes the canonical show registry,
then records each row as immutable source evidence. Email and general Drive
files may reuse a verified FLEX-to-show mapping, but they never attach from a
show name alone. Unmatched evidence remains in `needs_match`; company-level
evidence without a show reference is routed without creating a fake show task.

## Lifecycle guarantees

- Exact connector replays are deduplicated by source type, external ID, and
  content hash.
- Material edits create a new immutable Source Record with
  `supersedesSourceRecordId` pointing to the previous revision.
- A material edit also supersedes the prior active Intake Item and any still-
  proposed updates derived from it. Historical evidence remains queryable but
  is excluded from current operational counts by default.
- Connector cursors advance only after the batch is persisted.
- Invalid records are reported on the connector run; valid records in the same
  batch are retained and the run is marked `partial`.
- Typed FLEX references remain typed. A mentioned pull sheet never silently
  replaces the canonical primary show quote.
- Proposed updates enter the shared proposal collection and do not write to an
  operational source of truth without an authorized decision.
