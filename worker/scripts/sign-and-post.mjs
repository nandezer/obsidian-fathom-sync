#!/usr/bin/env node
/**
 * Local test harness: sign a payload the same way Fathom would and POST it
 * to the running wrangler dev Worker. Confirms HMAC verification round-trips.
 *
 * Secret used here matches the wrangler dev --var FATHOM_WEBHOOK_SECRET above
 * (whsec_dGVzdC1zZWNyZXQ=), which decodes to ASCII "test-secret".
 */
import { createHmac } from "node:crypto";

const SECRET_B64 = "dGVzdC1zZWNyZXQ="; // "test-secret"
const WORKER = "http://localhost:8787";

const webhookId = `msg_test_${Date.now()}`;
const timestamp = Math.floor(Date.now() / 1000).toString();

const body = JSON.stringify({
  triggered_for: "shared_external_recordings",
  meeting: {
    recording_id: 999999999,
    title: "Local signed test",
    url: "https://fathom.video/calls/999999999",
    recorded_by: { name: "Test", email: "t@example.com", email_domain: "example.com" },
    calendar_invitees: [],
    default_summary: { template_name: "default", markdown_formatted: "# Signed OK" },
    transcript: [],
  },
});

const signedContent = `${webhookId}.${timestamp}.${body}`;
const keyBytes = Buffer.from(SECRET_B64, "base64");
const sigBytes = createHmac("sha256", keyBytes).update(signedContent).digest();
const sigB64 = sigBytes.toString("base64");

const res = await fetch(`${WORKER}/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${sigB64}`,
  },
  body,
});

console.log(`POST /webhook → ${res.status}`);
console.log(await res.text());

const pendRes = await fetch(`${WORKER}/pending`, {
  headers: { authorization: "Bearer test-bearer" },
});
const pendBody = await pendRes.json();
console.log(`\nGET /pending → ${pendRes.status}`);
console.log(`Deliveries returned: ${pendBody.deliveries.length}`);
if (pendBody.deliveries.length > 0) {
  console.log(
    `First delivery: id=${pendBody.deliveries[0].delivery_id}, ` +
      `triggered_for=${pendBody.deliveries[0].triggered_for}, ` +
      `meeting.recording_id=${pendBody.deliveries[0].meeting.recording_id}`
  );
}

// Clean up
await fetch(`${WORKER}/ack`, {
  method: "POST",
  headers: {
    authorization: "Bearer test-bearer",
    "content-type": "application/json",
  },
  body: JSON.stringify({ delivery_ids: pendBody.deliveries.map((d) => d.delivery_id) }),
});
console.log(`\nCleaned up.`);
