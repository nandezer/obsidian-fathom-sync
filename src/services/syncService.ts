import { Notice } from "obsidian";
import type { FathomSyncSettings } from "../settings";
import type { FathomMeeting, FathomSummary, SyncMode, WebhookPayload } from "../types";
import { FathomApiClient, FathomApiError } from "./fathomApi";
import { DocumentProcessor } from "./documentProcessor";
import { FileSyncService } from "./fileSyncService";
import type { Queue } from "./queues/queue";
import { daysAgoIso } from "../utils/dateUtils";
import { logger } from "../utils/logger";

export interface SyncResult {
  summariesCreated: number;
  transcriptsCreated: number;
  skipped: number;
  errors: number;
}

export class SyncService {
  readonly api: FathomApiClient;
  private readonly processor: DocumentProcessor;

  constructor(
    private readonly settings: FathomSyncSettings,
    private readonly fileSync: FileSyncService,
    private readonly onSettingsChange: (partial: Partial<FathomSyncSettings>) => Promise<void>
  ) {
    this.api = new FathomApiClient(settings.apiToken);
    this.processor = new DocumentProcessor(settings);
  }

  /** Probe the API token by calling /teams. Throws on failure. */
  async testConnection(): Promise<{ teamsCount: number }> {
    const teams = await this.api.listTeams();
    return { teamsCount: Array.isArray(teams) ? teams.length : 0 };
  }

  async performSync(mode: SyncMode): Promise<SyncResult> {
    if (!this.settings.apiToken) {
      new Notice("Fathom Sync: API token not configured. Open settings to add it.");
      throw new Error("Missing API token");
    }

    logger.info(`Starting ${mode} sync…`);
    await this.fileSync.buildCache();

    const result: SyncResult = {
      summariesCreated: 0,
      transcriptsCreated: 0,
      skipped: 0,
      errors: 0,
    };

    const createdAfter =
      mode === "standard" ? daysAgoIso(this.settings.lookbackDays) : undefined;

    // Resume from the last saved cursor on standard sync. Full sync ignores it.
    const startingCursor =
      mode === "standard" && this.settings.lastSyncCursor
        ? this.settings.lastSyncCursor
        : undefined;

    let finalCursor: string | undefined = startingCursor;

    const meetings = await this.api.listAllMeetings(
      {
        teams: this.settings.syncTeams.length ? this.settings.syncTeams : undefined,
        recordedBy: this.settings.recordedByFilter.length
          ? this.settings.recordedByFilter
          : undefined,
        createdAfter,
        includeSummary: false, // we fetch summary individually to avoid payload bloat
        cursor: startingCursor,
      },
      (_page, cursor) => {
        // Remember the most recent next_cursor we saw. After the loop ends
        // this holds either the next page (if pagination was interrupted)
        // or undefined (if we reached the last page cleanly).
        finalCursor = cursor;
      }
    );

    logger.info(`Fetched ${meetings.length} meetings from Fathom.`);

    let fatalError = false;
    for (const meeting of meetings) {
      try {
        await this.processMeeting(meeting, result);
      } catch (err) {
        result.errors++;
        logger.error(`Error processing meeting ${meeting.recording_id}:`, err);
        if (err instanceof FathomApiError && err.status === 401) {
          new Notice("Fathom Sync: invalid API token. Check your settings.");
          fatalError = true;
          throw err;
        }
      }
    }

    // Persist cursor for next incremental run (only for standard mode and
    // only if we didn't bail with a fatal error). When `finalCursor` is
    // undefined the API has no more pages — clear the cursor so the next
    // sync starts a fresh lookback window.
    if (mode === "standard" && !fatalError) {
      await this.onSettingsChange({ lastSyncCursor: finalCursor ?? "" });
    }

    logger.info(
      `Sync complete. Summaries: ${result.summariesCreated}, ` +
        `Transcripts: ${result.transcriptsCreated}, ` +
        `Skipped: ${result.skipped}, Errors: ${result.errors}`
    );

    return result;
  }

  /**
   * Drain a webhook queue. Each payload writes summary + transcript notes
   * straight from inline content — no GET round-trips against Fathom, which
   * is the whole point of the webhook path.
   *
   * Errors on individual payloads are logged but don't abort the drain;
   * successfully-written deliveries are still acked so we don't get stuck.
   */
  async drainQueue(queue: Queue): Promise<SyncResult> {
    logger.info(`Draining queue ${queue.label}…`);
    await this.fileSync.buildCache();

    const result: SyncResult = {
      summariesCreated: 0,
      transcriptsCreated: 0,
      skipped: 0,
      errors: 0,
    };

    const pending = await queue.fetchPending();
    if (pending.length === 0) {
      logger.info(`Queue ${queue.label} is empty.`);
      return result;
    }
    logger.info(`Queue ${queue.label}: ${pending.length} pending deliveries.`);

    const processed: string[] = [];
    for (const payload of pending) {
      try {
        await this.processWebhookPayload(payload, result);
        processed.push(payload.delivery_id);
      } catch (err) {
        result.errors++;
        logger.error(
          `Error processing delivery ${payload.delivery_id} ` +
            `(meeting ${payload.meeting?.recording_id}):`,
          err
        );
      }
    }

    if (processed.length > 0) {
      await queue.ack(processed);
    }

    logger.info(
      `Queue drain complete. Summaries: ${result.summariesCreated}, ` +
        `Transcripts: ${result.transcriptsCreated}, ` +
        `Skipped: ${result.skipped}, Errors: ${result.errors}`
    );

    return result;
  }

  /**
   * Process one webhook payload. Mirrors {@link processMeeting} but reads
   * summary and transcript from the payload itself — Fathom packs them into
   * `default_summary` and `transcript` when the webhook is registered with
   * `include_summary: true` / `include_transcript: true`.
   *
   * If the payload is missing a field we wanted (e.g. transcript was still
   * processing when the webhook fired), we fall back to a REST GET. This
   * keeps the "no fetch" fast path while not silently dropping content.
   */
  private async processWebhookPayload(
    payload: WebhookPayload,
    result: SyncResult
  ): Promise<void> {
    const meeting = payload.meeting;
    if (!meeting || typeof meeting.recording_id !== "number") {
      throw new Error(
        `Webhook payload ${payload.delivery_id} has no usable meeting record.`
      );
    }

    const summaryAlreadyExists = this.fileSync.has(meeting.recording_id, "summary");
    const transcriptAlreadyExists = this.fileSync.has(meeting.recording_id, "transcript");

    const needSummary = this.settings.syncSummaries && !summaryAlreadyExists;
    const needTranscript = this.settings.syncTranscripts && !transcriptAlreadyExists;

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    const filename = this.processor.buildFilename(meeting);

    if (needSummary) {
      const summary = await this.summaryFromPayload(meeting);
      const transcriptPath = this.settings.syncTranscripts
        ? `${this.settings.transcriptFolder}/${filename}`
        : undefined;
      const note = this.processor.buildSummaryNote(meeting, summary, transcriptPath);
      const wrote = await this.fileSync.saveNote(meeting.recording_id, "summary", note);
      if (wrote) result.summariesCreated++;
      else result.skipped++;
    }

    if (needTranscript) {
      const segments =
        meeting.transcript && meeting.transcript.length > 0
          ? meeting.transcript
          : await this.api.getTranscript(meeting.recording_id);
      const summaryPath = `${this.settings.summaryFolder}/${filename}`;
      const note = this.processor.buildTranscriptNote(meeting, segments, summaryPath);
      const wrote = await this.fileSync.saveNote(meeting.recording_id, "transcript", note);
      if (wrote) result.transcriptsCreated++;
      else result.skipped++;
    }
  }

  /**
   * Prefer the inline summary from the webhook payload; only fall back to
   * the REST API when the payload didn't carry one. Throws via the API path
   * if neither source has it (cache-poisoning guard from CLAUDE.md).
   */
  private async summaryFromPayload(meeting: FathomMeeting): Promise<FathomSummary> {
    if (
      meeting.default_summary &&
      typeof meeting.default_summary.markdown_formatted === "string" &&
      meeting.default_summary.markdown_formatted.length > 0
    ) {
      return meeting.default_summary;
    }
    return this.api.getSummary(meeting.recording_id);
  }

  private async processMeeting(meeting: FathomMeeting, result: SyncResult): Promise<void> {
    const summaryAlreadyExists = this.fileSync.has(meeting.recording_id, "summary");
    const transcriptAlreadyExists = this.fileSync.has(meeting.recording_id, "transcript");

    const needSummary = this.settings.syncSummaries && !summaryAlreadyExists;
    const needTranscript = this.settings.syncTranscripts && !transcriptAlreadyExists;

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    const filename = this.processor.buildFilename(meeting);

    if (needSummary) {
      const summary = await this.api.getSummary(meeting.recording_id);
      const transcriptPath = this.settings.syncTranscripts
        ? `${this.settings.transcriptFolder}/${filename}`
        : undefined;
      const note = this.processor.buildSummaryNote(meeting, summary, transcriptPath);
      const wrote = await this.fileSync.saveNote(meeting.recording_id, "summary", note);
      if (wrote) result.summariesCreated++;
      else result.skipped++;
    }

    if (needTranscript) {
      const segments = await this.api.getTranscript(meeting.recording_id);
      const summaryPath = `${this.settings.summaryFolder}/${filename}`;
      const note = this.processor.buildTranscriptNote(meeting, segments, summaryPath);
      const wrote = await this.fileSync.saveNote(meeting.recording_id, "transcript", note);
      if (wrote) result.transcriptsCreated++;
      else result.skipped++;
    }
  }
}
