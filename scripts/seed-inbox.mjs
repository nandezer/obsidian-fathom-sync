#!/usr/bin/env node
/**
 * seed-inbox.mjs — drop a real Fathom recording into the plugin's webhook
 * inbox as a JSON envelope. The envelope shape matches what Fathom POSTs to
 * a webhook (modulo the outer `delivery_id` / `triggered_for` wrapper that
 * the Worker would add), so this is the closest thing to a real end-to-end
 * test of the v2.0 path without standing up the Worker yet.
 *
 * Uses raw `fetch()` because this runs in Node.js (not the Obsidian Electron
 * renderer), so the CORS rule that mandates `requestUrl` for the plugin
 * itself does not apply here.
 *
 * Usage:
 *   FATHOM_VAULT_ROOT=/path/to/vault \
 *     [FATHOM_VAULT_PLUGIN_DIR=/path/to/vault/.obsidian/plugins/fathom-sync] \
 *     [FATHOM_API_TOKEN=fathom_xxx] \
 *     node scripts/seed-inbox.mjs <recording_id> [--trigger=shared_external_recordings]
 *
 * The output file goes to $FATHOM_VAULT_ROOT/.fathom-inbox/<delivery_id>.json.
 * The plugin will pick it up on the next sync.
 *
 * Token resolution: prefer FATHOM_API_TOKEN env. If unset, read it from the
 * plugin's data.json at $FATHOM_VAULT_PLUGIN_DIR/data.json (defaults to
 * $FATHOM_VAULT_ROOT/.obsidian/plugins/fathom-sync/).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "https://api.fathom.ai/external/v1";

const args = process.argv.slice(2);
const recordingId = args.find((a) => !a.startsWith("--"));
const triggerArg = args.find((a) => a.startsWith("--trigger="));
const trigger = triggerArg
  ? triggerArg.split("=")[1]
  : "shared_external_recordings";

if (!recordingId || !/^\d+$/.test(recordingId)) {
  console.error("Usage: FATHOM_VAULT_ROOT=<path> node scripts/seed-inbox.mjs <recording_id> [--trigger=...]");
  process.exit(1);
}

const VAULT_ROOT = process.env.FATHOM_VAULT_ROOT;
if (!VAULT_ROOT) {
  console.error(
    "Missing FATHOM_VAULT_ROOT environment variable. Set it to the absolute " +
      "path of the Obsidian vault you want to seed (the folder containing .obsidian/)."
  );
  process.exit(1);
}

const PLUGIN_DIR =
  process.env.FATHOM_VAULT_PLUGIN_DIR ??
  join(VAULT_ROOT, ".obsidian", "plugins", "fathom-sync");
const INBOX_DIR = join(VAULT_ROOT, ".fathom-inbox");

async function getToken() {
  if (process.env.FATHOM_API_TOKEN) return process.env.FATHOM_API_TOKEN;
  const dataPath = join(PLUGIN_DIR, "data.json");
  if (!existsSync(dataPath)) {
    throw new Error(
      `No FATHOM_API_TOKEN env var and no data.json at ${dataPath}. ` +
        `Set FATHOM_API_TOKEN or FATHOM_VAULT_PLUGIN_DIR.`
    );
  }
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  if (!data.apiToken) {
    throw new Error("data.json has no apiToken field.");
  }
  return data.apiToken;
}

async function call(token, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-Api-Key": token, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const token = await getToken();
  console.log(`Fetching recording ${recordingId} from Fathom…`);

  // The polling /meetings endpoint won't return this if it wasn't recorded by
  // the token-owner. But the per-recording endpoints don't have that scope
  // restriction — they only need that the recording was shared with the
  // token-owner, which is exactly our case.
  const [summaryRaw, transcriptRaw] = await Promise.all([
    call(token, `/recordings/${recordingId}/summary`),
    call(token, `/recordings/${recordingId}/transcript`),
  ]);

  // Normalise summary to the nested shape we read in fathomApi.ts.
  const summary =
    summaryRaw.summary ??
    summaryRaw.default_summary ??
    (summaryRaw.markdown_formatted ? summaryRaw : null);

  if (!summary?.markdown_formatted) {
    throw new Error(
      `Could not find markdown_formatted in summary response. ` +
        `Keys: ${Object.keys(summaryRaw).join(", ")}`
    );
  }

  // Normalise transcript to a flat array of segments.
  const transcript = Array.isArray(transcriptRaw)
    ? transcriptRaw
    : transcriptRaw.segments ??
      transcriptRaw.transcript ??
      transcriptRaw.items ??
      [];

  // Reconstruct a meeting object using the minimum fields the plugin needs.
  // Fathom's REAL webhook payload would carry the full record verbatim; we
  // approximate from what the per-recording endpoints expose. The plugin
  // only needs: recording_id, title, url, created_at, recorded_by,
  // calendar_invitees, default_summary, transcript.
  const meeting = {
    recording_id: Number(recordingId),
    title: summary.meeting_title ?? `Recording ${recordingId}`,
    meeting_title: summary.meeting_title ?? `Recording ${recordingId}`,
    url: `https://fathom.video/calls/${recordingId}`,
    created_at: new Date().toISOString(),
    recorded_by: summary.recorded_by ?? {
      name: "Unknown",
      email: "unknown@example.com",
      email_domain: "example.com",
    },
    calendar_invitees: summary.calendar_invitees ?? [],
    default_summary: {
      template_name: summary.template_name ?? "default",
      markdown_formatted: summary.markdown_formatted,
    },
    transcript,
  };

  const deliveryId = `seed-${recordingId}-${Date.now()}`;
  const envelope = {
    delivery_id: deliveryId,
    delivered_at: Math.floor(Date.now() / 1000),
    triggered_for: trigger,
    meeting,
  };

  await mkdir(INBOX_DIR, { recursive: true });
  const outPath = join(INBOX_DIR, `${deliveryId}.json`);
  await writeFile(outPath, JSON.stringify(envelope, null, 2), "utf8");

  console.log(`Wrote envelope to: ${outPath}`);
  console.log(`Summary length: ${summary.markdown_formatted.length} chars`);
  console.log(`Transcript segments: ${transcript.length}`);
  console.log(``);
  console.log(`Now click the sync ribbon icon in Obsidian to ingest it.`);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
