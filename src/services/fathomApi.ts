import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  FathomListResponse,
  FathomMeeting,
  FathomSummary,
  FathomTeam,
  FathomTranscriptSegment,
} from "../types";

const BASE_URL = "https://api.fathom.ai/external/v1";

export class FathomApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "FathomApiError";
  }
}

export class FathomApiClient {
  private readonly headers: Record<string, string>;

  constructor(apiToken: string) {
    this.headers = {
      "X-Api-Key": apiToken,
      "Content-Type": "application/json",
    };
  }

  /**
   * Token-bucket-ish throttle: Fathom rate-limits at 60 req/min, so we
   * keep ~1.1s between calls. With this we can run unlimited meetings
   * without ever hitting 429 in the steady state.
   */
  private nextSlot = 0;
  private readonly minInterval = 1100; // ms

  private async throttle(): Promise<void> {
    const now = Date.now();
    if (now < this.nextSlot) {
      await new Promise((r) => setTimeout(r, this.nextSlot - now));
    }
    this.nextSlot = Math.max(now, this.nextSlot) + this.minInterval;
  }

  /**
   * Wrapper around Obsidian's requestUrl() that bypasses Electron CORS.
   * We use throw: false so non-2xx responses don't blow up before we can
   * read the body for diagnostics. Retries once on 429 after a backoff.
   */
  private async call<T>(
    path: string,
    query?: URLSearchParams,
    retriesOn429 = 2
  ): Promise<T> {
    await this.throttle();

    const url = query
      ? `${BASE_URL}${path}?${query.toString()}`
      : `${BASE_URL}${path}`;

    const params: RequestUrlParam = {
      url,
      method: "GET",
      headers: this.headers,
      throw: false,
    };

    const response = await requestUrl(params);

    if (response.status === 429 && retriesOn429 > 0) {
      // Honour Retry-After header if present, otherwise back off 30s
      const retryAfterHeader = response.headers?.["retry-after"];
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 30;
      const waitMs = Math.max(1000, retryAfter * 1000);
      console.warn(`[Fathom Sync] Rate-limited; backing off ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.call<T>(path, query, retriesOn429 - 1);
    }

    if (response.status < 200 || response.status >= 300) {
      const body = (response.text ?? "").slice(0, 500);
      throw new FathomApiError(
        response.status,
        `Fathom API ${response.status}: ${body || "no response body"}`
      );
    }

    return response.json as T;
  }

  /**
   * Fetch a single page of meetings.
   * Use `listAllMeetings` for full pagination.
   */
  async listMeetings(opts: {
    teams?: string[];
    recordedBy?: string[];
    createdAfter?: string;
    createdBefore?: string;
    includeSummary?: boolean;
    cursor?: string;
  }): Promise<FathomListResponse> {
    const q = new URLSearchParams();

    if (opts.teams?.length) {
      for (const t of opts.teams) q.append("teams[]", t);
    }
    if (opts.recordedBy?.length) {
      for (const e of opts.recordedBy) q.append("recorded_by[]", e);
    }
    if (opts.createdAfter) q.set("created_after", opts.createdAfter);
    if (opts.createdBefore) q.set("created_before", opts.createdBefore);
    if (opts.includeSummary) q.set("include_summary", "true");
    if (opts.cursor) q.set("cursor", opts.cursor);

    return this.call<FathomListResponse>("/meetings", q);
  }

  /**
   * Iterate all pages and return every meeting matching the filters.
   * Stops early when `onPage` returns false.
   */
  async listAllMeetings(
    opts: Parameters<FathomApiClient["listMeetings"]>[0],
    onPage?: (meetings: FathomMeeting[], cursor: string | undefined) => boolean | void
  ): Promise<FathomMeeting[]> {
    const all: FathomMeeting[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.listMeetings({ ...opts, cursor });
      const meetings = page.items ?? [];

      if (!Array.isArray(meetings)) {
        throw new FathomApiError(
          0,
          `Unexpected response shape — expected items to be an array. ` +
            `Got: ${JSON.stringify(page).slice(0, 300)}`
        );
      }

      all.push(...meetings);

      const shouldContinue = onPage?.(meetings, page.next_cursor);
      if (shouldContinue === false) break;

      cursor = page.next_cursor;
    } while (cursor);

    return all;
  }

  async getSummary(recordingId: number): Promise<FathomSummary> {
    const raw = await this.call<unknown>(`/recordings/${recordingId}/summary`);

    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;

      // Fathom's documented shape: { summary: { template_name, markdown_formatted } }
      const nested = (obj.summary ?? obj.default_summary) as Record<string, unknown> | undefined;
      if (nested && typeof nested.markdown_formatted === "string") {
        return nested as unknown as FathomSummary;
      }

      // Defensive fallbacks for shape drift
      if (typeof obj.markdown_formatted === "string") {
        return obj as unknown as FathomSummary;
      }
      if (typeof obj.markdown === "string") {
        return { template_name: String(obj.template_name ?? "default"), markdown_formatted: obj.markdown };
      }
      if (typeof obj.content === "string") {
        return { template_name: String(obj.template_name ?? "default"), markdown_formatted: obj.content };
      }
    }

    console.warn(`[Fathom Sync] Empty/unknown summary shape for recording ${recordingId}`);
    return { template_name: "default", markdown_formatted: "" };
  }

  async getTranscript(recordingId: number): Promise<FathomTranscriptSegment[]> {
    const raw = await this.call<unknown>(`/recordings/${recordingId}/transcript`);

    // Fathom may wrap the transcript in different shapes. Normalise here.
    if (Array.isArray(raw)) return raw as FathomTranscriptSegment[];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.segments)) return obj.segments as FathomTranscriptSegment[];
      if (Array.isArray(obj.transcript)) return obj.transcript as FathomTranscriptSegment[];
      if (Array.isArray(obj.items)) return obj.items as FathomTranscriptSegment[];

      // Log once so we can identify the real shape
      console.warn(
        `[Fathom Sync] Unknown transcript shape for recording ${recordingId}. Keys: ${Object.keys(obj).join(", ")}. Sample: ${JSON.stringify(raw).slice(0, 400)}`
      );
    }
    return [];
  }

  async listTeams(): Promise<FathomTeam[]> {
    return this.call<FathomTeam[]>("/teams");
  }
}
