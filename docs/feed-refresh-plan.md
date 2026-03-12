# Feed Refresh — Implementation Plan for `slcli appstore feed refresh`

## Overview

Refreshing a replicated NI Feed is a two-step, job-based operation:

1. **Check for updates** — ask the server which packages in the upstream index are newer than the local replicated copies.
2. **Apply updates** — tell the server to re-download those packages from their upstream URLs.

Both steps are asynchronous: each call returns a `jobId` that must be polled to determine whether the operation succeeded.

---

## API Base URL

```
{server}/nifeed/v1/feeds/{feedId}/
```

Authentication is via session cookie (browser) or `x-ni-api-key` header (CLI/`slcli`).

---

## Step 1 — Discover the feed ID

If the user doesn't supply a feed ID, look up the feed by name.

```
GET /nifeed/v1/feeds
```

Response body:

```json
{
  "feeds": [
    { "id": "a81c8b00-c188-4cc6-afc5-357d05757b70", "name": "SystemLink App Store", ... }
  ]
}
```

Filter by `name === "SystemLink App Store"` (or the name the user configured).

---

## Step 2 — Trigger a check-for-updates job

```
POST /nifeed/v1/feeds/{feedId}/check-for-updates
```

- **Request body**: empty / omit entirely (`body?: never` in the SDK types — the server ignores any body).
- **Success response**: `201 Created`
  ```json
  { "jobId": "3f2c1a00-..." }
  ```

---

## Step 3 — Poll until the check job completes

```
GET /nifeed/v1/feeds/{feedId}/jobs
```

Response body:

```json
{
  "jobs": [
    {
      "id": "3f2c1a00-...",
      "type": "CHECK_FEED_UPDATE",
      "status": "SUCCESS",
      "result": {
        "resourceIds": ["pkg-uuid-1", "pkg-uuid-2"]
      }
    }
  ]
}
```

### Polling strategy

- Filter the `jobs` array for the entry whose `id` matches the `jobId` from step 2.
- Poll every **2 seconds**, up to **30 attempts** (60 s total timeout).
- Possible `status` values: `RUNNING`, `SUCCESS`, `FAILED`, `ERROR`.
- On `SUCCESS`: extract `job.result.resourceIds` (a list of UUIDs identifying the packages that have available updates).
- On `FAILED` / `ERROR`: abort with the error message from `job.error`.
- On timeout: abort with a user-friendly message.

### Early exit

If `resourceIds` is empty (or absent), the feed is already up to date — skip step 4 and report "Feed is up to date."

> **Note**: `resourceIds` are internal NI Feed package UUIDs, **not** the upstream download URLs needed for step 4. They are used only to confirm that updates exist; the actual URIs come from the replicated Packages index (step 4).

---

## Step 4 — Resolve upstream download URLs

The `apply-updates` call requires the **full HTTPS download URL** for each package. These are stored in the `Filename:` fields of the Packages index.

Fetch the **replicated** index (already on the server — no external request needed):

```
GET /nifeed/v1/feeds/{feedId}/files/Packages
```

The file is a plaintext RFC 822–style stanza list. Parse it and extract every `Filename:` value that starts with `http`.

### Packages index format

```
Package: systemlink-app-store
Version: 0.1.0
DisplayName: SystemLink App Store
Filename: https://github.com/ni-kismet/systemlink-app-store/releases/download/systemlink-app-store-v0.1.0/systemlink-app-store_0.1.0_all.nipkg
SHA256: abc123...
Size: 1024000

Package: another-app
...
```

Stanzas are separated by one or more blank lines. Multi-line field values are continued by indented lines.

> **Important**: Normalize `\r\n` → `\n` before splitting, because the index may use CRLF line endings. Failing to do so causes the whole file to be parsed as a single stanza.

---

## Step 5 — Apply the updates

```
POST /nifeed/v1/feeds/{feedId}/apply-updates
Content-Type: application/json
```

Request body:

```json
{
  "applyUpdateDescriptors": [
    { "packageUri": "https://github.com/.../foo_0.1.0_all.nipkg" },
    { "packageUri": "https://github.com/.../bar_1.2.3_all.nipkg" }
  ]
}
```

### Critical constraints (learned from API probing)

| Rule                | Detail                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Flat object**     | Do **not** wrap in a `"request"` key. `{"request": {...}}` always returns HTTP 400.                                                    |
| **Non-empty array** | An empty `applyUpdateDescriptors: []` returns HTTP 400 with `"UpdateDescriptors must be an array type with a maximum length of 1000"`. |
| **Full URLs**       | Each `packageUri` must be an absolute HTTPS URL (from the `Filename:` field).                                                          |

Success response: `201 Created`

```json
{ "jobId": "e9e1de3e-..." }
```

---

## Step 6 — (Optional) Poll until the apply job completes

The apply job (`type: "APPLY_UPDATES"`) can be polled the same way as the check job. For a fire-and-forget CLI command this may be omitted; for a `--wait` flag, poll until `SUCCESS` or `FAILED`.

```
GET /nifeed/v1/feeds/{feedId}/jobs
```

Filter by `jobId` from step 5, `type === "APPLY_UPDATES"`.

---

## Complete flow diagram

```
slcli appstore feed refresh [--feed-id <id> | --feed-name <name>]
         │
         ├─ 1. GET /nifeed/v1/feeds  →  resolve feedId
         │
         ├─ 2. POST .../check-for-updates  →  { jobId }
         │
         ├─ 3. POLL GET .../jobs every 2s
         │        ├─ status=RUNNING  →  wait
         │        ├─ status=FAILED   →  exit error
         │        └─ status=SUCCESS  →  resourceIds (empty → "up to date", done)
         │
         ├─ 4. GET .../files/Packages  →  parse stanzas, collect Filename: URLs
         │
         ├─ 5. POST .../apply-updates  { applyUpdateDescriptors: [{packageUri},...] }
         │
         └─ 6. (--wait) POLL GET .../jobs  →  APPLY_UPDATES job SUCCESS / FAILED
```

---

## Suggested CLI command signature

```
slcli appstore feed refresh [--feed-id <uuid>] [--feed-name <name>] [--wait] [--timeout <seconds>]
```

| Flag          | Default                  | Description                                           |
| ------------- | ------------------------ | ----------------------------------------------------- |
| `--feed-id`   | —                        | Feed UUID. Takes priority over `--feed-name`.         |
| `--feed-name` | `"SystemLink App Store"` | Look up the feed ID by name if `--feed-id` not given. |
| `--wait`      | `false`                  | Block until the apply job also completes (step 6).    |
| `--timeout`   | `120`                    | Total seconds to wait for any polling loop.           |

### Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Feed refreshed successfully (or already up to date).            |
| `1`  | Feed not found, job failed, or apply-updates returned an error. |

---

## Error cases to handle

- Feed not found by name → exit 1 with `"Feed '<name>' not found"`.
- `check-for-updates` POST fails (non-2xx) → exit 1 with server error body.
- Check job times out → exit 1 with `"check-for-updates job timed out after <n>s"`.
- Check job fails → exit 1 with `job.error` message.
- `GET .../files/Packages` fails → exit 1 (`"Failed to fetch Packages index: HTTP <status>"`).
- No `Filename:` URLs found in index → exit 1 (`"No downloadable packages in index"`).
- `apply-updates` POST fails (non-2xx) → exit 1 with server error body.
- Apply job fails (when `--wait`) → exit 1 with `job.error` message.
