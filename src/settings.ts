import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FathomSyncPlugin from "./main";
import { logger } from "./utils/logger";

export interface FathomSyncSettings {
  apiToken: string;
  syncTeams: string[];
  recordedByFilter: string[];

  syncSummaries: boolean;
  syncTranscripts: boolean;

  summaryFolder: string;
  transcriptFolder: string;

  noteFilenamePattern: string;

  periodicSyncEnabled: boolean;
  periodicSyncIntervalMinutes: number;

  lookbackDays: number;

  // Persisted pagination cursor for incremental sync
  lastSyncCursor: string;
}

export const DEFAULT_SETTINGS: FathomSyncSettings = {
  apiToken: "",
  syncTeams: [],
  recordedByFilter: [],

  syncSummaries: true,
  syncTranscripts: false,

  summaryFolder: "Fathom/Summaries",
  transcriptFolder: "Fathom/Transcripts",

  noteFilenamePattern: "{date} {title}",

  periodicSyncEnabled: false,
  periodicSyncIntervalMinutes: 30,

  lookbackDays: 7,

  lastSyncCursor: "",
};

export class FathomSyncSettingTab extends PluginSettingTab {
  private plugin: FathomSyncPlugin;

  constructor(app: App, plugin: FathomSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Fathom Sync" });

    // ── Authentication ──────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("API token")
      .setDesc(
        createFragment((frag) => {
          frag.appendText("Your Fathom API key. Generate one at ");
          frag.createEl("a", {
            href: "https://fathom.video/customize#api-access-header",
            text: "fathom.video/customize",
          });
          frag.appendText(".");
        })
      )
      .addText((text) =>
        text
          .setPlaceholder("fathom_...")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Filters ─────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Filters" });

    new Setting(containerEl)
      .setName("Sync teams")
      .setDesc(
        "Comma-separated list of team names to sync. Leave empty to sync all meetings you have access to."
      )
      .addText((text) =>
        text
          .setPlaceholder("Sales, Engineering")
          .setValue(this.plugin.settings.syncTeams.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.syncTeams = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Recorded by (emails)")
      .setDesc(
        "Comma-separated emails to filter by recorder. Leave empty for all."
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.com, colleague@example.com")
          .setValue(this.plugin.settings.recordedByFilter.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.recordedByFilter = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Content ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Content" });

    new Setting(containerEl)
      .setName("Sync summaries")
      .setDesc("Download AI-generated meeting summaries.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncSummaries)
          .onChange(async (value) => {
            this.plugin.settings.syncSummaries = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync transcripts")
      .setDesc(
        "Download full speaker-attributed transcripts. Files can be large (50–150 KB each)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncTranscripts)
          .onChange(async (value) => {
            this.plugin.settings.syncTranscripts = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Folders ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Folders" });

    new Setting(containerEl)
      .setName("Summaries folder")
      .setDesc("Vault path where summary notes will be saved.")
      .addText((text) =>
        text
          .setPlaceholder("Fathom/Summaries")
          .setValue(this.plugin.settings.summaryFolder)
          .onChange(async (value) => {
            this.plugin.settings.summaryFolder = value.trim() || "Fathom/Summaries";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Transcripts folder")
      .setDesc("Vault path where transcript notes will be saved.")
      .addText((text) =>
        text
          .setPlaceholder("Fathom/Transcripts")
          .setValue(this.plugin.settings.transcriptFolder)
          .onChange(async (value) => {
            this.plugin.settings.transcriptFolder =
              value.trim() || "Fathom/Transcripts";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Filename pattern")
      .setDesc(
        "Pattern for note filenames. Available tokens: {date} (YYYY-MM-DD), {title}, {id}."
      )
      .addText((text) =>
        text
          .setPlaceholder("{date} {title}")
          .setValue(this.plugin.settings.noteFilenamePattern)
          .onChange(async (value) => {
            this.plugin.settings.noteFilenamePattern =
              value.trim() || "{date} {title}";
            await this.plugin.saveSettings();
          })
      );

    // ── Periodic Sync ────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Periodic sync" });

    new Setting(containerEl)
      .setName("Enable periodic sync")
      .setDesc("Automatically sync new meetings on a schedule.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.periodicSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.periodicSyncEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.reschedulePeriodicSync();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to check for new meetings when periodic sync is on.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.periodicSyncIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.periodicSyncIntervalMinutes = value;
            await this.plugin.saveSettings();
            this.plugin.reschedulePeriodicSync();
          })
      );

    new Setting(containerEl)
      .setName("Lookback window (days)")
      .setDesc(
        "How many days back to look when running a standard sync. Full sync ignores this."
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 90, 1)
          .setValue(this.plugin.settings.lookbackDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.lookbackDays = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Actions ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Full sync")
      .setDesc(
        "Re-sync all reachable meetings, ignoring the lookback window. This may take a while."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Run full sync")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true).setButtonText("Syncing…");
            try {
              await this.plugin.performSync("full");
              new Notice("Fathom Sync: full sync complete.");
            } catch (err) {
              logger.error("Full sync failed", err);
              new Notice("Fathom Sync: full sync failed — check the console.");
            } finally {
              btn.setDisabled(false).setButtonText("Run full sync");
            }
          })
      );

    new Setting(containerEl)
      .setName("Reset sync cursor")
      .setDesc(
        "Clears the saved pagination cursor so the next standard sync starts from scratch."
      )
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.lastSyncCursor = "";
          await this.plugin.saveSettings();
          new Notice("Fathom Sync: cursor reset.");
        })
      );
  }
}
