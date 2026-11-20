// Elements category + highlight overlay.
// The overlay lives in a closed Shadow DOM attached to one host element; page elements are never restyled.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  // ---------------- overlay ----------------

  const overlay = { host: null, root: null, items: [], raf: 0, onScroll: null };

  const SEV_COLORS = { critical: "#b91c1c", high: "#dc2626", medium: "#ea580c", low: "#ca8a04", info: "#2563eb" };

  function ensureHost() {
    if (overlay.host && overlay.host.isConnected) return overlay.root;
    const host = document.createElement("div");
    host.id = QA.OVERLAY_HOST_ID;
    host.setAttribute("style", "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; contain: strict;");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .box { position: fixed; box-sizing: border-box; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); border-radius: 2px; pointer-events: none; }
      .margin { position: fixed; box-sizing: border-box; border: 1px dashed color-mix(in srgb, var(--c) 60%, transparent); pointer-events: none; }
      .tip { position: fixed; box-sizing: border-box; max-width: min(420px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto; overflow-wrap: anywhere; word-break: break-word; white-space: normal; background: #111827; color: #f9fafb; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; border-radius: 8px; padding: 8px 30px 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); pointer-events: auto; border-left: 4px solid var(--c); }
      .tip b { display: block; font-size: 12.5px; margin-bottom: 2px; }
      .tip .sev { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 0 6px; border-radius: 99px; background: var(--c); color: #fff; margin-bottom: 4px; }
      .tip .line { color: #d1d5db; font-family: ui-monospace, Consolas, monospace; font-size: 11px; white-space: pre-wrap; }
      .tip .msg { margin: 2px 0 4px; }
      .x { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: 0; border-radius: 6px; background: rgba(255,255,255,.12); color: #fff; cursor: pointer; font-size: 14px; line-height: 22px; padding: 0; }
      .x:hover { background: rgba(255,255,255,.25); }
      .missing { position: fixed; top: 12px; right: 12px; }
    </style>`;
    document.documentElement.appendChild(host);
    overlay.host = host;
    overlay.root = root;
    overlay.onScroll = () => {
      if (overlay.raf) return;
      overlay.raf = requestAnimationFrame(() => {
        overlay.raf = 0;
        position();
      });
    };
    window.addEventListener("scroll", overlay.onScroll, { passive: true, capture: true });
    window.addEventListener("resize", overlay.onScroll, { passive: true });
    return root;
  }

  function position() {
    for (const it of overlay.items) {
      const el = it.el;
      if (!el || !el.isConnected) {
        it.box.style.display = "none";
        continue;
      }
      const r = el.getBoundingClientRect();
      Object.assign(it.box.style, { display: "", left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(r.width, 2)}px`, height: `${Math.max(r.height, 2)}px` });
      if (it.margin) {
        const cs = getComputedStyle(el);
        const mt = parseFloat(cs.marginTop) || 0;
        const mr = parseFloat(cs.marginRight) || 0;
        const mb = parseFloat(cs.marginBottom) || 0;
        const ml = parseFloat(cs.marginLeft) || 0;
        Object.assign(it.margin.style, { left: `${r.left - ml}px`, top: `${r.top - mt}px`, width: `${r.width + ml + mr}px`, height: `${r.height + mt + mb}px` });
      }
      if (it.tip) {
        const tr = it.tip.getBoundingClientRect();
        let top = r.bottom + 8;
        if (top + tr.height > innerHeight - 8) top = Math.max(8, r.top - tr.height - 8);
        let left = Math.min(Math.max(8, r.left), innerWidth - tr.width - 8);
        Object.assign(it.tip.style, { left: `${left}px`, top: `${top}px` });
      }
    }
  }

  function clear() {
    if (overlay.host) overlay.host.remove();
    // Overlays left by an earlier engine instance (e.g. before the extension was reloaded) are not in `overlay`.
    document.querySelectorAll(`#${QA.OVERLAY_HOST_ID}`).forEach((n) => n.remove());
    if (overlay.onScroll) {
      window.removeEventListener("scroll", overlay.onScroll, { capture: true });
      window.removeEventListener("resize", overlay.onScroll);
    }
    if (overlay.raf) cancelAnimationFrame(overlay.raf);
    Object.assign(overlay, { host: null, root: null, items: [], raf: 0, onScroll: null });
    return { ok: true };
  }

  function resolve(target) {
    if (!target) return null;
    let el = target.ref ? h.elementByRef(target.ref) : null;
    if (!el && target.selector) {
      try {
        el = document.querySelector(target.selector);
      } catch {
        el = null;
      }
    }
    return el;
  }

  function addItem(el, info, { tip = true, margin = false } = {}) {
    const root = ensureHost();
    const color = SEV_COLORS[info.severity] || SEV_COLORS.info;
    const box = document.createElement("div");
    box.className = "box";
    box.style.setProperty("--c", color);
    root.appendChild(box);
    let marginEl = null;
    if (margin) {
      marginEl = document.createElement("div");
      marginEl.className = "margin";
      marginEl.style.setProperty("--c", color);
      root.appendChild(marginEl);
    }
    let tipEl = null;
    if (tip) {
      tipEl = document.createElement("div");
      tipEl.className = "tip";
      tipEl.style.setProperty("--c", color);
      const sev = document.createElement("span");
      sev.className = "sev";
      sev.textContent = `${info.status || ""} ${info.severity || ""}`.trim();
      const title = document.createElement("b");
      title.textContent = info.title || el.localName;
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = U.truncate(info.message || "", 260);
      const x = document.createElement("button");
      x.className = "x";
      x.type = "button";
      x.title = info.dismissLabel || "Dismiss highlight";
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        clear();
      });
      tipEl.append(sev, title, msg);
      for (const line of info.lines || []) {
        const l = document.createElement("div");
        l.className = "line";
        l.textContent = line;
        tipEl.appendChild(l);
      }
      tipEl.appendChild(x);
      root.appendChild(tipEl);
    }
    overlay.items.push({ el, box, tip: tipEl, margin: marginEl });
  }

  async function highlight(target, info = {}) {
    clear();
    const el = resolve(target);
    if (!el) return { ok: false, found: false, message: "Element not found — the page may have changed since the scan. Re-run the test." };
    const r0 = el.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > innerHeight || r0.right < 0 || r0.left > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
    const r = el.getBoundingClientRect();
    const lines = [
      `${el.localName}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : ""}`,
      `size ${Math.round(r.width)}×${Math.round(r.height)} · viewport ${innerWidth}×${innerHeight}`,
      ...(info.lines || []),
    ];
    addItem(el, { ...info, lines }, { tip: true, margin: !!info.margin });
    position();
    requestAnimationFrame(position);
    const visible = h.isVisible(el);
    return { ok: true, found: true, visible, rect: h.rectOf(el), message: visible ? "" : "Element is in the DOM but not visible at this viewport." };
  }

  function highlightMany(targets) {
    clear();
    let n = 0;
    for (const t of targets.slice(0, 200)) {
      const el = resolve(t);
      if (!el) continue;
      addItem(el, t, { tip: false });
      n++;
    }
    position();
    return { ok: true, count: n };
  }

  // Outline only (no tooltip, so nothing hides the page), centred in the viewport for a screenshot.
  // With parentIfHidden, an element hidden at this size is shown through its nearest visible ancestor
  // ("key content hidden at this width" findings point at exactly such elements).
  async function frame(target, severity, parentIfHidden = false) {
    clear();
    let el = resolve(target);
    if (el && parentIfHidden) while (el && el !== document.body && !h.isVisible(el)) el = el.parentElement;
    if (!el || !h.isVisible(el)) return { ok: false };
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    addItem(el, { severity }, { tip: false });
    position();
    // requestAnimationFrame does not fire in background tabs.
    await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 150))]);
    position();
    const r = el.getBoundingClientRect();
    const de = document.documentElement;
    return {
      ok: true,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      viewportWidth: innerWidth,
      clientWidth: de.clientWidth || innerWidth,
      clientHeight: de.clientHeight || innerHeight,
      scrollX,
      scrollY,
      dpr: devicePixelRatio || 1,
    };
  }

  QA.inspector = { highlight, highlightMany, clear, frame };

  // ---------------- Elements category ----------------

  async function widerThanParent(ctx) {
    const { list } = h.allElements();
    for (const el of list) {
      await ctx.tick();
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" || cs.position === "fixed" || cs.display === "inline" || cs.display === "contents" || cs.display === "none") continue;
      const pcs = getComputedStyle(p);
      if (pcs.overflowX !== "visible" || pcs.display === "contents" || pcs.display === "inline") continue;
      const r = el.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const contentRight = pr.left + (parseFloat(pcs.borderLeftWidth) || 0) + p.clientWidth - (parseFloat(pcs.paddingRight) || 0);
      const over = r.right - contentRight;
      if (over <= 4 || r.width < 20) continue;
      if (/^-/.test(cs.marginLeft) || /^-/.test(cs.marginRight)) continue; // full-bleed patterns
      if (!h.isVisible(el)) continue;
      // Report the outermost offender only.
      let reported = false;
      for (let a = p; a && a !== document.body; a = a.parentElement) if (ctx.__wide && ctx.__wide.has(a)) reported = true;
      if (reported) continue;
      (ctx.__wide = ctx.__wide || new Set()).add(el);
      ctx.add({
        element: el,
        status: "warning",
        severity: "low",
        verification: "verified",
        message: `Element is ${Math.round(over)}px wider than its parent's content box and spills out of it.`,
        actual: `width ${Math.round(r.width)}px (${cs.width}), parent content ${p.clientWidth}px`,
        expected: "fits the parent",
        evidence: { width: cs.width, minWidth: cs.minWidth, flexBasis: cs.flexBasis, parent: h.cssPath(p), parentDisplay: pcs.display },
        fix: "Look for fixed widths, min-width, flex items without min-width: 0, or long unbreakable content.",
      });
    }
  }

  async function emptyContainers(ctx) {
    for (const el of document.querySelectorAll("div, section, article, aside, main, ul, ol")) {
      await ctx.tick();
      if (h.isOwnNode(el) || el.children.length || (el.textContent || "").trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== "none" || U.parseColor(cs.backgroundColor)?.a > 0 || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 60 || r.width < 60 || !h.isVisible(el)) continue;
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      ctx.add({
        element: el,
        status: "manual",
        severity: "info",
        verification: "manual",
        message: `Empty <${el.localName}> occupies ${Math.round(r.width)}×${Math.round(r.height)}px with no content, background or border. It may be a placeholder for content that failed to render.`,
        actual: "empty",
        expected: "content, or no reserved space",
        fix: "Verify whether content is expected here (lazy-loaded widget, ad slot, failed component).",
      });
    }
  }

  async function domStats(ctx) {
    const { list, truncated, total } = h.allElements(document.body, 50000);
    let maxDepth = 0;
    let deepest = null;
    let shadowHosts = 0;
    let absolute = 0;
    let fixed = 0;
    const highZ = [];
    for (const el of list) {
      await ctx.tick();
      if (el.shadowRoot) shadowHosts++;
      if (el.children.length) continue;
      let d = 0;
      for (let n = el; n.parentElement; n = n.parentElement) d++;
      if (d > maxDepth) {
        maxDepth = d;
        deepest = el;
      }
    }
    for (const el of list.slice(0, 8000)) {
      const cs = getComputedStyle(el);
      if (cs.position === "absolute") absolute++;
      else if (cs.position === "fixed") fixed++;
      const z = parseInt(cs.zIndex, 10);
      if (z >= 1000 && cs.position !== "static" && h.isVisible(el)) highZ.push({ selector: h.cssPath(el), zIndex: z });
    }
    const frames = [...document.querySelectorAll("iframe, frame")];
    let crossOrigin = 0;
    for (const f of frames) if (!f.contentDocument) crossOrigin++; // null for cross-origin frames
    ctx.extras.domStats = { elements: total, truncated, maxDepth, absolute, fixed, highZIndex: highZ.sort((a, b) => b.zIndex - a.zIndex).slice(0, 10), iframes: frames.length, inaccessibleIframes: crossOrigin, openShadowRoots: shadowHosts };
    if (frames.length) ctx.limitation(`${frames.length} iframe(s) on the page were not scanned (only the top document is tested${crossOrigin ? `; ${crossOrigin} are cross-origin and inaccessible` : ""}).`);
    if (shadowHosts) ctx.limitation(`${shadowHosts} open shadow root(s) found; their internal content is not scanned. Closed shadow roots cannot be detected at all.`);
    if (truncated) ctx.limitation(`Page has ${total} elements; per-element checks were capped.`);
    if (maxDepth > 32 && deepest) {
      ctx.add({
        element: deepest,
        status: "manual",
        severity: "info",
        verification: "manual",
        message: `DOM nesting reaches depth ${maxDepth}. Deep nesting is not a defect by itself but often indicates redundant wrappers that complicate layout and styling.`,
        actual: `depth ${maxDepth}`,
        expected: "informational",
        fix: "Consider flattening wrapper elements where they serve no layout purpose.",
      });
    }
    return { message: `${total} elements, max depth ${maxDepth}, ${absolute} absolute and ${fixed} fixed elements (informational).` };
  }

  QA.register("elements", {
    label: "Element sizes",
    tests: [
      { id: "elements.wider-than-parent", name: "Elements wider than their parent", run: widerThanParent, pass: "No in-flow element spills out of its parent." },
      { id: "elements.empty-containers", name: "Empty containers taking space", run: emptyContainers, pass: "No large empty containers." },
      { id: "elements.dom-stats", name: "DOM structure overview", run: domStats },
    ],
  });
})();
