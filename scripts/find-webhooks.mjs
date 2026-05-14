#!/usr/bin/env node
/**
 * Find any webhooks registered against the Fathom account. Fathom doesn't
 * publicly document a list endpoint, so we try a handful of common shapes
 * and report whatever responds with JSON containing webhook records.
 */
import { readFile } from "node:fs/promises";

const VAULT = process.env.FATHOM_VAULT_ROOT;
const data = JSON.parse(
  await readFile(`${VAULT}/.obsidian/plugins/fathom-sync/data.json`, "utf8")
);
const token = data.apiToken;
const savedId = data.registeredWebhookId;
console.log("Plugin's saved webhook id:", savedId || "(none)");
console.log();

const candidates = [
  "https://api.fathom.ai/external/v1/webhooks",
  "https://api.fathom.ai/external/v1/webhooks?limit=100",
];

for (const url of candidates) {
  process.stdout.write(`GET ${url} → `);
  try {
    const r = await fetch(url, { headers: { "X-Api-Key": token } });
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      console.log(`${r.status} (not JSON, ${ct.split(";")[0]})`);
      continue;
    }
    const body = await r.json();
    console.log(`${r.status} JSON`);
    console.log(JSON.stringify(body, null, 2));
  } catch (err) {
    console.log(`error: ${err.message}`);
  }
}
