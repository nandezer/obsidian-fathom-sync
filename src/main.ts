import { Notice, Platform, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  FathomSyncSettingTab,
  type FathomSyncSettings,
} from "./settings";
import { FileSyncService } from "./services/fileSyncService";
import { SyncService, type SyncResult } from "./services/syncService";
import { FolderQueue } from "./services/queues/folderQueue";
import { HttpQueue } from "./services/queues/httpQueue";
import type { Queue } from "./services/queues/queue";
import type { SyncMode } from "./types";
import { logger } from "./utils/logger";

type SyncTrigger = "manual" | "periodic";

export default class FathomSyncPlugin extends Plugin {
  settings!: FathomSyncSettings;

  private fileSync!: FileSyncService;
  private syncService!: SyncService;
  private periodicSyncIntervalId: number | null = null;
  private statusBarItem!: HTMLElement;
  private inFlightSync: Promise<void> | null = null;
  private warnedAboutForeignNotes = false;
  private lastBuiltApiToken: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (Platform.isMobile) {
      logger.warn("Mobile detected; Fathom Sync is desktop-only and will not run.");
      new Notice("Fathom Sync is desktop-only and won't run on mobile.");
      return;
    }

    this.initServices();

    this.statusBarItem = this.addStatusBarItem();
    this.setStatusBar("Fathom Sync ready");

    this.addRibbonIcon("refresh-cw", "Fathom Sync: sync now", async () => {
      await this.triggerSync("standard", "manual");
    });

    this.addCommand({
      id: "fathom-sync-standard",
      name: "Sync recent meetings",
      callback: () => this.triggerSync("standard", "manual"),
    });

    this.addCommand({
      id: "fathom-sync-full",
      name: "Full sync (all meetings)",
      callback: () => this.triggerSync("full", "manual"),
    });

    this.addSettingTab(new FathomSyncSettingTab(this.app, this));

    this.reschedulePeriodicSync();

    logger.info("Plugin loaded.");
  }

  onunload(): void {
    this.clearPeriodicSync();
    logger.info("Plugin unloaded.");
  }

  // ── Public API (called from settings tab) ──────────────────────────

  async performSync(mode: SyncMode): Promise<void> {
    await this.triggerSync(mode, "manual");
  }

  reschedulePeriodicSync(): void {
    this.clearPeriodicSync();

    if (!this.settings.periodicSyncEnabled) return;

    const ms = this.settings.periodicSyncIntervalMinutes * 60 * 1000;
    this.periodicSyncIntervalId = window.setInterval(
      () => this.triggerSync("standard", "periodic"),
      ms
    );
    this.register(() => this.clearPeriodicSync());
  }

  // ── Settings ────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Only rebuild services if the token actually changed. Otherwise
    // per-keystroke saves on folder/filter fields kept resetting the
    // throttle and tearing down in-flight services unnecessarily.
    if (this.settings.apiToken !== this.lastBuiltApiToken) {
      this.initServices();
    }
  }

  /** Used by the settings tab to grab the current API client for a test call. */
  getSyncService(): SyncService {
    return this.syncService;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private initServices(): void {
    this.fileSync = new FileSyncService(this.app);
    this.syncService = new SyncService(
      this.settings,
      this.fileSync,
      async (partial) => {
        Object.assign(this.settings, partial);
        await this.saveData(this.settings);
      }
    );
    this.lastBuiltApiToken = this.settings.apiToken;
    this.warnedAboutForeignNotes = false;
  }

  private async triggerSync(mode: SyncMode, trigger: SyncTrigger): Promise<void> {
    // CRIT-1: single-flight mutex. A second click / interval tick while a
    // sync is running just awaits the in-flight one.
    if (this.inFlightSync) {
      if (trigger === "manual") {
        new Notice("Fathom Sync: a sync is already running.");
      }
      return this.inFlightSync;
    }

    this.inFlightSync = this.runSync(mode, trigger);
    try {
      await this.inFlightSync;
    } finally {
      this.inFlightSync = null;
    }
  }

  /** Build the configured queue, or null if intake is disabled. */
  private buildQueue(): Queue | null {
    if (this.settings.webhookQueueType === "folder") {
      const folder = this.settings.webhookQueueFolder.trim();
      if (!folder) return null;
      return new FolderQueue(this.app, folder);
    }
    if (this.settings.webhookQueueType === "http") {
      const url = this.settings.webhookQueueHttpUrl.trim();
      const bearer = this.settings.webhookQueueHttpBearer.trim();
      if (!url || !bearer) return null;
      return new HttpQueue(url, bearer);
    }
    return null;
  }

  private async runSync(mode: SyncMode, trigger: SyncTrigger): Promise<void> {
    this.setStatusBar("Syncing…");
    const label = mode === "full" ? "full sync" : "sync";

    try {
      // Queue drain first — pulls in webhook-delivered meetings (especially
      // shared_external_recordings, which polling can't see). Errors here
      // are logged but don't abort the polling sync that follows; the two
      // intake paths are independent.
      const queue = this.buildQueue();
      let queueResult: SyncResult | null = null;
      if (queue) {
        try {
          queueResult = await this.syncService.drainQueue(queue);
        } catch (err) {
          logger.error("Queue drain failed", err);
          if (trigger === "manual") {
            const msg = err instanceof Error ? err.message : "unknown error";
            new Notice(`Fathom Sync: queue drain failed — ${msg}`);
          }
        }
      }

      const result = await this.syncService.performSync(mode);

      // Merge queue + polling counts so the toast reflects the whole tick.
      if (queueResult) {
        result.summariesCreated += queueResult.summariesCreated;
        result.transcriptsCreated += queueResult.transcriptsCreated;
        result.skipped += queueResult.skipped;
        result.errors += queueResult.errors;
      }

      // CRIT-2: surface Granola / other-plugin collisions once per session
      // so users understand why their counts look weird.
      if (
        !this.warnedAboutForeignNotes &&
        this.fileSync.foreignFathomNotes > 0
      ) {
        this.warnedAboutForeignNotes = true;
        new Notice(
          `Fathom Sync: ${this.fileSync.foreignFathomNotes} existing notes ` +
            `with fathom_id from another plugin were ignored. New copies will ` +
            `be created for those meetings.`,
          10000
        );
      }

      const msg =
        `Fathom Sync: ${label} done — ` +
        `${result.summariesCreated} summaries, ` +
        `${result.transcriptsCreated} transcripts created.`;
      new Notice(msg);
      this.setStatusBar(`Last sync: ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      logger.error(`${label} failed`, err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      // HIGH-7: suppress toast spam on periodic failures (overnight offline =
      // 16+ stacked Notices). Status bar stays red so the user still knows.
      if (trigger === "manual") {
        new Notice(`Fathom Sync: ${label} failed — ${msg}`);
      }
      this.setStatusBar("Sync failed");
    }
  }

  private setStatusBar(text: string): void {
    this.statusBarItem?.setText(text);
  }

  private clearPeriodicSync(): void {
    if (this.periodicSyncIntervalId !== null) {
      window.clearInterval(this.periodicSyncIntervalId);
      this.periodicSyncIntervalId = null;
    }
  }
}
