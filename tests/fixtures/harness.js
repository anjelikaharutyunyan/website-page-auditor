// Loads the QA engine into a fixture page (main world, via <script> tags) and checks the results against the
// page's <script type="application/json" id="qa-expect"> block. Used by tests/browser/run-harness.mjs.
(() => {
  const ENGINE = [
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
  const base = document.currentScript.src.replace(/tests\/fixtures\/harness\.js.*$/, "");

  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = base + src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  const ready = (async () => {
    for (const f of ENGINE) await load(f);
  })();

  // The background worker's MAIN-world network guard, taken verbatim from js/background.js.
  async function backgroundFn(name) {
    const src = await (await fetch(base + "js/background.js")).text();
    const m = src.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`));
    if (!m) throw new Error(`${name} not found in background.js`);
    return new Function(`return (${m[0]})`)();
  }

  // Same steps as runSearchQuery() in the background worker, for same-page searches.
  async function runSearchPlan(plan, options) {
    const sub = window.__webQA.searchSubmit(plan);
    if (!sub.ok) throw new Error(`searchSubmit failed: ${sub.error}`);
    await new Promise((r) => setTimeout(r, 3000));
    return window.__webQA.searchVerify(plan.query, plan.startUrl, options);
  }

  function matches(r, spec) {
    if (spec.testId && r.testId !== spec.testId) return false;
    if (spec.status && r.status !== spec.status) return false;
    if (spec.selectorIncludes && !(r.selector || "").includes(spec.selectorIncludes)) return false;
    if (typeof spec.occurrences === "number" && r.occurrences !== spec.occurrences) return false;
    return true;
  }

  // run({ categories, options, expect }) -> { ok, problems, counts, results }
  window.__qaRun = async (override = {}) => {
    await ready;
    const expect = override.expect || JSON.parse(document.getElementById("qa-expect").textContent);
    const categories = override.categories || expect.categories;
    const options = { ...(expect.options || {}), ...(override.options || {}) };
    const results = [];
    const runs = {};
    for (const c of categories) {
      const guarded = c === "forms" && options.formInteractive && options.networkGuard;
      if (guarded) (await backgroundFn("installNetworkGuard"))();
      let out;
      try {
        out = await window.__webQA.runCategory(c, options);
      } finally {
        if (guarded) (await backgroundFn("removeNetworkGuard"))();
      }
      runs[c] = { status: out.status, error: out.error, ran: out.ran.length, skipped: out.skipped, limitations: out.limitations };
      results.push(...out.results);
      if (c === "search" && out.extras && out.extras.searchPlan) {
        const sq = await runSearchPlan(out.extras.searchPlan, options);
        results.push(...sq.results);
      }
    }
    const problems = [];
    for (const spec of expect.present || []) {
      if (!results.some((r) => matches(r, spec))) problems.push(`missing expected result ${JSON.stringify(spec)}`);
    }
    for (const spec of expect.exactlyOnce || []) {
      const hits = results.filter((r) => r.status !== "passed" && matches({ ...r, occurrences: undefined }, { ...spec, occurrences: undefined }));
      if (hits.length !== 1) problems.push(`expected exactly one result for ${JSON.stringify(spec)}, got ${hits.length}`);
      else if (typeof spec.occurrences === "number" && hits[0].occurrences !== spec.occurrences) problems.push(`expected ${JSON.stringify(spec)} to be repeated ×${spec.occurrences}, got ×${hits[0].occurrences}`);
    }
    for (const spec of expect.absent || []) {
      const hits = results.filter((r) => r.status !== "passed" && matches(r, spec));
      if (hits.length) problems.push(`unexpected ${JSON.stringify(spec)} -> ${hits.map((h) => `${h.testId}@${h.selector}: ${h.message}`).join(" | ")}`);
    }
    if (typeof expect.maxFailed === "number") {
      const failed = results.filter((r) => r.status === "failed");
      if (failed.length > expect.maxFailed) problems.push(`too many failures (${failed.length} > ${expect.maxFailed}): ${failed.map((f) => `${f.testId}@${f.selector}`).join(", ")}`);
    }
    for (const [c, r] of Object.entries(runs)) if (r.status !== "completed") problems.push(`category ${c} ended with ${r.status}: ${r.error || ""}`);
    if (JSON.stringify(results).includes("qa-secret-value")) problems.push("a form value leaked into the results");
    const counts = { failed: 0, warning: 0, manual: 0, passed: 0 };
    for (const r of results) counts[r.status]++;
    return {
      ok: problems.length === 0,
      problems,
      counts,
      runs,
      results: results.map((r) => ({ testId: r.testId, status: r.status, severity: r.severity, verification: r.verification, selector: r.selector, message: r.message })),
    };
  };
})();
