import { Notice, Platform, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  FathomSyncSettingTab,
  type FathomSyncSettings,
} from "./settings";
import { FileSyncService } from "./services/fileSyncService";
import {
  MeetingNotFoundError,
  SharedRecordingNotAccessibleError,
  SyncService,
  UrlParseError,
  type SyncResult,
} from "./services/syncService";
import { FolderQueue } from "./services/queues/folderQueue";
import { HttpQueue } from "./services/queues/httpQueue";
import type { Queue } from "./services/queues/queue";
import type { SyncMode } from "./types";
import { parseFathomReference, type ParseFailure } from "./utils/fathomUrl";
import { FathomApiError } from "./services/fathomApi";
import { logger } from "./utils/logger";

type SyncTrigger = "manual" | "periodic";

/**
 * Combine queue-drain counts into the polling-sync result so the end-of-
 * tick toast reflects everything that happened. Returns the polling result
 * unchanged when there's no queue contribution.
 */
function mergeSyncResults(
  polling: SyncResult,
  queue: SyncResult | null
): SyncResult {
  if (!queue) return polling;
  return {
    summariesCreated: polling.summariesCreated + queue.summariesCreated,
    transcriptsCreated: polling.transcriptsCreated + queue.transcriptsCreated,
    skipped: polling.skipped + queue.skipped,
    errors: polling.errors + queue.errors,
  };
}

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

    this.addCommand({
      id: "fathom-sync-import-link",
      name: "Import meeting from Fathom link",
      callback: () => this.openImportSettings(),
    });

    this.addSettingTab(new FathomSyncSettingTab(this.app, this));

    // One-click webhook setup via custom URI scheme:
    //   obsidian://fathom-sync?worker=https://…&bearer=<token>
    // Lets users paste a single URL (from a Worker /setup-url helper, or
    // hand-crafted) instead of typing three fields. We deliberately do
    // NOT auto-click Connect — the user still confirms in settings.
    this.registerObsidianProtocolHandler("fathom-sync", async (params) => {
      const worker = (params.worker ?? "").trim();
      const bearer = (params.bearer ?? "").trim();
      if (!worker || !bearer) {
        new Notice(
          "Fathom Sync: setup link missing worker= or bearer= params."
        );
        return;
      }
      this.settings.webhookQueueType = "http";
      this.settings.webhookQueueHttpUrl = worker.replace(/\/+$/, "");
      this.settings.webhookQueueHttpBearer = bearer;
      await this.saveSettings();
      new Notice(
        "Fathom Sync: Worker URL + bearer imported. Open settings → Webhook intake → Test queue to verify."
      );
      logger.info("Imported webhook config via obsidian:// URI");
    });

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

  /**
   * Public entry point for the settings tab's "Import" button. Returns the
   * resulting counts so the caller can render a precise Notice. On any error
   * (parse failure, meeting-not-found, API failure, busy mutex) throws — the
   * caller is responsible for restoring its button state. Directed Notices
   * for each known failure mode are emitted from `runImport`/`importByLink`
   * themselves so the user always sees what went wrong.
   */
  async importByLink(input: string): Promise<SyncResult> {
    let result: SyncResult | undefined;
    const ran = await this.withMutex(async () => {
      result = await this.runImport(input);
    });
    if (!ran) {
      new Notice(
        "Fathom Sync: a sync or import is already running. Try again after it finishes."
      );
      throw new Error("Another operation in progress");
    }
    if (!result) {
      // runImport always sets `result` before resolving on the happy path.
      // The only way we reach here is if runImport threw — which propagates
      // out via the awaited withMutex above, never landing here. Defensive.
      throw new Error("Import did not produce a result");
    }
    return result;
  }

  /**
   * Open the settings tab so the user can use the Import-from-link control.
   * The `app.setting` API is internal (typed via obsidian-augments.d.ts), so
   * fall back to a Notice if it isn't available on this Obsidian version.
   */
  private openImportSettings(): void {
    const setting = this.app.setting;
    if (!setting || typeof setting.open !== "function") {
      new Notice(
        "Fathom Sync: open Settings → Fathom Sync → Actions and paste your link there."
      );
      return;
    }
    setting.open();
    if (typeof setting.openTabById === "function") {
      setting.openTabById(this.manifest.id);
    }
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

  /**
   * Single-flight mutex. Returns `true` if `task` ran (mutex was free),
   * `false` if another operation was already in flight (task did NOT run;
   * caller decides whether to Notice / piggyback / abort). Sync callers
   * piggyback (await the in-flight sync because it's the same work); the
   * import caller refuses (the in-flight is a sync, not the import the user
   * asked for).
   */
  private async withMutex(task: () => Promise<void>): Promise<boolean> {
    if (this.inFlightSync) return false;
    this.inFlightSync = task();
    try {
      await this.inFlightSync;
    } finally {
      this.inFlightSync = null;
    }
    return true;
  }

  private async triggerSync(mode: SyncMode, trigger: SyncTrigger): Promise<void> {
    // CRIT-1: single-flight mutex. A second click / interval tick while a
    // sync is running just awaits the in-flight one (piggyback) rather than
    // starting a second sync.
    const ran = await this.withMutex(() => this.runSync(mode, trigger));
    if (!ran) {
      if (trigger === "manual") {
        new Notice("Fathom Sync: a sync or import is already running.");
      }
      if (this.inFlightSync) await this.inFlightSync;
    }
  }

  private async runImport(input: string): Promise<SyncResult> {
    this.setStatusBar("Importing…");
    try {
      // Queue drain first so any pending webhook-delivered notes for the same
      // recording are persisted before we look it up — keeps dedup honest.
      await this.drainQueueIfConfigured("manual");

      const ref = parseFathomReference(input);
      const result = await this.syncService.importByReference(ref);

      this.surfaceForeignNotesWarningOnce();
      new Notice(
        `Fathom Sync: import done — ${result.summariesCreated} summaries, ` +
          `${result.transcriptsCreated} transcripts created` +
          (result.skipped > 0 ? `, ${result.skipped} skipped (already in vault)` : "") +
          "."
      );
      this.setStatusBar(`Last import: ${new Date().toLocaleTimeString()}`);
      return result;
    } catch (err) {
      this.setStatusBar("Import failed");
      this.noticeImportError(err);
      throw err;
    }
  }

  private noticeImportError(err: unknown): void {
    if (err instanceof UrlParseError) {
      new Notice(`Fathom Sync: ${importParseFailureMessage(err.reason)}`);
      return;
    }
    if (err instanceof MeetingNotFoundError) {
      if (err.kind === "share_token") {
        new Notice(
          "Fathom Sync: could not resolve share token — only recordings " +
            "visible to your API token can be imported. Ask the owner to " +
            "share the recording with your Fathom workspace or paste the " +
            "recording id instead."
        );
      } else {
        new Notice("Fathom Sync: meeting not found.");
      }
      return;
    }
    if (err instanceof SharedRecordingNotAccessibleError) {
      new Notice(
        `Fathom Sync: recording ${err.recordingId} is viewable in browser via the share link, ` +
          "but Fathom's API doesn't grant your token access to it. Ask the meeting owner " +
          "to share the recording with your Fathom workspace (not just a public link) so " +
          "it becomes API-accessible.",
        15000
      );
      return;
    }
    if (err instanceof FathomApiError) {
      if (err.status === 401) {
        new Notice("Fathom Sync: invalid API token. Check your settings.");
        return;
      }
      if (err.status === 403 || err.status === 404) {
        new Notice(
          "Fathom Sync: this recording isn't accessible to your API token " +
            "(404/403). Ask the owner to share it with your workspace."
        );
        return;
      }
      if (err.status >= 500) {
        new Notice(
          `Fathom Sync: Fathom returned HTTP ${err.status} (server-side error). ` +
            "Try again in a minute. If it persists, narrow your sync filters and retry."
        );
        return;
      }
      new Notice(`Fathom Sync: import failed (HTTP ${err.status}).`);
      return;
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    // performSync / importByReference / importByLink emit their own Notices
    // for missing-token and no-content-enabled — don't double-Notice those.
    if (msg === "Missing API token" || msg === "No content to import" ||
        msg === "Another operation in progress") {
      return;
    }
    new Notice(`Fathom Sync: import failed — ${msg}`);
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
      const queueResult = await this.drainQueueIfConfigured(trigger);
      const pollingResult = await this.syncService.performSync(mode);
      const result = mergeSyncResults(pollingResult, queueResult);

      this.surfaceForeignNotesWarningOnce();

      new Notice(
        `Fathom Sync: ${label} done — ` +
          `${result.summariesCreated} summaries, ` +
          `${result.transcriptsCreated} transcripts created.`
      );
      this.setStatusBar(`Last sync: ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      logger.error(`${label} failed`, err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      // Suppress toast spam on periodic failures (overnight offline = 16+
      // stacked Notices). Status bar stays red so the user still knows.
      if (trigger === "manual") {
        new Notice(`Fathom Sync: ${label} failed — ${msg}`);
      }
      this.setStatusBar("Sync failed");
    }
  }

  /**
   * Run a queue drain if intake is configured. Errors are logged and
   * surfaced (manual trigger only) but do not propagate — the polling
   * sync is independent and should still run.
   */
  private async drainQueueIfConfigured(
    trigger: SyncTrigger
  ): Promise<SyncResult | null> {
    const queue = this.buildQueue();
    if (!queue) return null;
    try {
      return await this.syncService.drainQueue(queue);
    } catch (err) {
      logger.error("Queue drain failed", err);
      if (trigger === "manual") {
        const msg = err instanceof Error ? err.message : "unknown error";
        new Notice(`Fathom Sync: queue drain failed — ${msg}`);
      }
      return null;
    }
  }

  /**
   * Surface Granola / other-plugin fathom_id collisions once per session
   * so users understand why their counts look weird. No-op afterwards.
   */
  private surfaceForeignNotesWarningOnce(): void {
    if (this.warnedAboutForeignNotes) return;
    if (this.fileSync.foreignFathomNotes === 0) return;
    this.warnedAboutForeignNotes = true;
    new Notice(
      `Fathom Sync: ${this.fileSync.foreignFathomNotes} existing notes ` +
        `with fathom_id from another plugin were ignored. New copies will ` +
        `be created for those meetings.`,
      10000
    );
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

function importParseFailureMessage(reason: ParseFailure): string {
  switch (reason) {
    case "empty":
      return "paste a Fathom URL or recording id.";
    case "too_long":
      return "input is too long — paste only the Fathom URL or id.";
    case "unrecognised_scheme":
      return "that URL doesn't look like a Fathom link. Paste a fathom.video/calls/… or /share/… URL, or a recording id.";
    case "no_recognisable_id":
      return "couldn't find a Fathom recording id or URL in that input.";
    default:
      // Exhaustiveness check: adding a new ParseFailure literal without
      // updating this switch will fail compilation here.
      return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ParseFailure variant: ${String(value)}`);
}
