// Browser-level engine tests: serves the repo over HTTP, drives headless Chrome through the DevTools protocol,
// runs the QA engine on each fixture page and verifies expectations plus safety guarantees.
// Usage: node tests/browser/run-harness.mjs   (set CHROME_PATH to override the browser binary)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/browser/output");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };

// ---------------------------------------------------------------- static server with request log
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  requests.push({ method: req.method, path: url.pathname });
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end(req.method === "HEAD" ? undefined : "not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- chrome
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error("No Chrome/Chromium/Edge binary found; set CHROME_PATH.");
  process.exit(2);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "webqa-harness-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function devtoolsPort() {
  const f = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(f)) {
      const [port] = fs.readFileSync(f, "utf8").split("\n");
      if (port) return Number(port);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome did not start");
}
const port = await devtoolsPort();

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    };
    this.ready = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
      const l = (m) => {
        if (m.method === method) {
          clearTimeout(t);
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve(m.params);
        }
      };
      this.listeners.push(l);
    });
  }
  async eval(expression, timeout = 60000) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function openPage(fixture) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  cdp.targetId = target.id;
  cdp.network = [];
  cdp.listeners.push((m) => {
    if (m.method === "Network.requestWillBeSent") cdp.network.push({ url: m.params.request.url, method: m.params.request.method });
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${BASE}/tests/fixtures/${fixture}` });
  await loaded;
  await cdp.eval("new Promise(r => setTimeout(r, 300))");
  return cdp;
}

async function closePage(cdp) {
  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${cdp.targetId}`).catch(() => {});
}

// ---------------------------------------------------------------- scenarios
const outcomes = [];
function record(name, ok, details = []) {
  outcomes.push({ name, ok, details });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  for (const d of details) console.log(`      ${d}`);
}

function summarizeRun(run) {
  return `failed ${run.counts.failed}, warnings ${run.counts.warning}, manual ${run.counts.manual}, passed ${run.counts.passed}`;
}

fs.mkdirSync(OUT, { recursive: true });
const collected = {};

async function simpleFixture(file, extraChecks) {
  const cdp = await openPage(file);
  try {
    const startUrl = await cdp.eval("location.href");
    const run = await cdp.eval("window.__qaRun()", 120000);
    collected[file] = run;
    const details = [summarizeRun(run), ...run.problems];
    let ok = run.ok;
    const endUrl = await cdp.eval("location.href");
    if (endUrl !== startUrl) {
      ok = false;
      details.push(`page navigated during the scan: ${endUrl}`);
    }
    if (extraChecks) {
      const extra = await extraChecks(cdp, run);
      for (const [good, msg] of extra) {
        if (!good) ok = false;
        details.push(`${good ? "ok" : "NOT OK"}: ${msg}`);
      }
    }
    record(file, ok, details);
  } catch (e) {
    record(file, false, [e.message]);
  } finally {
    await closePage(cdp);
  }
}

try {
  await simpleFixture("clean.html");

  await simpleFixture("layout-defects.html", async (cdp) => {
    const before = await cdp.eval(`(() => { const el = document.getElementById("clipped"); return { attrs: [...el.attributes].map(a => a.name + "=" + a.value), body: document.body.innerHTML.length }; })()`);
    const hl = await cdp.eval(`window.__webQA.inspector.highlight({ selector: "#clipped" }, { title: "Text clipped", severity: "high", status: "failed", message: "Demo highlight", lines: ["Fix: remove the fixed height"] })`);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "highlight.png"), Buffer.from(shot.data, "base64"));
    const after = await cdp.eval(`(() => { const el = document.getElementById("clipped"); const host = document.getElementById("__webqa-overlay-host"); return { attrs: [...el.attributes].map(a => a.name + "=" + a.value), host: !!host, hostInBody: !!(host && document.body.contains(host)) }; })()`);
    await cdp.eval("window.__webQA.inspector.clear()");
    const cleared = await cdp.eval(`(() => { const host = document.getElementById("__webqa-overlay-host"); return !host || !host.isConnected || host.shadowRoot === null; })()`);
    return [
      [hl && hl.ok, "highlight() found the element by selector"],
      [after.host && !after.hostInBody, "overlay lives in its own host outside <body>"],
      [JSON.stringify(before.attrs) === JSON.stringify(after.attrs), "highlighting did not modify the element's attributes/styles"],
      [cleared, "overlay host uses a closed shadow root / is removed on clear"],
    ];
  });

  await simpleFixture("images.html");

  await simpleFixture("repeated-components.html");

  await simpleFixture("links.html", async (cdp) => {
    const external = cdp.network.filter((r) => r.url.includes("example.invalid"));
    const logout = requests.filter((r) => r.path.includes("logout"));
    const missing = requests.filter((r) => r.path.endsWith("does-not-exist.html"));
    return [
      [external.length === 0, "no request was made to the external link (external checks are off by default)"],
      [logout.length === 0, "the logout link was never requested"],
      [missing.length > 0 && missing.every((r) => r.method === "HEAD" || r.method === "GET"), `same-origin link checked with ${[...new Set(missing.map((r) => r.method))].join("/")}`],
    ];
  });

  await simpleFixture("forms.html", async (cdp) => {
    const state = await cdp.eval(`({ submitted: window.__submitted, email: document.getElementById("email-as-text").value, nick: document.getElementById("nolabel").value })`);
    const posts = requests.filter((r) => r.method === "POST");
    const external = cdp.network.filter((r) => r.url.includes("example.invalid"));
    return [
      [external.length === 0 && posts.length === 0, "no form was submitted over the network"],
      [state.email === "qa-secret-value" && state.nick === "", "original field values were restored after interactive validation"],
      [true, `submit events seen by the page: ${state.submitted} (blocked before reaching the network)`],
    ];
  });

  await simpleFixture("forms-custom.html", async (cdp, run) => {
    const posts = requests.filter((r) => r.method === "POST");
    const state = await cdp.eval(`({ sent: window.__sent, fetchRestored: !window.__webqaNetGuard && !/Blocked by Website Page Auditor/.test(String(window.fetch)), name: document.getElementById("name").value })`);
    const iv = run.results.filter((r) => r.testId === "forms.interactive-validation");
    return [
      [posts.length === 0 && state.sent === 0, "the page's own fetch POST was blocked; nothing reached the server"],
      [state.fetchRestored, "page fetch() restored after the test"],
      [state.name === "", "field values restored"],
      [true, `interactive results: ${iv.map((r) => `${r.status}: ${r.message}`).join(" | ")}`],
    ];
  });

  await simpleFixture("search.html", async (cdp, run) => {
    const v = await cdp.eval(`document.getElementById("status").textContent`);
    const cq = run.results.find((r) => r.testId === "search.controlled-query");
    return [
      [/results for "test"/.test(v), `the page's own search responded: ${JSON.stringify(v)}`],
      [!!cq && /2 visible result item/.test(cq.message), `verdict: ${cq && cq.message}`],
    ];
  });

  await simpleFixture("search-broken.html", async (cdp, run) => {
    const cq = run.results.find((r) => r.testId === "search.controlled-query");
    return [[!!cq && /Nothing found/i.test(cq.message), `verdict: ${cq && cq.status} — ${cq && cq.message}`]];
  });

  for (const file of ["modal.html", "modal-sibling.html"]) {
    await simpleFixture(file, async (cdp, run) => {
      const lims = Object.values(run.runs).flatMap((r) => r.limitations || []);
      return [[lims.some((l) => /A modal is open/.test(l)), `custom modal recognised: ${lims.find((l) => /A modal is open/.test(l)) || "no"}`]];
    });
  }
  {
    // The same page with the modal closed: background overlap/covered checks must run again.
    const cdp = await openPage("modal.html");
    try {
      await cdp.eval(`document.querySelector(".popup-wrap").remove()`);
      const run = await cdp.eval(`window.__qaRun({ expect: { categories: ["layout", "links", "interactions"], present: [] } })`, 120000);
      const lims = Object.values(run.runs).flatMap((r) => r.limitations || []);
      const ok = !lims.some((l) => /A modal is open/.test(l));
      record("modal.html with the modal closed", ok, [summarizeRun(run), `${ok ? "ok" : "NOT OK"}: no modal detected on the normal page`]);
    } catch (e) {
      record("modal.html with the modal closed", false, [e.message]);
    } finally {
      await closePage(cdp);
    }
  }

  await simpleFixture("interactions.html", async (cdp) => {
    const s = await cdp.eval(`({ faqOpen: document.getElementById("faq").open, deleteExpanded: document.getElementById("delete").getAttribute("aria-expanded"), panelHidden: document.getElementById("faq-panel").hidden })`);
    return [
      [s.faqOpen === false, "disclosure widget state was restored after the toggle test"],
      [s.deleteExpanded === "false" && s.panelHidden === true, "the destructive-looking control was never activated"],
    ];
  });

  // Responsive: emulate viewports via DevTools (same commands the extension uses), then verify restoration.
  {
    const cdp = await openPage("responsive.html");
    const details = [];
    let ok = true;
    try {
      const base = await cdp.eval("({ w: innerWidth, h: innerHeight })");
      await cdp.eval("window.__webQA ? 0 : new Promise(r => setTimeout(r, 500))");
      await cdp.eval("window.__qaRun({ categories: [], expect: { present: [] } })");
      await cdp.eval("window.__webQA.responsiveBaseline()");
      const all = [];
      for (const vp of [{ label: "Small mobile", width: 320, height: 568, mobile: true }, { label: "Laptop", width: 1366, height: 768, mobile: false }]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 0, mobile: vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
        const layout = await cdp.eval("window.__webQA.waitForLayout(500)");
        const actual = vp.mobile ? layout.layoutWidth : layout.width;
        if (actual !== vp.width) {
          ok = false;
          details.push(`viewport ${vp.width} not applied (got ${actual})`);
        }
        const run = await cdp.eval(`window.__qaRun({ categories: ["responsive"], options: { viewport: ${JSON.stringify({ ...vp, method: "emulation", actualWidth: layout.width, actualHeight: layout.height })} }, expect: { present: [] } })`, 120000);
        details.push(`${vp.width}×${vp.height}: ${summarizeRun(run)}`);
        all.push(...run.results.map((r) => ({ ...r, vp: vp.width })));
      }
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      const restored = await cdp.eval("window.__webQA.waitForLayout(300)");
      const mobileOverflow = all.some((r) => r.vp === 320 && r.testId === "layout.horizontal-overflow" && r.status === "failed");
      const desktopOverflow = all.some((r) => r.vp === 1366 && r.testId === "layout.horizontal-overflow" && r.status === "failed");
      const navHidden = all.some((r) => r.vp === 320 && r.testId === "responsive.essential-hidden" && r.status !== "passed");
      const checks = [
        [mobileOverflow, "horizontal overflow detected at 320px"],
        [!desktopOverflow, "no horizontal overflow at 1366px"],
        [navHidden, "navigation hidden at 320px is reported"],
        [restored.width === base.w && restored.height === base.h, `viewport restored to ${base.w}×${base.h} (now ${restored.width}×${restored.height})`],
      ];
      for (const [good, msg] of checks) {
        if (!good) ok = false;
        details.push(`${good ? "ok" : "NOT OK"}: ${msg}`);
      }
      collected["responsive.html"] = { results: all };
    } catch (e) {
      ok = false;
      details.push(e.message);
    }
    record("responsive.html (DevTools emulation + restore)", ok, details);
    await closePage(cdp);
  }

  // SEO tab analysis: the fixture first, then DOM edits that hit each issue branch.
  {
    const cdp = await openPage("seo.html");
    const details = [];
    let ok = true;
    try {
      await cdp.eval("window.__qaRun({ categories: [], expect: { present: [] } })");
      const s = await cdp.eval(`(() => {
        const A = () => window.__webQA.seo.analyze();
        const pick = (r) => Object.fromEntries(r.checks.map((c) => [c.id.slice(4), { status: c.status, value: c.value, detail: c.detail }]));
        const out = {};
        const base = A();
        out.base = { checks: pick(base), info: base.info, title: base.title, titleLength: base.titleLength, og: base.ogImage };
        const h1 = document.getElementById("h1");
        const titleEl = document.querySelector("title");
        const origTitle = titleEl.textContent;
        const extra = document.createElement("h1");
        extra.textContent = "Second heading";
        document.body.append(extra);
        out.twoH1 = pick(A());
        out.twoH1Items = A().checks.find((c) => c.id === "seo.h1-count").items;
        extra.remove();
        h1.remove();
        out.noH1 = pick(A());
        document.querySelector("main").prepend(h1);
        h1.textContent = "  Acme Widgets  -   Durable tools for every workshop ";
        out.sameAsTitle = pick(A());
        h1.textContent = "Welcome to Acme";
        const len = (n) => { titleEl.textContent = "x".repeat(n); return pick(A())["title-length"]; };
        out.t29 = len(29); out.t30 = len(30); out.t65 = len(65); out.t66 = len(66);
        titleEl.textContent = "   ";
        out.emptyTitle = pick(A());
        titleEl.remove();
        out.noTitle = pick(A());
        document.head.append(titleEl);
        titleEl.textContent = origTitle;
        const h2 = document.querySelector("h2");
        h2.remove();
        out.noH2 = pick(A())["h2-exists"];
        document.querySelector("main").insertBefore(h2, document.querySelector("main p"));
        const img = document.createElement("img");
        img.src = "/icons/main.png";
        document.querySelector("main").append(img);
        out.imgNoAlt = A().checks.find((c) => c.id === "seo.img-alt");
        img.remove();
        const a = document.createElement("a");
        a.textContent = "no href";
        document.querySelector("main").append(a);
        out.aNoHref = A().checks.find((c) => c.id === "seo.a-href");
        const ul = document.createElement("ul");
        ul.innerHTML = Array.from({ length: 5 }, (_, i) => '<li class="card"><a class="card-link">Product ' + i + "</a></li>").join("");
        document.querySelector("main").append(ul);
        out.aRepeated = A().checks.find((c) => c.id === "seo.a-href").items;
        ul.remove();
        a.remove();
        const gs = document.getElementById("gtag-src");
        const gi = document.getElementById("gtag-init");
        gs.remove();
        out.inlineOnly = pick(A())["google-tag"];
        gi.remove();
        out.noGtag = pick(A())["google-tag"];
        const og = document.querySelector('meta[property="og:image"]');
        og.setAttribute("content", "  ");
        out.ogEmpty = A().checks.find((c) => c.id === "seo.og-image").status;
        og.remove();
        out.ogMissing = A().checks.find((c) => c.id === "seo.og-image").status;
        return out;
      })()`);
      const b = s.base.checks;
      const checks = [
        [b["h1-count"].status === "passed" && b["h1-count"].value === "1", `one H1: ${b["h1-count"].status} (${b["h1-count"].value})`],
        [s.twoH1["h1-count"].status === "issue" && s.twoH1["h1-count"].value === "2", `two H1: ${s.twoH1["h1-count"].status} (${s.twoH1["h1-count"].value})`],
        [s.twoH1Items && s.twoH1Items.total === 2, `both H1s listed: ${s.twoH1Items && s.twoH1Items.groups.flatMap((g) => g.instances.map((i) => i.label)).join(" | ")}`],
        [s.noH1["h1-count"].status === "issue" && s.noH1["h1-count"].value === "0", `no H1: ${s.noH1["h1-count"].status} (${s.noH1["h1-count"].value})`],
        [b["title-length"].status === "passed" && s.base.titleLength === 47 && s.base.title === "Acme Widgets - Durable tools for every workshop", `title "${s.base.title}" = ${b["title-length"].value}`],
        [s.t29.status === "issue" && s.t30.status === "passed" && s.t65.status === "passed" && s.t66.status === "issue", `title length 29/30/65/66: ${[s.t29, s.t30, s.t65, s.t66].map((t) => t.status).join("/")}`],
        [s.emptyTitle["title-length"].status === "issue" && /empty/.test(s.emptyTitle["title-length"].detail), `empty title: ${s.emptyTitle["title-length"].detail}`],
        [s.noTitle["title-length"].status === "issue" && /no <title>/.test(s.noTitle["title-length"].detail), `missing title: ${s.noTitle["title-length"].detail}`],
        [b["h1-title-similarity"].status === "passed", `different H1 and title: ${b["h1-title-similarity"].status}`],
        [s.sameAsTitle["h1-title-similarity"].status === "issue", `H1 equal to title after whitespace normalization: ${s.sameAsTitle["h1-title-similarity"].status}`],
        [["twoH1", "noH1", "emptyTitle", "noTitle"].every((k) => s[k]["h1-title-similarity"].status === "skipped"), `not compared with 2 H1 / no H1 / empty title / no title: ${["twoH1", "noH1", "emptyTitle", "noTitle"].map((k) => s[k]["h1-title-similarity"].status).join("/")}`],
        [b["h2-exists"].status === "passed" && s.noH2.status === "issue", `H2: ${b["h2-exists"].status} with one, ${s.noH2.status} with none`],
        [s.base.info.h3 === 2, `H3 count: ${s.base.info.h3}`],
        [s.base.info.words === 18 && s.base.info.scope === "main", `word count: ${s.base.info.words} in <${s.base.info.scope}> (hidden, screen-reader-only, script and template text excluded)`],
        [b["img-alt"].status === "passed" && b["img-alt"].value === "0 of 2 missing", `images with alt and alt="": ${b["img-alt"].value}`],
        [s.imgNoAlt.status === "issue" && s.imgNoAlt.value === "1 of 3 missing", `image without alt: ${s.imgNoAlt.status} (${s.imgNoAlt.value})`],
        [s.imgNoAlt.items.total === 1 && /main\.png$/.test(s.imgNoAlt.items.groups[0].instances[0].label) && !!s.imgNoAlt.items.groups[0].instances[0].selector, `image without alt located: ${s.imgNoAlt.items.groups[0].instances[0].selector} (${s.imgNoAlt.items.groups[0].instances[0].label})`],
        [!b["img-alt"].items && !b["a-href"].items, "passed checks list no elements"],
        [b["a-href"].status === "passed" && b["a-href"].value === "0 of 5 missing", `anchors incl. href="": ${b["a-href"].value}`],
        [s.aNoHref.status === "issue" && s.aNoHref.value === "1 of 6 missing", `anchor without href: ${s.aNoHref.status} (${s.aNoHref.value})`],
        [s.base.info.links.internal === 2 && s.base.info.links.external === 2, `links (same rule as the external-links visual aid): ${s.base.info.links.internal} internal (#top, clean.html), ${s.base.info.links.external} external (www.example.org, mailto:); href="" not counted`],
        [s.aNoHref.items.total === 1 && s.aNoHref.items.groups[0].instances[0].label === "no href", `anchor without href located: ${s.aNoHref.items.groups[0].instances[0].selector}`],
        [s.aRepeated.total === 6 && s.aRepeated.groups.length === 2 && s.aRepeated.groups.some((g) => g.count === 5 && g.instances.length === 5), `5 anchors in one repeated component form one group: ${s.aRepeated.groups.map((g) => `${g.pattern} ×${g.count}`).join(", ")}`],
        [b["google-tag"].status === "passed" && /G-TEST123/.test(b["google-tag"].detail), `Google tag: ${b["google-tag"].detail}`],
        [s.inlineOnly.status === "passed" && /gtag\(\) initialization/.test(s.inlineOnly.detail), `inline gtag() config only: ${s.inlineOnly.status}`],
        [s.noGtag.status === "warning", `no Google tag: ${s.noGtag.status}`],
        [b["og-image"].status === "passed" && s.base.og.url === `${BASE}/icons/main.png`, `og:image present: ${s.base.og.url}`],
        [s.ogEmpty === "issue" && s.ogMissing === "issue", `og:image empty / missing: ${s.ogEmpty} / ${s.ogMissing}`],
        [!cdp.network.some((r) => /google/.test(r.url)), "no request to Google was made"],
      ];
      for (const [good, msg] of checks) {
        if (!good) ok = false;
        details.push(`${good ? "ok" : "NOT OK"}: ${msg}`);
      }
    } catch (e) {
      ok = false;
      details.push(e.message);
    }
    record("seo.html (SEO tab analysis)", ok, details);
    await closePage(cdp);
  }
} finally {
  chrome.kill();
  server.close();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
}

const failed = outcomes.filter((o) => !o.ok);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} browser scenarios passed (${path.basename(chromePath)}).`);
process.exitCode = failed.length ? 1 : 0;
