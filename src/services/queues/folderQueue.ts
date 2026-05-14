import { App, normalizePath } from "obsidian";
import type { WebhookPayload } from "../../types";
import { logger } from "../../utils/logger";
import type { Queue } from "./queue";

/**
 * Queue backed by a folder inside the Obsidian vault.
 *
 * Designed for users who already run Make/Zapier/n8n: their scenario writes
 * one `.json` file per webhook delivery into the configured folder (synced
 * into the vault via iCloud / Dropbox / OneDrive / Obsidian Sync — doesn't
 * matter which), and we consume them.
 *
 * Each file's content must be a JSON-serialised {@link WebhookPayload}. The
 * filename is used as `delivery_id` if the payload doesn't carry one — useful
 * when the Make scenario doesn't have access to the webhook-id header.
 *
 * **Hidden folders:** we deliberately use `vault.adapter` (raw filesystem)
 * instead of `vault.getAbstractFileByPath` (Obsidian's note index). The index
 * silently skips folders starting with `.` — which is exactly what users
 * want for an inbox, but it means the high-level API can't see them. The
 * adapter API sees everything.
 *
 * **Ack semantics:** a delivery is acked by deleting the source file. We
 * keep this destructive (vs moving to a `processed/` subfolder) because the
 * dedup cache in FileSyncService already prevents double-writes, and a
 * growing archive folder is a sharper footgun than the JSON files themselves.
 */
export class FolderQueue implements Queue {
  readonly label: string;
  private readonly normalisedPath: string;

  constructor(
    private readonly app: App,
    folderPath: string
  ) {
    this.normalisedPath = normalizePath(folderPath);
    this.label = `folder:${folderPath}`;
  }

  async fetchPending(): Promise<WebhookPayload[]> {
    const adapter = this.app.vault.adapter;

    if (!(await adapter.exists(this.normalisedPath))) return [];

    const listing = await adapter.list(this.normalisedPath);
    const jsonFiles = listing.files.filter((p) => p.toLowerCase().endsWith(".json"));

    // Pull stats for ordering. Adapter doesn't return them inline, so we
    // collect them here. N is small (one per pending delivery) so a serial
    // loop is fine.
    type Entry = { path: string; basename: string; mtime: number };
    const entries: Entry[] = [];
    for (const path of jsonFiles) {
      try {
        const stat = await adapter.stat(path);
        const basename = path.split("/").pop()!.replace(/\.json$/i, "");
        entries.push({ path, basename, mtime: stat?.mtime ?? 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`FolderQueue: stat failed for ${path}: ${msg}`);
      }
    }

    // Delivery order: oldest first, so multi-event sequences for the same
    // recording (summary then transcript) are processed in arrival order.
    entries.sort((a, b) => a.mtime - b.mtime);

    const payloads: WebhookPayload[] = [];
    for (const entry of entries) {
      try {
        const raw = await adapter.read(entry.path);
        const parsed = JSON.parse(raw) as Partial<WebhookPayload>;
        const normalised = this.normalise(parsed, entry.basename, entry.mtime);
        if (normalised) payloads.push(normalised);
      } catch (err) {
        // A single bad file shouldn't poison the whole batch. Log and skip;
        // the user will see it sitting in the folder and can investigate.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`FolderQueue: failed to parse ${entry.path}: ${msg}`);
      }
    }

    return payloads;
  }

  async ack(deliveryIds: string[]): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.normalisedPath))) return;

    const toDelete = new Set(deliveryIds);
    const listing = await adapter.list(this.normalisedPath);
    const jsonFiles = listing.files.filter((p) => p.toLowerCase().endsWith(".json"));

    for (const path of jsonFiles) {
      const basename = path.split("/").pop()!.replace(/\.json$/i, "");
      if (!toDelete.has(basename)) continue;
      try {
        await adapter.remove(path);
      } catch (err) {
        // Best-effort: next fetchPending will re-deliver, FileSyncService
        // dedups by recording_id, so a failed ack is not data loss.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`FolderQueue: failed to delete ${path}: ${msg}`);
      }
    }
  }

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.normalisedPath))) {
      return {
        ok: false,
        reason: `Folder '${this.normalisedPath}' does not exist in the vault.`,
      };
    }
    const stat = await adapter.stat(this.normalisedPath);
    if (stat?.type !== "folder") {
      return {
        ok: false,
        reason: `Path '${this.normalisedPath}' exists but is not a folder.`,
      };
    }
    return { ok: true };
  }

  /**
   * Ensure delivery_id is set (fall back to filename) and that the meeting
   * field is present. Returns null and logs if the payload is missing the
   * load-bearing meeting record — we'd have nothing to write.
   */
  private normalise(
    parsed: Partial<WebhookPayload>,
    basename: string,
    mtime: number
  ): WebhookPayload | null {
    if (!parsed.meeting || typeof parsed.meeting !== "object") {
      logger.error(
        `FolderQueue: ${basename}.json has no 'meeting' field; skipping.`
      );
      return null;
    }
    return {
      delivery_id: parsed.delivery_id ?? basename,
      delivered_at: parsed.delivered_at ?? Math.floor(mtime / 1000),
      triggered_for: parsed.triggered_for ?? "my_recordings",
      meeting: parsed.meeting,
    };
  }
}
