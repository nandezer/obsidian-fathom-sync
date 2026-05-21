// Unit tests for parseFathomReference. Pure function — no Obsidian harness.
// Run with: node --test tests/lib/fathom-url.test.ts   (Node 24+; TS strip is default)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseFathomReference } from "../../src/utils/fathomUrl.ts";

test("bare numeric id", () => {
  const r = parseFathomReference("145099015");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("numeric id with whitespace is trimmed", () => {
  const r = parseFathomReference("  145099015  ");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with numeric segment → recording_id", () => {
  const r = parseFathomReference("https://fathom.video/calls/145099015");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with www subdomain", () => {
  const r = parseFathomReference("https://www.fathom.video/calls/145099015");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with http (not https)", () => {
  const r = parseFathomReference("http://fathom.video/calls/145099015");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with trailing slash", () => {
  const r = parseFathomReference("https://fathom.video/calls/145099015/");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with query string", () => {
  const r = parseFathomReference("https://fathom.video/calls/145099015?utm=foo");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with fragment", () => {
  const r = parseFathomReference("https://fathom.video/calls/145099015#section");
  assert.deepEqual(r, { kind: "recording_id", id: 145099015 });
});

test("calls URL with non-numeric segment → share_token", () => {
  const r = parseFathomReference("https://fathom.video/calls/abc-def_123");
  assert.deepEqual(r, {
    kind: "share_token",
    token: "abc-def_123",
    canonicalUrl: "https://fathom.video/calls/abc-def_123",
  });
});

test("share URL no letter prefix", () => {
  const r = parseFathomReference("https://fathom.video/share/abc123XYZ");
  assert.deepEqual(r, {
    kind: "share_token",
    token: "abc123XYZ",
    canonicalUrl: "https://fathom.video/calls/abc123XYZ",
  });
});

test("share URL /share/h/{token}", () => {
  const r = parseFathomReference("https://fathom.video/share/h/abc123");
  assert.deepEqual(r, {
    kind: "share_token",
    token: "abc123",
    canonicalUrl: "https://fathom.video/calls/abc123",
  });
});

test("share URL /share/i/{token}", () => {
  const r = parseFathomReference("https://fathom.video/share/i/foo-bar_baz");
  assert.deepEqual(r, {
    kind: "share_token",
    token: "foo-bar_baz",
    canonicalUrl: "https://fathom.video/calls/foo-bar_baz",
  });
});

test("share URL /share/p/{token}", () => {
  const r = parseFathomReference("https://fathom.video/share/p/tok1");
  assert.equal(r.kind, "share_token");
});

test("share URL /share/u/{token}", () => {
  const r = parseFathomReference("https://fathom.video/share/u/tok2");
  assert.equal(r.kind, "share_token");
});

test("share URL with trailing slash and query", () => {
  const r = parseFathomReference("https://www.fathom.video/share/h/token123/?ref=email");
  assert.deepEqual(r, {
    kind: "share_token",
    token: "token123",
    canonicalUrl: "https://fathom.video/calls/token123",
  });
});

test("empty string → unknown:empty", () => {
  assert.deepEqual(parseFathomReference(""), {
    kind: "unknown",
    reason: "empty",
  });
});

test("only whitespace → unknown:empty", () => {
  assert.deepEqual(parseFathomReference("   "), {
    kind: "unknown",
    reason: "empty",
  });
});

test("over-length input → unknown:too_long", () => {
  const huge = "a".repeat(501);
  assert.deepEqual(parseFathomReference(huge), {
    kind: "unknown",
    reason: "too_long",
  });
});

test("non-Fathom https URL → unknown:unrecognised_scheme", () => {
  assert.deepEqual(parseFathomReference("https://google.com"), {
    kind: "unknown",
    reason: "unrecognised_scheme",
  });
});

test("non-Fathom http URL → unknown:unrecognised_scheme", () => {
  assert.deepEqual(parseFathomReference("http://example.org/calls/123"), {
    kind: "unknown",
    reason: "unrecognised_scheme",
  });
});

test("garbage text → unknown:no_recognisable_id", () => {
  assert.deepEqual(parseFathomReference("not-a-url"), {
    kind: "unknown",
    reason: "no_recognisable_id",
  });
});

test("javascript: URL rejected", () => {
  const r = parseFathomReference("javascript:alert(1)");
  assert.equal(r.kind, "unknown");
});

test("Unicode digits rejected (Arabic-Indic)", () => {
  // ١٤٥٠٩٩٠١٥ would `Number()` to NaN — must not pass the numeric branch.
  const r = parseFathomReference("١٤٥٠٩٩٠١٥");
  assert.equal(r.kind, "unknown");
  assert.equal((r as { reason?: string }).reason, "no_recognisable_id");
});

test("fathom.video path that isn't calls or share → unknown", () => {
  const r = parseFathomReference("https://fathom.video/about");
  assert.equal(r.kind, "unknown");
});

test("calls URL with malformed segment (over 200 chars) rejected", () => {
  const longSeg = "a".repeat(201);
  const r = parseFathomReference(`https://fathom.video/calls/${longSeg}`);
  assert.equal(r.kind, "unknown");
});

test("calls URL with segment containing forbidden chars rejected", () => {
  const r = parseFathomReference("https://fathom.video/calls/abc!def");
  assert.equal(r.kind, "unknown");
});

test("zero-padded numeric id parses correctly", () => {
  const r = parseFathomReference("0001");
  assert.deepEqual(r, { kind: "recording_id", id: 1 });
});

test("very large numeric id stays a Number", () => {
  const r = parseFathomReference("999999999999");
  assert.deepEqual(r, { kind: "recording_id", id: 999999999999 });
});
