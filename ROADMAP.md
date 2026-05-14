# Roadmap

What works today, and what's planned. Sorted roughly by priority.

## ✅ v1.0.0 — Individual workflow (shipped)

- Personal API-key auth (`X-Api-Key` header)
- Syncs AI summaries + speaker-attributed transcripts
- Filter by team and/or recorder email
- Incremental sync via `fathom_id` dedup cache
- Periodic background sync on configurable interval
- Bi-directional wikilinks between summary ↔ transcript notes
- Rate-limited (1.1s/request) with automatic 429 retry/backoff

## ✅ v1.0.1 — Hardening (shipped)

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

## 🔜 v1.1 — Polish & resilience

- [ ] **Encrypted token storage** via Electron's `safeStorage` API. Currently `data.json` stores the API key in plaintext — fine for single-user, not great for shared/synced vaults. ~30 LOC.
- [ ] **Settings: filename pattern preview** — show the user what `{date} {title}` resolves to before they save.

## 🚀 v2.0 — Webhook-driven sync (attended meetings)

**The gap:** `/external/v1/meetings` only returns meetings recorded by the API-key user (and team-shared ones). It does **not** surface meetings shared with you by external people — so a Fathom share email lands in your inbox but never in your vault.

**The fix:** Fathom's webhook API supports a `triggered_for` enum that includes `shared_external_recordings` alongside `my_recordings`, `my_shared_with_team_recordings`, and `shared_team_recordings`. Webhook payloads carry the full summary + transcript + action items inline, so the plugin writes notes straight from the payload — no GET round-trips, no rate-limit pressure, near-instant sync.

**Architecture:**

```
Fathom ──webhook──► Cloudflare Worker (user-deployed, ~80 LOC)
                         │ verifies signature, appends to KV
                         ▼
                   GET /pending?since=cursor
                         ▲
                   Obsidian plugin polls every ~60s
                         │
                         ▼
                   Vault notes (existing DocumentProcessor + FileSyncService)
```

Two intake paths behind one interface:

- **`HttpQueue`** — plugin polls user-owned HTTPS endpoint. Primary path.
- **`FolderQueue`** — plugin reads JSON files from a vault folder (for Make/Zapier/n8n users with an existing flow). Documented fallback.

Polling sync stays as backfill and as the default when no queue is configured. Zero-friction upgrade — existing v1.x users see no behaviour change until they opt in.

**Plugin deliverables:**

- [ ] `WebhookPayload` type in `src/types.ts` matching Fathom's `new-meeting-content-ready` schema
- [ ] `Queue` interface + `HttpQueue` + `FolderQueue` under `src/services/queues/`
- [ ] `SyncService.processWebhookPayload(payload)` — writes from inline content, reuses existing processors
- [ ] Auto-register webhook via `POST /external/v1/webhooks` when queue URL is configured; store webhook ID; re-register on URL change
- [ ] Settings UI: queue type, URL/folder, bearer token, "Test queue", "Re-register webhook"
- [ ] Extend `inFlightSync` mutex to cover queue drains (single-flight across polling + webhook intake)

**Worker template (new repo `obsidian-fathom-sync-worker`):**

- [ ] `POST /webhook` — verify Svix-style headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) via HMAC-SHA256, append to KV
- [ ] `GET /pending?since=<cursor>` — bearer-auth, returns payloads + next cursor
- [ ] `POST /ack` — delete acked payloads (or rely on KV TTL)
- [ ] `wrangler.toml` + README with one-command deploy
- [ ] Signing-secret rotation guide

**Phasing:**

- **v2.0-alpha** — `FolderQueue` only; dogfooded with a Make.com scenario
- **v2.0-beta** — Worker template + `HttpQueue`; personal-install testers
- **v2.0** — Plugin store submission, ships alongside v1.1 (encrypted token)

**Risks to confirm during build:**

1. Fathom webhook retry policy — if the Worker is down for hours, can `shared_external_recordings` be lost? (Polling backfills the other three categories, not this one.)
2. Webhook payload max size — full transcripts can be large; Cloudflare free-plan body limit is 100MB so almost certainly fine.
3. Cloudflare free-tier KV write limits (1k/day) — power users with many daily meetings could hit it; document.

## 🚀 v2.1 — Multi-account in one vault

For users who want to consolidate meetings from multiple Fathom accounts into one vault. Originally planned as v2.0, deferred so the webhook path ships against the single-key model first.

- [ ] Settings becomes a list of accounts: `{ label, apiToken, queueConfig, teamFilter, recordedByFilter, summaryFolder, transcriptFolder }`
- [ ] Sync loops over all accounts, deduplicates by `recording_id` (same meeting fetched via two tokens shouldn't write twice)
- [ ] Frontmatter records `synced_via: <account-label>` for traceability
- [ ] UI: add/remove/test each account independently
- [ ] Each account registers its own webhook against its own queue (or shares one queue with account-label routing)

## 🌐 v3.0 — Public OAuth flow

For an Obsidian Community Plugin Store submission, individual API keys are friction. OAuth is the proper path but has a real constraint:

> Fathom OAuth uses `client_secret`-based credential flow. Public client-side apps can't safely ship a secret. The clean architecture is a minimal backend (Cloudflare Worker / Vercel function) that holds the secret and brokers token exchange.

- [ ] Register single OAuth app with Fathom
- [ ] Deploy auth-broker Worker (≈50 LOC)
- [ ] Plugin uses `obsidian://` URI handler to receive auth code
- [ ] Plugin stores `refresh_token`, exchanges for `access_token` as needed
- [ ] Drop API-key UI (or keep both as fallback)
- [ ] **OAuth limitation to handle**: `include_summary` / `include_transcript` don't work on the meetings list endpoint when authenticated via OAuth — must fetch summary/transcript per-meeting (which we already do).

## 🧹 v2.x — Code-quality follow-ups from pre-publish review

Items flagged in the security / code-quality review that were deliberately deferred (not publish blockers, but worth fixing later):

- [ ] **Unify `call` / `callMutate` retry envelope** in `src/services/fathomApi.ts`. The two methods share retry + backoff logic via copy-paste; extract a shared helper so future fixes don't drift.
- [ ] **Replace bare `console.warn` calls** in `fathomApi.ts:87, 98, 221` with `logger.warn` for consistency with the rest of the codebase.
- [ ] **`HttpQueue.call` empty-body fallback is too broad** ([httpQueue.ts:111-116](src/services/queues/httpQueue.ts)): currently any JSON parse error returns `{}`. Tighten to only treat 204/empty-body responses as empty; surface real malformed-JSON as an error.

## 🧪 v3.x — Quality of life

- [ ] **Selective sync** — preview list of meetings, let user pick which to import
- [ ] **Templates** — let users customise the Markdown body via a templating syntax (Handlebars / Templater compat)
- [ ] **Action items extraction** — Fathom returns `action_items` array; could become a separate "Action items" section or a Dataview-queryable structure
- [ ] **Mobile compatibility** — currently `isDesktopOnly: true` because `requestUrl` works the same on mobile, but storage paths and Electron APIs differ. Worth testing.
- [ ] **Granola Sync compatibility mode** — flag to detect existing Granola-imported meetings (with `fathom_id` but no `synced_by: fathom-sync`) and either skip them or merge them.

## 📚 v3.x — Documentation

- [ ] **Setup video** (Loom recording showing key generation → settings → first sync)
- [ ] **Frontmatter reference** for users wanting to query with Dataview
- [ ] **Migration guide** from obsidian-granola-sync
- [ ] **Plugin store submission**: requires removing `isDesktopOnly` if possible, README polish, screenshots

## Won't do

- ❌ Sync FROM Obsidian TO Fathom (editing meeting summaries in Fathom). Out of scope.
- ❌ Audio/video file downloads. Notes only.
- ❌ Real-time live transcript during a call. Use Fathom's UI for that.
