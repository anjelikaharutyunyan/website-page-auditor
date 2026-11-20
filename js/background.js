// Service worker: orchestrates QA scans in the active tab, responsive viewport emulation, bounded external
// link checks and highlight requests from the dashboard (popup or side panel).
importScripts("qa/qa-utils.js", "report-generator.js");

const U = self.__webQAUtils;
const R = self.__webQAReport;

const ENGINE_FILES = [
  "js/qa/qa-utils.js",
  "js/qa/core.js",
  "js/qa/layout-tests.js",
  "js/qa/image-tests.js",
  "js/qa/link-tests.js",
  "js/qa/interaction-tests.js",
  "js/qa/form-tests.js",
  "js/qa/search-tests.js",
  "js/qa/accessibility-tests.js",
  "js/qa/element-inspector.js",
  "js/qa/responsive-tests.js",
  "js/qa/seo-tests.js",
  "js/qa/runner.js",
];
const ENGINE_VERSION = "1.5.6";
const CATEGORY_ORDER = ["layout", "images", "links", "interactions", "forms", "search", "accessibility", "elements", "responsive"];
const CATEGORY_TIMEOUT_MS = 90000;

const DEFAULT_SETTINGS = {
  interactiveTests: true,
  formInteractive: true,
  searchQueryTest: true,
  searchQuery: "test",
  checkSameOriginLinks: true,
  checkExternalLinks: true,
  maxLinkChecks: 40,
  maxPerTest: 25,
  viewports: U.VIEWPORT_PRESETS.map((v) => v.id),
  customViewports: [],
};

const scans = new Map(); // tabId -> live scan state

// ---------------------------------------------------------------- helpers

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function msg(key, subs) {
  const text = subs === undefined ? chrome.i18n.getMessage(key) : chrome.i18n.getMessage(key, subs);
  return text || key;
}

const CAT_MSG = {
  layout: "uiCategoryLayout", responsive: "uiCategoryResponsive", images: "uiCategoryImages",
  links: "uiCategoryLinks", interactions: "uiCategoryInteractions", forms: "uiCategoryForms",
  search: "uiCategorySearch", accessibility: "uiCategoryAccessibility", elements: "uiCategoryElements",
};
const VP_BY_LABEL = {
  "Small mobile": "uiVpSmallMobile", "Typical mobile": "uiVpTypicalMobile", "Large mobile": "uiVpLargeMobile",
  Tablet: "uiVpTablet", Laptop: "uiVpLaptop", Desktop: "uiVpDesktop", Custom: "uiCustomViewport",
};
function viewportName(label) {
  const key = VP_BY_LABEL[label];
  return (key && chrome.i18n.getMessage(key)) || label || msg("uiCustomViewport");
}

function errorText(e) {
  return String((e && e.message) || e || msg("uiUnknownError"));
}

// Chrome's executeScript error texts for pages no extension may script (tab.url is hidden without the tabs permission).
const RESTRICTED_ERROR_RE = /Cannot access a (chrome|chrome-extension|edge|devtools)[\w-]*:\/\/ URL|extensions gallery cannot be scripted|cannot be scripted|Cannot access a .*(chrome|about|edge):/i;

function isRestrictedError(e) {
  return RESTRICTED_ERROR_RE.test(errorText(e));
}

function friendlyAccessError(e) {
  const m = errorText(e);
  if (isRestrictedError(e)) return msg("uiRestrictedAudit");
  if (/Cannot access|Missing host permission|Cannot access contents/i.test(m)) return msg("uiCannotAccessHelp");
  if (/No tab with id|Frame with ID 0 was removed|The tab was closed/i.test(m)) return msg("uiTabClosed");
  return m;
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(msg("uiTimedOut", [label, String(Math.round(ms / 1000))]))), ms)))]).finally(() => clearTimeout(t));
}

async function exec(tabId, func, args = [], timeoutMs = 30000) {
  const run = chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args });
  const res = await withTimeout(run, timeoutMs, msg("uiPageScript"));
  return res && res[0] ? res[0].result : undefined;
}

async function ensureEngine(tabId) {
  const ping = await exec(tabId, () => (window.__webQA && window.__webQA.ping ? window.__webQA.ping() : null)).catch((e) => {
    throw new Error(friendlyAccessError(e));
  });
  if (ping && ping.version === ENGINE_VERSION && ping.categories && ping.categories.length >= 9) return ping;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ENGINE_FILES }).catch((e) => {
    throw new Error(friendlyAccessError(e));
  });
  return exec(tabId, () => window.__webQA.ping());
}

async function saveReport(tabId, report) {
  await chrome.storage.session.set({ [`report:${tabId}`]: report });
}

async function loadReport(tabId) {
  const key = `report:${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

function publish(tabId) {
  const s = scans.get(tabId);
  if (!s) return;
  const pub = { status: s.status, done: s.done, total: s.total, current: s.current, error: s.error, startedAt: s.startedAt, scope: s.scope };
  chrome.storage.session.set({ [`scan:${tabId}`]: pub }).catch(() => {});
  chrome.runtime.sendMessage({ type: "qa:progress", tabId, scan: pub }).catch(() => {});
}

function stripCategory(out) {
  const { results, ...rest } = out;
  return rest;
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- external links (opt-in, bounded)

async function fetchHead(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", credentials: "omit", redirect: "follow", cache: "no-store", signal: ctl.signal });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, { method: "GET", credentials: "omit", redirect: "follow", cache: "no-store", signal: ctl.signal });
      ctl.abort();
    }
    return { status: res.status, finalUrl: res.url, redirected: res.redirected };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : errorText(e) };
  } finally {
    clearTimeout(t);
  }
}

async function checkExternalLinks(links, settings) {
  const id = "links.external";
  const name = msg("uiExternalLinkName");
  const base = { testId: id, sourceTest: id, category: "links", name };
  // Host access is checked per destination origin; links to origins the user has not granted are not requested.
  const access = new Map();
  for (const l of links) {
    let origin;
    try {
      origin = new URL(l.url).origin;
    } catch {
      continue;
    }
    if (!access.has(origin)) access.set(origin, await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false));
  }
  const allowed = links.filter((l) => {
    try {
      return access.get(new URL(l.url).origin) === true;
    } catch {
      return false;
    }
  });
  if (!allowed.length) {
    return [{ ...base, status: "manual", severity: "info", verification: "manual", message: msg("uiExternalNoAccess", [String(links.length)]) }];
  }
  const noAccess = links.length - allowed.length;
  const max = Math.min(settings.maxLinkChecks || 40, 60);
  const safe = allowed.filter((l) => !U.DESTRUCTIVE_URL_RE.test(l.url));
  const list = safe.slice(0, max);
  const checked = await pool(list, 3, async (l) => ({ l, r: await fetchHead(l.url) }));
  const out = [];
  let ok = 0;
  for (const { l, r } of checked) {
    if (r.error) {
      out.push({ ...base, status: "warning", severity: "low", verification: "inferred", selector: l.selector, ref: l.ref, message: msg("uiExternalRequestFailed", [r.error]), actual: r.error, expected: msg("uiHttpResponse"), evidence: { url: l.url }, fix: msg("uiOpenLinkManually") });
      continue;
    }
    const v = U.interpretHttpStatus(r.status);
    if (v.status === "passed") {
      ok++;
      continue;
    }
    out.push({ ...base, status: v.status, severity: v.severity, verification: v.unverifiable ? "inferred" : "verified", selector: l.selector, ref: l.ref, message: v.unverifiable ? msg("uiExternalBlocked", [String(r.status)]) : msg("uiExternalStatus", [String(r.status)]), actual: `HTTP ${r.status}`, expected: msg("uiHttp2xx"), evidence: { url: l.url, finalUrl: r.finalUrl }, fix: msg("uiUpdateOrRemoveLink") });
  }
  const notChecked = [
    noAccess && msg("uiWithoutHostAccess", [String(noAccess)]),
    allowed.length - safe.length && msg("uiSkippedDestructive", [String(allowed.length - safe.length)]),
    safe.length - list.length && msg("uiOverTheLimit", [String(safe.length - list.length)]),
  ].filter(Boolean);
  const extra = notChecked.length ? msg("uiNotRequested", [notChecked.join(", ")]) : "";
  out.push({ ...base, status: ok === list.length && !notChecked.length ? "passed" : "manual", severity: "info", verification: ok === list.length && !notChecked.length ? "verified" : "manual", message: msg("uiExternalSummary", [String(ok), String(list.length), extra]) });
  return out;
}

// ---------------------------------------------------------------- network guard for interactive form tests

// Runs in the page's MAIN world so the page's own fetch/XHR/sendBeacon/form.submit() calls can be intercepted.
// Data-sending requests are rejected and reported to the engine via a window event; reads (GET/HEAD) pass through.
function installNetworkGuard() {
  if (window.__webqaNetGuard) return true;
  const report = (kind, method, url) => {
    try {
      window.dispatchEvent(new CustomEvent("__webqa-net-blocked", { detail: JSON.stringify({ kind, method, url: String(url || "").slice(0, 200) }) }));
    } catch {}
  };
  const isRead = (m) => /^(GET|HEAD|OPTIONS)$/i.test(m || "GET");
  const orig = { fetch: window.fetch, open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send, beacon: navigator.sendBeacon, submit: HTMLFormElement.prototype.submit };
  window.fetch = function (input, init) {
    const method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
    if (isRead(method)) return orig.fetch.apply(this, arguments);
    report("fetch", method.toUpperCase(), input && typeof input === "object" ? input.url : input);
    return Promise.reject(new TypeError("Blocked by Website Page Auditor during form testing"));
  };
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__webqaReq = { method: String(method || "GET").toUpperCase(), url };
    return orig.open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const r = this.__webqaReq || {};
    if (isRead(r.method)) return orig.send.apply(this, arguments);
    report("xhr", r.method, r.url);
    setTimeout(() => {
      this.dispatchEvent(new ProgressEvent("error"));
      this.dispatchEvent(new ProgressEvent("loadend"));
    }, 0);
  };
  if (orig.beacon) navigator.sendBeacon = function (url) {
    report("beacon", "POST", url);
    return true;
  };
  HTMLFormElement.prototype.submit = function () {
    report("form.submit()", (this.method || "GET").toUpperCase(), this.action);
  };
  window.__webqaNetGuard = orig;
  return true;
}

function removeNetworkGuard() {
  const orig = window.__webqaNetGuard;
  if (!orig) return;
  window.fetch = orig.fetch;
  XMLHttpRequest.prototype.open = orig.open;
  XMLHttpRequest.prototype.send = orig.send;
  if (orig.beacon) navigator.sendBeacon = orig.beacon;
  HTMLFormElement.prototype.submit = orig.submit;
  delete window.__webqaNetGuard;
}

async function setNetworkGuard(tabId, on) {
  const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: on ? installNetworkGuard : removeNetworkGuard });
  return !!(res && res[0] && res[0].result);
}

// ---------------------------------------------------------------- search query (opt-in)

// Resolves true once a started navigation completes, false if none starts within startMs (same-page search).
function waitForNavigation(tabId, { startMs = 4000, totalMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish(true);
    };
    const finish = (v) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      clearTimeout(startTimer);
      resolve(v);
    };
    const startTimer = setTimeout(() => !sawLoading && finish(false), startMs);
    const timer = setTimeout(() => finish(sawLoading ? "timeout" : false), totalMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// The query is submitted for real (the user enabled it) as the last step of a scan, because the search may
// navigate the tab. The page is then inspected wherever it ended up.
async function runSearchQuery(tabId, plan, settings) {
  const manualResult = (message) => ({ results: [{ testId: "search.controlled-query", sourceTest: "search.controlled-query", category: "search", name: "Controlled test query", status: "manual", severity: "low", verification: "manual", message }], limitations: [] });
  const navP = waitForNavigation(tabId);
  let submitted;
  try {
    submitted = await exec(tabId, (p) => window.__webQA.searchSubmit(p), [plan], 5000);
  } catch (e) {
    submitted = { ok: true, note: String(e && e.message) };
  }
  if (!submitted || !submitted.ok) return manualResult(`The test query could not be entered (${(submitted && submitted.error) || "unknown reason"}). Test search manually.`);
  const navigated = await navP;
  if (!navigated) await new Promise((r) => setTimeout(r, 2500));
  else await new Promise((r) => setTimeout(r, 800));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureEngine(tabId);
      const out = await exec(tabId, (q, start, opts) => window.__webQA.searchVerify(q, start, opts), [plan.query, plan.startUrl, { maxPerTest: settings.maxPerTest, navigated: !!navigated }], 15000);
      if (navigated) out.limitations.push("The controlled search navigated the tab to a results page (it ran last, so the other categories inspected the original page). Go back to highlight elements from the other results.");
      return out;
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return manualResult(`The query was submitted and the tab ${navigated ? "navigated" : "did not navigate"}, but the results could not be inspected (${friendlyAccessError(e)}). Check the results page manually.`);
    }
  }
}

// ---------------------------------------------------------------- responsive (DevTools emulation with window fallback)

const emulating = new Set();
let detachListening = false;

function debuggerApi() {
  if (!chrome.debugger) return null;
  if (!detachListening) {
    detachListening = true;
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId && emulating.has(source.tabId)) {
        const s = scans.get(source.tabId);
        if (s) s.debuggerDetached = reason;
      }
    });
  }
  return chrome.debugger;
}

async function recoverEmulation() {
  const { emulatingTabs } = await chrome.storage.session.get("emulatingTabs");
  if (!emulatingTabs || !emulatingTabs.length || !debuggerApi()) return;
  for (const tabId of emulatingTabs) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3").catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      await chrome.debugger.detach({ tabId }).catch(() => {});
    } catch {}
  }
  await chrome.storage.session.set({ emulatingTabs: [] });
}
recoverEmulation();

async function markEmulating(tabId, on) {
  on ? emulating.add(tabId) : emulating.delete(tabId);
  await chrome.storage.session.set({ emulatingTabs: [...emulating] });
}

async function runResponsive(tabId, viewports, opts, state) {
  const t0 = Date.now();
  const out = { category: "responsive", status: "completed", ran: [], skipped: [], limitations: [], extras: { viewports: [] }, results: [], durationMs: 0 };
  const ran = new Set();
  await exec(tabId, () => window.__webQA.responsiveBaseline());
  const before = await exec(tabId, () => ({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight, x: scrollX, y: scrollY }));
  let method = "emulation";
  let attached = false;
  try {
    if (!debuggerApi()) throw new Error(msg("uiDebuggerUnavailable"));
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    await markEmulating(tabId, true);
  } catch (e) {
    method = "unavailable";
    out.limitations.push(msg("uiEmulationUnavailableDetail", [errorText(e)]));
  }
  const send = (cmd, params) => chrome.debugger.sendCommand({ tabId }, cmd, params);
  try {
    for (const vp of viewports) {
      if (state.cancelled) break;
      if (method === "unavailable") {
        out.skipped.push({ testId: "responsive.viewport", name: `${viewportName(vp.label)} ${vp.width}×${vp.height}`, reason: msg("uiEmulationUnavailableSkip") });
        continue;
      }
      if (state.debuggerDetached) {
        out.limitations.push(msg("uiDebuggerDetached", [state.debuggerDetached]));
        break;
      }
      state.current = msg("uiResponsiveProgress", [viewportName(vp.label), `${vp.width}×${vp.height}`]);
      publish(tabId);
      if (method === "emulation") {
        await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 0, mobile: !!vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
        await send("Emulation.setTouchEmulationEnabled", { enabled: !!vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
      }
      const layout = await exec(tabId, () => window.__webQA.waitForLayout(500));
      // Mobile emulation zooms out to fit overflowing content, which inflates innerWidth; the layout width is what CSS sees.
      const actualWidth = vp.mobile ? layout.layoutWidth : layout.width;
      const tag = { label: viewportName(vp.label), width: vp.width, height: vp.height, method, actualWidth, actualHeight: layout.height };
      if (Math.abs(actualWidth - vp.width) > 2) {
        tag.approximate = true;
        out.limitations.push(msg("uiViewportApproximate", [viewportName(vp.label), `${vp.width}×${vp.height}`, `${actualWidth}×${layout.height}`]));
      }
      out.extras.viewports.push(tag);
      let res;
      try {
        res = await exec(tabId, (o) => window.__webQA.runCategory("responsive", o), [{ ...opts, viewport: tag }], CATEGORY_TIMEOUT_MS);
      } catch (e) {
        out.skipped.push({ testId: "responsive.viewport", name: `${viewportName(vp.label)} ${vp.width}×${vp.height}`, reason: errorText(e) });
        continue;
      }
      res.ran.forEach((r) => ran.add(r));
      res.skipped.forEach((s) => out.skipped.push({ ...s, name: `${s.name} @ ${vp.width}×${vp.height}` }));
      res.limitations.forEach((l) => out.limitations.push(`${vp.width}×${vp.height}: ${l}`));
      out.results.push(...res.results);
    }
  } finally {
    if (attached) {
      await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await markEmulating(tabId, false);
    }
    const after = await exec(tabId, async (x, y) => {
      await window.__webQA.waitForLayout(300);
      window.scrollTo(x, y);
      return { w: innerWidth, h: innerHeight };
    }, [before.x, before.y]).catch(() => null);
    out.extras.restored = after ? after.w === before.w && after.h === before.h : false;
    if (!out.extras.restored) out.limitations.push(after ? msg("uiViewportNotRestoredNow", [`${before.w}×${before.h}`, `${after.w}×${after.h}`]) : msg("uiViewportNotRestored", [`${before.w}×${before.h}`]));
  }
  out.ran = [...ran];
  out.durationMs = Date.now() - t0;
  if (state.cancelled) out.status = "cancelled";
  return out;
}

function resolveViewports(settings, requested) {
  if (requested && requested.length) return requested;
  const presets = U.VIEWPORT_PRESETS.filter((p) => settings.viewports.includes(p.id));
  const custom = (settings.customViewports || []).filter((v) => v.enabled !== false).map((v) => ({ label: v.label || msg("uiCustomViewport"), width: v.width, height: v.height, mobile: v.width < 1024 }));
  return presets.concat(custom);
}

// ---------------------------------------------------------------- scan orchestration

async function runScan(tabId, req) {
  const settings = await getSettings();
  const categories = (req.categories && req.categories.length ? req.categories : CATEGORY_ORDER).filter((c) => CATEGORY_ORDER.includes(c));
  categories.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  const viewports = categories.includes("responsive") ? resolveViewports(settings, req.viewports) : [];
  const state = { status: "running", done: 0, total: categories.length + Math.max(0, viewports.length - 1), current: msg("uiPreparing"), startedAt: new Date().toISOString(), cancelled: false, scope: { categories, onlyTests: req.onlyTests || null, viewports: req.viewports || null } };
  scans.set(tabId, state);
  publish(tabId);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  const t0 = Date.now();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && U.isRestrictedUrl(tab.url)) throw new Error(msg("uiRestrictedPageInspect"));
    const ping = await ensureEngine(tabId);
    const opts = {
      locale: chrome.i18n.getUILanguage() || "en",
      interactiveTests: settings.interactiveTests,
      formInteractive: settings.formInteractive,
      searchQueryTest: settings.searchQueryTest,
      searchQuery: settings.searchQuery,
      checkSameOriginLinks: settings.checkSameOriginLinks,
      checkExternalLinks: settings.checkExternalLinks,
      maxLinkChecks: settings.maxLinkChecks,
      maxPerTest: settings.maxPerTest,
      onlyTests: req.onlyTests || null,
      categoryTimeoutMs: CATEGORY_TIMEOUT_MS - 5000,
    };
    const categoryOut = {};
    const results = [];
    let searchPlan = null;
    for (const cat of categories) {
      if (state.cancelled) break;
      if (cat === "responsive") {
        const out = await runResponsive(tabId, viewports, opts, state);
        categoryOut.responsive = stripCategory(out);
        results.push(...out.results);
        state.done = state.total;
        continue;
      }
      state.current = `${msg(CAT_MSG[cat]) || U.CATEGORIES[cat]}…`;
      publish(tabId);
      let out;
      const guarded = cat === "forms" && settings.formInteractive ? await setNetworkGuard(tabId, true).catch(() => false) : false;
      try {
        out = await exec(tabId, (c, o) => window.__webQA.runCategory(c, o), [cat, guarded ? { ...opts, networkGuard: true } : opts], CATEGORY_TIMEOUT_MS);
      } catch (e) {
        await exec(tabId, () => window.__webQA && window.__webQA.cancel()).catch(() => {});
        out = { category: cat, status: "error", error: friendlyAccessError(e), results: [], ran: [], skipped: [], limitations: [], extras: {} };
      } finally {
        if (guarded) await setNetworkGuard(tabId, false).catch(() => {});
      }
      if (cat === "links" && settings.checkExternalLinks && out.extras && out.extras.externalLinks && out.extras.externalLinks.length && (!req.onlyTests || req.onlyTests.includes("links.external"))) {
        state.current = msg("uiCheckingExternal");
        publish(tabId);
        out.results.push(...(await checkExternalLinks(out.extras.externalLinks, settings)));
        out.ran.push("links.external");
      }
      if (cat === "search" && out.extras && out.extras.searchPlan) searchPlan = out.extras.searchPlan;
      categoryOut[cat] = stripCategory(out);
      results.push(...out.results);
      state.done++;
      publish(tabId);
    }
    if (searchPlan && !state.cancelled) {
      state.current = msg("uiSubmittingSearch");
      publish(tabId);
      const sq = await runSearchQuery(tabId, searchPlan, settings);
      categoryOut.search.limitations = [...(categoryOut.search.limitations || []), ...(sq.limitations || [])];
      results.push(...sq.results);
    }

    const prev = req.merge ? await loadReport(tabId) : null;
    const manifest = chrome.runtime.getManifest();
    let report;
    if (prev && prev.meta && prev.meta.url === ping.url) {
      report = {
        ...prev,
        meta: { ...prev.meta, updatedAt: new Date().toISOString(), viewportsTested: categoryOut.responsive ? mergeViewports(prev.meta.viewportsTested, categoryOut.responsive.extras.viewports) : prev.meta.viewportsTested },
        categories: { ...prev.categories, ...mergeCategoryMeta(prev.categories, categoryOut, req) },
        results: U.mergeResults(prev.results, results, { categories, testIds: req.onlyTests, viewports: req.viewports }),
      };
    } else {
      report = {
        meta: {
          url: ping.url,
          title: ping.title,
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          extensionVersion: manifest.version,
          userAgent: navigator.userAgent,
          baseViewport: ping.viewport,
          viewportsTested: categoryOut.responsive ? categoryOut.responsive.extras.viewports : [],
          options: { interactiveTests: settings.interactiveTests, formInteractive: settings.formInteractive, searchQueryTest: settings.searchQueryTest, checkSameOriginLinks: settings.checkSameOriginLinks, checkExternalLinks: settings.checkExternalLinks, maxLinkChecks: settings.maxLinkChecks },
        },
        categories: categoryOut,
        results,
        limitations: ["Only the top-level document is scanned. Results reflect the page state and scroll position at scan time."],
      };
    }
    report = R.finalizeReport(report);
    if (state.cancelled) report.meta.cancelled = true;
    // Where the tab ended up (the opt-in search query may navigate); route changes are measured from here.
    report.meta.tabUrl = await exec(tabId, () => location.href, [], 5000).catch(() => report.meta.url);
    await saveReport(tabId, report);
    state.status = state.cancelled ? "cancelled" : "completed";
    state.current = state.cancelled ? msg("uiCancelledPartial") : msg("uiDone");
  } catch (e) {
    state.status = "error";
    state.error = friendlyAccessError(e);
    state.current = "";
  } finally {
    clearInterval(keepAlive);
    publish(tabId);
  }
}

function mergeViewports(a = [], b = []) {
  const map = new Map(a.map((v) => [`${v.width}x${v.height}`, v]));
  for (const v of b) map.set(`${v.width}x${v.height}`, v);
  return [...map.values()];
}

function mergeCategoryMeta(prevCats = {}, nextCats, req) {
  if (!req.onlyTests && !req.viewports) return nextCats;
  const out = {};
  for (const [k, v] of Object.entries(nextCats)) {
    const p = prevCats[k];
    if (!p) {
      out[k] = v;
      continue;
    }
    out[k] = {
      ...p,
      ran: [...new Set([...(p.ran || []), ...(v.ran || [])])],
      limitations: [...new Set([...(p.limitations || []), ...(v.limitations || [])])],
      extras: { ...p.extras, ...(k === "responsive" ? { viewports: mergeViewports(p.extras && p.extras.viewports, v.extras && v.extras.viewports) } : {}) },
    };
  }
  return out;
}

// ---------------------------------------------------------------- visual aids (retained from the original toolset)

async function visualAid(tabId, tool, on) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["js/outlineFunctions.js"] });
  return exec(tabId, (t, enable) => {
    if (t === "resetAll") {
      window.outlineFunctions && window.outlineFunctions.revertAll();
      return { ok: true, message: "All outlines removed" };
    }
    return enable ? window.outlineFunctions.apply(t) : window.outlineFunctions.revert(t);
  }, [tool, on]);
}

// ---------------------------------------------------------------- messaging

const handlers = {
  async "qa:getState"({ tabId }) {
    const report = await loadReport(tabId);
    const live = scans.get(tabId);
    const stored = (await chrome.storage.session.get(`scan:${tabId}`))[`scan:${tabId}`];
    const aids = (await chrome.storage.session.get(`aids:${tabId}`))[`aids:${tabId}`] || {};
    const seo = (await chrome.storage.session.get(`seo:${tabId}`))[`seo:${tabId}`] || null;
    let scan = live ? { status: live.status, done: live.done, total: live.total, current: live.current, error: live.error, scope: live.scope } : stored || null;
    if (scan && scan.status === "running" && !live) scan = { ...scan, status: "interrupted", current: msg("uiScanInterrupted") };
    return { ok: true, report, scan, aids, seo, settings: await getSettings() };
  },
  async "qa:checkAccess"({ tabId }) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && U.isRestrictedUrl(tab.url)) return { ok: false, restricted: true, url: tab.url, message: msg("uiRestrictedScan") };
      const url = await exec(tabId, () => location.href, [], 5000);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, restricted: isRestrictedError(e), message: friendlyAccessError(e) };
    }
  },
  async "qa:start"({ tabId, categories, onlyTests, viewports, merge }) {
    const live = scans.get(tabId);
    if (live && live.status === "running") return { ok: false, message: msg("uiScanAlreadyRunning") };
    runScan(tabId, { categories, onlyTests, viewports, merge });
    return { ok: true };
  },
  async "qa:cancel"({ tabId }) {
    const s = scans.get(tabId);
    if (!s || s.status !== "running") return { ok: false, message: msg("uiNoScanRunning") };
    s.cancelled = true;
    s.current = msg("uiCancelling");
    publish(tabId);
    await exec(tabId, () => window.__webQA && window.__webQA.cancel(), [], 3000).catch(() => {});
    return { ok: true };
  },
  async "qa:highlight"({ tabId, target, info }) {
    await ensureEngine(tabId);
    return exec(tabId, (t, i) => window.__webQA.inspector.highlight(t, i), [target, info]);
  },
  async "qa:highlightMany"({ tabId, targets }) {
    await ensureEngine(tabId);
    return exec(tabId, (t) => window.__webQA.inspector.highlightMany(t), [targets]);
  },
  async "qa:clearHighlights"({ tabId }) {
    // Works without the engine too: overlays drawn before an extension reload belong to a script context we can no longer reach.
    return exec(tabId, () => {
      if (window.__webQA && window.__webQA.inspector) window.__webQA.inspector.clear();
      const stale = document.querySelectorAll("#__webqa-overlay-host");
      stale.forEach((n) => n.remove());
      return { ok: true };
    }).catch((e) => ({ ok: false, message: friendlyAccessError(e) }));
  },
  async "qa:captureFindings"({ tabId, targets }) {
    const live = scans.get(tabId);
    if (live && live.status === "running") return { ok: false, message: msg("uiScanAlreadyRunning") };
    await ensureEngine(tabId);
    return { ok: true, ...(await captureFindings(tabId, targets || [])) };
  },
  async "qa:visualAid"({ tabId, tool, on }) {
    const res = await visualAid(tabId, tool, on);
    const key = `aids:${tabId}`;
    const aids = (await chrome.storage.session.get(key))[key] || {};
    if (tool === "resetAll") await chrome.storage.session.set({ [key]: {} });
    else {
      if (on && res && res.ok !== false) aids[tool] = true;
      else delete aids[tool];
      await chrome.storage.session.set({ [key]: aids });
    }
    return res;
  },
  async "qa:saveSettings"({ settings }) {
    const merged = { ...(await getSettings()), ...settings };
    await chrome.storage.local.set({ settings: merged });
    return { ok: true, settings: merged };
  },
  async "qa:clearReport"({ tabId }) {
    await chrome.storage.session.remove([`report:${tabId}`, `scan:${tabId}`]);
    scans.delete(tabId);
    return { ok: true };
  },
  async "qa:seo"({ tabId }) {
    await ensureEngine(tabId);
    const seo = await exec(tabId, () => window.__webQA.seo.analyze(), [], 30000);
    if (!seo) return { ok: false, message: msg("uiNoSeoData") };
    await chrome.storage.session.set({ [`seo:${tabId}`]: seo });
    return { ok: true, seo };
  },
  async "qa:clearIfRouteChanged"({ tabId, url }) {
    return { ok: true, cleared: await clearIfRouteChanged(tabId, url) };
  },
  async "qa:getConsent"() {
    return { ok: true, accepted: await hasConsent() };
  },
  async "qa:setConsent"({ accepted }) {
    if (accepted) {
      await chrome.storage.local.set({ [CONSENT_KEY]: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() } });
      return { ok: true, accepted: true };
    }
    await chrome.storage.local.remove(CONSENT_KEY);
    for (const s of scans.values()) s.cancelled = true;
    scans.clear();
    const stored = Object.keys(await chrome.storage.session.get(null)).filter((k) => /^(report|scan|aids|seo|pdfShot):/.test(k) || k === "pdfReport");
    await chrome.storage.session.remove(stored);
    return { ok: true, accepted: false };
  },
};

// ---------------------------------------------------------------- screenshots for the PDF report

const SHOT = { pad: 24, minWidth: 360, minHeight: 160, maxWidth: 1000, maxHeight: 800, quality: 0.8 };
// Chrome allows two captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 600;
let lastCapture = 0;

// The element plus some surrounding context, clamped to the visible viewport (CSS pixels).
function shotRegion(f) {
  const span = (a, b, min, max) => {
    const grow = min - (b - a);
    if (grow > 0) {
      a -= grow / 2;
      b += grow / 2;
    }
    if (a < 0) {
      b -= a;
      a = 0;
    }
    if (b > max) {
      a -= b - max;
      b = max;
    }
    return [Math.max(0, a), Math.min(max, b)];
  };
  const r = f.rect;
  const [x1, x2] = span(r.left - SHOT.pad, r.left + r.width + SHOT.pad, SHOT.minWidth, f.clientWidth);
  const [y1, y2] = span(r.top - SHOT.pad, r.top + r.height + SHOT.pad, SHOT.minHeight, f.clientHeight);
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

function outputScale(region, pixelRatio) {
  return Math.min(1, SHOT.maxWidth / (region.width * pixelRatio), SHOT.maxHeight / (region.height * pixelRatio));
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(s)}`;
}

async function captureVisible(windowId, f, region) {
  const wait = lastCapture + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const px = bmp.width / f.viewportWidth;
  const k = outputScale(region, px);
  const w = Math.max(1, Math.round(region.width * px * k));
  const h = Math.max(1, Math.round(region.height * px * k));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, region.x * px, region.y * px, region.width * px, region.height * px, 0, 0, w, h);
  bmp.close();
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: SHOT.quality }));
}

async function captureWithDebugger(tabId, f, region) {
  const clip = { x: region.x + f.scrollX, y: region.y + f.scrollY, width: region.width, height: region.height, scale: outputScale(region, f.dpr) };
  const res = await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "jpeg", quality: Math.round(SHOT.quality * 100), clip }), 10000, "Page.captureScreenshot");
  return `data:image/jpeg;base64,${res.data}`;
}

// Highlights each finding's element and photographs it. captureVisibleTab needs the tab to be in front and
// activeTab or all-sites access; otherwise the debugger (already used for responsive checks) takes the picture.
// Findings measured at another screen size are photographed with that size emulated again, like the
// responsive check, and the page is restored afterwards.
async function captureFindings(tabId, targets) {
  const tab = await chrome.tabs.get(tabId);
  const frame = (t) => exec(tabId, (target, severity, parentIfHidden) => window.__webQA.inspector.frame(target, severity, parentIfHidden), [t.target, t.severity, !!t.viewport], 10000).catch(() => null);
  const send = (cmd, params) => chrome.debugger.sendCommand({ tabId }, cmd, params);
  const sizeKey = (t) => (t.viewport ? `${String(t.viewport.width).padStart(5, "0")}x${t.viewport.height}` : "");
  const shots = {};
  let useTab = tab.active;
  let attached = false;
  let emulated = "";
  const attach = async () => {
    if (attached) return true;
    attached = !!debuggerApi() && (await chrome.debugger.attach({ tabId }, "1.3").then(() => true).catch(() => false));
    // Chrome's "started debugging" bar can change the viewport height.
    if (attached) await new Promise((r) => setTimeout(r, 300));
    return attached;
  };
  const emulate = async (vp) => {
    const key = vp ? `${vp.width}x${vp.height}` : "";
    if (key === emulated) return true;
    if (vp) {
      if (!(await attach())) return false;
      await markEmulating(tabId, true);
      await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 0, mobile: !!vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
      await send("Emulation.setTouchEmulationEnabled", { enabled: !!vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
    } else {
      await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      await markEmulating(tabId, false);
    }
    emulated = key;
    await exec(tabId, () => window.__webQA.waitForLayout(500), [], 5000).catch(() => {});
    return true;
  };
  // Current-size findings first, then one emulated size at a time.
  const ordered = targets.slice(0, 200).sort((a, b) => sizeKey(a).localeCompare(sizeKey(b)));
  try {
    for (const t of ordered) {
      if (t.viewport) {
        if (!(await emulate(t.viewport).catch(() => false))) continue;
        const f = await frame(t);
        if (!f || !f.ok) continue;
        const image = await captureWithDebugger(tabId, f, shotRegion(f)).catch(() => null);
        if (image) shots[t.id] = image;
        continue;
      }
      let f = await frame(t);
      if (!f || !f.ok) continue;
      let image = null;
      if (useTab) {
        image = await captureVisible(tab.windowId, f, shotRegion(f)).catch(() => null);
        if (!image) useTab = false;
      }
      if (!image) {
        const wasAttached = attached;
        if (!(await attach())) break;
        if (!wasAttached) {
          f = await frame(t);
          if (!f || !f.ok) continue;
        }
        image = await captureWithDebugger(tabId, f, shotRegion(f)).catch(() => null);
      }
      if (image) shots[t.id] = image;
    }
  } finally {
    if (emulated) await emulate(null).catch(() => {});
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    await exec(tabId, () => window.__webQA && window.__webQA.inspector.clear(), [], 5000).catch(() => {});
  }
  return { shots, method: attached ? "debugger" : "tab" };
}

// Nothing reads a page until the user has agreed to the in-product data notice.
const CONSENT_KEY = "consent";
const CONSENT_VERSION = 1;
const NO_CONSENT_TYPES = new Set(["qa:getConsent", "qa:setConsent"]);

async function hasConsent() {
  const c = (await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY];
  return !!c && c.version === CONSENT_VERSION;
}

// ---------------------------------------------------------------- automatic clean-up on navigation

function reportUrl(report) {
  return report && report.meta && (report.meta.tabUrl || report.meta.url);
}

// Drops the tab's report, SEO results and page overlays when the tab now shows another page or route.
// A running scan is left alone: the opt-in search query navigates the tab on purpose.
async function clearIfRouteChanged(tabId, url) {
  if (!url) return false;
  const live = scans.get(tabId);
  if (live && live.status === "running") return false;
  const report = await loadReport(tabId);
  const seo = (await chrome.storage.session.get(`seo:${tabId}`))[`seo:${tabId}`];
  if (!report && !seo) return false;
  const before = [reportUrl(report), seo && seo.url].filter(Boolean);
  if (before.every((u) => U.sameRoute(u, url))) return false;
  await chrome.storage.session.remove([`report:${tabId}`, `scan:${tabId}`, `aids:${tabId}`, `seo:${tabId}`]);
  scans.delete(tabId);
  // Single-page apps keep the document, so overlays and outline classes from the old route are still in it.
  await exec(tabId, () => {
    if (window.__webQA && window.__webQA.inspector) window.__webQA.inspector.clear();
    document.querySelectorAll("#__webqa-overlay-host").forEach((n) => n.remove());
    if (window.outlineFunctions) window.outlineFunctions.revertAll();
  }, [], 3000).catch(() => {});
  chrome.runtime.sendMessage({ type: "qa:cleared", tabId, url }).catch(() => {});
  return true;
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // info.url is reported for full navigations and for history.pushState/replaceState route changes.
  if (info.url) clearIfRouteChanged(tabId, info.url).catch(() => {});
});

const EXTENSION_ORIGIN = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from the extension's own pages (popup, side panel, dashboard tab), never from scripts in web pages.
  if (!msg || typeof msg.type !== "string" || !handlers[msg.type]) return false;
  if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(EXTENSION_ORIGIN)) return false;
  (NO_CONSENT_TYPES.has(msg.type) ? Promise.resolve(true) : hasConsent())
    .then((ok) => (ok ? handlers[msg.type](msg) : { ok: false, consentRequired: true, message: chrome.i18n.getMessage("uiConsentRequired") }))
    .then((r) => sendResponse(r === undefined ? { ok: true } : r))
    .catch((e) => sendResponse({ ok: false, message: friendlyAccessError(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scans.delete(tabId);
  chrome.storage.session.remove([`report:${tabId}`, `scan:${tabId}`, `aids:${tabId}`, `seo:${tabId}`]).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  // Clear the uninstall URL registered by older versions; Chrome keeps it until explicitly reset.
  chrome.runtime.setUninstallURL("");
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
