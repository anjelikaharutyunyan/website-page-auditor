// Pure helpers shared by the in-page QA engine, the dashboard and the Node unit tests.
// Must not touch the DOM or chrome.* APIs.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__webQAUtils = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATUSES = ["failed", "warning", "manual", "passed"];
  const SEVERITIES = ["critical", "high", "medium", "low", "info"];
  const VERIFICATION = ["verified", "inferred", "manual"];

  const CATEGORIES = {
    layout: "Layout",
    responsive: "Responsive",
    images: "Images",
    links: "Links",
    interactions: "Interactions",
    forms: "Forms",
    search: "Search",
    accessibility: "Accessibility",
    elements: "Element sizes",
  };

  const VIEWPORT_PRESETS = [
    { id: "mobile-s", label: "Small mobile", width: 320, height: 568, mobile: true },
    { id: "mobile", label: "Typical mobile", width: 375, height: 812, mobile: true },
    { id: "mobile-l", label: "Large mobile", width: 430, height: 932, mobile: true },
    { id: "tablet", label: "Tablet", width: 768, height: 1024, mobile: true },
    { id: "laptop", label: "Laptop", width: 1366, height: 768, mobile: false },
    { id: "desktop", label: "Desktop", width: 1920, height: 1080, mobile: false },
  ];

  // Names of controls that must never be clicked/submitted automatically.
  const DESTRUCTIVE_RE =
    /\b(delete|remove|destroy|erase|drop|log ?out|sign ?out|unsubscribe|deactivate|cancel (?:my )?(?:account|subscription|order)|buy|purchase|pay|checkout|check out|place order|order now|subscribe|donate|transfer|send|submit|confirm|reset|clear all|empty cart|add to (?:cart|bag|basket))\b/i;

  const DESTRUCTIVE_URL_RE =
    /(log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe|cart\/add|add-to-cart|checkout|purchase|\/pay\b|cancel|deactivate)/i;

  // ---------------- colours & contrast ----------------

  function parseColor(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();
    if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, a)) };
    }
    m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null; // color(), lab(), oklch() etc. are treated as "not measurable"
  }

  // Composite `top` over an opaque-or-not `bottom` colour.
  function blend(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: ch(top.r, bottom.r), g: ch(top.g, bottom.g), b: ch(top.b, bottom.b), a };
  }

  function relativeLuminance({ r, g, b }) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(fg, bg) {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }

  // WCAG 1.4.3: large text is >= 24px, or >= 18.66px (14pt) when bold.
  function isLargeText(fontSizePx, fontWeight) {
    const w = Number(fontWeight) || (String(fontWeight) === "bold" ? 700 : 400);
    return fontSizePx >= 24 || (fontSizePx >= 18.66 && w >= 700);
  }

  function requiredContrast(fontSizePx, fontWeight) {
    return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
  }

  // ---------------- image geometry ----------------

  /**
   * Analyse how an image's natural pixels are mapped into its rendered content box.
   * Returns distortion and cropping information for the given object-fit.
   */
  function analyzeImageFit({ naturalWidth, naturalHeight, boxWidth, boxHeight, objectFit = "fill" }) {
    const out = {
      naturalRatio: null,
      renderedRatio: null,
      ratioDelta: null,
      distorted: false,
      croppedFraction: 0,
      letterboxed: false,
      scale: null,
    };
    if (!(naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0)) return out;

    const nr = naturalWidth / naturalHeight;
    const br = boxWidth / boxHeight;
    out.naturalRatio = round(nr, 3);
    out.renderedRatio = round(br, 3);
    out.ratioDelta = round(Math.abs(br - nr) / nr, 4);

    const fit = String(objectFit || "fill").toLowerCase();
    if (fit === "fill") {
      // A rounding difference of ~1px is not visible distortion.
      const expectedH = boxWidth / nr;
      out.distorted = out.ratioDelta > 0.03 && Math.abs(expectedH - boxHeight) > 2;
      out.scale = round(boxWidth / naturalWidth, 3);
      return out;
    }

    let scale;
    if (fit === "cover") scale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    else if (fit === "contain") scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    else if (fit === "none") scale = 1;
    else if (fit === "scale-down") scale = Math.min(1, Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight));
    else scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);

    const drawnW = naturalWidth * scale;
    const drawnH = naturalHeight * scale;
    const visibleW = Math.min(1, boxWidth / drawnW);
    const visibleH = Math.min(1, boxHeight / drawnH);
    out.scale = round(scale, 3);
    out.croppedFraction = round(1 - visibleW * visibleH, 4);
    out.letterboxed = drawnW < boxWidth - 1 || drawnH < boxHeight - 1;
    return out;
  }

  // How many more source pixels are delivered than the rendered box needs at this DPR.
  function oversizeFactor({ naturalWidth, naturalHeight, renderedWidth, renderedHeight, dpr = 1 }) {
    if (!(naturalWidth > 0 && naturalHeight > 0 && renderedWidth > 0 && renderedHeight > 0)) return null;
    const needed = renderedWidth * dpr * renderedHeight * dpr;
    return round((naturalWidth * naturalHeight) / needed, 2);
  }

  // ---------------- URLs ----------------

  /**
   * Classify a raw href relative to the page URL.
   * kind: empty | placeholder | javascript | fragment | same-origin | external | mailto | tel | other-scheme | malformed
   */
  function classifyHref(rawHref, pageUrl) {
    if (rawHref === null || rawHref === undefined) return { kind: "missing" };
    const raw = String(rawHref);
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "empty" };
    if (trimmed === "#" || /^#!?$/.test(trimmed)) return { kind: "placeholder" };
    if (/^javascript:/i.test(trimmed)) {
      const body = trimmed.replace(/^javascript:/i, "").trim().replace(/;$/, "");
      const noop = body === "" || /^void\s*\(?\s*0\s*\)?$/.test(body) || body === "undefined";
      return { kind: "javascript", noop };
    }
    const issues = [];
    if (raw !== trimmed) issues.push("leading/trailing whitespace");
    if (/^https?:\/[^/]/i.test(trimmed) || /^https?\/\//i.test(trimmed) || /^(https?)(?!:)\/\//i.test(trimmed)) {
      issues.push("malformed scheme separator");
    }
    if (/^htp:|^htps:|^http:\/\/\/|^https:\/\/\//i.test(trimmed)) issues.push("suspicious scheme");
    if (/\s/.test(trimmed) && !/^mailto:/i.test(trimmed)) issues.push("unencoded whitespace");

    let url;
    try {
      url = new URL(trimmed, pageUrl);
    } catch {
      return { kind: "malformed", issues: issues.concat("URL constructor rejected the value") };
    }
    const page = safeUrl(pageUrl);
    if (url.protocol === "mailto:") {
      const addr = decodeURIComponent(url.pathname || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+/.test(addr)) issues.push("mailto address looks invalid");
      return { kind: "mailto", url: url.href, issues };
    }
    if (url.protocol === "tel:") {
      if (!/[0-9]{3,}/.test(url.pathname.replace(/[^0-9]/g, ""))) issues.push("tel number looks invalid");
      return { kind: "tel", url: url.href, issues };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") {
      return { kind: "other-scheme", url: url.href, scheme: url.protocol, issues };
    }
    if (url.hostname === "" && url.protocol !== "file:") issues.push("missing host");
    if (trimmed.startsWith("#")) {
      return { kind: "fragment", url: url.href, fragment: decodeSafe(trimmed.slice(1)), issues };
    }
    if (page && url.origin === page.origin) {
      const samePage = url.pathname === page.pathname && url.search === page.search;
      return { kind: "same-origin", url: url.href, samePage, fragment: url.hash ? decodeSafe(url.hash.slice(1)) : "", issues };
    }
    return { kind: "external", url: url.href, issues };
  }

  function safeUrl(u) {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  }

  function decodeSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  // True when two URLs show the same page/route. In-page anchors (#section) do not change the route;
  // hash routes used by single-page apps (#/products, #!/cart) do.
  function sameRoute(a, b) {
    const x = safeUrl(a);
    const y = safeUrl(b);
    if (!x || !y) return a === b;
    if (x.origin !== y.origin || x.pathname !== y.pathname || x.search !== y.search) return false;
    const routeHash = (u) => (/^#[!/]/.test(u.hash) ? u.hash : "");
    return routeHash(x) === routeHash(y);
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return (
      /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted|data|blob):/i.test(url) ||
      /^https:\/\/chrome\.google\.com\/webstore/i.test(url) ||
      /^https:\/\/chromewebstore\.google\.com/i.test(url) ||
      /^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url)
    );
  }

  // Interpret an HTTP status from a bounded link check.
  function interpretHttpStatus(status) {
    if (status >= 200 && status < 400) return { status: "passed", severity: "info" };
    if (status === 404 || status === 410) return { status: "failed", severity: "high" };
    if (status === 401 || status === 403 || status === 405 || status === 429 || status === 999) {
      return { status: "warning", severity: "low", unverifiable: true };
    }
    if (status >= 500) return { status: "warning", severity: "medium" };
    if (status >= 400) return { status: "failed", severity: "medium" };
    return { status: "warning", severity: "low", unverifiable: true };
  }

  // ---------------- results ----------------

  const MAX_INSTANCES = 200;

  // Structural signature of a CSS path: list position and numbers in ids/classes are dropped, so the same
  // component repeated on a page ("#product-12 > h3.title", "#product-13 > h3.title") maps to one pattern.
  function selectorPattern(selector) {
    if (!selector) return "";
    return String(selector)
      .replace(/:nth-(of-type|child)\([^)]*\)/g, "")
      .replace(/([#.])((?:\\.|[\w-])+)/g, (_, sigil, name) => sigil + name.replace(/\d+/g, "*"));
  }

  function resultKey(r) {
    const vp = r.viewport ? `${r.viewport.width}x${r.viewport.height}` : "";
    return [r.testId, r.pattern || selectorPattern(r.selector), vp].join("|");
  }

  function instancesOf(r) {
    if (r.instances && r.instances.length) return r.instances;
    return r.selector || r.ref ? [{ selector: r.selector, ref: r.ref }] : [];
  }

  function dedupeResults(results) {
    const map = new Map();
    for (const r of results) {
      const k = resultKey(r);
      const prev = map.get(k);
      if (!prev) {
        map.set(k, { ...r, occurrences: r.occurrences || 1, instances: instancesOf(r).slice(0, MAX_INSTANCES) });
        continue;
      }
      prev.occurrences += r.occurrences || 1;
      const seen = new Set(prev.instances.map((i) => i.selector));
      for (const i of instancesOf(r)) {
        if (prev.instances.length >= MAX_INSTANCES) break;
        if (!seen.has(i.selector)) prev.instances.push(i);
      }
    }
    return [...map.values()];
  }

  // Informational notes are not shown; passed checks keep their "info" severity.
  function withoutInfo(results) {
    return results.filter((r) => r.status === "passed" || r.severity !== "info");
  }

  function summarize(results) {
    const summary = {
      total: results.length,
      byStatus: { failed: 0, warning: 0, manual: 0, passed: 0 },
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byCategory: {},
      byVerification: { verified: 0, inferred: 0, manual: 0 },
    };
    for (const r of results) {
      if (summary.byStatus[r.status] !== undefined) summary.byStatus[r.status]++;
      if (r.status !== "passed" && summary.bySeverity[r.severity] !== undefined) summary.bySeverity[r.severity]++;
      if (summary.byVerification[r.verification] !== undefined) summary.byVerification[r.verification]++;
      const c = (summary.byCategory[r.category] = summary.byCategory[r.category] || {
        failed: 0,
        warning: 0,
        manual: 0,
        passed: 0,
      });
      if (c[r.status] !== undefined) c[r.status]++;
    }
    return summary;
  }

  function sortResults(results) {
    const so = (s) => STATUSES.indexOf(s);
    const sv = (s) => SEVERITIES.indexOf(s);
    return [...results].sort(
      (a, b) =>
        so(a.status) - so(b.status) ||
        sv(a.severity) - sv(b.severity) ||
        String(a.category).localeCompare(String(b.category)) ||
        String(a.name).localeCompare(String(b.name))
    );
  }

  /**
   * Merge a partial re-run into an existing report's result list.
   * `scope` describes what was re-run: categories, optional testIds, optional viewports.
   */
  function mergeResults(existing, incoming, scope) {
    const cats = new Set(scope.categories || []);
    const tests = scope.testIds && scope.testIds.length ? new Set(scope.testIds) : null;
    const vps = scope.viewports && scope.viewports.length
      ? new Set(scope.viewports.map((v) => `${v.width}x${v.height}`))
      : null;
    const kept = existing.filter((r) => {
      if (!cats.has(r.category)) return true;
      if (tests && !tests.has(r.sourceTest || r.testId)) return true;
      if (vps && r.category === "responsive") {
        const k = r.viewport ? `${r.viewport.width}x${r.viewport.height}` : "";
        if (!vps.has(k)) return true;
      }
      return false;
    });
    return dedupeResults(kept.concat(incoming));
  }

  function truncate(str, n) {
    const s = String(str ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function round(n, d = 0) {
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  // Strip anything that might contain user-entered data before persisting/exporting.
  const SENSITIVE_KEYS = /^(value|values|password|pass|pwd|token|secret|cookie|authorization|creditcard|cc|cvv|ssn)$/i;
  function sanitizeEvidence(obj, depth = 0) {
    if (obj === null || typeof obj !== "object") return obj;
    if (depth > 4) return "[truncated]";
    if (Array.isArray(obj)) return obj.slice(0, 50).map((v) => sanitizeEvidence(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.test(k)) continue;
      out[k] = typeof v === "string" ? truncate(v, 500) : sanitizeEvidence(v, depth + 1);
    }
    return out;
  }

  return {
    STATUSES,
    SEVERITIES,
    VERIFICATION,
    CATEGORIES,
    VIEWPORT_PRESETS,
    DESTRUCTIVE_RE,
    DESTRUCTIVE_URL_RE,
    parseColor,
    blend,
    relativeLuminance,
    contrastRatio,
    isLargeText,
    requiredContrast,
    analyzeImageFit,
    oversizeFactor,
    classifyHref,
    isRestrictedUrl,
    sameRoute,
    interpretHttpStatus,
    MAX_INSTANCES,
    selectorPattern,
    resultKey,
    dedupeResults,
    withoutInfo,
    summarize,
    sortResults,
    mergeResults,
    sanitizeEvidence,
    truncate,
    round,
    formatBytes,
  };
});
