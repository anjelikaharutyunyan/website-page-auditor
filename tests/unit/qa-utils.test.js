const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../../js/qa/qa-utils.js");

test("parseColor handles rgb, rgba, hex and transparent", () => {
  assert.deepEqual(U.parseColor("rgb(255, 0, 10)"), { r: 255, g: 0, b: 10, a: 1 });
  assert.deepEqual(U.parseColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(U.parseColor("rgb(0 128 255 / 50%)"), { r: 0, g: 128, b: 255, a: 0.5 });
  assert.deepEqual(U.parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(U.parseColor("transparent").a, 0);
  assert.equal(U.parseColor("oklch(0.5 0.1 200)"), null);
});

test("contrastRatio matches WCAG reference values", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  assert.equal(U.round(U.contrastRatio(black, white), 2), 21);
  assert.equal(U.round(U.contrastRatio(white, white), 2), 1);
  // #767676 on white is the classic 4.54:1 borderline pass.
  assert.equal(U.round(U.contrastRatio({ r: 118, g: 118, b: 118 }, white), 2), 4.54);
});

test("blend composites semi-transparent colours", () => {
  const out = U.blend({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(Math.round(out.r), 128);
  assert.equal(out.a, 1);
});

test("large text thresholds and required contrast", () => {
  assert.equal(U.isLargeText(24, 400), true);
  assert.equal(U.isLargeText(19, 700), true);
  assert.equal(U.isLargeText(19, 400), false);
  assert.equal(U.requiredContrast(16, 400), 4.5);
  assert.equal(U.requiredContrast(30, 400), 3);
});

test("analyzeImageFit: proportional scaling is not distortion", () => {
  const r = U.analyzeImageFit({ naturalWidth: 1600, naturalHeight: 900, boxWidth: 800, boxHeight: 450, objectFit: "fill" });
  assert.equal(r.distorted, false);
  assert.equal(r.croppedFraction, 0);
  assert.equal(r.scale, 0.5);
});

test("analyzeImageFit: 1px rounding is tolerated, real stretch is flagged", () => {
  assert.equal(U.analyzeImageFit({ naturalWidth: 1000, naturalHeight: 667, boxWidth: 300, boxHeight: 201 }).distorted, false);
  const stretched = U.analyzeImageFit({ naturalWidth: 800, naturalHeight: 600, boxWidth: 400, boxHeight: 400, objectFit: "fill" });
  assert.equal(stretched.distorted, true);
  assert.ok(stretched.ratioDelta > 0.2);
});

test("analyzeImageFit: object-fit cover crops instead of distorting", () => {
  const r = U.analyzeImageFit({ naturalWidth: 1600, naturalHeight: 900, boxWidth: 400, boxHeight: 400, objectFit: "cover" });
  assert.equal(r.distorted, false);
  // 16:9 into a square keeps 9/16 of the width visible.
  assert.equal(U.round(r.croppedFraction, 3), U.round(1 - 9 / 16, 3));
  assert.equal(r.letterboxed, false);
});

test("analyzeImageFit: contain letterboxes without cropping", () => {
  const r = U.analyzeImageFit({ naturalWidth: 1600, naturalHeight: 900, boxWidth: 400, boxHeight: 400, objectFit: "contain" });
  assert.equal(r.croppedFraction, 0);
  assert.equal(r.letterboxed, true);
});

test("analyzeImageFit: unknown sizes return neutral output", () => {
  const r = U.analyzeImageFit({ naturalWidth: 0, naturalHeight: 0, boxWidth: 100, boxHeight: 100 });
  assert.equal(r.distorted, false);
  assert.equal(r.naturalRatio, null);
});

test("oversizeFactor accounts for device pixel ratio", () => {
  assert.equal(U.oversizeFactor({ naturalWidth: 2000, naturalHeight: 2000, renderedWidth: 500, renderedHeight: 500, dpr: 1 }), 16);
  assert.equal(U.oversizeFactor({ naturalWidth: 1000, naturalHeight: 1000, renderedWidth: 500, renderedHeight: 500, dpr: 2 }), 1);
  assert.equal(U.oversizeFactor({ naturalWidth: 0, naturalHeight: 0, renderedWidth: 5, renderedHeight: 5 }), null);
});

test("classifyHref covers placeholder, javascript, fragment, same-origin and external", () => {
  const page = "https://example.com/products/list?page=2";
  assert.equal(U.classifyHref(null, page).kind, "missing");
  assert.equal(U.classifyHref("", page).kind, "empty");
  assert.equal(U.classifyHref("#", page).kind, "placeholder");
  assert.deepEqual(U.classifyHref("javascript:void(0)", page), { kind: "javascript", noop: true });
  assert.equal(U.classifyHref("javascript:openMenu()", page).noop, false);
  const frag = U.classifyHref("#reviews", page);
  assert.equal(frag.kind, "fragment");
  assert.equal(frag.fragment, "reviews");
  const same = U.classifyHref("/products/list?page=2#top", page);
  assert.equal(same.kind, "same-origin");
  assert.equal(same.samePage, true);
  assert.equal(U.classifyHref("/about", page).samePage, false);
  assert.equal(U.classifyHref("https://other.org/x", page).kind, "external");
});

test("classifyHref reports malformed values", () => {
  const page = "https://example.com/";
  assert.ok(U.classifyHref("https:/example.com", page).issues.includes("malformed scheme separator"));
  assert.ok(U.classifyHref(" /about ", page).issues.includes("leading/trailing whitespace"));
  assert.ok(U.classifyHref("/my page", page).issues.includes("unencoded whitespace"));
  assert.ok(U.classifyHref("mailto:not-an-address", page).issues.includes("mailto address looks invalid"));
  assert.equal(U.classifyHref("tel:+1-555-0100", page).issues.length, 0);
  assert.equal(U.classifyHref("ftp://files.example.com/a", page).kind, "other-scheme");
  assert.equal(U.classifyHref("http://[bad", page).kind, "malformed");
});

test("isRestrictedUrl blocks browser and store pages only", () => {
  assert.equal(U.isRestrictedUrl("chrome://extensions"), true);
  assert.equal(U.isRestrictedUrl("chrome-extension://abc/popup.html"), true);
  assert.equal(U.isRestrictedUrl("https://chromewebstore.google.com/detail/x"), true);
  assert.equal(U.isRestrictedUrl(""), true);
  assert.equal(U.isRestrictedUrl("https://example.com"), false);
  assert.equal(U.isRestrictedUrl("file:///C:/site/index.html"), false);
});

test("interpretHttpStatus distinguishes broken from unverifiable", () => {
  assert.equal(U.interpretHttpStatus(200).status, "passed");
  assert.equal(U.interpretHttpStatus(301).status, "passed");
  assert.deepEqual(U.interpretHttpStatus(404), { status: "failed", severity: "high" });
  assert.equal(U.interpretHttpStatus(403).unverifiable, true);
  assert.equal(U.interpretHttpStatus(429).status, "warning");
  assert.equal(U.interpretHttpStatus(503).severity, "medium");
  assert.equal(U.interpretHttpStatus(400).status, "failed");
});

test("DESTRUCTIVE_RE matches risky controls but not ordinary ones", () => {
  for (const s of ["Delete account", "Log out", "Sign out", "Buy now", "Checkout", "Place order", "Unsubscribe", "Add to cart", "Submit"]) {
    assert.ok(U.DESTRUCTIVE_RE.test(s), s);
  }
  for (const s of ["Menu", "Show more", "Next slide", "Open filters", "FAQ"]) assert.ok(!U.DESTRUCTIVE_RE.test(s), s);
  assert.ok(U.DESTRUCTIVE_URL_RE.test("/account/logout"));
  assert.ok(!U.DESTRUCTIVE_URL_RE.test("/blog/post-1"));
});

test("sameRoute treats in-page anchors as the same page and SPA routes as different", () => {
  assert.ok(U.sameRoute("https://a.com/shop?p=1", "https://a.com/shop?p=1#reviews"));
  assert.ok(!U.sameRoute("https://a.com/shop", "https://a.com/cart"));
  assert.ok(!U.sameRoute("https://a.com/shop?p=1", "https://a.com/shop?p=2"));
  assert.ok(!U.sameRoute("https://a.com/#/shop", "https://a.com/#/cart"));
  assert.ok(!U.sameRoute("https://a.com/", "https://b.com/"));
});

test("selectorPattern ignores list position and numbers in ids/classes", () => {
  assert.equal(U.selectorPattern("#product-12 > button.fav"), U.selectorPattern("#product-97 > button.fav"));
  assert.equal(U.selectorPattern("ul.tiles > li.tile:nth-of-type(3) > button"), U.selectorPattern("ul.tiles > li.tile:nth-of-type(18) > button"));
  assert.notEqual(U.selectorPattern("#product-12 > button.fav"), U.selectorPattern("#product-12 > button.cart"));
  assert.notEqual(U.selectorPattern("#close-x"), U.selectorPattern("#product-1 > button.fav"));
});

test("dedupeResults groups a repeated component into one result with every location", () => {
  const base = { testId: "interactions.no-name", category: "interactions", status: "failed", severity: "high" };
  const many = Array.from({ length: 100 }, (_, i) => ({ ...base, selector: `#product-${i + 1} > button.fav` }));
  const out = U.dedupeResults([...many, { ...base, selector: "#close-x" }]);
  assert.equal(out.length, 2);
  const group = out.find((r) => r.selector.startsWith("#product-"));
  assert.equal(group.occurrences, 100);
  assert.equal(group.instances.length, 100);
  assert.equal(group.instances[99].selector, "#product-100 > button.fav");
});

test("dedupeResults merges identical findings and counts occurrences", () => {
  const r = { testId: "layout.text-clipped", selector: "p.a", category: "layout", status: "failed", severity: "medium" };
  const out = U.dedupeResults([r, { ...r }, { ...r, selector: "p.b" }, { ...r, viewport: { width: 375, height: 812 } }]);
  assert.equal(out.length, 3);
  assert.equal(out.find((x) => x.selector === "p.a" && !x.viewport).occurrences, 2);
});

test("summarize counts statuses, open severities, categories and verification", () => {
  const s = U.summarize([
    { status: "failed", severity: "high", category: "links", verification: "verified" },
    { status: "warning", severity: "low", category: "links", verification: "inferred" },
    { status: "passed", severity: "info", category: "images", verification: "verified" },
    { status: "manual", severity: "info", category: "forms", verification: "manual" },
  ]);
  assert.deepEqual(s.byStatus, { failed: 1, warning: 1, manual: 1, passed: 1 });
  assert.equal(s.bySeverity.high, 1);
  assert.equal(s.bySeverity.info, 1, "passed results are not counted as open severities");
  assert.deepEqual(s.byCategory.links, { failed: 1, warning: 1, manual: 0, passed: 0 });
  assert.equal(s.byVerification.inferred, 1);
});

test("sortResults orders by status then severity", () => {
  const sorted = U.sortResults([
    { status: "passed", severity: "info", category: "a", name: "a" },
    { status: "failed", severity: "low", category: "a", name: "b" },
    { status: "failed", severity: "critical", category: "a", name: "c" },
    { status: "manual", severity: "info", category: "a", name: "d" },
  ]);
  assert.deepEqual(sorted.map((r) => r.name), ["c", "b", "d", "a"]);
});

test("mergeResults replaces only the re-run scope", () => {
  const existing = [
    { testId: "links.no-name", sourceTest: "links.no-name", category: "links", selector: "a.1", status: "failed" },
    { testId: "links.keyboard", sourceTest: "links.keyboard", category: "links", selector: "a.2", status: "failed" },
    { testId: "layout.tiny-text", sourceTest: "layout.tiny-text", category: "layout", selector: "p", status: "warning" },
  ];
  const incoming = [{ testId: "links.no-name", sourceTest: "links.no-name", category: "links", selector: "a.9", status: "failed" }];
  const merged = U.mergeResults(existing, incoming, { categories: ["links"], testIds: ["links.no-name"] });
  assert.deepEqual(merged.map((r) => r.selector).sort(), ["a.2", "a.9", "p"]);

  const full = U.mergeResults(existing, incoming, { categories: ["links"] });
  assert.deepEqual(full.map((r) => r.selector).sort(), ["a.9", "p"]);
});

test("mergeResults uses sourceTest for sub-results and viewports for responsive", () => {
  const existing = [
    { testId: "a11y.lang", sourceTest: "a11y.document", category: "accessibility", status: "failed" },
    { testId: "layout.horizontal-overflow", category: "responsive", viewport: { width: 375, height: 812 }, status: "failed" },
    { testId: "layout.horizontal-overflow", category: "responsive", viewport: { width: 768, height: 1024 }, status: "failed" },
  ];
  const a = U.mergeResults(existing, [], { categories: ["accessibility"], testIds: ["a11y.document"] });
  assert.equal(a.filter((r) => r.category === "accessibility").length, 0);
  const b = U.mergeResults(existing, [], { categories: ["responsive"], viewports: [{ width: 375, height: 812 }] });
  assert.deepEqual(b.filter((r) => r.category === "responsive").map((r) => r.viewport.width), [768]);
});

test("sanitizeEvidence drops sensitive keys and truncates long strings", () => {
  const out = U.sanitizeEvidence({ value: "hunter2", password: "x", fieldType: "email", nested: { token: "abc", ok: 1 }, long: "y".repeat(900) });
  assert.equal(out.value, undefined);
  assert.equal(out.password, undefined);
  assert.equal(out.nested.token, undefined);
  assert.equal(out.nested.ok, 1);
  assert.equal(out.fieldType, "email");
  assert.equal(out.long.length, 500);
});

test("viewport presets cover the required sizes", () => {
  const sizes = U.VIEWPORT_PRESETS.map((v) => `${v.width}x${v.height}`);
  assert.deepEqual(sizes, ["320x568", "375x812", "430x932", "768x1024", "1366x768", "1920x1080"]);
});

test("formatBytes and truncate", () => {
  assert.equal(U.formatBytes(512), "512 B");
  assert.equal(U.formatBytes(2048), "2.0 KB");
  assert.equal(U.formatBytes(null), "unknown");
  assert.equal(U.truncate("abcdef", 4), "abc…");
});
