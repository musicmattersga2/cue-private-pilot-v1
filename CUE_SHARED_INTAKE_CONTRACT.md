# CUE Shared Intake Contract

This increment establishes one connector-neutral path from operational sources
to CUE Source Records and Intake Items. The PostgreSQL schema remains the
production contract; `cue-foundation-store.mjs` is the JSON pilot implementation.

## Identity authority

1. A FLEX Confirmed Quote starts provisional show awareness and readiness.
2. The Active Show Index adopts the provisional record and owns ongoing operational lifecycle.
3. FLEX owns financial-document identity and the show/document hierarchy.
4. Native CUE modules (staffing, trucking, warehouse) own their domain events.
5. Motive, email, Drive documents, and Slack contribute evidence.
6. A human decision may confirm or correct any proposed association.

Source capabilities are explicit:

- FLEX Confirmed MMP Quotes may establish that a show exists and is confirmed.
- The Active Show Index may establish operational identity and lifecycle.
- FLEX document hierarchy may establish parent/child document relationships.
- Staffing, trucking, and warehouse modules may establish facts only in their
  owned operational domains.
- Email, Drive, Motive, and Slack may contribute evidence and proposed updates.
- Slack has `authorityRole: operational_signal` and
  `canEstablishShow: false`; it never confirms that a show exists.

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

## Source-first orchestration

`POST /api/foundation/source-first/sync` runs the authority and evidence layers
in this order:

1. discover confirmed FLEX MMP Quotes from a configured global feed when
   available, otherwise from the verified paginated snapshot endpoint, and
   verify their exact status transitions;
2. observe any explicitly supplied FLEX quote-status transitions;
3. read the live Active Show Index and refresh the Canonical Show Registry;
4. reconcile matching provisional shows and record Active Show Index identity evidence;
5. load verified FLEX document-to-show mappings from the registry;
6. ingest supplied email messages;
7. ingest supplied Drive files;
8. rematch and ingest Slack operational signals last.

The request accepts the same provider-shaped `emailMessages` and `driveFiles`
used by the typed adapters. Set `syncSlack` to `false` to stop after the
  authoritative and higher-signal sources.

## Confirmed Quote lifecycle trigger

`POST /api/foundation/flex/quote-status/observe` accepts `quotes` (or one
`quote`). A minimal observation is:

```json
{
  "quote": {
    "elementId": "85141d01-8008-4d29-8fc2-1749159e35e0",
    "documentNumber": "26-1846",
    "documentType": "quote",
    "status": "Confirmed Quote",
    "showName": "Live Nation Moonchild @ The Fox",
    "changedAt": "2026-07-14T08:05:00Z"
  }
}
```

The first confirmed observation creates a provisional canonical show, an
immutable FLEX source record, matched Intake, `flex.quote.confirmed` event,
show-onboarding decision card, and initial readiness milestones. Replays are
idempotent. The Active Show Index later reconciles the provisional show by
verified quote UUID first and quote number second.

`POST /api/foundation/flex/quote-status/poll` can retrieve status for known quote
UUIDs. Automatic discovery no longer depends on Slack or on a hypothetical
global feed. CUE pages the verified `element-list/row-data` endpoint using the
MMP Quote definition, Confirmed status, and Peachtree Corners location, then
reads `element-status-change/{elementUuid}` to obtain the authoritative
transition ID, timestamp, and actor. A global feed or webhook remains a useful
future optimization, not a correctness dependency.

### Local FLEX connector configuration and verification

Copy `.env.example` to the ignored `.env` file and configure `FLEX_BASE_URL`,
`FLEX_AUTH_HEADER`, and `FLEX_AUTH_VALUE` locally. Prefer a dedicated read-only
FLEX credential when one is available. A temporary authenticated browser cookie
may be used for local development, but it must never be committed, pasted into
project chat, or written to logs.

Run `npm run smoke:flex-confirmed` before enabling a live sync. The smoke test
performs exactly two read-only requests: one small confirmed MMP Quote page and
one status-history request for a returned quote. It does not write CUE state,
does not call a FLEX mutation endpoint, never prints the authentication value,
and exits nonzero when authentication, filtering, JSON shape, or the confirmed
transition cannot be verified.

When available, the optional lifecycle adapter is configured with
`CUE_FLEX_LIFECYCLE_FEED_PATH`. The path must resolve to the same origin as
`FLEX_BASE_URL`; credentials continue to use the existing authenticated FLEX
request path. Optional feed settings are:

- `CUE_FLEX_LIFECYCLE_CURSOR_PARAM` (default `cursor`);
- `CUE_FLEX_LIFECYCLE_SINCE_PARAM` (default `updatedSince`);
- `CUE_FLEX_LIFECYCLE_INITIAL_SINCE` for the first run;
- `CUE_FLEX_LIFECYCLE_LIMIT_PARAM` (default `limit`);
- `CUE_FLEX_LIFECYCLE_LIMIT` (default `100`, maximum `1000`).

The feed may return `events`, `records`, `quotes`, `items`, `results`, `rows`,
or `data`, plus `nextCursor` (or an equivalent supported cursor field). Every
candidate UUID is re-read from FLEX header data and, when available, the FLEX
element tree. Any pull sheet, invoice, child document, unknown document type,
number conflict, or incomplete lifecycle record is rejected rather than
treated as a quote. The connector checkpoint advances only after the entire
page is processed successfully; a partial page retains the prior cursor for an
idempotent replay.

Lifecycle health and manual execution are available at:

- `GET /api/foundation/flex/lifecycle/status`;
- `POST /api/foundation/flex/lifecycle/discover`.

When no feed is configured, CUE automatically uses the confirmed-quote
snapshot connector. Its durable state includes the complete UUID snapshot,
last successful completion, last full reconciliation, each row fingerprint,
confirmation event ID, confirmation timestamp, and disposition. The snapshot
advances only after all pages and required status histories succeed. Known
related FLEX documents are recorded as deferred-to-parent and cannot fire the
show lifecycle trigger.

If the live Active Show Index cannot be read, the sync reports
`fallback_not_authoritative` and preserves the existing registry unchanged.
Fallback UI rows and generated FLEX hints are never allowed to create,
deactivate, or rewrite canonical show identities.

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
- Only a document verified as a FLEX quote can fire the confirmation trigger;
  pull sheets, manifests, invoices, and other child documents remain evidence.
- Slack can never establish show existence or confirmation. It is processed
  after FLEX authority, the Active Show Index, email, and Drive so it can attach
  operational signals using the strongest available identity context.
- A provisional FLEX-confirmed show survives Active Show Index delays and is
  adopted rather than duplicated when the Index begins tracking it.
- Proposed updates enter the shared proposal collection and do not write to an
  operational source of truth without an authorized decision.
