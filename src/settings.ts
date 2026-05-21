import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
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

    // Header: name + version label + manual reload. Surfaces the actual
    // running version so users can confirm a fresh bundle loaded (the
    // Community Plugins list caches the version label and can lag).
    const header = containerEl.createDiv({
      attr: { style: "display: flex; align-items: baseline; gap: 0.75em;" },
    });
    header.createEl("h2", { text: "Fathom Sync" });
    header.createEl("span", {
      text: `v${this.plugin.manifest.version}`,
      attr: { style: "font-size: 0.85em; color: var(--text-muted);" },
    });
    header.createEl("button", {
      text: "Reload plugin",
      attr: { style: "margin-left: auto; font-size: 0.85em;" },
    }).onclick = () => {
      const id = this.plugin.manifest.id;
      // Obsidian exposes plugin manager via app.plugins.disablePlugin/
      // enablePlugin. This is a public API but not in the published .d.ts;
      // we cast to any narrowly here.
      const plugins = (this.app as unknown as {
        plugins: {
          disablePlugin(id: string): Promise<void>;
          enablePlugin(id: string): Promise<void>;
        };
      }).plugins;
      // Close the Settings modal first. disablePlugin() tears down this
      // FathomSyncSettingTab instance — if we keep awaiting from inside it,
      // the containerEl unmounts mid-flight and the user sees a blank pane.
      // Closing up front lets Obsidian re-register the fresh tab cleanly;
      // the user reopens Settings → Fathom Sync to see the reloaded UI.
      const setting = (this.app as unknown as {
        setting?: { close?: () => void };
      }).setting;
      setting?.close?.();
      new Notice("Fathom Sync: reloading…");
      // Defer to next tick so the modal close completes before teardown.
      setTimeout(async () => {
        try {
          await plugins.disablePlugin(id);
          await plugins.enablePlugin(id);
          new Notice("Fathom Sync: reloaded.");
        } catch (err) {
          new Notice(
            `Fathom Sync: reload failed — ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }, 0);
    };

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
            const newType = value as "none" | "folder" | "http";
            this.plugin.settings.webhookQueueType = newType;
            await this.plugin.saveSettings();
            // Toggle visibility of pre-rendered blocks. Avoids the race
            // where this.display() doesn't actually re-run before the user
            // looks for the new fields (Obsidian's settings panel re-render
            // can be skipped if the user is mid-interaction with a focused
            // input).
            folderBlock.style.display = newType === "folder" ? "" : "none";
            httpBlock.style.display = newType === "http" ? "" : "none";
          })
      );

    // Pre-create both blocks; visibility is driven by the dropdown above.
    // We rendered them lazily before, which meant switching Source from
    // Folder to HTTP didn't show the HTTP fields until the user manually
    // toggled the plugin off/on. Render-always-toggle-CSS sidesteps that.
    const folderBlock = containerEl.createDiv();
    folderBlock.style.display =
      this.plugin.settings.webhookQueueType === "folder" ? "" : "none";
    const httpBlock = containerEl.createDiv();
    httpBlock.style.display =
      this.plugin.settings.webhookQueueType === "http" ? "" : "none";

    {
      new Setting(folderBlock)
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

      new Setting(folderBlock)
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

    {
      httpBlock.createEl("p", {
        text:
          "Deploy the Worker once via the 'Deploy to Cloudflare' button in the plugin README, " +
          "then paste its URL and the bearer token you set at deploy time below. " +
          "Clicking Connect will register a Fathom webhook pointing at your Worker " +
          "and display the signing secret to paste into your Worker's config.",
        cls: "setting-item-description",
      });

      // Debounce re-rendering: as the user types Worker URL or Bearer the
      // Connect button below should un-grey once both are non-empty. We
      // re-render the whole panel on blur via a short debounce so we don't
      // re-render after every keystroke (which would lose focus).
      let connectGateTimer: number | null = null;
      const refreshConnectGate = () => {
        if (connectGateTimer !== null) window.clearTimeout(connectGateTimer);
        connectGateTimer = window.setTimeout(() => this.display(), 600);
      };

      new Setting(httpBlock)
        .setName("Worker URL")
        .setDesc("Base URL of your Cloudflare Worker (no trailing slash).")
        .addText((text) =>
          text
            .setPlaceholder("https://fathom-sync.you.workers.dev")
            .setValue(this.plugin.settings.webhookQueueHttpUrl)
            .onChange(async (value) => {
              this.plugin.settings.webhookQueueHttpUrl = value.trim();
              await this.plugin.saveSettings();
              refreshConnectGate();
            })
        );

      new Setting(httpBlock)
        .setName("Bearer token")
        .setDesc("Shared secret you set when deploying the Worker.")
        .addText((text) => {
          // Mask so the value isn't readable to anyone glancing at the
          // user's screen / screen-share / shoulder-surfing. Doesn't
          // protect against a determined attacker with local FS access.
          text.inputEl.type = "password";
          text
            .setPlaceholder("…")
            .setValue(this.plugin.settings.webhookQueueHttpBearer)
            .onChange(async (value) => {
              this.plugin.settings.webhookQueueHttpBearer = value.trim();
              await this.plugin.saveSettings();
              refreshConnectGate();
            });
        });

      new Setting(httpBlock)
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

      // Connect button: greyed out with an explicit hint when prerequisites
      // aren't met, so users don't click into a generic "enter X first"
      // Notice without knowing which field needed setting.
      const missing: string[] = [];
      if (!this.plugin.settings.apiToken.trim()) missing.push("API token");
      if (!this.plugin.settings.webhookQueueHttpUrl.trim()) missing.push("Worker URL");
      if (!this.plugin.settings.webhookQueueHttpBearer.trim()) missing.push("Bearer token");
      const blockerDesc =
        missing.length > 0
          ? `Disabled — fill in: ${missing.join(", ")}.`
          : null;

      new Setting(httpBlock)
        .setName(
          this.plugin.settings.registeredWebhookId
            ? "Re-register webhook"
            : "Connect (register webhook with Fathom)"
        )
        .setDesc(
          blockerDesc ??
            (this.plugin.settings.registeredWebhookId
              ? `Currently registered as webhook ${this.plugin.settings.registeredWebhookId.slice(0, 8)}…. ` +
                  "Click to delete it and create a new one against the current Worker URL."
              : "One-shot: tells Fathom to POST every new meeting (yours + shared) to your Worker. " +
                  "Fathom returns a signing secret that you must paste into Cloudflare.")
        )
        .addButton((btn) => {
          btn
            .setButtonText(
              this.plugin.settings.registeredWebhookId ? "Re-register" : "Connect"
            )
            .setCta()
            .onClick(() => this.handleConnectWebhook(btn));
          if (missing.length > 0) btn.setDisabled(true);
        });

      // Escape hatch: delete a specific Fathom webhook by id. Useful when an
      // older plugin version crashed mid-Connect and left orphans on the
      // server-side. Fathom doesn't expose GET /webhooks so we can't list
      // them automatically — the user pastes the id from a log line or
      // a Fathom support reply.
      let purgeInput = "";
      new Setting(httpBlock)
        .setName("Purge orphan webhook")
        .setDesc(
          "If an earlier failed Connect left a stale webhook on Fathom's side, " +
            "paste its id here to delete it. The plugin's saved id (if any) is " +
            "deleted by Re-register automatically — this field is only for cleanup."
        )
        .addText((text) =>
          text
            .setPlaceholder("e.g. WgLFyxyMpbQuUYF2")
            .onChange((value) => {
              purgeInput = value;
            })
        )
        .addButton((btn) =>
          btn
            .setButtonText("Delete")
            .setWarning()
            .onClick(() => this.handlePurgeWebhook(btn, purgeInput))
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

    // Import a single meeting from a Fathom URL or recording id. Sits inside
    // "Actions" because it's a one-off trigger, not a configuration setting.
    let importInputEl: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName("Import from link")
      .setDesc(
        "Paste a Fathom recording ID or meeting URL to import a single meeting. " +
          "If the meeting isn't in your account's list, a stub note is created " +
          "with today's date and no attendee metadata."
      )
      .addText((text) => {
        text.setPlaceholder("145099015 or fathom.video/calls/…");
        importInputEl = text.inputEl;
        // Make the input wide enough to hold a full share URL without the
        // user having to scroll inside the field.
        text.inputEl.style.width = "20em";
      })
      .addButton((btn) =>
        btn
          .setButtonText("Import")
          .setCta()
          .onClick(async () => {
            // Don't guard on empty here — pass through to the parser so the
            // user sees a single source of truth for parse feedback (via the
            // `empty` ParseFailure branch in noticeImportError).
            const value = importInputEl?.value ?? "";
            btn.setDisabled(true).setButtonText("Importing…");
            try {
              await this.plugin.importByLink(value);
              // Clear only on success — preserve on failure so the user can
              // edit/retry without re-pasting.
              if (importInputEl) importInputEl.value = "";
            } catch (err) {
              // runImport / importByLink have already emitted a directed
              // Notice. Just log for the console reader.
              logger.error("Import failed", err);
            } finally {
              btn.setDisabled(false).setButtonText("Import");
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

  /**
   * Register (or re-register) a webhook with Fathom and stash the signing
   * secret on the user's clipboard. Extracted from the settings UI block
   * so it stays under the project's function-length budget and is easier
   * to reason about as a self-contained operation.
   */
  private async handleConnectWebhook(btn: ButtonComponent): Promise<void> {
    if (!this.plugin.settings.apiToken) {
      new Notice("Fathom Sync: enter your API token first.");
      return;
    }
    if (!this.plugin.settings.webhookQueueHttpUrl) {
      new Notice("Fathom Sync: enter your Worker URL first.");
      return;
    }

    btn.setDisabled(true).setButtonText("Working…");
    let createdId: string | null = null;
    try {
      const created = await this.registerWebhook();
      createdId = created.id;

      // Persist the new id BEFORE anything else that could throw. If
      // saveSettings or surfaceSigningSecret then fails, we roll back by
      // deleting the webhook so we don't leak orphans on Fathom's side
      // (which can't be listed via API and accumulate forever).
      this.plugin.settings.registeredWebhookId = created.id;
      await this.plugin.saveSettings();

      // Past this point a thrown error means we already persisted the id,
      // so rollback is only correct for failures BEFORE this line.
      createdId = null;

      this.display();
      await this.surfaceSigningSecret(created.id, created.signing_secret);
    } catch (err) {
      if (createdId) {
        // Best-effort rollback. If this also fails we're stuck with a
        // server-side orphan, but the user at least won't end up with the
        // local state pointing at a webhook they can't see.
        logger.warn(
          `Rolling back orphan webhook ${createdId} after failure mid-flow`
        );
        try {
          await this.plugin.getSyncService().api.deleteWebhook(createdId);
        } catch (rollbackErr) {
          logger.error(
            `Rollback delete failed for ${createdId} — orphan webhook left on Fathom. ` +
              "Use 'Purge orphan webhook' in settings.",
            rollbackErr
          );
        }
        this.plugin.settings.registeredWebhookId = "";
        await this.plugin.saveSettings();
      }

      const status = err instanceof FathomApiError ? err.status : undefined;
      const message =
        status === 401
          ? "invalid API token"
          : err instanceof Error
          ? err.message
          : "unknown error";
      logger.error("Webhook registration failed", err);
      new Notice(`Fathom Sync: webhook registration failed — ${message}`);
    } finally {
      // On success this.display() destroys + recreates the button so this
      // is harmless. On error we stay on the same DOM node — restore label.
      btn
        .setDisabled(false)
        .setButtonText(
          this.plugin.settings.registeredWebhookId ? "Re-register" : "Connect"
        );
    }
  }

  /**
   * Manual escape hatch for deleting a webhook by its Fathom ID. Used when
   * Connect crashed mid-flow on an earlier plugin version and left orphans
   * on the Fathom side. Fathom does not expose GET /webhooks, so the user
   * has to find the id from logs (the failure message shows it) or from
   * Fathom support. Cheap to add and easy to remove if Fathom ever
   * publishes a list endpoint.
   */
  private async handlePurgeWebhook(
    btn: ButtonComponent,
    webhookId: string
  ): Promise<void> {
    const trimmed = webhookId.trim();
    if (!trimmed) {
      new Notice("Fathom Sync: paste a webhook id first.");
      return;
    }
    btn.setDisabled(true).setButtonText("Deleting…");
    try {
      await this.plugin.getSyncService().api.deleteWebhook(trimmed);
      new Notice(`Fathom Sync: webhook ${trimmed.slice(0, 8)}… deleted.`);
    } catch (err) {
      const status = err instanceof FathomApiError ? err.status : undefined;
      const message =
        status === 404
          ? "not found (already deleted?)"
          : err instanceof Error
          ? err.message
          : "unknown error";
      new Notice(`Fathom Sync: delete failed — ${message}`);
      logger.error(`Purge failed for ${trimmed}`, err);
    } finally {
      btn.setDisabled(false).setButtonText("Delete");
    }
  }

  /**
   * Delete any prior webhook (best-effort) and create a new one pointing
   * at the configured Worker URL. The /webhook path is appended here so
   * users don't have to remember to include it in the setting.
   */
  private async registerWebhook(): Promise<{ id: string; signing_secret: string }> {
    const api = this.plugin.getSyncService().api;
    if (this.plugin.settings.registeredWebhookId) {
      try {
        await api.deleteWebhook(this.plugin.settings.registeredWebhookId);
      } catch (err) {
        logger.warn("Old webhook delete failed (continuing)", err);
      }
    }
    return api.createWebhook({
      destinationUrl: `${this.plugin.settings.webhookQueueHttpUrl.replace(/\/+$/, "")}/webhook`,
    });
  }

  /**
   * The signing secret is the highest-sensitivity value in v2 — it's the
   * HMAC key the Worker uses to verify every inbound webhook. We never
   * render it in the UI. Strategy:
   *  1. Try clipboard write. If it succeeds, show only the last 6 chars
   *     plus "(copied to clipboard)" in a 20-second Notice.
   *  2. If clipboard fails (Linux without xclip, sandboxed contexts),
   *     log the full secret via the project logger so it lands in the
   *     devtools console — narrower exposure than a UI toast, and the
   *     user must deliberately open devtools to see it.
   */
  private async surfaceSigningSecret(
    webhookId: string,
    secret: string
  ): Promise<void> {
    // Defensive: createWebhook should already have rejected an empty/missing
    // secret, but guard here too so a future regression can't crash the UI
    // mid-flow and leave the user wondering whether the webhook was made.
    if (typeof secret !== "string" || secret.length === 0) {
      logger.error(
        "Webhook was registered but Fathom returned no signing secret. " +
          "Webhook id:",
        webhookId
      );
      new Notice(
        `Fathom Sync: webhook registered (id ${webhookId.slice(0, 8)}…) but ` +
          `Fathom did not return a signing secret. Delete the webhook and ` +
          `try again, or check the developer console.`,
        20000
      );
      return;
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(secret);
      copied = true;
    } catch (err) {
      logger.warn("Clipboard write failed", err);
    }
    if (!copied) {
      logger.warn(
        "Webhook signing secret (paste into Cloudflare FATHOM_WEBHOOK_SECRET):",
        secret
      );
    }

    const obfuscated = `…${secret.slice(-6)}`;
    const action = copied
      ? "copied to clipboard"
      : "clipboard unavailable — see developer console";
    new Notice(
      `Fathom Sync: webhook registered (id ${webhookId.slice(0, 8)}…). ` +
        `Signing secret ending in ${obfuscated} ${action}. ` +
        `Paste it into your Worker's FATHOM_WEBHOOK_SECRET variable.`,
      20000
    );
  }
}
