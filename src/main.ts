import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  FathomSyncSettingTab,
  type FathomSyncSettings,
} from "./settings";
import { FileSyncService } from "./services/fileSyncService";
import { SyncService } from "./services/syncService";
import type { SyncMode } from "./types";
import { logger } from "./utils/logger";

export default class FathomSyncPlugin extends Plugin {
  settings!: FathomSyncSettings;

  private fileSync!: FileSyncService;
  private syncService!: SyncService;
  private periodicSyncIntervalId: number | null = null;
  private statusBarItem!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initServices();

    this.statusBarItem = this.addStatusBarItem();
    this.setStatusBar("Fathom Sync ready");

    // Ribbon button
    this.addRibbonIcon("refresh-cw", "Fathom Sync: sync now", async () => {
      await this.triggerSync("standard");
    });

    // Command palette
    this.addCommand({
      id: "fathom-sync-standard",
      name: "Sync recent meetings",
      callback: () => this.triggerSync("standard"),
    });

    this.addCommand({
      id: "fathom-sync-full",
      name: "Full sync (all meetings)",
      callback: () => this.triggerSync("full"),
    });

    // Settings tab
    this.addSettingTab(new FathomSyncSettingTab(this.app, this));

    // Periodic sync
    this.reschedulePeriodicSync();

    logger.info("Plugin loaded.");
  }

  onunload(): void {
    this.clearPeriodicSync();
    logger.info("Plugin unloaded.");
  }

  // ── Public API (called from settings tab) ──────────────────────────

  async performSync(mode: SyncMode): Promise<void> {
    await this.triggerSync(mode);
  }

  reschedulePeriodicSync(): void {
    this.clearPeriodicSync();

    if (!this.settings.periodicSyncEnabled) return;

    const ms = this.settings.periodicSyncIntervalMinutes * 60 * 1000;
    this.periodicSyncIntervalId = window.setInterval(
      () => this.triggerSync("standard"),
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
    this.initServices(); // rebuild with fresh settings
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
  }

  private async triggerSync(mode: SyncMode): Promise<void> {
    this.setStatusBar("Syncing…");
    const label = mode === "full" ? "full sync" : "sync";

    try {
      const result = await this.syncService.performSync(mode);
      const msg =
        `Fathom Sync: ${label} done — ` +
        `${result.summariesCreated} summaries, ` +
        `${result.transcriptsCreated} transcripts created.`;
      new Notice(msg);
      this.setStatusBar(`Last sync: ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      logger.error(`${label} failed`, err);
      const msg =
        err instanceof Error ? err.message : "Unknown error";
      new Notice(`Fathom Sync: ${label} failed — ${msg}`);
      this.setStatusBar("Sync failed");
    }
  }

  private setStatusBar(text: string): void {
    this.statusBarItem.setText(text);
  }

  private clearPeriodicSync(): void {
    if (this.periodicSyncIntervalId !== null) {
      window.clearInterval(this.periodicSyncIntervalId);
      this.periodicSyncIntervalId = null;
    }
  }
}
