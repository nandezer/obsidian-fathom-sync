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
│   │                              # Includes 1.1s throttle and 429 retry.
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
