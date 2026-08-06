# Agent Gateway

The agent gateway is a separate, read-only process over the PostgreSQL content index. It exposes HTTP v1 and MCP tools without granting callers database, SQL, storage-path, or filesystem access. Both adapters call the same `AgentReadService`, which applies the application source predicate from `src/server/access` before selecting indexed entries.

## Start

```bash
npm run agent-gateway
```

The secure default is `127.0.0.1:8787`. Set `AGENT_GATEWAY_HOST=0.0.0.0` only behind an authenticated network boundary. `AGENT_GATEWAY_PORT` changes the port.

A standalone image target is available without adding a production Compose service:

```bash
docker build --target agent-gateway -t dnd-firegory-agent .
docker run --rm -p 8787:8787 \
  -e DATABASE_URL=postgres://... \
  -e AGENT_GATEWAY_TOKENS='[...]' \
  dnd-firegory-agent
```

The target includes a healthcheck that calls `npm run agent-healthcheck`. No production Compose wiring is included; that remains deployment issue #85.

## Authentication

All data operations require `Authorization: Bearer <token>`. `/healthz` is intentionally unauthenticated and reveals only availability and protocol version.

Configure API tokens with `AGENT_GATEWAY_TOKENS`, a JSON array. Store only lowercase SHA-256 token digests:

```bash
node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' 'replace-with-random-token'
```

```json
[
  {
    "id": "rules-agent",
    "sha256": "64-lowercase-hex-characters",
    "role": "premium",
    "userId": "personal-content-owner-user-id",
    "scopes": ["list_entries", "get_entry", "get_citations", "read_section"]
  }
]
```

`role` and `userId` produce the same source access policy as application sessions:

| Role | Accessible sources |
| --- | --- |
| `user` | Open sources |
| `premium` | Open, shared premium, and personal sources owned by `userId` |
| `admin` | All sources |

Use `agent:read` for all nine read tools, or list individual tool names as scopes. An empty scope list grants no tools. Tokens cannot request broader filters or pass an owner identity in a request.

Existing application session tokens may be accepted as bearer tokens only when `AGENT_GATEWAY_ALLOW_SESSIONS=true`. Session validation is read-only: the gateway does not update `last_seen_at`. Session principals receive `agent:read` and retain their server-owned role and user ID.

## HTTP v1

The request header `Agent-API-Version` may be omitted for v1 or set to `1`. Other values return HTTP `406` with `error.code=unsupported_version` and the supported versions. Successful responses include `Agent-API-Version: 1` and use:

```json
{
  "data": {},
  "meta": { "version": "1" }
}
```

Endpoints are read-only `GET` operations:

| Endpoint | Operation |
| --- | --- |
| `GET /v1/entity-types` | `list_entity_types` |
| `GET /v1/entries` | `list_entries` |
| `GET /v1/entries/{identifier}` | `get_entry` |
| `GET /v1/aliases/{alias}` | `resolve_alias` |
| `GET /v1/search?query=...` | `search_entries` |
| `GET /v1/sources/{sourceId}` | `get_source` |
| `GET /v1/entries/{identifier}/citations` | `get_citations` |
| `GET /v1/entries/{identifier}/sections/{sectionId}` | `read_section` |
| `GET /v1/changes?since=2026-01-01T00:00:00Z` | `list_changed_entries` |
| `GET /healthz` | Database-backed healthcheck |

Common narrowing parameters are `edition`, `language`, and `category`. Lists and searches also accept `entryType`, `limit` (1-200), and opaque `cursor`. Follow only the returned `nextCursor`; cursors are operation-specific and versioned. Ordering uses stable canonical IDs plus deterministic UUID tie-breakers. Search additionally preserves rank, and change pagination preserves change timestamp.

`list_changed_entries` reports the latest indexed state after `since`: `upserted` for active entries and `deleted` for retired entries. It is an index synchronization feed, not an immutable audit log. Consumers should store a successful polling watermark and reconcile returned stable IDs.

Machine errors have a stable code and request ID:

```json
{
  "error": {
    "code": "not_found",
    "message": "The requested resource was not found.",
    "requestId": "..."
  }
}
```

Codes are `authentication_required`, `forbidden`, `invalid_request`, `not_found`, `unsupported_version`, and `internal_error`. Missing and inaccessible entries, sources, aliases, sections, and citations are deliberately indistinguishable where applicable.

## MCP

MCP uses Streamable HTTP-style JSON-RPC requests at `POST /mcp`. The server is stateless and supports protocol versions `2025-03-26` and `2024-11-05`. Send the negotiated value in `MCP-Protocol-Version` after `initialize`. Unsupported initialize versions return JSON-RPC error data with `code=unsupported_version`.

Available tools are:

- `list_entity_types`
- `list_entries`
- `get_entry`
- `resolve_alias`
- `search_entries`
- `get_source`
- `get_citations`
- `read_section`
- `list_changed_entries`

`tools/list` returns only tools allowed by the bearer token scopes. Tool failures set `isError: true` and include the same machine error object in `structuredContent.error`. There are no mutation, SQL, file-reading, resource-writing, or prompt-writing capabilities.

## IDs And Provenance

Responses preserve the #102 indexed identities:

- `id`: deterministic UUID for an indexed repository entry.
- `entryId`: canonical repository entry ID.
- `revisionId` and `contentHash`: immutable revision/content identities.
- Top-level `sourceId` and `fileId`: deterministic indexed database source/file UUIDs.
- `sectionId` and `citationId`: canonical payload identities.

Citation objects retain the canonical repository `sourceId` and `fileId`; citation and section responses also include the indexed UUIDs at the top level for `get_source` and database-backed correlation.

Entry, section, citation, and search responses retain source, page, section, quote, and text-span provenance where present. The gateway never returns storage paths.

## Filesystem Trust Boundary

Direct NFS access remains an intentional trusted administrative bypass. It does not apply SQL RBAC and must be mounted only for administrators, the indexing worker, and trusted local agents. Remote or scoped callers must use this gateway. Do not mount the canonical repository or application storage into a gateway-facing client environment, and do not infer caller authorization from filesystem access.
