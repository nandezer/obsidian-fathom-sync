/**
 * Parse a user-supplied Fathom reference (URL or bare recording id) into a
 * discriminated descriptor the importer can act on.
 *
 * Pure function — no side effects, no I/O. Safe to unit-test from Node.
 */

export type ParseFailure =
  | "empty"
  | "too_long"
  | "unrecognised_scheme"
  | "no_recognisable_id";

export type ParsedFathomReference =
  | { kind: "recording_id"; id: number }
  | { kind: "share_token"; token: string; canonicalUrl: string }
  | { kind: "unknown"; reason: ParseFailure };

const MAX_INPUT_LENGTH = 500;

// ASCII-digit only. `/^\d+$/` would accept Unicode digits like Arabic-Indic
// numerals (٠١٢) which then `Number()`-cast to NaN.
const NUMERIC_ID_RE = /^[0-9]+$/;

// Tight character class on the captured token prevents catastrophic
// backtracking and rejects anything that isn't a plausible Fathom slug.
const CALLS_URL_RE =
  /^https?:\/\/(?:www\.)?fathom\.video\/calls\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/;

const SHARE_URL_RE =
  /^https?:\/\/(?:www\.)?fathom\.video\/share(?:\/[a-z])?\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/;

export function parseFathomReference(input: string): ParsedFathomReference {
  const trimmed = (input ?? "").trim();

  if (trimmed.length === 0) {
    return { kind: "unknown", reason: "empty" };
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { kind: "unknown", reason: "too_long" };
  }

  // Bare numeric id first. A purely numeric share token would be unusual; if
  // Fathom ever issues one, the recording_id branch wins by ordering. Do not
  // invert without updating the importer's fallback flow.
  if (NUMERIC_ID_RE.test(trimmed)) {
    return { kind: "recording_id", id: Number(trimmed) };
  }

  const callsMatch = trimmed.match(CALLS_URL_RE);
  if (callsMatch) {
    const segment = callsMatch[1];
    if (NUMERIC_ID_RE.test(segment)) {
      return { kind: "recording_id", id: Number(segment) };
    }
    return {
      kind: "share_token",
      token: segment,
      canonicalUrl: `https://fathom.video/calls/${segment}`,
    };
  }

  const shareMatch = trimmed.match(SHARE_URL_RE);
  if (shareMatch) {
    const token = shareMatch[1];
    return {
      kind: "share_token",
      token,
      canonicalUrl: `https://fathom.video/calls/${token}`,
    };
  }

  // Looks like a URL but not a Fathom one we recognise.
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "unknown", reason: "unrecognised_scheme" };
  }

  return { kind: "unknown", reason: "no_recognisable_id" };
}
