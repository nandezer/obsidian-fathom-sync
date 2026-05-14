import type { WebhookPayload } from "../../types";

/**
 * A Queue is an intake source for Fathom webhook deliveries.
 *
 * The plugin doesn't care whether the queue is backed by a Cloudflare Worker
 * (HttpQueue), a vault folder fed by Make/Zapier (FolderQueue), or anything
 * else. It just needs to pull pending payloads and ack the ones it successfully
 * wrote to the vault.
 *
 * Implementations MUST:
 *  - Return payloads in delivery order (oldest first) so we honour Fathom's
 *    ordering for the same meeting (e.g. summary then transcript updates).
 *  - Be idempotent on fetchPending — calling it twice without an intervening
 *    ack must return the same payloads. SyncService relies on this for retry.
 *  - Treat ack as best-effort. A successful note write followed by a failed
 *    ack should not cause data loss — at-least-once delivery is fine because
 *    FileSyncService's recording_id dedup catches duplicates.
 */
export interface Queue {
  /** Human-readable label for logs and the "Test queue" button. */
  readonly label: string;

  /**
   * Pull all pending webhook payloads. Returns [] when the queue is empty.
   * Throws on transport errors so SyncService can surface a Notice.
   */
  fetchPending(): Promise<WebhookPayload[]>;

  /**
   * Mark the given delivery_ids as processed. Implementations may delete the
   * underlying record, advance a cursor, or move the file — it's their call.
   * Errors here are logged but not rethrown; the next fetchPending will
   * re-deliver and FileSyncService will dedup.
   */
  ack(deliveryIds: string[]): Promise<void>;

  /**
   * Cheap health check. HttpQueue does an authenticated GET against a /health
   * route; FolderQueue verifies the folder exists and is readable. Used by the
   * settings "Test queue" button.
   */
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
}
