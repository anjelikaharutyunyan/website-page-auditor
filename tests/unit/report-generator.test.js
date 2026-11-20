const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../js/report-generator.js");

function sampleReport() {
  return {
    meta: {
      url: "https://example.com/?q=<script>",
      title: 'Shop "Home" <b>',
      startedAt: "2026-10-09T10:00:00.000Z",
      durationMs: 1234,
      extensionVersion: "3.0.0",
      baseViewport: { width: 1280, height: 720, dpr: 1 },
      viewportsTested: [{ label: "Typical mobile", width: 375, height: 812, method: "emulation", actualWidth: 375, actualHeight: 812 }],
    },
    categories: {
      links: { status: "completed", ran: ["links.no-name"], skipped: [{ name: "Internal link status", reason: "timed out" }], limitations: ["Only top frame scanned"], durationMs: 20, extras: { externalLinks: [{ url: "https://x.org", ref: "r1" }] } },
      images: { status: "completed", ran: [], skipped: [], limitations: [], durationMs: 5, extras: { imageInventory: [{ src: "a.jpg", kind: "img", ref: "r2", natural: { width: 10, height: 10 } }] } },
    },
    results: [
      { testId: "links.no-name", category: "links", name: "Link without name", status: "failed", severity: "high", verification: "verified", message: "Link <a> has no name", selector: "a.icon", ref: "abc-1", evidence: { href: "/x" } },
      { testId: "links.no-name", category: "links", name: "Link without name", status: "failed", severity: "high", verification: "verified", message: "dup", selector: "a.icon", ref: "abc-1" },
      { testId: "images.broken", category: "images", name: "Broken image", status: "passed", severity: "info", verification: "verified", message: "ok" },
      { testId: "layout.horizontal-overflow", category: "responsive", name: "Overflow", status: "warning", severity: "medium", verification: "inferred", message: "wide", viewport: { width: 375, height: 812, label: "Typical mobile" } },
    ],
    limitations: ["General limitation"],
  };
}

test("finalizeReport dedupes, sorts and summarizes", () => {
  const r = R.finalizeReport(sampleReport());
  assert.equal(r.schema, "web-qa-report/1");
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].occurrences, 2);
  assert.equal(r.results[0].status, "failed");
  assert.equal(r.summary.byStatus.failed, 1);
  assert.equal(r.summary.byStatus.passed, 1);
});
