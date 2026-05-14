/** Format an ISO datetime string to YYYY-MM-DD */
export function isoToDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Format an ISO datetime string to a human-readable date */
export function isoToDisplay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Return the current UTC ISO datetime string */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Return an ISO datetime string for N days ago. Clamps `days` to [1, 3650]. */
export function daysAgoIso(days: number): string {
  const safeDays = Number.isFinite(days)
    ? Math.min(Math.max(Math.floor(days), 1), 3650)
    : 7;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - safeDays);
  return d.toISOString();
}

/** Sanitise a string for use as a filename (replaces unsafe chars) */
export function toSafeFilename(value: string): string {
  let out = value.replace(/[\\/:*?"<>|]/g, "-").trim();

  out = out.replace(/[.\s]+$/g, "").trim();

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(out)) {
    out = `_${out}`;
  }

  return out || "Untitled";
}
