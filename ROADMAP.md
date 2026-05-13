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

## 🔜 v1.1 — Polish & resilience

- [ ] **Encrypted token storage** via Electron's `safeStorage` API. Currently `data.json` stores the API key in plaintext — fine for single-user, not great for shared/synced vaults. ~30 LOC.
- [ ] **Settings: filename pattern preview** — show the user what `{date} {title}` resolves to before they save.
- [ ] **Settings: validate API key on save** — call `GET /teams` to verify the token works, show a green/red status.
- [ ] **Better error surfacing** — 401 → "Invalid API token", 403 → "Token lacks permission for this team", etc.
- [ ] **Resume from last sync** — currently every "standard sync" re-queries the same 7-day window. Use `lastSyncCursor` properly to paginate forward only.

## 🚀 v2.0 — Multi-account in one vault

Right now the plugin stores **one** API token. For users who want to consolidate meetings from multiple Fathom accounts into one vault:

- [ ] Settings becomes a list of accounts: `{ label, apiToken, teamFilter, recordedByFilter, summaryFolder, transcriptFolder }`
- [ ] Sync loops over all accounts, deduplicates by `recording_id` (same meeting fetched via two tokens shouldn't write twice)
- [ ] Frontmatter records `synced_via: <account-label>` for traceability
- [ ] UI: add/remove/test each account independently

## 🌐 v3.0 — Public OAuth flow

For an Obsidian Community Plugin Store submission, individual API keys are friction. OAuth is the proper path but has a real constraint:

> Fathom OAuth uses `client_secret`-based credential flow. Public client-side apps can't safely ship a secret. The clean architecture is a minimal backend (Cloudflare Worker / Vercel function) that holds the secret and brokers token exchange.

- [ ] Register single OAuth app with Fathom
- [ ] Deploy auth-broker Worker (≈50 LOC)
- [ ] Plugin uses `obsidian://` URI handler to receive auth code
- [ ] Plugin stores `refresh_token`, exchanges for `access_token` as needed
- [ ] Drop API-key UI (or keep both as fallback)
- [ ] **OAuth limitation to handle**: `include_summary` / `include_transcript` don't work on the meetings list endpoint when authenticated via OAuth — must fetch summary/transcript per-meeting (which we already do).

## 🧪 v3.x — Quality of life

- [ ] **Selective sync** — preview list of meetings, let user pick which to import
- [ ] **Templates** — let users customise the Markdown body via a templating syntax (Handlebars / Templater compat)
- [ ] **Action items extraction** — Fathom returns `action_items` array; could become a separate "Action items" section or a Dataview-queryable structure
- [ ] **Webhooks** — Fathom supports webhooks. Self-host a tiny relay → Obsidian via URI scheme for near-realtime sync
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
