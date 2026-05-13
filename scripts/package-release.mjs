#!/usr/bin/env node
/**
 * Packages the built plugin into a release zip under releases/.
 *
 * Usage: npm run release
 *
 * Produces: releases/fathom-sync-v{version}.zip
 *   The zip contains a top-level `fathom-sync/` folder with `main.js` and
 *   `manifest.json` inside, so users can drop the folder directly into
 *   their vault's `.obsidian/plugins/` directory.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;

// Files that go inside the plugin folder (read by Obsidian)
const pluginFiles = ["main.js", "manifest.json"];

// Files that sit next to the plugin folder inside the zip (read by humans)
const docFiles = ["INSTALL.md"];

for (const f of [...pluginFiles, ...docFiles]) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`✗ Missing required file: ${f}. Run "npm run build" first.`);
    process.exit(1);
  }
}

const releasesDir = path.join(root, "releases");
fs.mkdirSync(releasesDir, { recursive: true });

const stagingDir = path.join(root, ".release-staging");
const pluginStagingDir = path.join(stagingDir, "fathom-sync");
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(pluginStagingDir, { recursive: true });

for (const f of pluginFiles) {
  fs.copyFileSync(path.join(root, f), path.join(pluginStagingDir, f));
}
for (const f of docFiles) {
  fs.copyFileSync(path.join(root, f), path.join(stagingDir, f));
}

const zipPath = path.join(releasesDir, `fathom-sync-v${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

// Cross-platform zip via PowerShell on Windows, zip elsewhere.
// We zip the *contents* of stagingDir (the fathom-sync/ folder + INSTALL.md
// at the same level).
if (process.platform === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipPath}'"`,
    { stdio: "inherit" }
  );
} else {
  execSync(`cd "${stagingDir}" && zip -r "${zipPath}" .`, { stdio: "inherit" });
}

fs.rmSync(stagingDir, { recursive: true, force: true });

const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`✓ Packaged: ${path.relative(root, zipPath)} (${sizeKb} KB)`);
console.log("");
console.log("To share with another Obsidian user:");
console.log("  1. Send them this zip file.");
console.log("  2. They unzip it into <their-vault>/.obsidian/plugins/");
console.log("  3. In Obsidian → Settings → Community plugins → enable Fathom Sync.");
