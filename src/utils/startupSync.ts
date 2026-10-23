/**
 * Run one catch-up sync as soon as Obsidian's workspace layout is ready.
 *
 * The periodic setInterval first fires one full interval after load, so
 * without this a vault that was closed for days stays stale for the first
 * hour after reopening. Runs regardless of `periodicSyncEnabled` (Marc
 * 2026-10-24: "Always on startup"); skipped only when no API token is set,
 * so a fresh install doesn't flash "Sync failed".
 *
 * Pure function — no Obsidian import. Safe to unit-test from Node.
 *
 * @returns true if a sync was scheduled.
 */
export function scheduleStartupSync(
  apiToken: string,
  onLayoutReady: (cb: () => void) => void,
  sync: () => Promise<void>
): boolean {
  if (!apiToken.trim()) return false;
  onLayoutReady(() => {
    // triggerSync already logs and swallows sync errors; this catch only
    // guards against an unexpected rejection escaping into Obsidian.
    sync().catch(() => undefined);
  });
  return true;
}
