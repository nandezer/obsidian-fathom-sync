# Obsidian Fathom Sync

Sync your [Fathom](https://fathom.video) meeting summaries and transcripts into your Obsidian vault automatically.

> Inspired by [obsidian-granola-sync](https://github.com/tomelliot/obsidian-granola-sync). Like Granola Sync, but for Fathom.

---

## Features

- 📝 **AI-generated summaries** with timestamped section links back to the recording
- 🎙️ **Speaker-attributed transcripts** with clickable timestamps for every line
- 🔄 **Incremental sync** — already-synced meetings are skipped
- ⏰ **Periodic background sync** at a schedule you set (e.g. every hour)
- 🔍 **Filter by team or recorder** so only the right meetings land in your vault
- 🔗 **Bi-directional wikilinks** between each summary and its transcript

## Installation (for non-developers)

### 1. Get your Fathom API key

1. Open [fathom.video/customize](https://fathom.video/customize#api-access-header)
2. Scroll to the **API Access** section
3. Click **Generate API Key** and copy the resulting string

### 2. Install the plugin

**Option A — From a release zip** (easiest):

1. Download the latest `fathom-sync-vX.Y.Z.zip` from [Releases](#releases)
2. Open your Obsidian vault folder in File Explorer / Finder
3. Navigate to `.obsidian/plugins/` (you may need to enable hidden folders)
4. Unzip the file there. You should end up with `.obsidian/plugins/fathom-sync/main.js` and `.obsidian/plugins/fathom-sync/manifest.json`
5. In Obsidian, go to **Settings → Community plugins**
6. If it says "Community plugins are restricted," click **Turn on community plugins**
7. Refresh the list (the circular arrow icon next to "Installed plugins")
8. Find **Fathom Sync** and toggle it **on**

**Option B — From source**: see the [Development](#development) section below.

### 3. Configure

1. **Settings → Fathom Sync** (in the left sidebar of Obsidian's settings)
2. Paste your **API token** in the first field
3. (Optional) Add team names you want to filter by (comma-separated)
4. Choose **summary folder** and **transcript folder** paths in your vault
5. Toggle **periodic sync** on if you want background syncing

### 4. Run your first sync

Press `Ctrl+P` (or `Cmd+P` on Mac), type `Fathom`, and pick **"Fathom Sync: Sync recent meetings"**.

Notes will land in `Fathom/Summaries/` and `Fathom/Transcripts/` (or whichever folders you configured).

## How notes look

### Summary note

```markdown
---
fathom_id: 000000000
fathom_url: "https://fathom.video/calls/EXAMPLE"
title: "Example meeting"
recorded_by: "Plugin Author"
recorded_by_email: "author@example.com"
attendees:
  - "User Two"
  - "User Three"
created_at: "2026-05-13T08:05:48Z"
synced_at: "2026-05-13T10:00:00Z"
synced_by: fathom-sync
type: summary
transcript: "[[Fathom/Transcripts/2026-05-13 Example meeting (000000000)]]"
---

# Example meeting

[View recording](https://fathom.video/calls/EXAMPLE)
**Recorded by:** Plugin Author
**Attendees:** User Two, User Three

## Summary

### [Opening remarks and meeting agenda @ 0:57](https://fathom.video/share/...)
User Two outlines three main discussion points...
```

### Transcript note

```markdown
---
fathom_id: 000000000
type: transcript
synced_by: fathom-sync
note: "[[Fathom/Summaries/2026-05-13 Example meeting (000000000)]]"
---

# Example meeting — Transcript

[00:00:00](https://fathom.video/calls/EXAMPLE?timestamp=0) **User Two:** OK let's start...
[00:00:08](https://fathom.video/calls/EXAMPLE?timestamp=8) **User Three:** I have two things to add...
```

## Settings reference

| Setting | What it does | Default |
|---------|-------------|---------|
| **API token** | Your Fathom API key | (none, required) |
| **Sync teams** | Comma-separated team names to filter by | (all teams) |
| **Recorded by (emails)** | Comma-separated emails to filter by recorder | (all recorders) |
| **Sync summaries** | Download AI summaries | On |
| **Sync transcripts** | Download full transcripts (files can be large) | Off |
| **Summary folder** | Vault path for summary notes | `Fathom/Summaries` |
| **Transcript folder** | Vault path for transcript notes | `Fathom/Transcripts` |
| **Filename pattern** | Tokens: `{date}` `{title}` `{id}` | `{date} {title}` |
| **Periodic sync** | Auto-sync on a schedule | Off |
| **Sync interval** | How often periodic sync runs | 30 minutes |
| **Lookback window** | Days back to check on each periodic sync | 7 |

## Privacy & security

- **Your API token stays local** — it's stored in your Obsidian vault's `.obsidian/plugins/fathom-sync/data.json` and never sent anywhere except Fathom's API.
- The token is currently in **plaintext** in that file (this is how Obsidian plugin settings work). If your vault is in cloud sync (Dropbox/iCloud/OneDrive), be aware of that. Encrypted storage is planned — see `ROADMAP.md`.
- The plugin only ever **reads** from Fathom and **writes** to your local vault. It never modifies anything in Fathom.

## Troubleshooting

**"Fathom API 401" error:** Your API token is invalid or expired. Generate a new one at [fathom.video/customize](https://fathom.video/customize#api-access-header).

**"Fathom API 403" error:** The token is valid but doesn't have access to the team you filtered by. Check the team names match exactly (case-sensitive).

**Nothing happens after clicking sync:** Open the dev console with `Ctrl+Shift+I`, click the "Console" tab, and look for `[Fathom Sync]` log lines. The most common cause is no meetings in the lookback window — try running **"Full sync"** from settings to fetch everything.

**"File already exists" warnings:** Harmless — means the plugin found a previously synced note and is keeping it. Re-run sync; it'll skip those properly next time.

## Releases

See [Releases](../../releases) for downloadable zip files.

## Development

See [CLAUDE.md](./CLAUDE.md) for the architecture overview and [ROADMAP.md](./ROADMAP.md) for planned features.

```bash
# Setup
git clone https://github.com/<you>/obsidian-fathom-sync
cd obsidian-fathom-sync
npm install   # On Windows + Node 24+, set NODE_OPTIONS=--use-system-ca first

# Build
npm run build  # produces main.js at repo root

# Watch mode
npm run dev
```

Then copy `main.js` and `manifest.json` to `<your-vault>/.obsidian/plugins/fathom-sync/` and reload Obsidian.

## License

MIT
