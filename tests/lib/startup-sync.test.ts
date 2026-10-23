// Unit tests for scheduleStartupSync. Pure function — no Obsidian harness.
// Run with: node --test tests/lib/startup-sync.test.ts   (Node 24+; TS strip is default)
//
// Bug 2026-10-24: the plugin only synced from the periodic setInterval, whose
// first tick fires one interval AFTER load. Obsidian was closed 21 to 24 Oct;
// on reopening, nothing synced for the first 60 minutes, and a launch shorter
// than one interval never synced at all.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scheduleStartupSync } from "../../src/utils/startupSync.ts";

function harness() {
  const ready: Array<() => void> = [];
  let syncs = 0;
  return {
    onLayoutReady: (cb: () => void) => {
      ready.push(cb);
    },
    sync: async () => {
      syncs++;
    },
    fireLayoutReady: () => ready.forEach((cb) => cb()),
    get syncs() {
      return syncs;
    },
    get pending() {
      return ready.length;
    },
  };
}

test("syncs once when the workspace layout is ready", () => {
  const h = harness();
  const scheduled = scheduleStartupSync("token", h.onLayoutReady, h.sync);
  assert.equal(scheduled, true);
  assert.equal(h.syncs, 0, "must not sync before layout ready (vault cache not built)");
  h.fireLayoutReady();
  assert.equal(h.syncs, 1);
});

test("does not depend on the periodic-sync setting", () => {
  // Marc 2026-10-24: "Always on startup". The helper takes no periodic flag.
  assert.equal(scheduleStartupSync.length, 3);
});

test("skips when no API token is set (fresh install)", () => {
  const h = harness();
  assert.equal(scheduleStartupSync("", h.onLayoutReady, h.sync), false);
  assert.equal(scheduleStartupSync("   ", h.onLayoutReady, h.sync), false);
  assert.equal(h.pending, 0);
  h.fireLayoutReady();
  assert.equal(h.syncs, 0);
});

test("a rejected sync does not throw out of the layout-ready callback", async () => {
  const ready: Array<() => void> = [];
  scheduleStartupSync(
    "token",
    (cb) => ready.push(cb),
    () => Promise.reject(new Error("offline"))
  );
  assert.doesNotThrow(() => ready.forEach((cb) => cb()));
  await new Promise((r) => setTimeout(r, 0));
});
