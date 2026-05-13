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
    transcriptPath?: string
  ): ProcessedNote {
    const filename = this.buildFilename(meeting);
    const folder = this.settings.summaryFolder;

    const recorderName = meeting.recorded_by?.name ?? "Unknown";
    const recorderEmail = meeting.recorded_by?.email ?? "";
    const attendees = (meeting.calendar_invitees ?? []).map((a) => a.name);

    const frontmatter = [
      "---",
      `fathom_id: ${meeting.recording_id}`,
      `fathom_url: "${meeting.url}"`,
      `title: "${escapeFrontmatterString(meeting.title)}"`,
      `recorded_by: "${escapeFrontmatterString(recorderName)}"`,
      `recorded_by_email: "${escapeFrontmatterString(recorderEmail)}"`,
      `attendees:`,
      ...attendees.map((a) => `  - "${escapeFrontmatterString(a)}"`),
      `created_at: "${meeting.created_at}"`,
      `synced_at: "${nowIso()}"`,
      `synced_by: fathom-sync`,
      `type: summary`,
      transcriptPath ? `transcript: "[[${transcriptPath}]]"` : null,
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
    summaryPath: string
  ): ProcessedNote {
    const filename = this.buildFilename(meeting);
    const folder = this.settings.transcriptFolder;

    const frontmatter = [
      "---",
      `fathom_id: ${meeting.recording_id}`,
      `fathom_url: "${meeting.url}"`,
      `title: "${escapeFrontmatterString(meeting.title)}"`,
      `type: transcript`,
      `synced_by: fathom-sync`,
      `note: "[[${summaryPath}]]"`,
      `synced_at: "${nowIso()}"`,
      "---",
    ].join("\n");

    const safeSegments = Array.isArray(segments) ? segments : [];
    const lines = safeSegments.map((seg) => {
      const secs = hhmmssToSeconds(seg.timestamp);
      const link = `${meeting.url}?timestamp=${secs}`;
      const speakerName = speakerToString(seg.speaker);
      return `[${seg.timestamp}](${link}) **${speakerName}:** ${seg.text}`;
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

function escapeFrontmatterString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
