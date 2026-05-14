# Roadmap

What ships in the current release.

## v2.0.0-alpha.1 — Webhook intake (current)

Adds a webhook-driven sync path so the plugin can pick up meetings shared with the user, not only meetings they recorded themselves. Polling sync from v1.x remains the default; webhook intake is opt-in via plugin settings.

**Plugin**

- New `Queue` interface with two implementations:
  - `FolderQueue` — reads JSON payloads from a vault folder (dotfile-safe via the adapter API). Pairs with any Make/Zapier/n8n flow that can drop files.
  - `HttpQueue` — polls a user-deployed Cloudflare Worker via `requestUrl` (CORS-safe).
- `SyncService.drainQueue()` and `processWebhookPayload()` write notes straight from inline webhook content — no GET round-trips, no rate-limit pressure.
- `FathomApiClient` gained `createWebhook` / `deleteWebhook` for one-click registration against `POST /external/v1/webhooks`.
- Settings UI: "Webhook intake" section with a Connect button that registers the webhook and copies the signing secret to the clipboard (never rendered in full in the UI). Bearer-token field is masked.
- Single-flight `inFlightSync` mutex covers queue drains alongside polling sync.

**Worker** (`worker/`)

- Cloudflare Worker (~200 LOC) that:
  - `POST /webhook` — verifies Svix-style HMAC-SHA256 signatures with a 5-minute replay tolerance, stores payload in KV with 7-day TTL.
  - `GET /pending` — bearer-auth, paginates `KV.list` for high-volume backlogs.
  - `POST /ack` — bearer-auth, deletes acknowledged deliveries.
  - `GET /health` — open readiness probe.
- Fails closed with HTTP 503 `worker_not_configured` when `PLUGIN_BEARER_TOKEN` or `FATHOM_WEBHOOK_SECRET` are missing — secrets MUST be set via the Cloudflare secrets store (`wrangler secret put`), never as `[vars]`.
- `wrangler.toml` + Deploy-to-Cloudflare button in `WEBHOOKS.md` for one-click setup.

## v1.0.1 — Hardening (shipped)

Pre-mortem pass — 15 issues identified and fixed. No new user-facing features beyond Test connection.

- **Single-flight sync mutex** — manual click + periodic tick can no longer overlap. Status: "A sync is already running" notice on double-click.
- **Granola Sync collision detection** — counts existing `fathom_id` notes from other plugins and surfaces a one-time notice so users understand why they may see new copies.
- **Test connection button** in settings — hits `GET /teams` to verify the token works. Decodes 401 → "invalid API token", 403 → "token lacks permission".
- **Forward pagination via `lastSyncCursor`** — standard sync now resumes from the saved cursor and saves the next one only on clean completion. Reset button clears it.
- **Periodic-mode toast suppression** — overnight offline no longer produces a stack of 16 failure Notices. Status bar still goes red.
- **Empty-summary cache poisoning fixed** — unknown summary shapes throw instead of writing a stub note that would forever be skipped.
- **Static rate-limit throttle** — survives client rebuilds when settings change mid-sync.
- **Windows reserved filename handling** — `CON`, `NUL`, `COM1` etc. are escaped; trailing dots/spaces stripped.
- **YAML frontmatter rewritten** as single-quoted scalars — robust against titles/names containing `:`, `"`, `\`.
- Plus: settings only rebuild services when the API token actually changes; `recorded_by` emails lowercased; `daysAgoIso` clamped + UTC; mobile platform guard; logger level switch; defensive coercion on transcript segments.

## v1.0.0 — Individual workflow (shipped)

- Personal API-key auth (`X-Api-Key` header)
- Syncs AI summaries + speaker-attributed transcripts
- Filter by team and/or recorder email
- Incremental sync via `fathom_id` dedup cache
- Periodic background sync on configurable interval
- Bi-directional wikilinks between summary ↔ transcript notes
- Rate-limited (1.1s/request) with automatic 429 retry/backoff
