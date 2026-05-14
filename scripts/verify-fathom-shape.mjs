#!/usr/bin/env node
/**
 * verify-fathom-shape.mjs — pre-publish smoke test against the live Fathom
 * API. Catches the class of bug that crashed v2's first Connect: the plugin
 * assumed Fathom returns the HMAC key under `signing_secret`, but the real
 * field is `secret`. We never noticed because no automated check exercised
 * the live endpoint before release.
 *
 * Run this before tagging any release that touches webhook code:
 *
 *   FATHOM_API_TOKEN=fathom_xxx node scripts/verify-fathom-shape.mjs
 *
 * Exits 0 on success, non-zero (with a diagnostic) if any contract drifts.
 *
 * What it asserts:
 *   1. POST /webhooks accepts our exact request body
 *   2. The 201 response has BOTH `id` AND `secret` as strings
 *   3. `secret` starts with `whsec_`
 *   4. DELETE /webhooks/:id returns 204 No Content with empty body
 *      (so callMutate's empty-body tolerance is exercised)
 *   5. GET /teams works (token sanity)
 *
 * The test webhook points at a non-routable URL so Fathom never delivers
 * to it, and we DELETE it immediately after assertions pass. No real
 * meeting data is touched.
 */

const BASE = "https://api.fathom.ai/external/v1";
const TOKEN = process.env.FATHOM_API_TOKEN;
const DESTINATION = "https://contract-verification.invalid/webhook";

if (!TOKEN) {
  console.error("Missing FATHOM_API_TOKEN env var.");
  process.exit(2);
}

const headers = { "X-Api-Key": TOKEN, "Content-Type": "application/json" };
const failures = [];
const note = (msg) => console.log(`  ${msg}`);
const fail = (msg) => failures.push(msg);

async function step(label, fn) {
  console.log(`▶ ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(`${label}: ${err.message}`);
  }
}

let createdId = null;

await step("GET /teams (token sanity, shape)", async () => {
  const r = await fetch(`${BASE}/teams`, { headers });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  const body = await r.json();
  // Fathom returns { items, limit, next_cursor } here, not a bare array.
  // The plugin's listTeams() unwraps both shapes defensively.
  let items;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === "object" && Array.isArray(body.items)) items = body.items;
  else {
    throw new Error(
      `expected array or {items: array}, got keys: ${Object.keys(body ?? {}).join(", ") || "(non-object)"}`
    );
  }
  note(`token OK; ${items.length} teams visible`);
});

await step("POST /webhooks (response shape)", async () => {
  const r = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      destination_url: DESTINATION,
      triggered_for: ["my_recordings"],
      include_summary: true,
      include_transcript: true,
      include_action_items: true,
      include_crm_matches: false,
    }),
  });
  if (r.status !== 201) {
    const t = await r.text();
    throw new Error(`expected 201, got ${r.status}: ${t.slice(0, 200)}`);
  }
  const body = await r.json();

  if (typeof body.id !== "string" || body.id.length === 0) {
    fail('POST /webhooks: response missing "id" string');
  }
  if (typeof body.secret !== "string" || body.secret.length === 0) {
    fail(
      'POST /webhooks: response missing "secret" string. ' +
        `Got keys: ${Object.keys(body).join(", ")}. ` +
        "If Fathom renamed this field, update FathomApiClient.createWebhook accordingly."
    );
  } else if (!body.secret.startsWith("whsec_")) {
    fail(
      `POST /webhooks: "secret" field does not start with "whsec_" (got "${body.secret.slice(0, 8)}…"). ` +
        "Worker verifyFathomSignature assumes the whsec_ prefix; update if Fathom changed format."
    );
  }
  createdId = body.id;
  note(`created webhook id=${body.id} secret=whsec_<redacted>`);
});

if (createdId) {
  await step("DELETE /webhooks/:id (empty-body tolerance)", async () => {
    const r = await fetch(`${BASE}/webhooks/${createdId}`, {
      method: "DELETE",
      headers,
    });
    if (r.status !== 204) {
      fail(
        `DELETE expected 204, got ${r.status}. ` +
          "callMutate currently assumes 204 No Content; update if Fathom started returning 200 with a body."
      );
    }
    const text = await r.text();
    if (text.length !== 0) {
      fail(
        `DELETE expected empty body, got ${text.length} bytes. ` +
          "callMutate's empty-body path won't be exercised; review if this is real."
      );
    }
    note("DELETE returned 204 with empty body as expected");
  });
}

console.log();
if (failures.length === 0) {
  console.log("✓ Fathom API contract matches plugin expectations.");
  process.exit(0);
}
console.error("✗ Contract drift detected:");
for (const f of failures) console.error(`  - ${f}`);
console.error(
  "\nIf Fathom changed their API, update src/services/fathomApi.ts to match."
);
process.exit(1);
