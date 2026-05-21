import { Notice } from "obsidian";
import type { FathomSyncSettings } from "../settings";
import type {
  FathomInvitee,
  FathomMeeting,
  FathomSummary,
  FathomTranscriptSegment,
  SyncMode,
  WebhookPayload,
} from "../types";
import {
  FathomApiClient,
  FathomApiError,
  type ScrapedCall,
  type ShareScrapeResult,
} from "./fathomApi";
import { DocumentProcessor } from "./documentProcessor";
import { FileSyncService } from "./fileSyncService";
import type { Queue } from "./queues/queue";
import { daysAgoIso } from "../utils/dateUtils";
import { logger } from "../utils/logger";
import type { ParseFailure, ParsedFathomReference } from "../utils/fathomUrl";

export interface SyncResult {
  summariesCreated: number;
  transcriptsCreated: number;
  skipped: number;
  errors: number;
}

/** Thrown by `importByReference` when the input fails to parse. */
export class UrlParseError extends Error {
  constructor(public readonly reason: ParseFailure) {
    super(`URL parse failed: ${reason}`);
    this.name = "UrlParseError";
    // ES2018 transpile of `class extends Error` loses the prototype chain;
    // `instanceof` then returns false in the compiled output. Reset it so
    // `noticeImportError`'s `instanceof UrlParseError` branch actually fires.
    Object.setPrototypeOf(this, UrlParseError.prototype);
  }
}

/**
 * Thrown by `importByReference` when the input is well-formed but the
 * referenced meeting can't be resolved. `kind` distinguishes "share token
 * not in /meetings list" (no fallback possible) from "recording id has no
 * accessible content" (theoretical — would surface from a 4xx, not this).
 */
export class MeetingNotFoundError extends Error {
  constructor(public readonly kind: "share_token" | "recording_id") {
    super(`Meeting not found via ${kind}`);
    this.name = "MeetingNotFoundError";
    Object.setPrototypeOf(this, MeetingNotFoundError.prototype);
  }
}

/**
 * Thrown when a share token resolved to a real recording id, but Fathom's
 * REST API refuses to serve summary/transcript for that id with the user's
 * token. This is Fathom's permission model: public share links are
 * browser-viewable by anyone with the URL, but the REST API only grants
 * access to recordings inside the user's workspace. Externally-shared
 * recordings show up as 404 on `/recordings/{id}/summary`.
 */
export class SharedRecordingNotAccessibleError extends Error {
  constructor(public readonly recordingId: number) {
    super(
      `Recording ${recordingId} resolved from share link but is not accessible via the REST API for this account.`
    );
    this.name = "SharedRecordingNotAccessibleError";
    Object.setPrototypeOf(this, SharedRecordingNotAccessibleError.prototype);
  }
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
   * Import a single meeting from a user-supplied URL or recording id. Two-tier
   * resolution: try the user's `/meetings` list first (rich metadata via the
   * existing `processMeeting` path), then fall back to a stub-metadata note
   * built around the raw summary/transcript content when only a recording id
   * is known. Share tokens cannot fall back — without a recording id there's
   * no endpoint to call.
   */
  async importByReference(ref: ParsedFathomReference): Promise<SyncResult> {
    if (!this.settings.apiToken) {
      new Notice("Fathom Sync: API token not configured. Open settings to add it.");
      throw new Error("Missing API token");
    }

    if (!this.settings.syncSummaries && !this.settings.syncTranscripts) {
      new Notice(
        "Fathom Sync: enable summaries or transcripts in settings before importing."
      );
      throw new Error("No content to import");
    }

    if (ref.kind === "unknown") {
      throw new UrlParseError(ref.reason);
    }

    await this.fileSync.buildCache();

    const result: SyncResult = {
      summariesCreated: 0,
      transcriptsCreated: 0,
      skipped: 0,
      errors: 0,
    };

    if (ref.kind === "recording_id") {
      const found = await this.findMeeting((m) => m.recording_id === ref.id);
      if (found) {
        logger.info(`Import: recording_id ${ref.id} found in /meetings list.`);
        await this.processMeeting(found, result);
      } else {
        logger.info(
          `Import: recording_id ${ref.id} not in /meetings list — using stub path.`
        );
        await this.processStubImport(ref.id, result);
      }
      return result;
    }

    // share_token branch. Hand off to `processSharedTokenImport`, which
    // scrapes the share page for a numeric recording_id and then dispatches
    // through three fallback paths (workspace meeting / API stub / Inertia
    // scrape). We deliberately do NOT pre-search /meetings here — the share
    // token never matches `lastUrlSegment(meeting.url)` because Fathom
    // always serves the canonical `/calls/{id}` URL there, so the call was
    // pure dead weight and an avoidable failure surface for /meetings 5xx.
    await this.processSharedTokenImport(ref.token, ref.canonicalUrl, result);
    return result;
  }

  /**
   * Page through `/meetings` and return the first match. Uses
   * `listAllMeetings`'s `onPage` early-stop contract (returning `false` stops
   * pagination).
   *
   * Applies the user's configured `syncTeams` / `recordedByFilter` filters,
   * same as `performSync`. Originally the plan said "no filters — broadest
   * possible search", but Fathom's `/meetings` endpoint returns HTTP 500
   * (HTML error page) when an account has many recordings and no filters are
   * passed. So we narrow the search to what we know Fathom can serve.
   *
   * Consequence: for `recording_id` inputs outside the user's filters, this
   * returns `undefined` and the caller falls through to `processStubImport`
   * (good — that's exactly the case the stub path was designed for). For
   * `share_token` inputs outside the user's filters, the caller surfaces a
   * `MeetingNotFoundError` and the user is told to broaden their filter or
   * paste the recording id.
   */
  private async findMeeting(
    predicate: (m: FathomMeeting) => boolean
  ): Promise<FathomMeeting | undefined> {
    let found: FathomMeeting | undefined;
    await this.api.listAllMeetings(
      {
        teams: this.settings.syncTeams.length ? this.settings.syncTeams : undefined,
        recordedBy: this.settings.recordedByFilter.length
          ? this.settings.recordedByFilter
          : undefined,
      },
      (meetings) => {
        const hit = meetings.find(predicate);
        if (hit) {
          found = hit;
          return false; // stop pagination
        }
        return undefined; // continue
      }
    );
    return found;
  }

  /**
   * Synthesise a minimal FathomMeeting around a recording id and call the
   * shared `persistNotePair` primitive. Used when the user pastes a link to a
   * meeting that their `/meetings` list excludes (e.g. excluded by their
   * `recordedByFilter` or `syncTeams` settings) but which their token can
   * still fetch via `getSummary`/`getTranscript`.
   *
   * `import_source: pasted-link` frontmatter tag is intentionally absent from
   * the FileSyncService dedup key — `buildCache` filters on
   * `synced_by: fathom-sync` only. The tag is for human grep, not for cache
   * logic.
   *
   * `getSummary` throws on empty/unknown shape (the cache-poisoning guard
   * from CLAUDE.md). We deliberately do NOT catch here — the throw must
   * propagate so we never write a stub note for a recording that has no
   * real summary content.
   */
  private async processStubImport(id: number, result: SyncResult): Promise<void> {
    // RECONSTRUCTED canonical URL — never the raw paste. buildSummaryNote
    // emits `[View recording](${meeting.url})` outside the YAML block, so a
    // hostile URL would become a live Markdown link.
    return this.processStubImportWithUrl(
      id,
      `https://fathom.video/calls/${id}`,
      result,
      "pasted-link"
    );
  }

  /**
   * Generalised stub-import path. `url` is the link shown in the note's
   * "View recording" body line (typically the share URL when the import
   * came from a /share/ token, or the canonical /calls/ URL otherwise).
   * `importSource` becomes the `import_source` frontmatter tag.
   */
  private async processStubImportWithUrl(
    id: number,
    url: string,
    result: SyncResult,
    importSource: "pasted-link" | "shared-link"
  ): Promise<void> {
    const needSummary = this.settings.syncSummaries && !this.fileSync.has(id, "summary");
    const needTranscript =
      this.settings.syncTranscripts && !this.fileSync.has(id, "transcript");

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    const stub: FathomMeeting = {
      recording_id: id,
      title: `Imported Fathom meeting ${id}`,
      meeting_title: "",
      url,
      created_at: new Date().toISOString(),
      recorded_by: { name: "", email: "", email_domain: "" },
      calendar_invitees: [],
    };

    const summary = needSummary ? await this.api.getSummary(id) : null;
    const segments = needTranscript ? await this.api.getTranscript(id) : null;

    await this.persistNotePair(stub, summary, segments, result, {
      import_source: importSource,
    });
  }

  /**
   * Resolve a share token by scraping the public share page (Fathom's REST
   * API does not expose a token resolver), then dispatch through three
   * fallback paths in order:
   *
   *  1. **Workspace path** — recording is in the user's filtered /meetings
   *     list → process as a normal meeting (rich metadata, full API content).
   *  2. **API stub path** — recording_id is API-accessible to the user's
   *     token (workspace-shared) → process as a stub with API-fetched
   *     summary + transcript.
   *  3. **Inertia-scrape path** — recording is only publicly share-viewable,
   *     not API-accessible. Build the note from the scraped Inertia
   *     metadata + the share page's signed "copy transcript" URL.
   *
   * If none of those work (token revoked or Fathom changed the share
   * format), throw `SharedRecordingNotAccessibleError` so the UI explains
   * the situation rather than a generic 404.
   */
  private async processSharedTokenImport(
    token: string,
    canonicalUrl: string,
    result: SyncResult
  ): Promise<void> {
    const scrape = await this.api.resolveShareToken(token);
    if (scrape === null) {
      throw new MeetingNotFoundError("share_token");
    }
    const { recordingId, call: scrapedCall, transcriptUrl } = scrape;
    logger.info(
      `Import: share token ${token.slice(0, 8)}… resolved to recording_id ${recordingId}.`
    );

    // Path 1: workspace
    const found = await this.findMeeting((m) => m.recording_id === recordingId);
    if (found) {
      // Replace meeting.url with the share URL so the note's "View recording"
      // link works for anyone who has the share link (the /calls/ URL would
      // require workspace access). Other fields stay authoritative.
      const meetingWithShareUrl: FathomMeeting = { ...found, url: canonicalUrl };
      await this.processMeeting(meetingWithShareUrl, result);
      return;
    }

    // Path 2: API stub. May 404 (public-share-only, not in account).
    try {
      await this.processStubImportWithUrl(
        recordingId,
        canonicalUrl,
        result,
        "shared-link"
      );
      return;
    } catch (err) {
      if (!(err instanceof FathomApiError) || (err.status !== 404 && err.status !== 403)) {
        throw err;
      }
      // Fall through to scraped path.
      logger.info(
        `Import: API access denied for recording ${recordingId}; falling back to Inertia scrape.`
      );
    }

    // Path 3: scraped Inertia data. Requires that we extracted props.call
    // from the share page — if the page shape changed, we have nothing.
    if (scrapedCall === null) {
      throw new SharedRecordingNotAccessibleError(recordingId);
    }
    await this.processScrapedSharedImport(scrape, canonicalUrl, result);
  }

  /**
   * Build a note from Fathom share-page-scraped data. Pulls together:
   *   - `props.call` metadata (title, host, duration, topic, company)
   *   - `copyTranscriptUrl` → the same transcript Fathom's UI renders
   *   - `clipboardActionItemsUrl` → AI-extracted action items
   *   - Speculative Inertia partial-data probe for an AI summary prop
   *     (failures are silent; we drop down to placeholder body if so)
   *
   * Notes written this way are tagged `import_source: shared-link-scraped`
   * so the user can grep them later. The `recording_id` is the real Fathom
   * id, so dedup works correctly.
   */
  private async processScrapedSharedImport(
    scrape: ShareScrapeResult,
    canonicalUrl: string,
    result: SyncResult
  ): Promise<void> {
    const scrapedCall = scrape.call;
    if (scrapedCall === null) {
      throw new SharedRecordingNotAccessibleError(scrape.recordingId);
    }
    const id = scrapedCall.id;

    const needSummary = this.settings.syncSummaries && !this.fileSync.has(id, "summary");
    const needTranscript =
      this.settings.syncTranscripts && !this.fileSync.has(id, "transcript");

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    // Fetch transcript FIRST so we can derive attendees from speaker names.
    // The Inertia `call` object exposes only the host, no invitee list — but
    // the transcript names everyone who spoke, which is a usable substitute.
    // Force-fetch even when `needTranscript` is false, since we need it for
    // attendee derivation (cheap one-off fetch — share signed URLs use their
    // own auth). Cap the fetch on settings only for the WRITE decision.
    let transcriptText: string | null = null;
    let segments: FathomTranscriptSegment[] | null = null;
    if (scrape.transcriptUrl) {
      try {
        transcriptText = await this.api.fetchSignedShareResource(scrape.transcriptUrl);
        segments = parseFathomCopyTranscript(transcriptText);
      } catch (err) {
        logger.warn(
          `Scraped transcript fetch failed for recording ${id}; continuing without transcript:`,
          err
        );
        segments = needTranscript ? [] : null;
      }
    } else if (needTranscript) {
      segments = [];
    }

    const attendees = deriveAttendeesFromSegments(segments);

    const recordedByName =
      scrapedCall.byline ||
      (scrapedCall.hostEmail ? scrapedCall.hostEmail.split("@")[0] : "Unknown");
    const hostDomain = scrapedCall.hostEmail.includes("@")
      ? scrapedCall.hostEmail.split("@")[1]
      : "";

    const meeting: FathomMeeting = {
      recording_id: id,
      title: scrapedCall.title,
      meeting_title: "",
      url: canonicalUrl,
      created_at: scrapedCall.startedAt,
      recorded_by: {
        name: recordedByName,
        email: scrapedCall.hostEmail,
        email_domain: hostDomain,
      },
      calendar_invitees: attendees,
    };

    // Build the summary body. Layered: meta-info → AI summary (if Inertia
    // partial-data probe finds it) → action items (always tried) → fallback
    // boilerplate explaining the public-share provenance.
    let summary: FathomSummary | null = null;
    if (needSummary) {
      const aiSummaryRaw = await this.probeInertiaSummary(scrape.shareToken);
      const aiSummaryMarkdown = aiSummaryRaw
        ? convertFathomNoteTextLinks(aiSummaryRaw, id)
        : null;
      const actionItemsMarkdown = await this.fetchAndFormatActionItems(
        scrape.actionItemsUrl,
        id
      );
      summary = {
        template_name: aiSummaryMarkdown ? "shared-link-scraped" : "shared-link-fallback",
        markdown_formatted: assembleSharedLinkSummary(
          scrapedCall,
          aiSummaryMarkdown,
          actionItemsMarkdown
        ),
      };
    }

    // Honour the transcript write toggle now — segments may be present
    // (we fetched anyway for attendees) but only persist if the user wants it.
    const segmentsToWrite = needTranscript ? segments : null;

    await this.persistNotePair(meeting, summary, segmentsToWrite, result, {
      import_source: "shared-link-scraped",
    });
  }

  /**
   * Speculative: ask Fathom for an AI summary via Inertia partial-data on
   * the share page. Tries a few plausible prop names. Returns markdown if
   * any candidate yields a non-empty string-like prop, else `null`.
   * Failures are silent — the caller falls through to the placeholder.
   *
   * Logs structural diagnostics (which props came back, what types) so we
   * can iterate on the prop-name guesses without exposing content.
   */
  private async probeInertiaSummary(shareToken: string): Promise<string | null> {
    // Fathom's confirmed AI-summary prop is `aiNotes` (an object with
    // `defaultNote`, `notes`, `templates`, `isMeetingTooShortForSummary`,
    // etc.). We keep a wider list of candidates so a Fathom rename or A/B
    // test doesn't silently break us.
    const candidates = [
      "aiNotes",
      "ai_notes",
      "templatedNotes",
      "templated_notes",
      "defaultSummary",
      "default_summary",
      "aiSummary",
      "ai_summary",
      "notes",
      "summary",
    ];
    let props: Record<string, unknown> | null;
    try {
      props = await this.api.fetchInertiaPartialProps(shareToken, candidates);
    } catch (err) {
      logger.warn("Inertia partial-data probe threw:", err);
      return null;
    }
    if (!props) {
      logger.info(
        "Inertia partial-data probe: server returned no JSON props (likely no partial-data support for share pages)."
      );
      return null;
    }

    // Diagnostic: report which candidate keys came back and their shapes.
    const summary: string[] = [];
    for (const key of candidates) {
      const v = props[key];
      if (v === undefined) continue;
      if (v === null) summary.push(`${key}=null`);
      else if (typeof v === "string") summary.push(`${key}=string(${v.length})`);
      else if (Array.isArray(v)) summary.push(`${key}=array(${v.length})`);
      else if (typeof v === "object")
        summary.push(`${key}={${Object.keys(v).join(",")}}`);
      else summary.push(`${key}=${typeof v}`);
    }
    logger.info(`Inertia partial-data probe returned: [${summary.join("; ")}]`);

    for (const key of candidates) {
      const value = props[key];
      const md = extractInertiaSummaryFromValue(value);
      if (md !== null) {
        logger.info(`Inertia probe: extracted summary content from prop "${key}".`);
        return md;
      }
    }
    return null;
  }

  /**
   * Fetch the share-page's signed action-items URL and convert its response
   * (typically `{"html": "<p>...</p>"}`) into a markdown bullet list. Returns
   * `null` if the URL is missing, the fetch fails, or no items are found.
   *
   * Logs structural diagnostics on failure so we can refine the parser
   * without exposing content.
   */
  private async fetchAndFormatActionItems(
    actionItemsUrl: string | null,
    recordingId: number
  ): Promise<string | null> {
    if (!actionItemsUrl) {
      logger.info(`Action items: no URL in share page props for recording ${recordingId}.`);
      return null;
    }
    let body: string;
    try {
      body = await this.api.fetchSignedShareResource(actionItemsUrl);
    } catch (err) {
      logger.warn(`Action items fetch failed for recording ${recordingId}:`, err);
      return null;
    }
    const parsed = parseFathomActionItems(body);
    if (parsed === null) {
      logger.warn(
        `Action items: parsed to null for recording ${recordingId}. ` +
          `Response length=${body.length}, first 60 chars=${JSON.stringify(body.slice(0, 60))}`
      );
    } else {
      logger.info(
        `Action items: ${parsed.split("\n").length} bullet(s) parsed for recording ${recordingId}.`
      );
    }
    return parsed;
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

    const needSummary =
      this.settings.syncSummaries && !this.fileSync.has(meeting.recording_id, "summary");
    const needTranscript =
      this.settings.syncTranscripts &&
      !this.fileSync.has(meeting.recording_id, "transcript");

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    const summary = needSummary ? await this.summaryFromPayload(meeting) : null;
    const segments = needTranscript
      ? meeting.transcript && meeting.transcript.length > 0
        ? meeting.transcript
        : await this.api.getTranscript(meeting.recording_id)
      : null;

    await this.persistNotePair(meeting, summary, segments, result);
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
    const needSummary =
      this.settings.syncSummaries && !this.fileSync.has(meeting.recording_id, "summary");
    const needTranscript =
      this.settings.syncTranscripts &&
      !this.fileSync.has(meeting.recording_id, "transcript");

    if (!needSummary && !needTranscript) {
      result.skipped++;
      return;
    }

    const summary = needSummary ? await this.api.getSummary(meeting.recording_id) : null;
    const segments = needTranscript
      ? await this.api.getTranscript(meeting.recording_id)
      : null;

    await this.persistNotePair(meeting, summary, segments, result);
  }

  /**
   * Shared write primitive. Owns filename construction, note rendering, vault
   * write, and counter mutation — but NOT content acquisition (summary fetch
   * policy differs by caller) and NOT cache-check (callers pre-check so they
   * only fetch what's actually missing).
   *
   * Pass `null` for either content arg to skip writing that note kind.
   * Errors from `saveNote` propagate; the cache-poisoning guard for empty
   * summaries lives in the caller (where the fetch happens), not here.
   */
  private async persistNotePair(
    meeting: FathomMeeting,
    summary: FathomSummary | null,
    segments: FathomTranscriptSegment[] | null,
    result: SyncResult,
    extraFrontmatter?: Record<string, string>
  ): Promise<void> {
    if (summary === null && segments === null) {
      result.skipped++;
      return;
    }

    const filename = this.processor.buildFilename(meeting);

    if (summary !== null) {
      const transcriptPath = this.settings.syncTranscripts
        ? `${this.settings.transcriptFolder}/${filename}`
        : undefined;
      const note = this.processor.buildSummaryNote(
        meeting,
        summary,
        transcriptPath,
        extraFrontmatter
      );
      const wrote = await this.fileSync.saveNote(meeting.recording_id, "summary", note);
      if (wrote) result.summariesCreated++;
      else result.skipped++;
    }

    if (segments !== null) {
      const summaryPath = `${this.settings.summaryFolder}/${filename}`;
      const note = this.processor.buildTranscriptNote(
        meeting,
        segments,
        summaryPath,
        extraFrontmatter
      );
      const wrote = await this.fileSync.saveNote(
        meeting.recording_id,
        "transcript",
        note
      );
      if (wrote) result.transcriptsCreated++;
      else result.skipped++;
    }
  }
}

/**
 * Compose the markdown body that goes where Fathom's AI summary would
 * normally appear, for notes built from a scraped public share page. The
 * body layers (in order):
 *
 *   1. Metadata block — host, byline, topic, duration, company.
 *   2. AI summary (only when `aiSummaryMarkdown` is non-null — pulled via
 *      the Inertia partial-data probe).
 *   3. Action items (only when `actionItemsMarkdown` is non-null — fetched
 *      from the share page's signed `clipboardActionItemsUrl`).
 *   4. A provenance note explaining how/why this note was assembled.
 */
function assembleSharedLinkSummary(
  call: ScrapedCall,
  aiSummaryMarkdown: string | null,
  actionItemsMarkdown: string | null
): string {
  const sections: string[] = [];

  // --- Metadata block ---
  const meta: string[] = [];
  if (call.topic && call.topic !== call.title) meta.push(`**Topic:** ${call.topic}`);
  if (call.hostEmail) meta.push(`**Host:** ${call.hostEmail}`);
  if (call.byline) meta.push(`**Byline:** ${call.byline}`);
  if (call.durationMinutes > 0) meta.push(`**Duration:** ${call.durationMinutes} min`);
  if (call.companyName) meta.push(`**Company:** ${call.companyName}`);
  if (meta.length > 0) sections.push(meta.join("  \n"));

  // --- AI summary (rare, only if Inertia probe found it) ---
  if (aiSummaryMarkdown && aiSummaryMarkdown.trim().length > 0) {
    sections.push("### AI summary\n\n" + aiSummaryMarkdown.trim());
  }

  // --- Action items (common — same signed URL the share page uses) ---
  if (actionItemsMarkdown && actionItemsMarkdown.trim().length > 0) {
    sections.push("### Action items\n\n" + actionItemsMarkdown.trim());
  }

  // --- Provenance note (always last) ---
  sections.push(
    "> Imported from a public Fathom share link. " +
      (aiSummaryMarkdown
        ? "AI summary was pulled via an Inertia partial-data request."
        : "Fathom's REST API doesn't grant your account access to this " +
          "recording's AI summary, so this note is assembled from the share " +
          "page's public data (metadata + action items + transcript).") +
      " The transcript below is fetched from the same signed URL the share " +
      "page's \"copy transcript\" button uses."
  );

  return sections.join("\n\n");
}

/**
 * Parse the body of a Fathom "copy action items" URL into a markdown bullet
 * list. The response shape mirrors the transcript endpoint:
 * `{"html": "<p>...</p>"}`. We tag-strip the HTML, split on `<br />` or
 * paragraph boundaries, and emit a bullet per non-empty line.
 *
 * Returns `null` if no items can be extracted.
 */
function parseFathomActionItems(text: string): string | null {
  if (!text) return null;

  let html: string | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.html === "string") html = obj.html;
    }
  } catch {
    /* Not JSON — treat raw text as already-formatted markdown. */
    html = null;
  }

  // If JSON didn't have an `html` field, treat the whole body as plain text.
  const source = html ?? text;

  // Convert <br/>, </p>, </li> into line breaks; strip remaining tags;
  // collapse whitespace; split into trimmed non-empty lines; emit bullets.
  const lines = source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((l) => decodeBasicHtmlEntities(l).replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * Convert Fathom's embedded click-to-jump anchor tags in noteText into proper
 * Markdown links pointing back to the recording at the same timestamp:
 *
 *   <a class='cursor-pointer' data-timestamp="72.0">Demo the new ...</a>
 *     →  [Demo the new ...](https://fathom.video/calls/{id}?timestamp=72)
 *
 * Idempotent — running it on text without the tags returns the input as-is.
 */
function convertFathomNoteTextLinks(markdown: string, recordingId: number): string {
  return markdown.replace(
    /<a[^>]*class=["']cursor-pointer["'][^>]*data-timestamp=["']([\d.]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, timestamp, text) => {
      const seconds = Math.floor(parseFloat(timestamp));
      const cleanText = String(text).replace(/\s+/g, " ").trim();
      return `[${cleanText}](https://fathom.video/calls/${recordingId}?timestamp=${seconds})`;
    }
  );
}

/**
 * Derive a synthetic invitee list from transcript speakers. Fathom's public
 * share API doesn't expose `invitees`, but we have the transcript with named
 * speakers — close enough for the note's attendee field.
 *
 * Returns invitee stubs (empty email/domain, `is_external: false`) so the
 * frontmatter renderer's `(a) => a.name` mapper has something to read.
 */
function deriveAttendeesFromSegments(
  segments: FathomTranscriptSegment[] | null
): FathomInvitee[] {
  if (!segments || segments.length === 0) return [];
  const names = new Set<string>();
  for (const seg of segments) {
    let name = "";
    if (typeof seg.speaker === "string") {
      name = seg.speaker;
    } else if (seg.speaker && typeof seg.speaker === "object") {
      const sp = seg.speaker as {
        name?: unknown;
        display_name?: unknown;
      };
      if (typeof sp.display_name === "string") name = sp.display_name;
      else if (typeof sp.name === "string") name = sp.name;
    }
    name = name.trim();
    // Skip the placeholder "Transcript" speaker the parser uses when it
    // can't recognise the format. Skip empty / generic Speaker N too.
    if (!name) continue;
    if (name.toLowerCase() === "transcript") continue;
    names.add(name);
  }
  return [...names].map((name) => ({
    name,
    email: "",
    email_domain: "",
    is_external: false,
    matched_speaker_display_name: name,
  }));
}

/**
 * Pull markdown summary content out of an Inertia partial-data response value.
 * Handles the confirmed Fathom shapes plus several defensive fallbacks:
 *
 *   - string                       → use directly
 *   - { isMeetingTooShortForSummary: true, ... }  → surface that fact
 *   - { defaultNote: <note> }      → recurse into defaultNote
 *   - { notes: [<note>, ...] }     → recurse into the first non-empty note
 *   - { markdown_formatted | markdown | content | text: string }
 *   - { html: string }             → strip tags via simpleHtmlToMarkdown
 *
 * Returns `null` if no content is found. Logs structural diagnostic when
 * the value is an object with no matching keys, so we can iterate without
 * exposing any actual meeting content.
 */
function extractInertiaSummaryFromValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const md = extractInertiaSummaryFromValue(item);
      if (md !== null) return md;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;

  // Fathom's aiNotes carries this flag when no AI summary was generated
  // (call was too short). Surface that explicitly rather than returning
  // null — the user should see WHY the summary slot is otherwise empty.
  if (obj.isMeetingTooShortForSummary === true) {
    return "_Fathom did not generate an AI summary for this recording (the meeting was too short)._";
  }

  // Direct content fields (in priority order).
  // `noteText` is Fathom's field name on `aiNotes.defaultNote` (the active
  // templated AI note for the meeting). Confirmed via the Inertia probe.
  if (typeof obj.noteText === "string" && obj.noteText.trim()) return obj.noteText;
  if (typeof obj.markdown_formatted === "string" && obj.markdown_formatted.trim()) {
    return obj.markdown_formatted;
  }
  if (typeof obj.markdown === "string" && obj.markdown.trim()) return obj.markdown;
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  if (typeof obj.html === "string" && obj.html.trim()) {
    return simpleHtmlToMarkdown(obj.html);
  }

  // Fathom's confirmed aiNotes shape: { defaultNote, notes, templates, ... }
  if ("defaultNote" in obj) {
    const md = extractInertiaSummaryFromValue(obj.defaultNote);
    if (md !== null) return md;
  }
  if ("notes" in obj) {
    const md = extractInertiaSummaryFromValue(obj.notes);
    if (md !== null) return md;
  }

  // Diagnostic for the next iteration if none of the known shapes matched.
  // Logs SHAPE only — key names + child key names — so we can refine
  // without seeing any actual meeting content.
  const shape: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) shape.push(`${k}=null`);
    else if (Array.isArray(v))
      shape.push(`${k}=array(${v.length})`);
    else if (typeof v === "object") {
      const childKeys = Object.keys(v as Record<string, unknown>);
      shape.push(`${k}={${childKeys.slice(0, 8).join(",")}}`);
    } else if (typeof v === "string") {
      shape.push(`${k}=string(${v.length})`);
    } else {
      shape.push(`${k}=${typeof v}`);
    }
  }
  console.warn(
    `[Fathom Sync] extractInertiaSummaryFromValue: no recognised content keys. Shape: {${shape.join(", ")}}`
  );

  return null;
}

/**
 * Crude HTML → markdown for short AI-summary fragments that might come back
 * from an Inertia partial-data probe in `{html: ...}` form. Strips tags,
 * decodes basic entities, normalises whitespace. Lossy but acceptable for
 * the "speculative summary recovery" path.
 */
function simpleHtmlToMarkdown(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|div|h\d)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .split(/\n/)
    .map((l) => decodeBasicHtmlEntities(l).replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse the body of a Fathom "copy transcript" URL into transcript segments.
 * The exact text format isn't documented; this parser tries a few common
 * shapes and falls back to a single-segment wrap if nothing matches.
 *
 * On failure, logs structural diagnostics (length, line count, first 30
 * chars only) so we can refine the parser without exposing meeting text.
 */
function parseFathomCopyTranscript(text: string): FathomTranscriptSegment[] {
  if (!text) return [];

  // Try JSON first. Fathom's actual copy-transcript URL returns
  // `{"html": "<p>...</p>"}` — a single HTML field with speaker/timestamp
  // blocks. We parse that into structured segments below.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as FathomTranscriptSegment[];
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.html === "string") {
        const fromHtml = parseFathomCopyTranscriptHtml(obj.html);
        if (fromHtml.length > 0) return fromHtml;
      }
      if (Array.isArray(obj.segments)) return obj.segments as FathomTranscriptSegment[];
      if (Array.isArray(obj.transcript)) return obj.transcript as FathomTranscriptSegment[];
    }
  } catch {
    /* not JSON, fall through to text parsers */
  }

  // Try a few line-based formats. Each line is normally one utterance:
  //   "00:00:00 Speaker Name: text…"
  //   "[00:00:00] Speaker Name: text…"
  //   "Speaker Name (00:00:00): text…"
  const segments: FathomTranscriptSegment[] = [];
  const patterns: RegExp[] = [
    /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:]+?):\s*(.*)$/,
    /^([^()]+?)\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*:\s*(.*)$/,
  ];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (let i = 0; i < patterns.length; i++) {
      const m = line.match(patterns[i]);
      if (!m) continue;
      // Pattern 0: ts, speaker, text. Pattern 1: speaker, ts, text.
      const ts = i === 0 ? m[1] : m[2];
      const speaker = (i === 0 ? m[2] : m[1]).trim();
      const segText = (i === 0 ? m[3] : m[3]).trim();
      const normalisedTs = ts.split(":").length === 2 ? `00:${ts}` : ts;
      segments.push({ timestamp: normalisedTs, speaker, text: segText });
      break;
    }
  }

  if (segments.length === 0) {
    const lineCount = text.split(/\r?\n/).length;
    const firstChars = text.slice(0, 30);
    const hasTimestamps = /\d{1,2}:\d{2}/.test(text);
    console.warn(
      `[Fathom Sync] Couldn't parse copy-transcript format. ` +
        `length=${text.length}, lines=${lineCount}, hasTimestamps=${hasTimestamps}, ` +
        `firstChars=${JSON.stringify(firstChars)}. ` +
        `Wrapping whole body in a single segment.`
    );
    segments.push({ timestamp: "00:00:00", speaker: "Transcript", text: text.trim() });
  }

  return segments;
}

/**
 * Parse Fathom's copy-transcript HTML payload. The structure is a sequence
 * of speaker-header paragraphs followed by one or more text paragraphs:
 *
 *   <p><a href="…timestamp=N">@MM:SS</a> - <b>Speaker Name</b></p>
 *   <p style="…">Utterance text…</p>
 *   <p style="…">Continuation if any…</p>
 *   <br />
 *   <p><a href="…timestamp=N">@MM:SS</a> - <b>Next Speaker</b></p>
 *   …
 *
 * Walks the header matches in order, captures the substring between each
 * pair of headers as the utterance body, then extracts text from any <p>
 * tags in that body. Joins multi-paragraph utterances into one segment.
 *
 * Returns `[]` if no headers match (caller falls back to wrap-as-single).
 */
function parseFathomCopyTranscriptHtml(html: string): FathomTranscriptSegment[] {
  const headerRe =
    /<p>\s*<a[^>]*timestamp=([\d.]+)[^>]*>\s*@[\d:]+\s*<\/a>\s*-\s*<b>([^<]+)<\/b>\s*<\/p>/gi;

  interface Header {
    index: number;
    length: number;
    seconds: number;
    speaker: string;
  }
  const headers: Header[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(html)) !== null) {
    headers.push({
      index: m.index,
      length: m[0].length,
      seconds: parseFloat(m[1]),
      speaker: decodeBasicHtmlEntities(m[2]).trim(),
    });
  }

  const segments: FathomTranscriptSegment[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const chunkStart = h.index + h.length;
    const chunkEnd = i + 1 < headers.length ? headers[i + 1].index : html.length;
    const chunk = html.substring(chunkStart, chunkEnd);

    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    const pieces: string[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(chunk)) !== null) {
      const cleaned = decodeBasicHtmlEntities(pm[1])
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) pieces.push(cleaned);
    }
    const text = pieces.join(" ").trim();
    if (text) {
      segments.push({
        timestamp: secondsToHms(h.seconds),
        speaker: h.speaker,
        text,
      });
    }
  }

  return segments;
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last
}

function secondsToHms(s: number): string {
  if (!isFinite(s) || s < 0) return "00:00:00";
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

