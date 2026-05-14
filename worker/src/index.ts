/**
 * Cloudflare Worker for Obsidian Fathom Sync.
 *
 * Receives webhook deliveries from Fathom, stores them in KV, and exposes a
 * polling endpoint the Obsidian plugin reads from.
 *
 * Routes
 * ──────
 * POST /webhook   ← Fathom delivers new-meeting-content-ready events here.
 *                   Signature verified against FATHOM_WEBHOOK_SECRET.
 *                   Payload stored in KV under key `delivery:<webhook-id>`
 *                   with 7-day TTL.
 *
 * GET  /pending   ← Plugin polls this. Bearer-authenticated. Returns all
 *                   stored payloads as { deliveries: WebhookPayload[] }.
 *                   (No cursor — plugin acks every delivery it processes.)
 *
 * POST /ack       ← Plugin posts { delivery_ids: string[] }. Bearer-auth.
 *                   Worker deletes those keys from KV.
 *
 * GET  /health    ← Unauthenticated readiness probe.
 *
 * KV schema
 * ─────────
 * Key:   `delivery:<webhook-id>`
 * Value: JSON-encoded WebhookPayload (delivery_id, delivered_at,
 *        triggered_for, meeting). TTL = 7 days so abandoned deliveries
 *        evict themselves if the plugin is offline for a week.
 */

interface Env {
  DELIVERIES: KVNamespace;
  PLUGIN_BEARER_TOKEN: string;
  FATHOM_WEBHOOK_SECRET: string;
}

interface WebhookPayload {
  delivery_id: string;
  delivered_at: number;
  triggered_for: string;
  meeting: unknown;
}

const DELIVERY_KEY_PREFIX = "delivery:";
const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Reject webhook deliveries whose timestamp is more than this many seconds
 * away from the Worker's current time. Limits replay-attack window. Five
 * minutes matches the Svix-recommended default.
 */
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Fail closed if either secret is missing. Cloudflare leaves unset env
    // bindings as undefined, and an undefined PLUGIN_BEARER_TOKEN would
    // make every "Authorization: Bearer undefined" request authenticate;
    // an undefined FATHOM_WEBHOOK_SECRET would let any signature verify.
    // /health is exempt so deployment readiness probes still work.
    const isHealthcheck =
      request.method === "GET" && url.pathname === "/health";
    if (!isHealthcheck) {
      if (!env.PLUGIN_BEARER_TOKEN || !env.FATHOM_WEBHOOK_SECRET) {
        return json(
          {
            error: "worker_not_configured",
            message:
              "Set PLUGIN_BEARER_TOKEN and FATHOM_WEBHOOK_SECRET via " +
              "`wrangler secret put` before sending traffic.",
          },
          503
        );
      }
    }

    try {
      if (isHealthcheck) {
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/webhook") {
        return await handleWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/pending") {
        return await handlePending(request, env);
      }
      if (request.method === "POST" && url.pathname === "/ack") {
        return await handleAck(request, env);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      // Log the full error for the operator (Cloudflare dashboard) but
      // return a generic message to the caller. Echoing err.message could
      // disclose KV internals or stack-trace hints to unauthenticated
      // callers on /webhook.
      console.error("Unhandled error:", err);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Verify the Svix-style signature Fathom sends with every webhook delivery.
 *
 * Headers:
 *   webhook-id        unique message identifier
 *   webhook-timestamp seconds-since-epoch when Fathom dispatched
 *   webhook-signature space-separated list of `v1,<base64-sig>` entries
 *
 * Signed content: `${webhook-id}.${webhook-timestamp}.${raw-body}`
 * Algorithm:      HMAC-SHA256 with FATHOM_WEBHOOK_SECRET as the key.
 *
 * Tolerance: reject deliveries older than 5 minutes to limit replay.
 */
async function verifyFathomSignature(
  request: Request,
  rawBody: string,
  secret: string
): Promise<{ ok: true; webhookId: string } | { ok: false; reason: string }> {
  const headers = readSignatureHeaders(request);
  if (!headers.ok) return headers;

  const { id, timestamp, signatures } = headers;
  const expectedSig = await computeExpectedSignature(
    secret,
    id,
    timestamp,
    rawBody
  );
  const match = signatures.some((sig) => constantTimeEqual(sig, expectedSig));
  if (!match) return { ok: false, reason: "signature mismatch" };
  return { ok: true, webhookId: id };
}

/**
 * Pull and validate the three Svix signature headers. Also enforces the
 * 5-minute replay window so callers don't have to. The list of presented
 * signatures is returned pre-stripped of the `v1,` algorithm prefix.
 */
function readSignatureHeaders(
  request: Request
):
  | { ok: true; id: string; timestamp: string; signatures: string[] }
  | { ok: false; reason: string } {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");

  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing signature headers" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "malformed webhook-timestamp" };
  }
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
    return {
      ok: false,
      reason: `timestamp skew ${Math.round(skew)}s exceeds ${MAX_TIMESTAMP_SKEW_SECONDS}s`,
    };
  }

  const signatures = signatureHeader
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));

  return { ok: true, id, timestamp, signatures };
}

/**
 * Derive the HMAC-SHA256 signature Fathom should have presented for this
 * payload. The signed content is `${id}.${timestamp}.${rawBody}`, the key
 * is the base64-decoded body of a `whsec_<base64>` secret (or the raw
 * UTF-8 bytes if the secret is unprefixed).
 */
async function computeExpectedSignature(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string
): Promise<string> {
  const keyMaterial = secret.startsWith("whsec_")
    ? base64Decode(secret.slice("whsec_".length))
    : new TextEncoder().encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(signedContent)
  );
  return base64Encode(new Uint8Array(sigBuf));
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verification = await verifyFathomSignature(
    request,
    rawBody,
    env.FATHOM_WEBHOOK_SECRET
  );
  if (!verification.ok) {
    console.warn(`Rejected webhook: ${verification.reason}`);
    return json({ error: "invalid_signature", reason: verification.reason }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  if (!parsed || typeof parsed !== "object") {
    return json({ error: "payload_not_object" }, 400);
  }

  const body = parsed as Record<string, unknown>;
  const meeting = body.meeting ?? body.recording ?? body.data;
  if (!meeting || typeof meeting !== "object") {
    return json({ error: "payload_has_no_meeting" }, 400);
  }

  const payload: WebhookPayload = {
    delivery_id: verification.webhookId,
    delivered_at: Number(request.headers.get("webhook-timestamp") ?? 0),
    triggered_for:
      typeof body.triggered_for === "string" ? body.triggered_for : "unknown",
    meeting,
  };

  await env.DELIVERIES.put(
    DELIVERY_KEY_PREFIX + verification.webhookId,
    JSON.stringify(payload),
    { expirationTtl: DELIVERY_TTL_SECONDS }
  );

  return json({ ok: true, delivery_id: verification.webhookId });
}

async function handlePending(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  // KV list() returns at most 1000 keys per page. Without pagination, users
  // who leave the plugin offline for a long time could silently lose
  // deliveries past the first 1000. We page through the cursor until done.
  const deliveries: WebhookPayload[] = [];
  let cursor: string | undefined;

  while (true) {
    const listing = await env.DELIVERIES.list({
      prefix: DELIVERY_KEY_PREFIX,
      cursor,
    });
    for (const key of listing.keys) {
      const raw = await env.DELIVERIES.get(key.name);
      if (!raw) continue;
      try {
        deliveries.push(JSON.parse(raw) as WebhookPayload);
      } catch {
        console.warn(`Skipping malformed delivery at ${key.name}`);
      }
    }
    if (listing.list_complete) break;
    cursor = listing.cursor;
  }

  // Oldest first so the plugin processes in arrival order.
  deliveries.sort((a, b) => a.delivered_at - b.delivered_at);

  return json({ deliveries });
}

async function handleAck(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  let body: { delivery_ids?: unknown };
  try {
    body = (await request.json()) as { delivery_ids?: unknown };
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  if (!Array.isArray(body.delivery_ids)) {
    return json({ error: "delivery_ids_must_be_array" }, 400);
  }

  const ids = body.delivery_ids.filter((id): id is string => typeof id === "string");
  await Promise.all(
    ids.map((id) => env.DELIVERIES.delete(DELIVERY_KEY_PREFIX + id))
  );

  return json({ ok: true, acked: ids.length });
}

function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.PLUGIN_BEARER_TOKEN}`;
  return constantTimeEqual(header, expected);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Compare two strings in time that does not depend on whether (or where) they
 * differ. Always iterates over the longer of the two inputs and records a
 * length mismatch as an unconditional non-zero diff. This avoids the classic
 * length-oracle leak where a fast early `return false` on length-mismatch
 * lets a remote attacker discover the correct token length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function base64Decode(s: string): Uint8Array {
  const decoded = atob(s);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
