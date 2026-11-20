// QA runner: executes one category per call so the background worker can report progress, cancel between
// categories and enforce timeouts. Results are plain JSON (no DOM references).
(function () {
  "use strict";
  const QA = window.__webQA;

  QA.runCategory = async function (category, options = {}) {
    const def = QA.categories[category];
    const t0 = performance.now();
    if (!def) {
      return { category, status: "error", error: `Unknown category: ${category}`, results: [], ran: [], skipped: [], limitations: [], extras: {}, durationMs: 0 };
    }
    QA.state.cancelled = false;
    QA.state.running = true;
    const ctx = QA.createContext(category, options);
    const only = options.onlyTests && options.onlyTests.length ? new Set(options.onlyTests) : null;
    let error = null;
    try {
      if (!document.body) throw new Error("Document has no body yet.");
      if (def.tests) {
        for (const t of def.tests) await ctx.test(t.id, t.name, () => t.run(ctx), t.pass);
      }
      if (def.custom) {
        const list = (await def.custom(ctx)) || [];
        for (const t of list) {
          if (!ctx.shouldRun(t.id)) continue;
          ctx.markRan(t.id);
          if (!t.found) ctx.pass(t.id, t.name, t.passMessage || "No issues detected.");
        }
      }
      if (def.after) await def.after(ctx);
      if (def.manual && !only && !options.viewport) {
        for (const m of def.manual) ctx.manual(m.id, m.name, m.message, { severity: m.severity || "info" });
      }
    } catch (e) {
      error = e;
    } finally {
      QA.state.running = false;
    }
    const out = ctx.finish(Math.round(performance.now() - t0), error);
    if (only) out.results = out.results.filter((r) => only.has(r.sourceTest) || only.has(r.testId));
    return out;
  };

  QA.cancel = function () {
    QA.state.cancelled = true;
    return { ok: true };
  };

  QA.ping = function () {
    return {
      ok: true,
      version: QA.version,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      categories: Object.keys(QA.categories),
      viewport: QA.h.viewport(),
      scroll: { x: scrollX, y: scrollY },
      running: QA.state.running,
    };
  };
})();
