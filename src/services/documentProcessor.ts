import type { FathomMeeting, FathomSummary, FathomTranscriptSegment } from "../types";
import type { FathomSyncSettings } from "../settings";
import { isoToDate, toSafeFilename, nowIso } from "../utils/dateUtils";

export interface ProcessedNote {
  filename: string;
  folder: string;
  content: string;
}

export class DocumentProcessor {
  constructor(private readonly settings: FathomSyncSettings) {}

  buildFilename(meeting: FathomMeeting): string {
    const date = isoToDate(meeting.created_at);
    const title = toSafeFilename(meeting.title || "Untitled");
    const id = String(meeting.recording_id);

    let pattern = this.settings.noteFilenamePattern || "{date} {title}";

    // Defensive: if the user's pattern has no recognised tokens, fall back
    // to a sane default so we don't collapse every note to the same name.
    if (!pattern.includes("{date}") && !pattern.includes("{title}") && !pattern.includes("{id}")) {
      pattern = "{date} {title}";
    }

    const result = pattern
      .replace(/\{date\}/g, date)
      .replace(/\{title\}/g, title)
      .replace(/\{id\}/g, id)
      .trim();

    // Final safety net: always suffix with the recording_id if the result
    // doesn't already contain it, so two meetings can never collide.
    return result.includes(id) ? result : `${result} (${id})`;
  }

  buildSummaryNote(
    meeting: FathomMeeting,
    summary: FathomSummary,
    transcriptPath?: string,
    extraFrontmatter?: Record<string, string>
  ): ProcessedNote {
    const filename = this.buildFilename(meeting);
    const folder = this.settings.summaryFolder;

    const recorderName = meeting.recorded_by?.name ?? "Unknown";
    const recorderEmail = meeting.recorded_by?.email ?? "";
    const attendees = (meeting.calendar_invitees ?? [])
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    const frontmatter = [
      "---",
      `fathom_id: ${meeting.recording_id}`,
      `fathom_url: ${yamlString(meeting.url)}`,
      `title: ${yamlString(meeting.title)}`,
      `recorded_by: ${yamlString(recorderName)}`,
      `recorded_by_email: ${yamlString(recorderEmail)}`,
      `attendees:`,
      ...attendees.map((a) => `  - ${yamlString(a)}`),
      `created_at: ${yamlString(meeting.created_at)}`,
      `synced_at: ${yamlString(nowIso())}`,
      `synced_by: fathom-sync`,
      `type: summary`,
      transcriptPath ? `transcript: ${yamlString(`[[${transcriptPath}]]`)}` : null,
      ...buildExtraFrontmatterLines(extraFrontmatter),
      "---",
    ]
      .filter((line) => line !== null)
      .join("\n");

    const body = [
      `# ${meeting.title}`,
      "",
      `[View recording](${meeting.url})  `,
      `**Recorded by:** ${recorderName}  `,
      `**Attendees:** ${attendees.join(", ") || "—"}`,
      "",
      "## Summary",
      "",
      summary.markdown_formatted,
    ].join("\n");

    return { filename, folder, content: `${frontmatter}\n\n${body}\n` };
  }

  buildTranscriptNote(
    meeting: FathomMeeting,
    segments: FathomTranscriptSegment[],
    summaryPath: string,
    extraFrontmatter?: Record<string, string>
  ): ProcessedNote {
    const filename = this.buildFilename(meeting);
    const folder = this.settings.transcriptFolder;

    const frontmatter = [
      "---",
      `fathom_id: ${meeting.recording_id}`,
      `fathom_url: ${yamlString(meeting.url)}`,
      `title: ${yamlString(meeting.title)}`,
      `type: transcript`,
      `synced_by: fathom-sync`,
      `note: ${yamlString(`[[${summaryPath}]]`)}`,
      `synced_at: ${yamlString(nowIso())}`,
      ...buildExtraFrontmatterLines(extraFrontmatter),
      "---",
    ].join("\n");

    const safeSegments = Array.isArray(segments) ? segments : [];
    const lines = safeSegments.map((seg) => {
      const ts = typeof seg.timestamp === "string" ? seg.timestamp : "00:00:00";
      const secs = hhmmssToSeconds(ts);
      const link = `${meeting.url}?timestamp=${secs}`;
      const speakerName = speakerToString(seg.speaker);
      const text = typeof seg.text === "string" ? seg.text : "";
      return `[${ts}](${link}) **${speakerName}:** ${text}`;
    });

    const body = [
      `# ${meeting.title} — Transcript`,
      "",
      `[View recording](${meeting.url})`,
      "",
      ...lines,
    ].join("\n");

    return { filename, folder, content: `${frontmatter}\n\n${body}\n` };
  }
}

/**
 * Quote a value as a YAML single-quoted scalar. Single-quoted scalars in YAML
 * 1.2 only need `'` doubled — no other escaping. This avoids the brittle
 * backslash-escaping that double-quoted YAML demands and that the previous
 * implementation got partially wrong.
 */
function yamlString(value: string): string {
  const safe = value.replace(/'/g, "''");
  return `'${safe}'`;
}

const FRONTMATTER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render caller-supplied frontmatter pairs as `key: 'value'` lines. Skips any
 * key that doesn't match a strict identifier shape (would otherwise let a
 * caller break out of the YAML block with `:` or newline in the key), and
 * escapes literal newlines in values (YAML 1.2 single-quoted scalars preserve
 * `\n` literally, which would split the frontmatter prematurely).
 */
function buildExtraFrontmatterLines(
  extra?: Record<string, string>
): string[] {
  if (!extra) return [];
  const lines: string[] = [];
  for (const [key, rawValue] of Object.entries(extra)) {
    if (!FRONTMATTER_KEY_RE.test(key)) continue;
    // Replace any line break form — \r\n, lone \n, or bare \r — so a value
    // can't span lines and break out of the YAML scalar.
    const value = String(rawValue ?? "").replace(/\r\n|\r|\n/g, "\\n");
    lines.push(`${key}: ${yamlString(value)}`);
  }
  return lines;
}

function speakerToString(speaker: unknown): string {
  if (!speaker) return "Unknown";
  if (typeof speaker === "string") return speaker;
  if (typeof speaker === "object") {
    const obj = speaker as Record<string, unknown>;
    return (
      (typeof obj.display_name === "string" && obj.display_name) ||
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.email === "string" && obj.email) ||
      "Unknown"
    );
  }
  return String(speaker);
}

function hhmmssToSeconds(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}
