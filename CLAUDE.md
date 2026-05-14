# CLAUDE.md

Guidance for Claude Code agents working on this repository.

## Project

**Obsidian Fathom Sync** — an Obsidian plugin that downloads Fathom meeting summaries and transcripts into the user's vault. Modelled on the [obsidian-granola-sync](https://github.com/tomelliot/obsidian-granola-sync) plugin.

Status: working end-to-end for **individual** Fathom users with a personal API key. Multi-account and OAuth-based public release are tracked in `ROADMAP.md`.

## Architecture

```
src/
├── main.ts                        # Plugin entry: lifecycle, commands, ribbon, status bar, periodic sync
├── settings.ts                    # FathomSyncSettings interface + DEFAULT_SETTINGS + FathomSyncSettingTab (UI)
├── types.ts                       # Fathom REST API types (verified against live API)
├── services/
│   ├── fathomApi.ts               # REST client. Uses Obsidian's requestUrl() (not fetch — fetch is CORS-blocked).
│   │                              # Static 1.1s throttle, 429 + 502/503/504 retry, throws on unknown summary shapes.
│   ├── documentProcessor.ts       # Builds Markdown notes (summary + transcript) from API responses
│   ├── fileSyncService.ts         # Vault cache + dedup. Keyed on {recording_id}-{type}.
│   │                              # Only counts notes with `synced_by: fathom-sync` frontmatter.
│   └── syncService.ts             # Orchestrator: standard/full sync modes
└── utils/
    ├── dateUtils.ts               # isoToDate, daysAgoIso, toSafeFilename
    └── logger.ts                  # Prefixed console logger
```

## Build commands

```powershell
# Install deps (Windows note below)
$env:NODE_OPTIONS = "--use-system-ca"
npm install --no-audit --no-fund

# Type-check + production build → produces main.js at repo root
npm run build

# Dev mode (esbuild watch, inline sourcemaps)
npm run dev
```

**Windows-specific gotcha**: Node 24+ on Windows fails TLS cert verification against the npm registry by default. Always set `NODE_OPTIONS=--use-system-ca` before running `npm install`. Build / esbuild itself is fine without it.

## Deploy to a test vault

```powershell
$pluginDir = "<your-vault>/.obsidian/plugins/fathom-sync"
New-Item -ItemType Directory -Path $pluginDir -Force
Copy-Item main.js, manifest.json -Destination $pluginDir -Force
```

Then in Obsidian: reload the plugin (Settings → Community plugins → toggle off/on) so it picks up the new bundle.

## Hard-won knowledge (don't re-learn the hard way)

### Use `requestUrl`, never `fetch`

Obsidian plugins run in an Electron renderer process with strict CORS. `fetch('https://api.fathom.ai/...')` is blocked with `No 'Access-Control-Allow-Origin' header`. Always use `requestUrl()` from `obsidian`, which goes through Node's HTTP stack.

### Fathom REST API quirks (verified live)

| Field | Real shape | Common assumption |
|-------|-----------|-------------------|
| List response | `{ items: [...], next_cursor }` | NOT `meetings:` |
| `recorded_by` | `{name, email, email_domain}` object | NOT a string |
| `calendar_invitees` | `[{name, email, ...}]` objects | NOT strings |
| Summary response | `{ summary: { template_name, markdown_formatted } }` | NOT flat — nested under `summary` |
| Transcript `speaker` | Either string OR `{name, display_name, email}` object | Always normalise via `speakerToString()` |
| Rate limit | 60 req/min per user | Hit it after ~25 sequential calls |

### Dedup marker

Notes written by this plugin always include `synced_by: fathom-sync` in frontmatter. The cache scan in `FileSyncService.buildCache()` filters on this so we don't collide with other plugins (notably Granola Sync, which also uses `fathom_id` frontmatter).

### Settings live in plaintext

Obsidian stores `data.json` in plain text in the vault. The user's API token is therefore on disk unencrypted. See `ROADMAP.md` → "Encrypted token storage" for the planned fix using Electron's `safeStorage`.

### Sync mutex lives in main.ts, not SyncService

`FathomSyncPlugin.inFlightSync` is the single-flight gate. Ribbon click, command palette, and the periodic `setInterval` tick all funnel through `triggerSync()`, which awaits any existing in-flight promise instead of starting a second sync. **Don't add a second entry point that calls `SyncService.performSync` directly** — it would bypass the mutex.

### Periodic vs manual: trigger matters for toasts

`triggerSync(mode, trigger)` carries a `"manual" | "periodic"` discriminator. Periodic failures intentionally do NOT raise a `Notice` (overnight offline used to stack 16+ toasts). Status bar going red is the only periodic-failure signal. If you add a new sync entry point, plumb the trigger through.

### Foreign `fathom_id` notes are counted, not absorbed

`FileSyncService.foreignFathomNotes` counts notes that have `fathom_id` frontmatter but lack `synced_by: fathom-sync` (typically obsidian-granola-sync output). `main.ts` surfaces a one-time Notice when non-zero so users understand why duplicates appear. **Don't loosen the `synced_by` filter** to absorb foreign notes — it would mean we'd silently update notes written by other plugins.

### Throttle is static on FathomApiClient

`FathomApiClient.nextSlot` and `minInterval` are `static`. The plugin rebuilds the API client whenever the API token changes; previously this reset the throttle and the first request after a save would race past the 1.1s gate. Don't make these instance fields again.

### Empty summaries throw, they don't return `""`

`FathomApiClient.getSummary` throws `FathomApiError` when no recognised shape is found. The old code returned `{ markdown_formatted: "" }`, which then wrote a `synced_by: fathom-sync` stub note that poisoned the dedup cache forever. If you ever need a "skip this meeting" path, do it in `SyncService.processMeeting` — never write the stub.

### YAML frontmatter uses single-quoted scalars

`yamlString()` in `documentProcessor.ts` wraps every value in `'...'` and doubles any internal `'`. This is the YAML 1.2 single-quoted scalar rule — one escape, no backslash games. Double-quoted YAML requires escaping `\` and `"` differently from JSON; the old code got that subtly wrong for titles containing `\`. **Don't switch back to double quotes** without using a real YAML library.

### Cursor is only saved on clean completion

`SyncService.performSync` saves `lastSyncCursor` as `""` when pagination reaches the end cleanly, and to the next-page cursor only when interrupted by a non-401 error. The "Reset sync cursor" button in settings exists for when the saved cursor goes stale (e.g. the user toggles a team filter and wants a fresh scan).

### `saveSettings` only rebuilds services on token change

`FathomSyncPlugin.saveSettings` compares the new token against `lastBuiltApiToken` and only calls `initServices()` when it changes. Per-keystroke saves in unrelated fields (folders, filters, filename pattern) used to tear down the in-flight `FathomApiClient` and throttle. Keep this guard.

## Style

- TypeScript strict-ish (`strictNullChecks`, `noImplicitAny`)
- No top-level `any` — use `unknown` and narrow
- Defensive on API responses — Fathom has changed shapes mid-conversation
- All user-facing errors should produce a `new Notice(...)` toast AND a `logger.error(...)` line

## What NOT to do

- Don't use `fetch()` — see above
- Don't store user-facing strings inline in API client — keep `Notice()` calls in `main.ts` / `syncService.ts`
- Don't loosen the `synced_by` filter in `fileSyncService.ts` — it's load-bearing for dedup with other plugins
- Don't remove the throttle in `fathomApi.ts` without replacing it — Fathom will 429 fast otherwise
- Don't bypass `FathomSyncPlugin.triggerSync()` to start a sync — it owns the single-flight mutex
- Don't return placeholder data from `FathomApiClient.getSummary` / `getTranscript` — throw instead, so the cache isn't poisoned with stub notes
- Don't write frontmatter as double-quoted YAML without a real YAML library — use `yamlString()` (single-quoted) or extend it
