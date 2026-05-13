// Fathom REST API response shapes (verified against live API)

export interface FathomInvitee {
  name: string;
  email: string;
  email_domain: string;
  is_external: boolean;
  matched_speaker_display_name: string | null;
}

export interface FathomRecordedBy {
  name: string;
  email: string;
  email_domain: string;
}

export interface FathomMeeting {
  recording_id: number;
  title: string;
  meeting_title: string;
  url: string;
  created_at: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
  recording_start_time?: string;
  recording_end_time?: string;
  calendar_invitees_domains_type?: string;
  transcript_language?: string;
  recorded_by: FathomRecordedBy;
  calendar_invitees: FathomInvitee[];
  default_summary?: FathomSummary | null;
  transcript?: FathomTranscriptSegment[] | null;
  action_items?: FathomActionItem[] | null;
}

export interface FathomSummary {
  template_name: string;
  markdown_formatted: string;
}

/**
 * Fathom's transcript "speaker" can be either a plain string or an object
 * (name + maybe email). We normalise in the processor.
 */
export type FathomSpeaker =
  | string
  | { name?: string; display_name?: string; email?: string; [k: string]: unknown };

export interface FathomTranscriptSegment {
  speaker: FathomSpeaker;
  text: string;
  timestamp: string; // HH:MM:SS format
}

export interface FathomActionItem {
  text: string;
  assignee?: string;
}

export interface FathomListResponse {
  items: FathomMeeting[];
  next_cursor?: string;
}

export interface FathomTeam {
  id: number;
  name: string;
}

// Plugin-internal types

export type SyncMode = "standard" | "full";

export type NoteType = "summary" | "transcript";

export interface NoteMetadata {
  fathom_id: number;
  fathom_url: string;
  title: string;
  recorded_by: string;
  attendees: string[];
  created_at: string;
  synced_at: string;
  type: NoteType;
  /** Wikilink to the paired note (summary ↔ transcript) */
  paired_note?: string;
}

/** Composite cache key: `{recording_id}-{type}` */
export type CacheKey = string;
