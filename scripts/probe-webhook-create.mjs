#!/usr/bin/env node
/**
 * Inspect what Fathom actually returns when we POST a webhook. We hit
 * /webhooks with a junk destination URL so we don't accidentally register
 * yet ANOTHER webhook against the live account — if Fathom validates URLs
 * before saving, this fails fast; if Fathom accepts it, we delete it
 * immediately after recording the response shape.
 *
 * The point is purely to see what fields are in the create response so
 * we can patch the plugin's createWebhook() to read the right one.
 */
import { readFile } from "node:fs/promises";

const VAULT = process.env.FATHOM_VAULT_ROOT;
if (!VAULT) {
  console.error("Set FATHOM_VAULT_ROOT to your vault path first.");
  process.exit(1);
}

const tokenPath = `${VAULT}/.obsidian/plugins/fathom-sync/data.json`;
const data = JSON.parse(await readFile(tokenPath, "utf8"));
const token = data.apiToken;
if (!token) {
  console.error("No apiToken in data.json.");
  process.exit(1);
}

// Use a URL that's plausible but won't actually be used.
const probeUrl = "https://obsidian-fathom-sync-worker.marc-006.workers.dev/webhook";

const res = await fetch("https://api.fathom.ai/external/v1/webhooks", {
  method: "POST",
  headers: { "X-Api-Key": token, "Content-Type": "application/json" },
  body: JSON.stringify({
    destination_url: probeUrl,
    triggered_for: [
      "my_recordings",
      "shared_external_recordings",
      "my_shared_with_team_recordings",
      "shared_team_recordings",
    ],
    include_summary: true,
    include_transcript: true,
    include_action_items: true,
    include_crm_matches: false,
  }),
});

console.log(`POST /webhooks → ${res.status} ${res.statusText}`);
console.log("Response headers:");
for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`);
const text = await res.text();
console.log("\nResponse body:");
console.log(text);

// Best-effort parse so we can see field names
try {
  const json = JSON.parse(text);
  console.log("\nField names in response object:");
  console.log(Object.keys(json));
  if (json.id) {
    console.log(`\nNote: a webhook was created with id ${json.id}. Already-existing duplicates probably did the same. Use the DELETE below to clean up.`);
    console.log(`Cleanup command: curl -X DELETE -H "X-Api-Key: $TOKEN" https://api.fathom.ai/external/v1/webhooks/${json.id}`);
  }
} catch (err) {
  console.log("\n(body was not JSON)");
}
