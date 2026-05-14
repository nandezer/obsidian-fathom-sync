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
   * Token-bucket-ish throttle: Fathom rate-limits at 60 req/min, so we keep
   * ~1.1s between calls. Static so the gate survives when the client is
   * rebuilt mid-sync (e.g. when settings are saved during an active run).
   */
  private static nextSlot = 0;
  private static readonly minInterval = 1100; // ms

  private async throttle(): Promise<void> {
    const now = Date.now();
    if (now < FathomApiClient.nextSlot) {
      await new Promise((r) => setTimeout(r, FathomApiClient.nextSlot - now));
    }
    FathomApiClient.nextSlot =
      Math.max(now, FathomApiClient.nextSlot) + FathomApiClient.minInterval;
  }

  /**
   * Wrapper around Obsidian's requestUrl() that bypasses Electron CORS.
   * We use throw: false so non-2xx responses don't blow up before we can
   * read the body for diagnostics.
   *
   * Retries on:
   *  - 429 (rate limit): honours Retry-After header, else 30s.
   *  - 502 / 503 / 504 (transient server errors): exponential backoff
   *    starting at 2s. Fathom's edge regularly returns brief 502s under load;
   *    these usually clear within a few seconds.
   */
  private async call<T>(
    path: string,
    query?: URLSearchParams,
    attempt = 0
  ): Promise<T> {
    const maxAttempts = 4; // initial + 3 retries
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
    const status = response.status;
    const isLastAttempt = attempt >= maxAttempts - 1;

    if (status === 429 && !isLastAttempt) {
      const retryAfterHeader = response.headers?.["retry-after"];
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 30;
      const waitMs = Math.max(1000, retryAfter * 1000);
      console.warn(
        `[Fathom Sync] Rate-limited on ${path}; backing off ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      return this.call<T>(path, query, attempt + 1);
    }

    if ((status === 502 || status === 503 || status === 504) && !isLastAttempt) {
      // 2s, 4s, 8s — Fathom asks for "try again in 30 seconds" on 502, but in
      // practice their edge clears within a few seconds. Start small.
      const waitMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[Fathom Sync] Transient ${status} on ${path}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      return this.call<T>(path, query, attempt + 1);
    }

    if (status < 200 || status >= 300) {
      const body = (response.text ?? "").slice(0, 500);
      throw new FathomApiError(
        status,
        `Fathom API ${status}: ${body || "no response body"}`
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
      for (const e of opts.recordedBy) q.append("recorded_by[]", e.toLowerCase());
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

    throw new FathomApiError(
      0,
      `Empty or unknown summary shape for recording ${recordingId}. ` +
        `Sample: ${JSON.stringify(raw).slice(0, 300)}`
    );
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

  /**
   * Register a webhook with Fathom.
   *
   * Returns the created webhook's id and the signing secret (sent by Fathom
   * exactly ONCE in the create response — we surface it so the user can
   * paste it into their Worker's secret store).
   *
   * `triggered_for` defaults to all four categories so a single webhook
   * covers own + team + shared meetings. The whole point of the v2 path is
   * that `shared_external_recordings` only flows through here.
   */
  async createWebhook(opts: {
    destinationUrl: string;
    triggeredFor?: ReadonlyArray<
      | "my_recordings"
      | "shared_external_recordings"
      | "my_shared_with_team_recordings"
      | "shared_team_recordings"
    >;
    includeSummary?: boolean;
    includeTranscript?: boolean;
    includeActionItems?: boolean;
    includeCrmMatches?: boolean;
  }): Promise<{ id: string; signing_secret: string }> {
    const body = {
      destination_url: opts.destinationUrl,
      triggered_for: opts.triggeredFor ?? [
        "my_recordings",
        "shared_external_recordings",
        "my_shared_with_team_recordings",
        "shared_team_recordings",
      ],
      include_summary: opts.includeSummary ?? true,
      include_transcript: opts.includeTranscript ?? true,
      include_action_items: opts.includeActionItems ?? true,
      include_crm_matches: opts.includeCrmMatches ?? false,
    };
    return this.callMutate<{ id: string; signing_secret: string }>(
      "POST",
      "/webhooks",
      body
    );
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.callMutate("DELETE", `/webhooks/${id}`);
  }

  /**
   * Variant of {@link call} for non-GET requests. Same throttle + retry
   * envelope, plus a JSON body. Webhook registration is rare so we don't
   * try to share code more aggressively.
   */
  private async callMutate<T>(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
    attempt = 0
  ): Promise<T> {
    const maxAttempts = 4;
    await this.throttle();

    const params: RequestUrlParam = {
      url: `${BASE_URL}${path}`,
      method,
      headers: this.headers,
      throw: false,
    };
    if (body !== undefined) {
      params.body = JSON.stringify(body);
    }

    const response = await requestUrl(params);
    const status = response.status;
    const isLastAttempt = attempt >= maxAttempts - 1;

    if (status === 429 && !isLastAttempt) {
      const retryAfterHeader = response.headers?.["retry-after"];
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 30;
      const waitMs = Math.max(1000, retryAfter * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.callMutate<T>(method, path, body, attempt + 1);
    }

    if ((status === 502 || status === 503 || status === 504) && !isLastAttempt) {
      const waitMs = 2000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.callMutate<T>(method, path, body, attempt + 1);
    }

    if (status < 200 || status >= 300) {
      const bodyText = (response.text ?? "").slice(0, 500);
      throw new FathomApiError(
        status,
        `Fathom API ${method} ${path} → ${status}: ${bodyText || "no response body"}`
      );
    }

    return response.json as T;
  }
}
