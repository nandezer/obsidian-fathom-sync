import { requestUrl, type RequestUrlParam } from "obsidian";
import type { WebhookPayload } from "../../types";
import { logger } from "../../utils/logger";
import type { Queue } from "./queue";

/**
 * Queue backed by a user-deployed Cloudflare Worker.
 *
 * The Worker receives webhook POSTs from Fathom, verifies the Svix signature,
 * and stores payloads in KV. This class polls `GET /pending` on the Worker
 * and acks via `POST /ack`. Both calls are bearer-authenticated with a token
 * shared between the plugin and the Worker at deploy time.
 *
 * Uses Obsidian's `requestUrl` rather than `fetch` because Electron's
 * renderer enforces CORS on `fetch` and Cloudflare Workers don't ship with
 * permissive CORS headers by default. `requestUrl` goes through Node's HTTP
 * stack so the same rule that applies to fathomApi.ts applies here.
 */
export class HttpQueue implements Queue {
  readonly label: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly bearerToken: string) {
    // Strip trailing slashes so we can concatenate paths safely.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.label = `http:${this.baseUrl}`;
  }

  async fetchPending(): Promise<WebhookPayload[]> {
    const response = await this.call("GET", "/pending");
    const body = response as { deliveries?: unknown };

    if (!Array.isArray(body.deliveries)) {
      throw new Error(
        `Worker /pending returned malformed response (no deliveries array).`
      );
    }

    // Defensive parse: only keep entries that look like a WebhookPayload.
    // A malformed entry should not poison the whole batch.
    const payloads: WebhookPayload[] = [];
    for (const entry of body.deliveries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Partial<WebhookPayload>;
      if (typeof e.delivery_id !== "string") continue;
      if (!e.meeting || typeof e.meeting !== "object") continue;
      payloads.push({
        delivery_id: e.delivery_id,
        delivered_at: typeof e.delivered_at === "number" ? e.delivered_at : 0,
        triggered_for: e.triggered_for ?? "my_recordings",
        meeting: e.meeting,
      });
    }
    return payloads;
  }

  async ack(deliveryIds: string[]): Promise<void> {
    if (deliveryIds.length === 0) return;
    try {
      await this.call("POST", "/ack", { delivery_ids: deliveryIds });
    } catch (err) {
      // Best-effort: SyncService's at-least-once contract + FileSyncService
      // dedup mean a failed ack is not data loss. Just log it.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`HttpQueue: ack failed (will retry next drain): ${msg}`);
    }
  }

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      // /health is unauthenticated by design — proves the Worker is up
      // without revealing whether our bearer is valid.
      await this.call("GET", "/health", undefined, { skipAuth: true });
      // And one authed call to prove the bearer works.
      await this.call("GET", "/pending");
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      return { ok: false, reason };
    }
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts?: { skipAuth?: boolean }
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!opts?.skipAuth) {
      headers.authorization = `Bearer ${this.bearerToken}`;
    }

    const params: RequestUrlParam = {
      url: `${this.baseUrl}${path}`,
      method,
      headers,
      throw: false,
    };
    if (body !== undefined) {
      params.body = JSON.stringify(body);
    }

    const response = await requestUrl(params);
    if (response.status < 200 || response.status >= 300) {
      const text = (response.text ?? "").slice(0, 300);
      throw new Error(
        `Worker ${method} ${path} → ${response.status}: ${text || "no body"}`
      );
    }
    try {
      return response.json;
    } catch {
      // Some Worker responses (e.g. /ack) have empty bodies — fine.
      return {};
    }
  }
}
