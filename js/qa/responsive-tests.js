// Responsive QA (in-page part). The background worker changes the real viewport (DevTools emulation or window
// resizing) and calls QA.runCategory("responsive") once per viewport; this module evaluates the page at that size.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;

  const ALLOWED = new Set([
    "layout.horizontal-overflow",
    "layout.outside-viewport",
    "layout.text-clipped",
    "layout.text-overflow",
    "layout.collapsed-content",
    "layout.overlapping-siblings",
    "layout.content-overflow-fixed-height",
    "layout.obscured-by-fixed",
    "layout.overlay-beyond-viewport",
    "images.outside-container",
    "images.distorted",
    "images.zero-size",
    "images.unexpectedly-large",
    "interactions.zero-size",
    "search.visibility",
    "responsive.inner-scroll",
    "responsive.essential-hidden",
  ]);

  const ESSENTIAL_SEL = "nav a[href], header a[href], [role=navigation] a[href], header button, nav button, main button, form button, input:not([type=hidden]), select, textarea, h1, [role=search] input";

  // Snapshot of important elements visible at the original viewport.
  QA.responsiveBaseline = function () {
    const items = [];
    for (const el of document.querySelectorAll(ESSENTIAL_SEL)) {
      if (h.isOwnNode(el) || !h.isVisible(el) || h.isVisuallyHiddenPattern(el) || h.isAriaHidden(el)) continue;
      items.push({ ref: h.refFor(el), selector: h.cssPath(el), name: (h.accessibleName(el).name || el.localName).slice(0, 60) });
      if (items.length >= 300) break;
    }
    QA.state.baseline = { items, width: innerWidth, height: innerHeight };
    return { ok: true, count: items.length, width: innerWidth, height: innerHeight };
  };

  QA.waitForLayout = async function (ms = 450) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, ms));
    return { width: innerWidth, height: innerHeight, layoutWidth: document.documentElement.clientWidth, dpr: devicePixelRatio, scrollY };
  };

  function menuToggle() {
    return [...document.querySelectorAll("button, [role=button], a")].find((b) => {
      if (!h.isVisible(b)) return false;
      const t = [h.accessibleName(b).name, b.className && String(b.className), b.id, b.getAttribute("aria-controls")].join(" ");
      return /menu|navigation|navbar|hamburger|burger|toggler|☰|nav-toggle|drawer/i.test(t) || (b.hasAttribute("aria-expanded") && b.closest("header, nav, [role=banner]"));
    });
  }

  async function essentialHidden(ctx) {
    const base = QA.state.baseline;
    if (!base || !base.items.length) return { skipped: "No baseline captured at the original viewport." };
    if (Math.abs(base.width - innerWidth) < 2) return { message: "This is the baseline viewport." };
    const missing = [];
    for (const it of base.items) {
      await ctx.tick();
      const el = h.elementByRef(it.ref);
      if (!el) {
        missing.push({ ...it, state: "removed from DOM" });
        continue;
      }
      if (!h.isVisible(el) || h.isAriaHidden(el)) missing.push({ ...it, state: "hidden" });
      else {
        const r = el.getBoundingClientRect();
        if (r.right + scrollX < 0 || r.left + scrollX > document.documentElement.clientWidth) missing.push({ ...it, state: "off-screen" });
      }
    }
    if (!missing.length) return { message: `All ${base.items.length} key elements visible at ${base.width}px are still visible.` };
    const toggle = menuToggle();
    const navOnly = missing.every((m) => /nav|header/.test(m.selector) || /^a/.test(m.selector));
    ctx.add({
      element: toggle || null,
      selector: toggle ? undefined : "body",
      status: toggle && navOnly ? "manual" : "warning",
      severity: toggle && navOnly ? "low" : "medium",
      verification: toggle && navOnly ? "manual" : "inferred",
      message: `${missing.length} of ${base.items.length} key elements visible at ${base.width}px are not visible at ${innerWidth}px${toggle ? `. A menu toggle (${h.cssPath(toggle)}) is present — open it and confirm they are reachable.` : " and no menu toggle was detected; essential functionality may be unavailable at this width."}`,
      actual: `${missing.length} hidden/removed`,
      expected: "every function reachable at every width (directly or via a menu)",
      evidence: { examples: missing.slice(0, 12).map((m) => `${m.state}: ${m.name} (${m.selector})`) },
      fix: "Make sure hidden items are available through a visible, keyboard-operable menu at this breakpoint.",
    });
  }

  async function innerScroll(ctx) {
    const { list } = h.allElements();
    for (const el of list) {
      await ctx.tick();
      if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth < 40) continue;
      const cs = getComputedStyle(el);
      if (!/auto|scroll/.test(cs.overflowX)) continue;
      if (!h.isVisible(el)) continue;
      if (cs.scrollSnapType !== "none" || el.querySelector("table, pre, code") || el.matches("pre, code, textarea, table") || el.getAttribute("aria-roledescription") || el.getAttribute("role") === "region") continue;
      if (el.closest("[role=tablist], [role=toolbar]")) continue;
      ctx.add({
        element: el,
        status: "warning",
        severity: "low",
        verification: "inferred",
        message: `Component scrolls horizontally (${el.scrollWidth}px of content in ${el.clientWidth}px). Intended for carousels/tables, otherwise usually a layout bug.`,
        actual: `scrollWidth ${el.scrollWidth}px, clientWidth ${el.clientWidth}px`,
        expected: "content fits, or an intentional, discoverable scroller",
        evidence: { overflowX: cs.overflowX },
        fix: "If unintended, let the content wrap or shrink; if intended, add scroll-snap and visual affordances.",
      });
    }
  }

  QA.register("responsive", {
    label: "Responsive",
    custom: async (ctx) => {
      const sub = { ...ctx.options, interactiveTests: false, formInteractive: false, searchQueryTest: false, skipBackgroundImages: true };
      const saveOpts = ctx.options;
      ctx.options = sub;
      const summary = [];
      try {
        for (const t of QA.categories.layout.tests) {
          if (ALLOWED.has(t.id)) await ctx.test(t.id, t.name, () => t.run(ctx), t.pass);
        }
        for (const cat of ["images", "interactions", "search"]) {
          const def = QA.categories[cat];
          if (!def || !def.custom) continue;
          const tests = await def.custom(ctx);
          summary.push(...(tests || []).filter((t) => ALLOWED.has(t.id)));
        }
        await ctx.test("responsive.inner-scroll", "Unexpected inner horizontal scrollbars", () => innerScroll(ctx), "No unexpected horizontal scrollers.");
        await ctx.test("responsive.essential-hidden", "Key content hidden at this width", () => essentialHidden(ctx));
      } finally {
        ctx.options = saveOpts;
      }
      // Drop results from shared checks that are not viewport-dependent.
      for (let i = ctx.results.length - 1; i >= 0; i--) if (!ALLOWED.has(ctx.results[i].testId)) ctx.results.splice(i, 1);
      return summary;
    },
  });
})();
