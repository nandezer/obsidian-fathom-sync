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

/** Return an ISO datetime string for N days ago */
export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** Sanitise a string for use as a filename (replaces unsafe chars) */
export function toSafeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim();
}
