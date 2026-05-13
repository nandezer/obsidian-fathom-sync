import { Notice } from "obsidian";
import type { FathomSyncSettings } from "../settings";
import type { FathomMeeting, SyncMode } from "../types";
import { FathomApiClient, FathomApiError } from "./fathomApi";
import { DocumentProcessor } from "./documentProcessor";
import { FileSyncService } from "./fileSyncService";
import { daysAgoIso } from "../utils/dateUtils";
import { logger } from "../utils/logger";

export interface SyncResult {
  summariesCreated: number;
  transcriptsCreated: number;
  skipped: number;
  errors: number;
}

export class SyncService {
  private readonly api: FathomApiClient;
  private readonly processor: DocumentProcessor;

  constructor(
    private readonly settings: FathomSyncSettings,
    private readonly fileSync: FileSyncService,
    private readonly onSettingsChange: (partial: Partial<FathomSyncSettings>) => Promise<void>
  ) {
    this.api = new FathomApiClient(settings.apiToken);
    this.processor = new DocumentProcessor(settings);
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

    let lastSeenCursor: string | undefined;

    const meetings = await this.api.listAllMeetings(
      {
        teams: this.settings.syncTeams.length ? this.settings.syncTeams : undefined,
        recordedBy: this.settings.recordedByFilter.length
          ? this.settings.recordedByFilter
          : undefined,
        createdAfter,
        includeSummary: false, // we fetch summary individually to avoid payload bloat
      },
      (_page, cursor) => {
        lastSeenCursor = cursor;
      }
    );

    logger.info(`Fetched ${meetings.length} meetings from Fathom.`);

    for (const meeting of meetings) {
      try {
        await this.processMeeting(meeting, result);
      } catch (err) {
        result.errors++;
        logger.error(`Error processing meeting ${meeting.recording_id}:`, err);
        if (err instanceof FathomApiError && err.status === 401) {
          new Notice("Fathom Sync: invalid API token. Check your settings.");
          throw err;
        }
      }
    }

    // Persist cursor for next incremental run (only for standard mode)
    if (mode === "standard" && lastSeenCursor !== undefined) {
      await this.onSettingsChange({ lastSyncCursor: lastSeenCursor });
    }

    logger.info(
      `Sync complete. Summaries: ${result.summariesCreated}, ` +
        `Transcripts: ${result.transcriptsCreated}, ` +
        `Skipped: ${result.skipped}, Errors: ${result.errors}`
    );

    return result;
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
