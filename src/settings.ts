import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FathomSyncPlugin from "./main";
import { FathomApiError } from "./services/fathomApi";
import { FolderQueue } from "./services/queues/folderQueue";
import { HttpQueue } from "./services/queues/httpQueue";
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

  // ── v2.0: webhook intake ─────────────────────────────────────────────

  /**
   * Where webhook payloads come from. `none` keeps the v1 polling-only
   * behaviour; `folder` reads JSON files from a vault folder; `http` polls
   * a user-deployed Cloudflare Worker (not implemented yet, settings only).
   */
  webhookQueueType: "none" | "folder" | "http";

  /** Vault folder watched by FolderQueue (e.g. ".fathom-inbox"). */
  webhookQueueFolder: string;

  /** Base URL of the user's Cloudflare Worker (used by HttpQueue, v2.0-beta). */
  webhookQueueHttpUrl: string;

  /** Bearer secret for the Worker (used by HttpQueue, v2.0-beta). */
  webhookQueueHttpBearer: string;

  /**
   * Fathom-side webhook id created by createWebhook(). Stored so we can
   * delete-and-recreate on URL change. Empty when no webhook is registered.
   */
  registeredWebhookId: string;
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

  webhookQueueType: "none",
  webhookQueueFolder: ".fathom-inbox",
  webhookQueueHttpUrl: "",
  webhookQueueHttpBearer: "",
  registeredWebhookId: "",
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

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc(
        "Verify the API token by calling Fathom's /teams endpoint."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .onClick(async () => {
            if (!this.plugin.settings.apiToken) {
              new Notice("Fathom Sync: enter an API token first.");
              return;
            }
            btn.setDisabled(true).setButtonText("Testing…");
            try {
              const { teamsCount } = await this.plugin
                .getSyncService()
                .testConnection();
              new Notice(
                `Fathom Sync: connection OK (${teamsCount} team${
                  teamsCount === 1 ? "" : "s"
                } visible).`
              );
            } catch (err) {
              const status =
                err instanceof FathomApiError ? err.status : undefined;
              const message =
                status === 401
                  ? "invalid API token"
                  : status === 403
                  ? "token lacks permission"
                  : err instanceof Error
                  ? err.message
                  : "unknown error";
              logger.error("Connection test failed", err);
              new Notice(`Fathom Sync: connection failed — ${message}`);
            } finally {
              btn.setDisabled(false).setButtonText("Test");
            }
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

    // ── Webhook intake (v2) ─────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Webhook intake" });

    containerEl.createEl("p", {
      text:
        "Fathom's polling API only returns meetings you recorded. To also pick up meetings shared with you " +
        "(your own + team + external shares), configure a webhook source below. Meetings flow in near-instantly " +
        "without burning REST API quota.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Source")
      .setDesc(
        "Where to read incoming webhook payloads from. 'Folder' watches a vault folder for JSON files " +
          "(works with any Make/Zapier/n8n flow). 'HTTP' polls a Cloudflare Worker (v2.0-beta)."
      )
      .addDropdown((dd) =>
        dd
          .addOption("none", "Disabled (polling only)")
          .addOption("folder", "Folder (vault)")
          .addOption("http", "HTTP (Cloudflare Worker)")
          .setValue(this.plugin.settings.webhookQueueType)
          .onChange(async (value) => {
            this.plugin.settings.webhookQueueType = value as
              | "none"
              | "folder"
              | "http";
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide relevant fields
          })
      );

    if (this.plugin.settings.webhookQueueType === "folder") {
      new Setting(containerEl)
        .setName("Inbox folder")
        .setDesc(
          "Vault folder where webhook payloads are dropped as .json files. The plugin reads, " +
            "processes, and deletes each file. Create this folder first if it doesn't exist."
        )
        .addText((text) =>
          text
            .setPlaceholder(".fathom-inbox")
            .setValue(this.plugin.settings.webhookQueueFolder)
            .onChange(async (value) => {
              this.plugin.settings.webhookQueueFolder =
                value.trim() || ".fathom-inbox";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Test queue")
        .setDesc("Verify the folder exists and is readable.")
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(async () => {
            btn.setDisabled(true).setButtonText("Testing…");
            try {
              const queue = new FolderQueue(
                this.app,
                this.plugin.settings.webhookQueueFolder
              );
              const health = await queue.healthCheck();
              if (health.ok) {
                const pending = await queue.fetchPending();
                new Notice(
                  `Fathom Sync: queue OK (${pending.length} pending deliver${
                    pending.length === 1 ? "y" : "ies"
                  }).`
                );
              } else {
                new Notice(`Fathom Sync: queue not ready — ${health.reason}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "unknown error";
              logger.error("Queue test failed", err);
              new Notice(`Fathom Sync: queue test failed — ${msg}`);
            } finally {
              btn.setDisabled(false).setButtonText("Test");
            }
          })
        );
    }

    if (this.plugin.settings.webhookQueueType === "http") {
      containerEl.createEl("p", {
        text:
          "Deploy the Worker once via the 'Deploy to Cloudflare' button in the plugin README, " +
          "then paste its URL and the bearer token you set at deploy time below. " +
          "Clicking Connect will register a Fathom webhook pointing at your Worker " +
          "and display the signing secret to paste into your Worker's config.",
        cls: "setting-item-description",
      });

      new Setting(containerEl)
        .setName("Worker URL")
        .setDesc("Base URL of your Cloudflare Worker (no trailing slash).")
        .addText((text) =>
          text
            .setPlaceholder("https://fathom-sync.you.workers.dev")
            .setValue(this.plugin.settings.webhookQueueHttpUrl)
            .onChange(async (value) => {
              this.plugin.settings.webhookQueueHttpUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Bearer token")
        .setDesc("Shared secret you set when deploying the Worker.")
        .addText((text) =>
          text
            .setPlaceholder("…")
            .setValue(this.plugin.settings.webhookQueueHttpBearer)
            .onChange(async (value) => {
              this.plugin.settings.webhookQueueHttpBearer = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Test queue")
        .setDesc("Hit the Worker's /health and /pending endpoints.")
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(async () => {
            btn.setDisabled(true).setButtonText("Testing…");
            try {
              const queue = new HttpQueue(
                this.plugin.settings.webhookQueueHttpUrl,
                this.plugin.settings.webhookQueueHttpBearer
              );
              const health = await queue.healthCheck();
              if (health.ok) {
                const pending = await queue.fetchPending();
                new Notice(
                  `Fathom Sync: Worker OK (${pending.length} pending deliver${
                    pending.length === 1 ? "y" : "ies"
                  }).`
                );
              } else {
                new Notice(`Fathom Sync: Worker not ready — ${health.reason}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "unknown error";
              logger.error("Worker test failed", err);
              new Notice(`Fathom Sync: Worker test failed — ${msg}`);
            } finally {
              btn.setDisabled(false).setButtonText("Test");
            }
          })
        );

      new Setting(containerEl)
        .setName(
          this.plugin.settings.registeredWebhookId
            ? "Re-register webhook"
            : "Connect (register webhook with Fathom)"
        )
        .setDesc(
          this.plugin.settings.registeredWebhookId
            ? `Currently registered as webhook ${this.plugin.settings.registeredWebhookId.slice(0, 8)}…. ` +
                "Click to delete it and create a new one against the current Worker URL."
            : "One-shot: tells Fathom to POST every new meeting (yours + shared) to your Worker. " +
                "Fathom returns a signing secret that you must paste into Cloudflare."
        )
        .addButton((btn) =>
          btn
            .setButtonText(
              this.plugin.settings.registeredWebhookId ? "Re-register" : "Connect"
            )
            .setCta()
            .onClick(async () => {
              if (!this.plugin.settings.apiToken) {
                new Notice("Fathom Sync: enter your API token first.");
                return;
              }
              if (!this.plugin.settings.webhookQueueHttpUrl) {
                new Notice("Fathom Sync: enter your Worker URL first.");
                return;
              }
              btn.setDisabled(true).setButtonText("Working…");
              try {
                const api = this.plugin.getSyncService().api;

                // Delete the existing webhook first so we don't accumulate.
                if (this.plugin.settings.registeredWebhookId) {
                  try {
                    await api.deleteWebhook(
                      this.plugin.settings.registeredWebhookId
                    );
                  } catch (err) {
                    logger.warn("Old webhook delete failed (continuing)", err);
                  }
                }

                const created = await api.createWebhook({
                  destinationUrl: `${this.plugin.settings.webhookQueueHttpUrl.replace(/\/+$/, "")}/webhook`,
                });

                this.plugin.settings.registeredWebhookId = created.id;
                await this.plugin.saveSettings();
                this.display();

                // The signing secret is the highest-sensitivity value in
                // the v2 system — it's what the Worker uses to verify every
                // inbound webhook. We deliberately don't render the full
                // value in the UI toast (visible to screen-capture, shoulder
                // surfing, screen recorders). Instead: copy to clipboard
                // silently, and surface only an obfuscated suffix as proof
                // that *something* was copied. The user pastes once into
                // Cloudflare and the value never appears on screen again.
                let copied = false;
                try {
                  await navigator.clipboard.writeText(created.signing_secret);
                  copied = true;
                } catch (err) {
                  logger.warn("Clipboard write failed", err);
                }

                const tail = created.signing_secret.slice(-6);
                const obfuscated = `…${tail}`;
                const action = copied
                  ? "copied to clipboard"
                  : "clipboard unavailable — see developer console";
                if (!copied) {
                  // Fallback: surface the secret to the console only, NEVER
                  // the UI. Console requires the user to deliberately open
                  // devtools — much narrower exposure than a 60s toast.
                  console.info(
                    "[Fathom Sync] Webhook signing secret (copy this into Cloudflare " +
                      "FATHOM_WEBHOOK_SECRET):",
                    created.signing_secret
                  );
                }
                new Notice(
                  `Fathom Sync: webhook registered (id ${created.id.slice(0, 8)}…). ` +
                    `Signing secret ending in ${obfuscated} ${action}. ` +
                    `Paste it into your Worker's FATHOM_WEBHOOK_SECRET variable.`,
                  20000
                );
              } catch (err) {
                const status =
                  err instanceof FathomApiError ? err.status : undefined;
                const message =
                  status === 401
                    ? "invalid API token"
                    : err instanceof Error
                    ? err.message
                    : "unknown error";
                logger.error("Webhook registration failed", err);
                new Notice(
                  `Fathom Sync: webhook registration failed — ${message}`
                );
              } finally {
                // On success path this.display() destroys + recreates the
                // button, so the label doesn't matter. On the error path
                // we stay on the same DOM node — restore the label too.
                btn
                  .setDisabled(false)
                  .setButtonText(
                    this.plugin.settings.registeredWebhookId
                      ? "Re-register"
                      : "Connect"
                  );
              }
            })
        );
    }

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
