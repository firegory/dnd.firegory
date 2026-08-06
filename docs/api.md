# API Reference

All endpoints return JSON. Authentication is via session cookie (`token`) set by the login/register flow.

## Authentication

Authentication uses Next.js server actions (form submissions to `/login` and `/register` pages), not API endpoints. After login, a session cookie (`token`) is set automatically.

All API endpoints require a valid session cookie. Admin endpoints additionally require the `admin` role.

## Search

### POST `/api/search`

Search for chunks across authorized content using hybrid retrieval (keyword + vector).

**Auth**: Any authenticated user.

**Request body**:

```json
{
  "query": "how does grappling work",
  "edition": "5e",
  "language": "en",
  "category": "core_rules",
  "limit": 10
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Search query (max 500 characters) |
| `edition` | string | no | Filter by edition: `5e` or `5.5e` |
| `language` | string | no | Filter by language: `en` or `ru` |
| `category` | string | no | Filter by category: `core_rules`, `official_supplement`, or `homebrew` |
| `limit` | number | no | Maximum results to return |

**Response** (200):

```json
{
  "chunks": [
    {
      "chunkId": "uuid",
      "sourceId": "uuid",
      "fileId": "uuid",
      "text": "Full chunk text...",
      "quoteText": "Quote-safe text span...",
      "sectionHeading": "Grappling",
      "pageNumber": 42,
      "edition": "5e",
      "language": "en",
      "sourceTitle": "Player's Handbook",
      "sourceCategory": "core_rules",
      "accessTier": "open",
      "score": 0.85,
      "strategy": "keyword"
    }
  ],
  "total": 15,
  "hasMore": true,
  "expansions": [
    { "text": "grapple", "reason": "synonym", "weight": 0.8 },
    { "text": "grab", "reason": "synonym", "weight": 0.6 }
  ]
}
```

**Error responses**:

| Status | Condition |
| --- | --- |
| 401 | Not authenticated |
| 400 | Missing or invalid query, query too long |

Results are automatically filtered by the user's role and access tier. A `user` will only see chunks from `open` sources. A `premium` user sees `open` + shared premium + personal owned content. Admin sees everything.

When `language` is not specified, query expansion includes bilingual English↔Russian D&D term aliases. When a specific language is selected, expansion is monolingual.

---

## Compendium

All compendium reads apply the same source predicate as search and citation previews before selecting or grouping versions. Inaccessible UUID, slug, alias, source, and preview lookups return `404`.

### GET `/api/compendium/entries`

Lists published entries and returns an authorization-filtered `count`. Query parameters are `type`, `edition`, `language`, `category`, `limit` (1-200), and `offset`. If multiple sources publish the same conceptual entry and language, fields and aliases come from one highest-priority accessible version; values are never combined across versions.

### GET `/api/compendium/entries/[identifier]`

Returns a published entry by UUID or slug, including only source-bound aliases, relations to accessible entries, accessible source versions, and citations from the selected version and revision. Relations fail closed: each returned relation must have at least one provenance link to an accessible, non-deleted published source version. Relations with zero provenance links or only inaccessible/deleted provenance are omitted.

### GET `/api/compendium/aliases/[alias]`

Resolves an alias only when the alias belongs to the caller's selected accessible version. Supports the same `edition`, `language`, and `category` narrowing parameters.

### GET `/api/sources/[sourceId]`

Returns the caller-visible source attribution and publication fields. This non-admin route never emits ownership, raw metadata, storage paths, uploader/creator identity, or administrative timestamps. Full source metadata and mutations remain under `/api/admin/sources`.

**Role matrix**:

| Context | Open | Shared premium | Own personal | Other personal |
| --- | --- | --- | --- | --- |
| `user` | yes | no | no | no |
| `premium` owner | yes | yes | yes | no |
| `premium` non-owner | yes | yes | no | no |
| `admin` | yes | yes | yes | yes |
| Caller with zero matching sources | empty list/count 0 | empty | empty | empty |

---

## Admin: Ingestion

### POST `/api/admin/ingestion/upload`

Upload a PDF and start an ingestion job.

**Auth**: Admin only.

**Content-Type**: `multipart/form-data`

**Form fields**:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | File | yes | PDF file (max 1 GB) |
| `title` | string | yes | Source title |
| `category` | string | yes | `core_rules`, `official_supplement`, or `homebrew` |
| `edition` | string | yes | `5e` or `5.5e` |
| `language` | string | yes | `en` or `ru` |
| `accessTier` | string | yes | `open`, `premium`, or `personal` |
| `canonicalSourceId` | string | no | Stable canonical source ID |
| `publicationCode` | string | no | Publication/catalog code |
| `publicationTitle` | string | no | Defaults to source title |
| `publisher` | string | no | Publisher |
| `releaseYear` | integer | no | Publication year |
| `revision` | string | no | Printing/revision; requires release year |
| `originUrl` | string | no | Absolute HTTP(S) URL; requires origin ID and valid percent encoding |
| `originId` | string | no | External provider ID; requires origin URL |
| `attribution` | string | no | Display attribution |
| `sourcePriority` | integer | no | 0-1000; defaults to 0 |
| `canonicalBookId` | string | no | Stable conceptual book identity |
| `license` | string | no | License statement |

**Response** (201):

```json
{
  "sourceId": "uuid",
  "fileId": "uuid",
  "jobId": "uuid",
  "status": "queued"
}
```

**Error responses**:

| Status | Condition |
| --- | --- |
| 403 | Not admin |
| 400 | Missing file, invalid metadata, file too large, non-PDF |

### GET `/api/admin/ingestion/jobs`

List ingestion jobs with optional filtering and pagination.

**Auth**: Admin only.

**Query parameters**:

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `status` | string | all | Filter by status: `queued`, `processing`, `succeeded`, `failed`, `cancelled` |
| `limit` | number | 50 | Results per page (1–200) |
| `offset` | number | 0 | Pagination offset |

**Response** (200):

```json
{
  "jobs": [
    {
      "id": "uuid",
      "kind": "upload",
      "status": "succeeded",
      "sourceId": "uuid",
      "fileId": "uuid",
      "progress": 100,
      "errorSummary": null,
      "queuedAt": "2026-01-01T00:00:00Z",
      "finishedAt": "2026-01-01T00:01:30Z"
    }
  ]
}
```

### POST `/api/admin/ingestion/jobs/[jobId]/retry`

Retry a failed ingestion job.

**Auth**: Admin only.

**Response** (200):

```json
{
  "job": {
    "id": "uuid",
    "kind": "retry",
    "status": "queued",
    "sourceId": "uuid",
    "fileId": "uuid"
  },
  "queueId": "queue-identifier"
}
```

**Error responses**:

| Status | Condition |
| --- | --- |
| 403 | Not admin |
| 400 | Invalid job ID, job is not in a retryable state |

### POST `/api/admin/ingestion/sources/[sourceId]/reprocess`

Reprocess a source — creates a new ingestion job from the original PDF.

**Auth**: Admin only.

**Response** (200):

```json
{
  "job": {
    "id": "uuid",
    "kind": "reprocess",
    "status": "queued",
    "sourceId": "uuid",
    "fileId": "uuid"
  },
  "queueId": "queue-identifier"
}
```

### POST `/api/admin/ingestion/sources/[sourceId]/delete`

Delete a source and all associated data (files, chunks, jobs).

**Auth**: Admin only.

**Response** (200):

```json
{
  "sourceId": "uuid",
  "cancelledJobs": 1,
  "removedFiles": 2,
  "message": "Source uuid deleted successfully."
}
```

---

## Admin: Source metadata CRUD

### GET `/api/admin/sources`

List all sources with optional filtering.

**Auth**: Admin only.

**Query parameters**:

| Param | Type | Description |
| --- | --- | --- |
| `category` | string | Filter by category |
| `edition` | string | Filter by edition |
| `language` | string | Filter by language |
| `accessTier` | string | Filter by access tier |
| `includeDeleted` | string | Set to `true` to include soft-deleted sources |

**Response** (200):

```json
{
  "sources": [
    {
      "id": "uuid",
      "canonicalSourceId": "players-handbook-2014-en",
      "title": "Player's Handbook",
      "category": "core_rules",
      "edition": "5e",
      "language": "en",
      "accessTier": "premium",
      "shared": true,
      "ownerUserId": null,
      "publication": {
        "code": "PHB-2014",
        "title": "Player's Handbook",
        "publisher": "Wizards of the Coast",
        "releaseYear": 2014,
        "revision": "first printing",
        "origin": { "url": "https://example.com/books/phb", "id": "phb-2014" },
        "attribution": "Player's Handbook, Wizards of the Coast",
        "sourcePriority": 100,
        "canonicalBookId": "players-handbook"
      },
      "license": "All rights reserved",
      "metadata": {},
      "createdByUserId": "uuid",
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z",
      "deletedAt": null
    }
  ]
}
```

### POST `/api/admin/sources`

Create a new source metadata record.

**Auth**: Admin only.

**Request body**:

```json
{
  "canonicalSourceId": "players-handbook-2014-en",
  "title": "Player's Handbook",
  "category": "core_rules",
  "edition": "5e",
  "language": "en",
  "accessTier": "premium",
  "ownerUserId": null,
  "publication": {
    "code": "PHB-2014",
    "title": "Player's Handbook",
    "publisher": "Wizards of the Coast",
    "releaseYear": 2014,
    "revision": "first printing",
    "origin": { "url": "https://example.com/books/phb", "id": "phb-2014" },
    "attribution": "Player's Handbook, Wizards of the Coast",
    "sourcePriority": 100,
    "canonicalBookId": "players-handbook"
  },
  "license": "All rights reserved",
  "metadata": {}
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Source title |
| `canonicalSourceId` | string or null | no | Stable lowercase ID used by canonical `source.json` |
| `category` | string | yes | `core_rules`, `official_supplement`, or `homebrew` |
| `edition` | string | yes | `5e` or `5.5e` |
| `language` | string | yes | `en` or `ru` |
| `accessTier` | string | yes | `open`, `premium`, or `personal` |
| `ownerUserId` | UUID string | no | Required for `personal` tier; rejected for `open` and `premium` |
| `publication` | object | no | Bibliographic projection; omitted values retain documented nullable/default behavior |
| `publication.code` | string or null | no | Publication/catalog code |
| `publication.title` | string | no | Publication title; defaults to source `title` |
| `publication.publisher` | string or null | no | Publisher |
| `publication.releaseYear` | integer or null | no | 1974-2100; `5.5e` cannot predate 2024 |
| `publication.revision` | string or null | no | Printing/revision; requires `releaseYear` |
| `publication.origin` | object or null | no | Absolute HTTP(S) `url` and `id`, supplied together; WHATWG-normalized and whitespace-free |
| `publication.attribution` | string or null | no | Display attribution |
| `publication.sourcePriority` | integer | no | 0-1000; defaults to 0 |
| `publication.canonicalBookId` | string or null | no | Stable conceptual book identity |
| `license` | string or null | no | License statement |
| `metadata` | object | no | Additional metadata |

**Response** (201): Returns the created source record.

### GET `/api/admin/sources/[sourceId]`

Get a single source by ID.

**Auth**: Admin only.

**Response** (200): Returns the source record.

**Error responses**: 404 if not found.

### PATCH `/api/admin/sources/[sourceId]`

Update a source's metadata.

**Auth**: Admin only.

**Request body**: Any subset of the create fields.

**Response** (200): Returns the updated source record.

### DELETE `/api/admin/sources/[sourceId]`

Soft-delete a source.

**Auth**: Admin only.

**Response** (200): Returns the deleted source record.

---

## Admin: File metadata CRUD

### GET `/api/admin/sources/[sourceId]/files`

List files for a source.

**Auth**: Admin only.

**Query parameters**:

| Param | Type | Description |
| --- | --- | --- |
| `includeDeleted` | string | Set to `true` to include soft-deleted files |

**Response** (200):

```json
{
  "files": [
    {
      "id": "uuid",
      "sourceId": "uuid",
      "originalFilename": "phb.pdf",
      "mimeType": "application/pdf",
      "checksumSha256": "abc123...",
      "byteSize": 104857600,
      "storagePath": "storage/originals/uuid/uuid.pdf",
      "processedArtifactsRoot": null,
      "uploadedByUserId": "uuid",
      "createdAt": "2026-01-01T00:00:00Z",
      "deletedAt": null
    }
  ]
}
```

### POST `/api/admin/sources/[sourceId]/files`

Create a file metadata record (does not upload a file — use the ingestion upload endpoint for that).

**Auth**: Admin only.

**Request body**:

```json
{
  "originalFilename": "phb.pdf",
  "mimeType": "application/pdf",
  "checksumSha256": "abc123...",
  "byteSize": 104857600,
  "storagePath": "storage/originals/uuid/uuid.pdf"
}
```

**Response** (201): Returns the created file record.

### GET `/api/admin/sources/[sourceId]/files/[fileId]`

Get a single file by ID.

**Auth**: Admin only.

### PATCH `/api/admin/sources/[sourceId]/files/[fileId]`

Update a file's metadata.

**Auth**: Admin only.

### DELETE `/api/admin/sources/[sourceId]/files/[fileId]`

Soft-delete a file.

**Auth**: Admin only.

---

## Error format

All error responses follow this shape:

```json
{
  "error": "Human-readable error message."
}
```

Common error status codes:

| Status | Meaning |
| --- | --- |
| 400 | Bad request — invalid input, missing fields |
| 401 | Not authenticated |
| 403 | Forbidden — insufficient role (admin required) |
| 404 | Not found |
| 500 | Internal server error |
