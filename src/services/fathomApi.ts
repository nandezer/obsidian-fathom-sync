import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  FathomListResponse,
  FathomMeeting,
  FathomSummary,
  FathomTeam,
  FathomTranscriptSegment,
} from "../types";

const BASE_URL = "https://api.fathom.ai/external/v1";

/**
 * Metadata pulled from a Fathom share page's Inertia `props.call` object.
 * Just the fields we need to build a useful note when the REST API refuses
 * to serve the recording (public-share-only case).
 */
export interface ScrapedCall {
  id: number;
  title: string;
  byline: string;
  startedAt: string;
  durationMinutes: number;
  hostEmail: string;
  companyName: string | null;
  /** Calendar topic (often the meeting subject line). May duplicate title. */
  topic: string | null;
}

/** Combined result of scraping a share page — recording id + optional content. */
export interface ShareScrapeResult {
  recordingId: number;
  /** Metadata pulled from `props.call`. `null` if the page didn't expose it. */
  call: ScrapedCall | null;
  /** Signed URL the share page's "copy transcript" button uses. */
  transcriptUrl: string | null;
  /** Signed URL the share page's "copy action items" button uses. */
  actionItemsUrl: string | null;
  /** Share token, retained for follow-up partial-data probes. */
  shareToken: string;
}

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

    if (
      (status === 500 || status === 502 || status === 503 || status === 504) &&
      !isLastAttempt
    ) {
      // 2s, 4s, 8s — Fathom asks for "try again in 30 seconds" on 502, but in
      // practice their edge clears within a few seconds. Start small.
      // 500 is included because Fathom's /meetings endpoint empirically
      // returns 500 (with an HTML error page body) on transient query-
      // execution failures even with valid filters. They recover on retry.
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
    return this.getSummaryByPath(String(recordingId));
  }

  /**
   * Variant of `getSummary` that takes an opaque path segment instead of a
   * numeric id. Used by the import-by-link path to speculatively pass a
   * share token where the documented endpoint expects a `recording_id` —
   * Fathom's REST API empirically accepts share tokens on this route for
   * some recordings, but we cannot prove it without trying.
   *
   * The `pathSegment` is URL-encoded so a token containing `/` or `?` (none
   * known to exist today, but defensive) can't escape the URL structure.
   */
  async getSummaryByPath(pathSegment: string): Promise<FathomSummary> {
    const raw = await this.call<unknown>(
      `/recordings/${encodeURIComponent(pathSegment)}/summary`
    );

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
      `Empty or unknown summary shape for recording ${pathSegment}. ` +
        `Sample: ${JSON.stringify(raw).slice(0, 300)}`
    );
  }

  async getTranscript(recordingId: number): Promise<FathomTranscriptSegment[]> {
    return this.getTranscriptByPath(String(recordingId));
  }

  /** See {@link getSummaryByPath} for the rationale around path segments. */
  async getTranscriptByPath(pathSegment: string): Promise<FathomTranscriptSegment[]> {
    const raw = await this.call<unknown>(
      `/recordings/${encodeURIComponent(pathSegment)}/transcript`
    );

    // Fathom may wrap the transcript in different shapes. Normalise here.
    if (Array.isArray(raw)) return raw as FathomTranscriptSegment[];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.segments)) return obj.segments as FathomTranscriptSegment[];
      if (Array.isArray(obj.transcript)) return obj.transcript as FathomTranscriptSegment[];
      if (Array.isArray(obj.items)) return obj.items as FathomTranscriptSegment[];

      // Log once so we can identify the real shape
      console.warn(
        `[Fathom Sync] Unknown transcript shape for recording ${pathSegment}. Keys: ${Object.keys(obj).join(", ")}. Sample: ${JSON.stringify(raw).slice(0, 400)}`
      );
    }
    return [];
  }

  /**
   * Resolve a Fathom share token by fetching the public share page and
   * scraping its Inertia.js page payload. Returns the numeric recording_id
   * plus extracted call metadata + the signed transcript URL the share
   * page's "copy transcript" button uses, so the caller can build a note
   * even when the REST API refuses to serve the recording (the public-
   * share-but-not-in-workspace case).
   *
   * Returns `null` if no recording_id can be extracted (token invalid,
   * share expired/revoked, or Fathom restructured the page in a way that
   * breaks every extraction strategy).
   *
   * Does NOT send the X-Api-Key header — share pages are public.
   */
  async resolveShareToken(token: string): Promise<ShareScrapeResult | null> {
    const url = `https://fathom.video/share/${encodeURIComponent(token)}`;
    const response = await requestUrl({
      url,
      method: "GET",
      throw: false,
    });

    const status = response.status;
    if (status === 404 || status === 410) {
      console.warn(
        `[Fathom Sync] Share page returned ${status} for token ${token.slice(0, 8)}… (share invalid or expired)`
      );
      return null;
    }
    if (status < 200 || status >= 300) {
      throw new FathomApiError(
        status,
        `Fathom share page ${status} for token ${token.slice(0, 8)}…`
      );
    }

    const html = response.text ?? "";

    // Structural diagnostic — describes what kinds of data containers exist
    // in the page WITHOUT logging any meeting content. Lets us decide whether
    // a content scrape is feasible (data already in HTML) or whether the
    // page is a JS shell (data only loaded after JS runs, which we can't do).
    console.info(
      `[Fathom Sync] Share page structure for ${token.slice(0, 8)}…: ${describeShareHtmlStructure(html)}`
    );

    // Fathom uses Inertia.js: the full page state is bundled into the
    // `data-page` attribute on `#app` as HTML-escaped JSON. The `props.call`
    // object has the meeting metadata; `props.copyTranscriptUrl` and
    // `props.clipboardActionItemsUrl` are signed URLs the page's "copy"
    // buttons use to fetch transcript / action-items text without auth.
    const inertiaPage = extractInertiaPageData(html);
    let scrapedCall: ScrapedCall | null = null;
    let transcriptUrl: string | null = null;
    let actionItemsUrl: string | null = null;
    if (inertiaPage !== null && isPlainObject(inertiaPage.props)) {
      const props = inertiaPage.props;
      scrapedCall = extractScrapedCall(props);
      transcriptUrl = extractStringProp(props, "copyTranscriptUrl");
      actionItemsUrl = extractStringProp(props, "clipboardActionItemsUrl");
    }

    const recordingId =
      scrapedCall?.id ?? extractRecordingIdFromShareHtml(html);
    if (recordingId === null) {
      console.warn(
        `[Fathom Sync] No recording_id found in share page HTML for token ` +
          `${token.slice(0, 8)}…. First 500 chars of response: ${html.slice(0, 500)}`
      );
      return null;
    }

    return {
      recordingId,
      call: scrapedCall,
      transcriptUrl,
      actionItemsUrl,
      shareToken: token,
    };
  }

  /**
   * GET a Fathom-hosted, signed URL (e.g. `copyTranscriptUrl` or
   * `clipboardActionItemsUrl` from a share page's Inertia props) and return
   * the body as text. Does NOT send the X-Api-Key header — these URLs use
   * their own auth (signed query params). Caller is responsible for parsing
   * the body, since the response format isn't documented.
   *
   * Retries 500/502/503/504 with exponential backoff (2s/4s/8s) — Fathom's
   * signed-resource endpoints empirically return transient 500s on first
   * hit but clear on retry, same pattern as the REST API.
   *
   * Relative paths are resolved against `https://fathom.video`.
   */
  async fetchSignedShareResource(url: string, attempt = 0): Promise<string> {
    const maxAttempts = 4;
    const fullUrl = /^https?:\/\//i.test(url)
      ? url
      : `https://fathom.video${url.startsWith("/") ? "" : "/"}${url}`;
    const response = await requestUrl({
      url: fullUrl,
      method: "GET",
      throw: false,
    });
    const status = response.status;
    const isLastAttempt = attempt >= maxAttempts - 1;

    if (
      (status === 500 || status === 502 || status === 503 || status === 504) &&
      !isLastAttempt
    ) {
      const waitMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[Fathom Sync] Transient ${status} on signed share URL; retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      return this.fetchSignedShareResource(url, attempt + 1);
    }

    if (status < 200 || status >= 300) {
      throw new FathomApiError(
        status,
        `Signed share URL returned HTTP ${status}`
      );
    }
    return response.text ?? "";
  }

  /**
   * Speculative: ask Fathom to return JSON for a share page using Inertia's
   * partial-data protocol. If the requested props exist as lazy props for
   * the `page-call-detail` component, Fathom returns them in the response.
   * If not, we get the full component or a 4xx — caller treats anything
   * non-conforming as "no extra data available".
   *
   * Used to probe for an AI summary prop name that isn't in the initial
   * page payload. Cheap one-shot attempt; failures are non-fatal.
   */
  async fetchInertiaPartialProps(
    token: string,
    propNames: ReadonlyArray<string>
  ): Promise<Record<string, unknown> | null> {
    const url = `https://fathom.video/share/${encodeURIComponent(token)}`;
    const response = await requestUrl({
      url,
      method: "GET",
      throw: false,
      headers: {
        "X-Inertia": "true",
        "X-Inertia-Partial-Component": "page-call-detail",
        "X-Inertia-Partial-Data": propNames.join(","),
        Accept: "text/html, application/xhtml+xml, application/json",
      },
    });
    if (response.status !== 200) return null;
    const body = response.text ?? "";
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (isPlainObject(obj.props)) return obj.props;
      }
    } catch {
      /* Server returned HTML (not Inertia JSON) → no partial-data support. */
    }
    return null;
  }

  async listTeams(): Promise<FathomTeam[]> {
    // Fathom returns `{ items, limit, next_cursor }` for /teams, not a bare
    // array. The v1 settings.testConnection() defensively wraps with
    // `Array.isArray(teams) ? teams.length : 0` so the bug was invisible
    // (just reported "0 teams visible" for everyone), but anything that
    // actually iterated the array would have silently looped zero times.
    const raw = await this.call<unknown>("/teams");
    if (Array.isArray(raw)) return raw as FathomTeam[];
    if (raw && typeof raw === "object") {
      const items = (raw as { items?: unknown }).items;
      if (Array.isArray(items)) return items as FathomTeam[];
    }
    return [];
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
    // Fathom returns the signing key in a field literally called `secret` —
    // not `signing_secret` like the earlier code assumed. We normalise here
    // so callers see a stable name. Defensive on both spellings in case
    // Fathom adds an alias later.
    const raw = await this.callMutate<{
      id: string;
      secret?: string;
      signing_secret?: string;
    }>("POST", "/webhooks", body);
    const signing_secret = raw.signing_secret ?? raw.secret;
    if (typeof signing_secret !== "string" || signing_secret.length === 0) {
      throw new FathomApiError(
        0,
        `Webhook created (id ${raw.id}) but Fathom response had no secret/signing_secret field. ` +
          `Keys: ${Object.keys(raw).join(", ")}`
      );
    }
    return { id: raw.id, signing_secret };
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

    // 204 No Content (and any other 2xx with empty body) is normal for
    // DELETE /webhooks/:id. requestUrl's `.json` getter throws on empty
    // body, so probe via `.text` first.
    const text = response.text ?? "";
    if (text.length === 0) {
      return {} as T;
    }
    try {
      return response.json as T;
    } catch {
      // Non-empty but not JSON — treat the same way as empty for mutations,
      // since the caller only cares about success/failure for DELETE-shaped
      // requests. POST callers that need a real body will see the cast as
      // `{}` and explicitly error on missing fields (see createWebhook).
      return {} as T;
    }
  }
}

/**
 * Find the numeric recording_id inside a Fathom share page's HTML. Tries
 * progressively looser extraction strategies so a minor restructure of the
 * page doesn't break us:
 *
 *  1. `<link rel="canonical" href=".../calls/{id}">` — most authoritative.
 *  2. `<meta property="og:url" content=".../calls/{id}">` — open-graph URL.
 *  3. First `/calls/{n}` substring anywhere in the response (anchor tags,
 *     embedded JSON, JS bundles) — last-resort, but works as long as the
 *     id appears somewhere.
 *
 * Returns `null` if none match.
 */
/**
 * Diagnostic-only: describe what kinds of data containers exist in a Fathom
 * share-page response. Does NOT include any actual meeting content (titles,
 * names, transcript text) — only structural fingerprints + counts/sizes.
 *
 * Output is a single comma-separated line, safe to paste into a bug report.
 */
function describeShareHtmlStructure(html: string): string {
  const notes: string[] = [];
  notes.push(`size=${html.length}B`);

  // Common SPA hydration patterns. Their presence tells us where the
  // initial data lives so we can write a targeted extractor next.
  if (/<script[^>]+id=["']__NEXT_DATA__["']/i.test(html)) notes.push("__NEXT_DATA__");
  if (/window\.__INITIAL_STATE__\s*=/.test(html)) notes.push("__INITIAL_STATE__");
  if (/window\.__PRELOADED_STATE__\s*=/.test(html)) notes.push("__PRELOADED_STATE__");
  if (/__APOLLO_STATE__/.test(html)) notes.push("__APOLLO_STATE__");
  if (/window\.__NUXT__/.test(html)) notes.push("__NUXT__");
  if (/window\.__remixContext/.test(html)) notes.push("__remixContext");
  if (/data-page=/.test(html)) notes.push("inertia-page");

  // Embedded JSON blocks (often where SSR'd state lives).
  const ldJson = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi);
  if (ldJson) notes.push(`json-ld×${ldJson.length}`);
  const appJson = html.match(/<script[^>]+type=["']application\/json["'][^>]*>/gi);
  if (appJson) notes.push(`app-json×${appJson.length}`);

  // Content-shape fingerprints. We can't tell what's in them, just that
  // there are containers consistent with a transcript / summary render.
  const articleCount = (html.match(/<article\b/gi) ?? []).length;
  if (articleCount) notes.push(`<article>×${articleCount}`);
  const sectionCount = (html.match(/<section\b/gi) ?? []).length;
  if (sectionCount) notes.push(`<section>×${sectionCount}`);
  if (/data-testid=["'][^"']*transcript/i.test(html)) notes.push("transcript-testid");
  if (/class=["'][^"']*transcript/i.test(html)) notes.push("transcript-class");
  if (/data-testid=["'][^"']*summary/i.test(html)) notes.push("summary-testid");

  // Bare-minimum meta tags (presence only).
  if (/<meta[^>]+property=["']og:title["']/i.test(html)) notes.push("og:title");
  if (/<meta[^>]+property=["']og:description["']/i.test(html)) notes.push("og:description");
  if (/<link[^>]+rel=["']canonical["']/i.test(html)) notes.push("canonical");

  // API endpoint hints. Many SPAs leave their backend URLs in the bundle.
  // Report path patterns only (no query strings, no tokens).
  const apiPaths = new Set<string>();
  const apiMatches = html.matchAll(/["'](\/api\/[A-Za-z0-9_\-\/]+)["']/g);
  for (const m of apiMatches) {
    if (apiPaths.size >= 10) break;
    apiPaths.add(m[1]);
  }
  if (apiPaths.size > 0) notes.push(`api-paths=[${[...apiPaths].join(",")}]`);

  // Root selectors (helps identify the JS framework).
  if (/<div[^>]+id=["']root["']/i.test(html)) notes.push("#root");
  if (/<div[^>]+id=["']__next["']/i.test(html)) notes.push("#__next");
  if (/<div[^>]+id=["']app["']/i.test(html)) notes.push("#app");

  return notes.join(", ");
}

interface InertiaPage {
  component?: unknown;
  props?: unknown;
  url?: unknown;
  version?: unknown;
}

/**
 * Extract and parse Fathom's Inertia.js page payload. Inertia stores the
 * full SSR'd page state in `<div id="app" data-page="…">` as HTML-escaped
 * JSON. We decode the attribute, parse it, and return the page object so
 * callers can read `component` / `props` / etc.
 *
 * Returns `null` if the attribute is missing, can't be decoded, or doesn't
 * parse as a JSON object.
 */
function extractInertiaPageData(html: string): InertiaPage | null {
  const m = html.match(
    /<div[^>]+id=["']app["'][^>]*\sdata-page=(["'])((?:(?!\1).)*)\1/i
  );
  if (!m) return null;

  const decoded = decodeHtmlEntities(m[2]);
  try {
    const parsed = JSON.parse(decoded);
    if (isPlainObject(parsed)) return parsed;
    return null;
  } catch (err) {
    console.warn("[Fathom Sync] Failed to parse Inertia data-page JSON:", err);
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&#60;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#62;/g, ">")
    .replace(/&amp;/g, "&"); // must be last
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Describe the SHAPE of an arbitrary object — its keys, their types, and
 * array lengths / nested object shapes (up to a depth limit). Does NOT
 * include any leaf values, so the output is safe to log even when the
 * source object contains private meeting content.
 */
function describeObjectShape(obj: Record<string, unknown>, depth: number): string {
  if (depth > 2) return "{…}";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (parts.length >= 30) {
      parts.push("…");
      break;
    }
    parts.push(`${key}:${describeValueShape(value, depth + 1)}`);
  }
  return `{${parts.join(", ")}}`;
}

function describeValueShape(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const sample = value[0];
    if (isPlainObject(sample)) {
      return `[${value.length}×${describeObjectShape(sample, depth)}]`;
    }
    return `[${value.length}×${describeValueShape(sample, depth)}]`;
  }
  if (isPlainObject(value)) {
    return describeObjectShape(value, depth);
  }
  if (typeof value === "string") {
    return value.length > 50 ? "string(long)" : "string";
  }
  return typeof value;
}

/**
 * Pluck the meeting-metadata fields we need out of Fathom's Inertia
 * `props.call` object. Returns `null` if the shape isn't what we expect
 * (e.g. token revoked → page renders a different component, or Fathom
 * renames fields).
 *
 * Defensive: every field is type-checked before use. Missing optional
 * fields fall back to sensible empties.
 */
function extractScrapedCall(props: Record<string, unknown>): ScrapedCall | null {
  const call = props.call;
  if (!isPlainObject(call)) return null;

  const id = typeof call.id === "number" ? call.id : null;
  const title = typeof call.title === "string" ? call.title : null;
  if (id === null || title === null) return null;

  const byline = typeof call.byline === "string" ? call.byline : "";
  const startedAt =
    typeof call.started_at === "string" ? call.started_at : new Date().toISOString();
  const durationMinutes =
    typeof call.duration_minutes === "number" ? call.duration_minutes : 0;

  let hostEmail = "";
  if (isPlainObject(call.host) && typeof call.host.email === "string") {
    hostEmail = call.host.email;
  }

  let companyName: string | null = null;
  if (isPlainObject(call.company) && typeof call.company.name === "string") {
    companyName = call.company.name;
  }

  const topic = typeof call.topic === "string" && call.topic.length > 0 ? call.topic : null;

  return { id, title, byline, startedAt, durationMinutes, hostEmail, companyName, topic };
}

function extractStringProp(props: Record<string, unknown>, key: string): string | null {
  const v = props[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractRecordingIdFromShareHtml(html: string): number | null {
  const canonical = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/calls\/(\d+)/i
  );
  if (canonical) return Number(canonical[1]);

  const og = html.match(
    /<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']*\/calls\/(\d+)/i
  );
  if (og) return Number(og[1]);

  const any = html.match(/\/calls\/(\d+)/);
  if (any) return Number(any[1]);

  return null;
}
