# Installing Obsidian Fathom Sync

## 1. Get your Fathom API key

Go to **[fathom.video/customize](https://fathom.video/customize#api-access-header)** → scroll to **API Access** → click **Generate API Key** → copy it.

## 2. Drop the plugin into your vault

You should have a folder named `fathom-sync` (from the unzipped release).

1. Open your Obsidian vault in your file manager.
2. Show hidden files/folders if needed.
3. Open the `.obsidian/plugins/` folder inside your vault.
   - If `plugins/` doesn't exist, create it.
4. Move the `fathom-sync/` folder into `plugins/`.

You should end up with:
```
<your-vault>/.obsidian/plugins/fathom-sync/main.js
<your-vault>/.obsidian/plugins/fathom-sync/manifest.json
```

## 3. Enable it in Obsidian

1. Open Obsidian and switch to the vault you just installed it in.
2. **Settings → Community plugins**.
3. If you see "Community plugins are restricted," click **Turn on community plugins**.
4. Click the refresh icon next to "Installed plugins" if needed.
5. Find **Fathom Sync** and toggle it **on**.

## 4. Paste your API key

1. Still in Settings, click **Fathom Sync** in the left sidebar.
2. Paste your API token in the first field.
3. (Optional) Configure team filters, folder paths, periodic sync.

## 5. Run your first sync

Press `Ctrl+P` (`Cmd+P` on Mac) → type `Fathom` → choose **"Fathom Sync: Sync recent meetings"**.

Notes will appear in `Fathom/Summaries/` and (if enabled) `Fathom/Transcripts/`.

## Need help?

Check `README.md` in the source repo for the full documentation and troubleshooting tips.
