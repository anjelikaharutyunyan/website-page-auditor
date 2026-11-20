// End-to-end test of the real extension in headless Chrome.
// Loads a temporary copy via the DevTools Extensions.loadUnpacked command (Chrome 126+, pipe transport) and drives
// the service worker's message handlers directly. Test-only difference from the shipped manifest: the copy is
// granted host access to the local test server at install time, because a headless run cannot click permission
// prompts or the toolbar icon (activeTab).
// Usage: node tests/browser/run-extension.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/browser/output");
const SCREENSHOTS_ONLY = process.argv.includes("--screenshots-only");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome not found; set CHROME_PATH.");
  process.exit(2);
}

// ---------------------------------------------------------------- server
const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  requests.push({ method: req.method, host: req.headers.host, path: url.pathname, cookie: req.headers.cookie || null });
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/tests/fixtures`;
const STORE_BASE = `http://demo-shop.test:${PORT}/tests/fixtures`;

// ---------------------------------------------------------------- extension copy
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "webqa-ext-"));
for (const p of ["manifest.json", "popup.html", "popup.css", "privacy.html", "welcome.html", "welcome.css", "leave.html", "leave.css", "_locales", "icons", "js", "store"]) fs.cpSync(path.join(ROOT, p), path.join(extDir, p), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "http://localhost/*", "http://demo-shop.test/*"];
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------- chrome over pipe
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "webqa-prof-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--host-resolver-rules=MAP demo-shop.test 127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const pipeOut = chrome.stdio[3];
const pipeIn = chrome.stdio[4];
let msgId = 0;
const pending = new Map();
const listeners = [];
let buf = "";
pipeIn.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  pipeOut.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
async function evaluate(sessionId, expression, timeout = 180000) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- results
const outcomes = [];
function record(name, checks, extra = []) {
  const ok = checks.every(([good]) => good);
  outcomes.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  for (const e of extra) console.log(`      ${e}`);
  for (const [good, msg] of checks) console.log(`      ${good ? "ok" : "NOT OK"}: ${msg}`);
}

let sw;
async function bg(expr) {
  return evaluate(sw, expr);
}
async function openTab(url) {
  return bg(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: true }).then(t => new Promise(res => {
    const l = (id, info) => { if (id === t.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(l); res(t.id); } };
    chrome.tabs.onUpdated.addListener(l);
  }))`);
}
async function scan(tabId, req) {
  const started = await bg(`handlers["qa:start"](${JSON.stringify({ tabId, ...req })})`);
  if (!started.ok) throw new Error(started.message);
  for (let i = 0; i < 400; i++) {
    await sleep(500);
    const s = await bg(`chrome.storage.session.get("scan:${tabId}").then(d => d["scan:${tabId}"])`);
    if (s && s.status !== "running") {
      const report = await bg(`chrome.storage.session.get("report:${tabId}").then(d => d["report:${tabId}"] || null)`);
      return { scan: s, report };
    }
  }
  throw new Error("scan did not finish");
}
const has = (report, testId, pred = () => true) => report.results.some((r) => r.testId === testId && pred(r));

try {
  await send("Target.setDiscoverTargets", { discover: true });
  const { id: extId } = await send("Extensions.loadUnpacked", { path: extDir });
  let swTarget;
  for (let i = 0; i < 50 && !swTarget; i++) {
    const { targetInfos } = await send("Target.getTargets");
    swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!swTarget) await sleep(200);
  }
  if (!swTarget) throw new Error("extension service worker did not start");
  sw = (await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, sw);
  console.log(`Loaded extension ${extId} (${manifest.version}) in ${path.basename(CHROME)}\n`);

  if (!SCREENSHOTS_ONLY) {
  // 0. Nothing reads a page before the user agrees to the in-product notice; emulation starts switched off.
  {
    const tabId = await openTab(`${BASE}/clean.html`);
    const defaults = await bg(`getSettings()`);
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html?tabId=${tabId}` });
    const ps = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ps);
    await sleep(1200);
    const visible = (id) => evaluate(ps, `!document.getElementById("${id}").classList.contains("d-none")`);
    const beforeConsent = { notice: await visible("consent"), app: await visible("appBody") };
    const blocked = await evaluate(ps, `chrome.runtime.sendMessage({ type: "qa:checkAccess", tabId: ${tabId} })`);
    const engineBefore = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => !!window.__webQA }).then(r => r[0].result)`);
    await evaluate(ps, `document.getElementById("acceptConsent").click()`);
    await sleep(1500);
    const afterConsent = { notice: await visible("consent"), app: await visible("appBody") };
    const stored = await bg(`chrome.storage.local.get("consent").then(d => d.consent)`);
    const allowed = await evaluate(ps, `chrome.runtime.sendMessage({ type: "qa:checkAccess", tabId: ${tabId} })`);
    await send("Target.closeTarget", { targetId });
    await bg(`chrome.tabs.remove(${tabId})`);
    record("consent notice and safe defaults", [
      [beforeConsent.notice && !beforeConsent.app, "the data notice is shown and the dashboard hidden before consent"],
      [blocked.ok === false && blocked.consentRequired === true && !engineBefore, "page access is refused and nothing is injected before consent"],
      [afterConsent.app && !afterConsent.notice && stored && stored.version === 1, "“Agree and continue” stores consent and opens the dashboard"],
      [allowed.ok === true, "page access works after consent"],
      [defaults.useDebugger === false && defaults.checkExternalLinks === false && defaults.searchQueryTest === false && defaults.formInteractive === false, "screen-size emulation and the optional active checks are off by default"],
    ]);
    // The remaining scenarios cover emulation, so turn it on as a user would in Settings.
    await bg(`handlers["qa:saveSettings"]({ settings: { useDebugger: true } })`);
  }

  // 1. Restricted pages are refused gracefully.
  {
    const tabId = await openTab("chrome://version");
    const access = await bg(`handlers["qa:checkAccess"]({ tabId: ${tabId} })`);
    const { scan: s } = await scan(tabId, { categories: ["layout"] }).catch((e) => ({ scan: { status: "error", error: e.message } }));
    record("restricted page (chrome://version)", [
      [access.ok === false && access.restricted === true, `access check refused: ${access.message}`],
      [s.status === "error" && /browser, extension/i.test(s.error || ""), `scan ended with a clear error: ${s.error}`],
    ]);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 2. Full scan of a clean page: all categories, responsive emulation and restoration.
  let layoutTab;
  {
    const tabId = await openTab(`${BASE}/clean.html`);
    const before = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => ({ w: innerWidth, h: innerHeight }) }).then(r => r[0].result)`);
    const t0 = Date.now();
    const { scan: s, report } = await scan(tabId, {});
    const after = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => ({ w: innerWidth, h: innerHeight }) }).then(r => r[0].result)`);
    const attached = await bg(`chrome.debugger.getTargets().then(ts => ts.some(t => t.tabId === ${tabId} && t.attached))`);
    const cats = Object.entries(report.categories);
    const vps = report.meta.viewportsTested || [];
    record("full scan: clean.html", [
      [s.status === "completed", `scan status ${s.status}`],
      [cats.length === 9 && cats.every(([, c]) => c.status === "completed"), `9 categories completed (${cats.map(([k, c]) => `${k}:${c.status}`).join(", ")})`],
      [report.summary.byStatus.failed === 0, `no failed checks (${JSON.stringify(report.summary.byStatus)})`],
      [vps.length === 6 && vps.every((v) => v.method === "emulation" && !v.approximate), `6 viewports emulated exactly: ${vps.map((v) => `${v.width}×${v.height}`).join(", ")}`],
      [report.categories.responsive.extras.restored === true && after.w === before.w && after.h === before.h, `viewport restored to ${before.w}×${before.h}`],
      [!attached, "debugger detached after the scan"],
      [report.results.every((r) => !JSON.stringify(r.evidence || {}).includes("password")), "no sensitive evidence keys"],
    ], [`duration ${((Date.now() - t0) / 1000).toFixed(1)}s, ${report.results.length} results`]);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 3. Defects page: failures found, highlighting works, rerun of a single test merges.
  {
    const tabId = await openTab(`${BASE}/layout-defects.html`);
    layoutTab = tabId;
    const { report } = await scan(tabId, { categories: ["layout", "accessibility"] });
    const target = report.results.find((r) => r.testId === "layout.text-clipped" && r.status === "failed");
    const hl = target ? await bg(`handlers["qa:highlight"](${JSON.stringify({ tabId, target: { ref: target.ref, selector: target.selector }, info: { title: target.name, severity: target.severity, status: target.status, message: target.message } })})`) : null;
    const overlayCount = () => bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);
    // Simulate an overlay orphaned by a previous extension instance (different script world, unknown to the engine).
    await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: "MAIN", func: () => { const d = document.createElement("div"); d.id = "__webqa-overlay-host"; document.documentElement.appendChild(d); } })`);
    const shownAfterHighlight = await overlayCount();
    const cleared = await bg(`handlers["qa:clearHighlights"]({ tabId: ${tabId} })`);
    const leftAfterClear = await overlayCount();
    const before = report.results.length;
    const { report: merged } = await scan(tabId, { categories: ["layout"], onlyTests: ["layout.text-clipped"], merge: true });
    record("defects page: layout-defects.html", [
      [report.summary.byStatus.failed > 0, `failures reported (${JSON.stringify(report.summary.byStatus)})`],
      [!!target && hl && hl.ok, `clicking a result highlights it via its ref (${target && target.selector})`],
      [shownAfterHighlight === 2 && cleared.ok && leftAfterClear === 0, `clear highlights removes current and orphaned overlays (hosts: ${shownAfterHighlight} → ${leftAfterClear})`],
      [merged.results.length === before && has(merged, "layout.text-clipped") && has(merged, "a11y.duplicate-ids"), `single-test rerun merged into the existing report (${before} → ${merged.results.length} results)`],
    ]);
  }

  // 3b. Leaving the page or changing the SPA route clears the old output; an in-page anchor does not.
  {
    const tabId = await openTab(`${BASE}/layout-defects.html`);
    const stored = () => bg(`chrome.storage.session.get("report:${tabId}").then(d => !!d["report:${tabId}"])`);
    const waitFor = async (want) => {
      for (let i = 0; i < 20; i++) {
        if ((await stored()) === want) return want;
        await sleep(150);
      }
      return !want;
    };
    const pageRun = (code) => bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: "MAIN", func: () => { ${code} } })`);

    await scan(tabId, { categories: ["layout"] });
    await pageRun(`location.hash = "#first";`);
    await sleep(800);
    const keptOnAnchor = await stored();

    await pageRun(`history.pushState({}, "", "/tests/fixtures/layout-defects.html?route=products");`);
    const clearedOnPushState = !(await waitFor(false));

    await scan(tabId, { categories: ["layout"] });
    await bg(`handlers["qa:highlight"]({ tabId: ${tabId}, target: { selector: "#clipped" }, info: { title: "x", severity: "high" } })`);
    await pageRun(`history.pushState({}, "", "/tests/fixtures/layout-defects.html?route=cart");`);
    await waitFor(false);
    const overlaysLeft = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);

    await scan(tabId, { categories: ["layout"] });
    await bg(`chrome.tabs.update(${tabId}, { url: ${JSON.stringify(`${BASE}/clean.html`)} })`);
    const clearedOnNavigation = !(await waitFor(false));

    record("route change clears the old report", [
      [keptOnAnchor, "report kept after an in-page anchor (#first)"],
      [clearedOnPushState, "report cleared after a history.pushState route change"],
      [overlaysLeft === 0, `highlights removed from the page on route change (hosts left: ${overlaysLeft})`],
      [clearedOnNavigation, "report cleared after navigating to another page"],
    ]);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 4. Navigating search, opt-in.
  {
    await bg(`handlers["qa:saveSettings"]({ settings: { searchQueryTest: true, searchQuery: "test" } })`);
    const tabId = await openTab(`${BASE}/search-nav.html`);
    const { report } = await scan(tabId, { categories: ["search"] });
    const url = await bg(`chrome.tabs.get(${tabId}).then(t => t.url)`);
    const cq = report.results.find((r) => r.testId === "search.controlled-query");
    record("navigating search (opt-in)", [
      [report.categories.search.status === "completed", `search category status: ${report.categories.search.status}`],
      [!!cq && cq.status === "passed", `controlled query result: ${cq && cq.status} — ${cq && cq.message}`],
      [/search-results\.html\?q=test/.test(url), `tab navigated to ${url}`],
    ]);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 4b. Search without a form whose button navigates by script, scanned together with later categories.
  {
    const tabId = await openTab(`${BASE}/search-js-nav.html`);
    const { scan: s, report } = await scan(tabId, { categories: ["search", "accessibility", "elements"] });
    const url = await bg(`chrome.tabs.get(${tabId}).then(t => t.url)`);
    const cq = report.results.find((r) => r.testId === "search.controlled-query");
    const cats = Object.entries(report.categories);
    record("script-navigating search (opt-in)", [
      [s.status === "completed" && cats.every(([, c]) => c.status === "completed"), `categories: ${cats.map(([k, c]) => `${k}:${c.status}${c.error ? ` (${c.error})` : ""}`).join(", ")}`],
      [!!cq && cq.status === "passed", `controlled query result: ${cq && cq.status} — ${cq && cq.message}`],
      [/search-results\.html\?q=test/.test(url), `tab navigated to ${url} after the other categories ran`],
      [report.meta.title === "Script-navigating search", `other categories inspected the original page (${report.meta.title})`],
    ]);
    await bg(`handlers["qa:saveSettings"]({ settings: { searchQueryTest: false } })`);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 4c. Custom (script) form validation with interactive form tests: page scripts run, data requests blocked.
  {
    await bg(`handlers["qa:saveSettings"]({ settings: { formInteractive: true } })`);
    const tabId = await openTab(`${BASE}/forms-custom.html`);
    requests.length = 0;
    const { report } = await scan(tabId, { categories: ["forms"] });
    const page = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: "MAIN", func: () => ({ sent: window.__sent, guard: !!window.__webqaNetGuard }) }).then(r => r[0].result)`);
    const iv = report.results.filter((r) => r.testId === "forms.interactive-validation");
    const req = report.results.find((r) => r.testId === "forms.required-constraint");
    record("custom form validation (opt-in)", [
      [iv.some((r) => r.status === "passed" && /Please fill in this field/.test(r.message)), `empty submit: ${iv.map((r) => `${r.status}: ${r.message}`).join(" | ")}`],
      [!iv.some((r) => r.status === "warning" || r.status === "failed"), "no validation warnings for a form that validates by script"],
      [!req || req.status === "passed", `"*" without required attribute is not reported as an issue: ${req && req.status}`],
      [!requests.some((r) => r.method === "POST") && page.sent === 0, "the page's POST was blocked; nothing reached the server"],
      [!page.guard, "network guard removed after the scan"],
    ]);
    await bg(`handlers["qa:saveSettings"]({ settings: { formInteractive: false } })`);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 5. External links, opt-in (HEAD without cookies, destructive URLs skipped).
  {
    await bg(`handlers["qa:saveSettings"]({ settings: { checkExternalLinks: true } })`);
    const granted = await bg(`chrome.permissions.contains({ origins: ["http://localhost/*"] })`);
    const tabId = await openTab(`${BASE}/links-external.html`);
    requests.length = 0;
    const { report } = await scan(tabId, { categories: ["links"] });
    const ext = report.results.filter((r) => r.testId === "links.external");
    const toLocalhost = requests.filter((r) => (r.host || "").startsWith("localhost"));
    record("external link checks (opt-in)", [
      [granted, `host access to the "external" origin granted in this test profile: ${granted}`],
      [toLocalhost.some((r) => r.path.endsWith("gone.html")), "the external links were actually requested"],
      [granted ? ext.some((r) => r.status === "failed" && /ext-missing/.test(r.selector)) : ext.some((r) => r.status === "manual"), granted ? "404 external link reported as failed" : "without host access the check is reported as manual, not run"],
      [!ext.some((r) => r.status === "failed" && /ext-ok/.test(r.selector)), "working external link not reported"],
      [!toLocalhost.some((r) => r.path.includes("logout")), "external logout URL was never requested"],
      [toLocalhost.every((r) => r.cookie === null && (r.method === "HEAD" || r.method === "GET")), `external requests: ${toLocalhost.map((r) => `${r.method} ${r.path}`).join(", ") || "none"} (no cookies)`],
    ]);
    await bg(`handlers["qa:saveSettings"]({ settings: { checkExternalLinks: false } })`);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 6. Cancellation mid-scan leaves no emulation behind.
  {
    const tabId = await openTab(`${BASE}/responsive.html`);
    await bg(`handlers["qa:start"]({ tabId: ${tabId}, categories: ["responsive"] })`);
    await sleep(1500);
    const c = await bg(`handlers["qa:cancel"]({ tabId: ${tabId} })`);
    let s;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      s = await bg(`chrome.storage.session.get("scan:${tabId}").then(d => d["scan:${tabId}"])`);
      if (s && s.status !== "running") break;
    }
    const attached = await bg(`chrome.debugger.getTargets().then(ts => ts.some(t => t.tabId === ${tabId} && t.attached))`);
    const vp = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => innerWidth }).then(r => r[0].result)`);
    record("cancel during responsive emulation", [
      [c.ok, "cancel accepted"],
      [s && s.status === "cancelled", `scan status: ${s && s.status}`],
      [!attached && vp > 1000, `debugger detached and desktop viewport restored (innerWidth ${vp})`],
    ]);
    await bg(`chrome.tabs.remove(${tabId})`);
  }

  // 7. Dashboard renders the stored report (opened as a page for the defects tab).
  {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html?tabId=${layoutTab}` });
    const ps = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const errors = [];
    listeners.push((m) => {
      if (m.sessionId === ps && m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.sessionId === ps && m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
    });
    await send("Runtime.enable", {}, ps);
    await send("Emulation.setDeviceMetricsOverride", { width: 752, height: 1100, deviceScaleFactor: 1, mobile: false }, ps);
    await sleep(1500);
    const ui = await evaluate(ps, `({
      tabs: [...document.querySelectorAll(".view-tab")].map(t => t.textContent.trim()).join(" | "),
      cards: [...document.querySelectorAll("#summary .card")].map(c => c.lastChild.textContent.trim()).join(" | "),
      runAll: document.getElementById("runAll").textContent,
      chips: [...new Set([...document.querySelectorAll("#resultsList .chip[class*=ver-]")].map(c => c.textContent))],
      failed: document.getElementById("countFailed").textContent,
      groups: [...document.querySelectorAll("#resultsList details.group > summary")].map(s => s.textContent.trim()),
      cats: document.querySelectorAll(".cat-card").length,
      exportVisible: !document.getElementById("exportBar").classList.contains("d-none"),
      empty: !document.getElementById("emptyState").classList.contains("d-none"),
    })`);
    await evaluate(ps, `document.querySelector(".result-head").click()`);
    await sleep(700);
    const expanded = await evaluate(ps, `!!document.querySelector(".result.open .result-body")`);
    const hostsIn = () => bg(`chrome.scripting.executeScript({ target: { tabId: ${layoutTab} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);
    const uiHighlighted = await hostsIn();
    const noClearButton = await evaluate(ps, `!document.getElementById("clearHighlights")`);
    const noHScroll = await evaluate(ps, `document.documentElement.scrollWidth <= innerWidth`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, ps);
    fs.writeFileSync(path.join(OUT, "dashboard.png"), Buffer.from(shot.data, "base64"));
    await evaluate(ps, `document.querySelector('[data-view="settings"]').click()`);
    await sleep(300);
    const settingsUi = await evaluate(ps, `({ toggles: document.querySelectorAll("[data-setting]").length, presets: document.querySelectorAll("#viewportPresets input").length, unsafeDefaults: ["interactiveTests","formInteractive","searchQueryTest","checkExternalLinks"].filter(k => document.querySelector('[data-setting="' + k + '"]').checked) })`);
    const shot2 = await send("Page.captureScreenshot", { format: "png" }, ps);
    fs.writeFileSync(path.join(OUT, "dashboard-settings.png"), Buffer.from(shot2.data, "base64"));
    record("dashboard (popup.html) renders the report", [
      [Number(ui.failed) > 0 && ui.groups.length >= 2, `summary shows ${ui.failed} failed; groups: ${ui.groups.join(" | ")}`],
      [ui.tabs === "Page audit | Images | Search appearance | Inspect page | Settings" && ui.runAll === "Check this page", `tabs: ${ui.tabs}; main button: ${ui.runAll}`],
      [ui.cards === "Issue found | Possible issue | Review manually | No issue found", `summary cards: ${ui.cards}`],
      [ui.chips.length > 0 && ui.chips.every((c) => ["Issue found", "Possible issue", "Check manually", "No issue found"].includes(c)), `finding labels: ${ui.chips.join(", ")}`],
      [ui.cats === 9 && ui.exportVisible && !ui.empty, "category cards and export bar visible"],
      [expanded, "clicking a result expands its details"],
      [uiHighlighted >= 1 && noClearButton, `expanding a result highlights it on the page (hosts: ${uiHighlighted}); no "Clear highlights" button`],
      [noHScroll, "no horizontal scrolling in the dashboard"],
      [settingsUi.presets === 6 && settingsUi.toggles >= 8 && settingsUi.unsafeDefaults.length === 0, `settings: ${settingsUi.toggles} controls, 6 viewport presets, active-test toggles off by default (${settingsUi.unsafeDefaults.join(",") || "none on"})`],
      [errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`],
    ]);
  }

  // 8. SEO tab: background handler, dashboard rendering, og:image size, and clean-up on route change.
  {
    const png = fs.readFileSync(path.join(ROOT, "icons/main.png"));
    const iconSize = `${png.readUInt32BE(16)} × ${png.readUInt32BE(20)} px`;
    const tabId = await openTab(`${BASE}/seo.html`);
    const direct = await bg(`handlers["qa:seo"]({ tabId: ${tabId} })`);
    const stored = await bg(`chrome.storage.session.get("seo:${tabId}").then(d => !!d["seo:${tabId}"])`);
    await bg(`chrome.storage.session.remove("seo:${tabId}")`);

    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html?tabId=${tabId}` });
    const ps = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const errors = [];
    listeners.push((m) => {
      if (m.sessionId === ps && m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    await send("Runtime.enable", {}, ps);
    await send("Emulation.setDeviceMetricsOverride", { width: 752, height: 1100, deviceScaleFactor: 1, mobile: false }, ps);
    await sleep(1200);
    await evaluate(ps, `document.querySelector('[data-view="seo"]').click()`);
    const readUi = () => evaluate(ps, `({
      groups: [...document.querySelectorAll("#seoChecks details.group")].map(d => ({ label: d.querySelector("summary").textContent.trim(), open: d.open })),
      rows: [...document.querySelectorAll("#seoChecks .result[data-seo-check]")].map(r => ({ id: r.dataset.seoCheck, status: r.querySelector(".seo-status").textContent, name: r.querySelector(".result-name").textContent, value: r.querySelector(".seo-value").textContent, open: r.classList.contains("open"), text: r.textContent })),
      info: [...document.querySelectorAll("#seoChecks [data-seo-info]")].map(r => r.querySelector(".result-name").textContent + " " + r.querySelector(".seo-value").textContent),
      infoBlue: (() => { const d = document.querySelector("#seoChecks details.group-info"); return !!d && getComputedStyle(d.querySelector(".count")).backgroundColor === "rgb(37, 99, 235)" && /Information/.test(d.querySelector("summary").textContent); })(),
    })`);
    const expand = (id) => evaluate(ps, `(() => { const r = document.querySelector('[data-seo-check="${id}"]'); r.closest("details").open = true; r.querySelector(".result-head").click(); })()`);
    const waitRow = async (id, done) => {
      let row;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        row = (await readUi()).rows.find((r) => r.id === id);
        if (row && done(row)) break;
      }
      return row;
    };
    let ui;
    for (let i = 0; i < 40 && !(ui && ui.rows.length); i++) {
      await sleep(250);
      ui = await readUi();
    }
    const closedByDefault = ui.groups.length > 0 && ui.groups.every((g) => !g.open) && ui.rows.every((r) => !r.open);
    await expand("seo.og-image");
    const og = await waitRow("seo.og-image", (r) => r.open && !/measuring/.test(r.text));

    await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => {
      document.querySelector('meta[property="og:image"]').setAttribute("content", "/does-not-exist.png");
      document.querySelector('main a[href="clean.html"]').removeAttribute("href");
    } })`);
    await evaluate(ps, `document.querySelector('[data-view="results"]').click(); document.querySelector('[data-view="seo"]').click()`);
    const rerunStarted = await evaluate(ps, `!document.getElementById("seoProgress").classList.contains("d-none") && !document.getElementById("runSeo")`);
    await waitRow("seo.a-href", (r) => r.status === "Issue found");
    for (let i = 0; i < 40 && !(await evaluate(ps, `document.getElementById("seoProgress").classList.contains("d-none")`)); i++) await sleep(250);
    const readSummary = () => evaluate(ps, `({
      counts: ["Issue", "Warning", "Skipped", "Passed"].map(k => document.getElementById("seoCount" + k).textContent).join("/"),
      progressHidden: document.getElementById("seoProgress").classList.contains("d-none"),
      groups: [...document.querySelectorAll("#seoChecks details.group")].map(d => ({ label: d.querySelector("summary").textContent.trim(), open: d.open })),
      select: document.getElementById("seoFilterStatus").value,
      activeCard: [...document.querySelectorAll("[data-seo-filter].active")].map(b => b.dataset.seoFilter).join(","),
    })`);
    const summary = await readSummary();
    await evaluate(ps, `document.querySelector('[data-seo-filter="issue"]').click()`);
    const filtered = await readSummary();
    await evaluate(ps, `document.getElementById("seoResetFilters").click()`);
    const reset = await readSummary();
    await expand("seo.og-image");
    const og2 = await waitRow("seo.og-image", (r) => r.open && /does-not-exist/.test(r.text) && !/measuring/.test(r.text));
    await bg(`handlers["qa:clearHighlights"]({ tabId: ${tabId} })`);
    await expand("seo.a-href");
    const href = await waitRow("seo.a-href", (r) => r.open);
    const locations = await evaluate(ps, `[...document.querySelectorAll('[data-seo-check="seo.a-href"] .seo-locations li code')].map(c => c.textContent)`);
    await sleep(500);
    const overlayAfterExpand = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);
    await bg(`handlers["qa:clearHighlights"]({ tabId: ${tabId} })`);
    await evaluate(ps, `document.querySelector('[data-seo-check="seo.a-href"] .seo-locations .result-actions button').click()`);
    await sleep(700);
    const overlayAfterButton = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);
    await evaluate(ps, `document.querySelector("#seoChecks details.group-info").open = true`);
    const shot = await send("Page.captureScreenshot", { format: "png" }, ps);
    fs.writeFileSync(path.join(OUT, "dashboard-seo.png"), Buffer.from(shot.data, "base64"));

    const cleared = await bg(`clearIfRouteChanged(${tabId}, "${BASE}/clean.html").then(() => chrome.storage.session.get("seo:${tabId}")).then(d => !d["seo:${tabId}"])`);
    await send("Target.closeTarget", { targetId });
    await bg(`chrome.tabs.remove(${tabId})`);
    const statusOf = (name) => (ui.rows.find((r) => r.name === name) || {}).status;
    record("SEO tab", [
      [direct.ok && direct.seo.checks.length === 8 && stored, `background analysis returned ${direct.seo && direct.seo.checks.length} checks and stored them for the tab`],
      [ui.rows.length === 8 && ui.rows.every((r) => ["No issue found", "Issue found", "Possible issue", "Couldn't compare"].includes(r.status)), `dashboard rows: ${ui.rows.map((r) => `${r.name}=${r.status} (${r.value})`).join("; ")}`],
      [closedByDefault, `groups and rows start closed (${ui.groups.map((g) => g.label).join(" | ")})`],
      [!!href && href.status === "Issue found" && locations.length === 1 && /a:nth-of-type\(1\)|main > a/.test(locations[0]), `anchor without href listed: ${locations.join(", ")}`],
      [overlayAfterExpand === 1 && overlayAfterButton === 1, `expanding the row and the Highlight button both highlight the anchor on the page (${overlayAfterExpand}, ${overlayAfterButton})`],
      [["H1 tag count", "Title tag length", "H1 and title similarity", "H2 tag existence", "Image alt attributes", "Anchor href attributes", "Google tag", "Open Graph image"].every((n) => statusOf(n) === "No issue found"), "every check passes on the fixture"],
      [ui.info.join(" | ") === "H3 count 2 | Word count 18 | Internal links 2 | External links 2" && ui.infoBlue, `information group (blue count): ${ui.info.join(" | ")}`],
      [!!og && og.text.includes(iconSize) && og.text.includes(`${BASE.replace("/tests/fixtures", "")}/icons/main.png`), `og:image URL and size shown (${og && og.text.match(/Dimensions(.*)$/)?.[1]}, expected ${iconSize})`],
      [!!og2 && og2.status === "No issue found" && /DimensionsUnavailable/.test(og2.text), `a failing og:image keeps the existence check and shows: ${og2 && og2.text.match(/Dimensions(.*)$/)?.[1]}`],
      [rerunStarted, "re-opening the SEO tab re-runs the checks (no Run button)"],
      [summary.counts === "1/0/0/7" && summary.progressHidden, `summary cards after rerun (issues/warnings/not compared/passed): ${summary.counts}; progress bar hidden when done: ${summary.progressHidden}`],
      [filtered.groups.length === 1 && /^Issue found/.test(filtered.groups[0].label) && filtered.groups[0].open && filtered.select === "issue" && filtered.activeCard === "issue", `Issues card filters to: ${filtered.groups.map((g) => g.label).join(" | ")} (select=${filtered.select})`],
      [reset.groups.length === summary.groups.length && reset.select === "" && !reset.activeCard, `Reset restores all groups: ${reset.groups.map((g) => g.label).join(" | ")}`],
      [cleared, "SEO results are dropped when the tab changes route"],
      [errors.length === 0, `no dashboard errors${errors.length ? ": " + errors.join(" | ") : ""}`],
    ]);
  }

  }

  // Chrome Web Store screenshots (1280×800) of the real extension on a demo shop page.
  {
    const STORE = path.join(ROOT, "store/screenshots");
    fs.mkdirSync(STORE, { recursive: true });
    await bg(`handlers["qa:setConsent"]({ accepted: true })`);
    const tabId = await openTab(`${STORE_BASE}/store-demo.html`);
    await scan(tabId, {});
    const pageTarget = (await send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.endsWith("/store-demo.html"));
    const pg = (await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true })).sessionId;
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, pg);

    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html?tabId=${tabId}` });
    const ps = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ps);
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, ps);
    await sleep(1500);
    const shoot = async (session, name) => {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, session);
      fs.writeFileSync(path.join(STORE, name), Buffer.from(shot.data, "base64"));
      return name;
    };
    const saved = [];
    await evaluate(ps, `document.querySelectorAll("#resultsList details.group").forEach((d, i) => (d.open = i === 0)); scrollTo(0, 0)`);
    await sleep(300);
    saved.push(await shoot(ps, "1-page-audit.png"));
    const finding = await evaluate(ps, `(() => {
      const head = [...document.querySelectorAll("#resultsList .result-head")].find(h => /clipped/i.test(h.textContent)) || document.querySelector("#resultsList .result-head");
      head.click();
      return head.querySelector(".result-name").textContent;
    })()`);
    await sleep(900);
    await evaluate(ps, `document.querySelector(".result.open").scrollIntoView({ block: "start" })`);
    await sleep(300);
    saved.push(await shoot(ps, "2-finding-details.png"));
    const hosts = await bg(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelectorAll("#__webqa-overlay-host").length }).then(r => r[0].result)`);
    saved.push(await shoot(pg, "3-highlighted-element.png"));
    await evaluate(ps, `document.querySelector('[data-view="seo"]').click()`);
    for (let i = 0; i < 40 && !(await evaluate(ps, `!document.getElementById("seoResults").classList.contains("d-none") && document.getElementById("seoProgress").classList.contains("d-none")`)); i++) await sleep(250);
    await evaluate(ps, `document.querySelectorAll("#seoChecks details.group").forEach(d => (d.open = !d.classList.contains("group-info"))); scrollTo(0, 0)`);
    await sleep(300);
    saved.push(await shoot(ps, "4-search-appearance.png"));
    await evaluate(ps, `document.querySelector('[data-view="settings"]').click(); document.querySelector(".advanced-settings").open = true; scrollTo(0, 0)`);
    await sleep(300);
    saved.push(await shoot(ps, "5-settings-disclosures.png"));
    const sizes = saved.map((n) => {
      const png = fs.readFileSync(path.join(STORE, n));
      return `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`;
    });
    await send("Target.closeTarget", { targetId });
    await bg(`chrome.tabs.remove(${tabId})`);
    record("store screenshots", [
      [sizes.every((s) => s === "1280×800"), `${saved.length} screenshots at ${[...new Set(sizes)].join(", ")} in store/screenshots/`],
      [hosts === 1, `the expanded finding (“${finding}”) is highlighted on the page`],
    ]);
  }
} catch (e) {
  console.error("Run aborted:", e.message);
  outcomes.push({ name: "run", ok: false });
} finally {
  chrome.kill();
  server.close();
  setTimeout(() => {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }, 800);
}
const failed = outcomes.filter((o) => !o.ok).length;
console.log(`\n${outcomes.length - failed}/${outcomes.length} extension scenarios passed.`);
process.exitCode = failed ? 1 : 0;
