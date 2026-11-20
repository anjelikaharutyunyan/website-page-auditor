// In-page QA engine core. Injected on demand (ISOLATED world) together with the test modules.
// Exposes window.__webQA. Never reads or reports user-entered form values.
(function () {
  "use strict";
  const VERSION = "1.5.6";
  if (window.__webQA && window.__webQA.version === VERSION) return;

  const U = window.__webQAUtils;
  const OVERLAY_HOST_ID = "__webqa-overlay-host";
  const MAX_ELEMENTS = 8000;

  const state = {
    cancelled: false,
    running: false,
    registry: new Map(), // ref -> WeakRef(element)
    refByEl: new WeakMap(),
    nextRef: 1,
    // Refs are only valid in this document instance; a ref from a report of an earlier page load must not match.
    session: Math.random().toString(36).slice(2, 8),
  };

  // ---------------- element helpers ----------------

  function isOwnNode(el) {
    return !!(el && el.closest && el.closest(`#${OVERLAY_HOST_ID}`));
  }

  function refFor(el) {
    if (!el) return null;
    let ref = state.refByEl.get(el);
    if (!ref) {
      ref = `${state.session}-${state.nextRef++}`;
      state.refByEl.set(el, ref);
      state.registry.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function elementByRef(ref) {
    const el = state.registry.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function isUniqueId(id) {
    if (!id) return false;
    try {
      return document.querySelectorAll(`#${cssEscape(id)}`).length === 1;
    } catch {
      return false;
    }
  }

  // Short, stable-ish CSS selector. Prefers unique ids, then nth-of-type chains.
  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
      if (node.id && isUniqueId(node.id) && !/^\d/.test(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      let part = node.localName;
      const cls = [...node.classList].filter((c) => /^[a-zA-Z][\w-]{1,40}$/.test(c) && !/^(is-|has-)?(active|open|hover|focus|selected)$/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map(cssEscape).join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node === document.body) break;
      node = parent;
    }
    return parts.join(" > ");
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
    };
  }

  function textSnippet(el, n = 80) {
    if (!el) return "";
    if (el.matches?.("input, textarea, select")) return ""; // never capture field contents
    return U.truncate((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), n);
  }

  function describe(el) {
    if (!el || !(el instanceof Element)) return null;
    return {
      tag: el.localName,
      id: el.id || null,
      classes: [...el.classList].slice(0, 6),
      role: el.getAttribute("role"),
      rect: rectOf(el),
      text: textSnippet(el),
    };
  }

  function viewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      layoutWidth: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio || 1,
    };
  }

  function isRendered(el, cs) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ opacityProperty: false, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    } else {
      cs = cs || getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    return true;
  }

  function isVisible(el) {
    if (!isRendered(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 1px clip patterns used for screen-reader-only text and skip links.
  function isVisuallyHiddenPattern(el, cs) {
    cs = cs || getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.position === "absolute" || cs.position === "fixed") {
      if (r.width <= 1.5 || r.height <= 1.5) return true;
      if (cs.clip && cs.clip !== "auto" && /rect\(\s*0/.test(cs.clip)) return true;
      if (cs.clipPath && /inset\(\s*(50%|100%)/.test(cs.clipPath)) return true;
      if (r.right < -500 || r.bottom < -500) return true;
    }
    return false;
  }

  function isAriaHidden(el) {
    return !!el.closest('[aria-hidden="true"], [inert]');
  }

  // Elements intentionally positioned off-screen (off-canvas menus, carousels, hidden mobile nav).
  function isIntentionallyOffscreen(el) {
    if (isAriaHidden(el)) return true;
    let node = el;
    for (let i = 0; node && node !== document.body && i < 25; i++, node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.visibility === "hidden") return true;
      if (cs.position === "fixed" && node !== el) {
        const r = node.getBoundingClientRect();
        if (r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) return true;
      }
      if (node.getAttribute("aria-roledescription")?.match(/carousel|slide/i)) return true;
      if (/^(region|group|tabpanel)$/.test(node.getAttribute("role") || "") && node.getAttribute("aria-roledescription")) return true;
    }
    return false;
  }

  // Nearest ancestor that clips or scrolls horizontally (so overflow inside it does not reach the page).
  function horizontalClipAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== "visible" || (cs.contain && /paint|strict|content/.test(cs.contain))) return { el: node, cs };
      node = node.parentElement;
    }
    return null;
  }

  function clipAncestor(el, maxDepth = 30) {
    let node = el.parentElement;
    for (let i = 0; node && node !== document.documentElement && i < maxDepth; i++) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") return { el: node, cs };
      node = node.parentElement;
    }
    return null;
  }

  function isScrollContainer(el, cs) {
    cs = cs || getComputedStyle(el);
    const sx = /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const sy = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    return sx || sy;
  }

  function allElements(root = document.body, limit = MAX_ELEMENTS) {
    if (!root) return { list: [], truncated: false, total: 0 };
    const nodes = root.querySelectorAll("*");
    const list = [];
    for (const n of nodes) {
      if (list.length >= limit) break;
      if (n.id === OVERLAY_HOST_ID) continue;
      if (/^(script|style|noscript|template|link|meta|head|title|br|wbr)$/.test(n.localName)) continue;
      list.push(n);
    }
    return { list, truncated: nodes.length > limit, total: nodes.length };
  }

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[tabindex]",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=option]",
    "[role=combobox]",
    "[role=slider]",
    "[role=spinbutton]",
    "[role=textbox]",
    "[role=searchbox]",
    "[role=treeitem]",
    "[onclick]",
  ].join(",");

  const NATIVE_FOCUSABLE = "a[href], area[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [contenteditable='']";

  function isDisabled(el) {
    return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
  }

  function isFocusable(el) {
    if (isDisabled(el) && el.matches(":disabled")) return false;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && !Number.isNaN(parseInt(ti, 10))) return true;
    return el.matches(NATIVE_FOCUSABLE) || el.isContentEditable;
  }

  function isTabbable(el) {
    if (!isFocusable(el)) return false;
    const ti = el.getAttribute("tabindex");
    return !(ti !== null && parseInt(ti, 10) < 0);
  }

  // ---------------- accessible name (pragmatic subset of accname 1.2) ----------------

  function textFromIds(ids, depth) {
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((n) => nameFromContent(n, depth + 1))
      .join(" ")
      .trim();
  }

  function nameFromContent(el, depth = 0) {
    if (depth > 6) return "";
    let out = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.textContent;
      else if (child.nodeType === 1) {
        const c = child;
        if (c.getAttribute("aria-hidden") === "true") continue;
        const cs = getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (c.localName === "img" || c.getAttribute("role") === "img") out += " " + (c.getAttribute("aria-label") || c.getAttribute("alt") || "") + " ";
        else if (c.localName === "svg") out += " " + (c.getAttribute("aria-label") || c.querySelector("title")?.textContent || "") + " ";
        else if (c.matches("input, select, textarea")) continue;
        else out += " " + (c.getAttribute("aria-label") || nameFromContent(c, depth + 1)) + " ";
      }
    }
    if (depth === 0) {
      const before = getComputedStyle(el, "::before").content;
      const after = getComputedStyle(el, "::after").content;
      const pseudo = (v) => (v && v !== "none" && v !== "normal" && /^".*"$/.test(v) ? v.slice(1, -1) : "");
      out = pseudo(before) + out + pseudo(after);
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function labelsFor(el) {
    const labels = [];
    if (el.labels && el.labels.length) labels.push(...el.labels);
    return labels;
  }

  /** Returns { name, source } where source tells which mechanism produced the name. */
  function accessibleName(el) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = textFromIds(lb, 0);
      if (t) return { name: t, source: "aria-labelledby" };
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return { name: al.trim(), source: "aria-label" };

    const tag = el.localName;
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && /^(submit|reset|button)$/.test(type)) {
        const v = el.getAttribute("value");
        if (v && v.trim()) return { name: v.trim(), source: "value" };
        if (type === "submit") return { name: "Submit", source: "default" };
        if (type === "reset") return { name: "Reset", source: "default" };
      }
      if (tag === "input" && type === "image") {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) return { name: alt.trim(), source: "alt" };
      }
      const labels = labelsFor(el);
      const lt = labels.map((l) => nameFromContent(l)).join(" ").trim();
      if (lt) return { name: lt, source: "label" };
    }
    if (tag === "img" || tag === "area" || (tag === "input" && el.type === "image")) {
      const alt = el.getAttribute("alt");
      if (alt !== null && alt.trim()) return { name: alt.trim(), source: "alt" };
    }
    if (tag === "svg") {
      const t = el.querySelector(":scope > title")?.textContent?.trim();
      if (t) return { name: t, source: "svg-title" };
    }
    if (tag === "fieldset") {
      const lg = el.querySelector(":scope > legend");
      if (lg) return { name: nameFromContent(lg), source: "legend" };
    }
    const role = el.getAttribute("role") || "";
    const nameFromContentRoles = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|checkbox|radio|switch|heading|cell|columnheader|rowheader|tooltip)$/;
    if (/^(a|button|summary|h[1-6]|td|th|label|legend|caption|option)$/.test(tag) || nameFromContentRoles.test(role)) {
      const t = nameFromContent(el);
      if (t) return { name: t, source: "content" };
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return { name: title.trim(), source: "title" };
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return { name: ph.trim(), source: "placeholder" };
    return { name: "", source: null };
  }

  // ---------------- hit testing ----------------

  function isInViewport(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function relatedTo(el, hit) {
    if (!hit) return false;
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    if (hit.localName === "label" && hit.control === el) return true;
    if (el.labels && [...el.labels].some((l) => l === hit || l.contains(hit))) return true;
    return false;
  }

  /**
   * Hit-tests up to 5 points of an element that is inside the current viewport.
   * Only meaningful for the viewport as currently scrolled; never scrolls the page.
   */
  function hitTest(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { state: "empty" };
    if (!isInViewport(r)) return { state: "offscreen" };
    const ix = Math.max(1, Math.min(4, r.width / 4));
    const iy = Math.max(1, Math.min(4, r.height / 4));
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + ix, r.top + iy],
      [r.right - ix, r.top + iy],
      [r.left + ix, r.bottom - iy],
      [r.right - ix, r.bottom - iy],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    if (!pts.length) return { state: "offscreen" };
    let blocked = 0;
    let centerBlocked = false;
    let by = null;
    pts.forEach(([x, y], i) => {
      let hit = document.elementFromPoint(x, y);
      if (hit && isOwnNode(hit)) hit = null; // ignore our own overlay
      if (hit && !relatedTo(el, hit)) {
        blocked++;
        if (i === 0) centerBlocked = true;
        by = by || hit;
      }
    });
    if (!blocked) return { state: "clear" };
    return { state: centerBlocked ? "covered" : "partial", by, blockedPoints: blocked, testedPoints: pts.length };
  }

  function positionedAncestor(el, positions = ["fixed", "sticky"]) {
    let node = el;
    for (let i = 0; node && node !== document.documentElement && i < 30; i++, node = node.parentElement) {
      if (positions.includes(getComputedStyle(node).position)) return node;
    }
    return null;
  }

  const MODAL_HINT = /modal|popup|pop-up|dialog|lightbox|overlay|drawer|offcanvas|fancybox|mfp-|popover|sheet|backdrop/i;

  function outermostPositioned(el, positions) {
    let found = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (positions.includes(getComputedStyle(n).position)) found = n;
    }
    return found;
  }

  function coversViewport(el) {
    const r = el.getBoundingClientRect();
    return r.left <= innerWidth * 0.05 && r.top <= innerHeight * 0.05 && r.right >= innerWidth * 0.95 && r.bottom >= innerHeight * 0.95;
  }

  // Custom modals (fixed .modal/.popup with a backdrop) rarely use <dialog> or aria-modal. They are recognised by a
  // fixed layer covering the whole viewport on top of the page, with the dialog box at the viewport centre.
  function overlayModal() {
    const W = innerWidth;
    const H = innerHeight;
    if (!W || !H) return null;
    const layers = new Set();
    let covered = 0;
    let overContent = 0;
    let center = null;
    let fullLayer = null;
    const page = (e) => e !== document.documentElement && e !== document.body && !isOwnNode(e);
    [0.08, 0.5, 0.92].forEach((fy) =>
      [0.08, 0.5, 0.92].forEach((fx) => {
        const stack = document.elementsFromPoint(W * fx, H * fy).filter(page);
        const hit = stack[0];
        if (!hit) return;
        const layer = outermostPositioned(hit, ["fixed"]);
        if (fx === 0.5 && fy === 0.5) center = layer || outermostPositioned(hit, ["absolute"]);
        if (!layer) return;
        covered++;
        layers.add(layer);
        if (!fullLayer && coversViewport(layer)) fullLayer = layer;
        // Page content underneath distinguishes a backdrop from a fixed page background.
        if (stack.some((e) => !layer.contains(e) && !e.contains(layer) && ![...layers].some((l) => l.contains(e)))) overContent++;
      })
    );
    if (covered < 7 || !fullLayer || !center || overContent < 3) return null;
    const parts = [...new Set([...layers, center])];
    const hinted = parts.some((l) => MODAL_HINT.test(`${typeof l.className === "string" ? l.className : ""} ${l.id} ${l.getAttribute("role") || ""}`)) || [document.body, document.documentElement].some((n) => getComputedStyle(n).overflowY === "hidden");
    const bodyText = (document.body.innerText || "").length;
    const layerText = parts.reduce((s, l) => s + (l.innerText || "").length, 0);
    // A fixed full-viewport app shell holding the whole page is not a modal.
    if (!hinted && bodyText > 0 && layerText / bodyText > 0.6) return null;
    return { root: center, backdrop: fullLayer !== center && !fullLayer.contains(center) ? fullLayer : null, kind: "overlay" };
  }

  function modalInfo() {
    const candidates = document.querySelectorAll('dialog[open], [aria-modal="true"], [role=dialog], [role=alertdialog]');
    for (const d of candidates) {
      if (!isVisible(d) || isOwnNode(d)) continue;
      let isModal = d.getAttribute("aria-modal") === "true";
      try {
        isModal = isModal || d.matches("dialog:modal");
      } catch {}
      if (isModal) return { root: d, backdrop: null, kind: "aria" };
    }
    return overlayModal();
  }

  function openModal() {
    const m = modalInfo();
    return m ? m.root : null;
  }

  // True when a modal is open and el belongs to the page underneath it (not the modal, not its backdrop).
  function behindModal(el, modal) {
    if (!modal || !el) return false;
    return !modal.contains(el) && !el.contains(modal);
  }

  // ---------------- run context ----------------

  class Cancelled extends Error {}

  function createContext(category, options = {}) {
    const results = [];
    const ran = new Set();
    const skipped = [];
    const limitations = [];
    const extras = {};
    const vp = viewport();
    const viewportTag = options.viewport ? { ...options.viewport, actualWidth: vp.width, actualHeight: vp.height } : null;
    let lastYield = performance.now();
    const deadline = performance.now() + (options.categoryTimeoutMs || 45000);
    let currentTest = null;
    let currentHadFindings = false;
    const perTest = new Map();
    const suppressed = {};
    const groups = new Map(); // testId|status|selector pattern -> result, so a repeated component is reported once
    const maxPerTest = options.maxPerTest || 25;

    const ctx = {
      category,
      options,
      viewport: vp,
      results,
      extras,
      limitations,
      utils: U,
      add(partial) {
        const status = partial.status || "warning";
        if (status !== "passed" && partial.severity === "info") return null;
        const testId = partial.testId || currentTest?.id;
        const el = partial.element instanceof Element ? partial.element : null;
        const selector = el ? cssPath(el) : partial.selector || null;
        const groupKey = selector && status !== "passed" ? `${testId}|${status}|${U.selectorPattern(selector)}` : null;
        const existing = groupKey && groups.get(groupKey);
        if (existing) {
          currentHadFindings = true;
          existing.occurrences++;
          if (existing.instances.length < U.MAX_INSTANCES) existing.instances.push({ selector, ref: el ? refFor(el) : null });
          return existing;
        }
        if (status !== "passed") {
          currentHadFindings = true;
          const n = (perTest.get(testId) || 0) + 1;
          perTest.set(testId, n);
          if (n > maxPerTest) {
            suppressed[testId] = (suppressed[testId] || 0) + 1;
            return null;
          }
        }
        const ref = el ? refFor(el) : null;
        const r = {
          testId,
          sourceTest: currentTest?.id || testId, // the runnable test that produced this result (for re-runs)
          category,
          name: partial.name || currentTest?.name,
          status,
          severity: partial.severity || "medium",
          message: partial.message || "",
          actual: partial.actual,
          expected: partial.expected,
          fix: partial.fix || "",
          verification: partial.verification || "inferred",
          selector,
          ref,
          pattern: selector ? U.selectorPattern(selector) : null,
          occurrences: 1,
          instances: selector ? [{ selector, ref }] : [],
          element: el ? describe(el) : partial.elementInfo || null,
          evidence: U.sanitizeEvidence(partial.evidence || {}),
          viewport: viewportTag || { width: vp.width, height: vp.height },
          frameUrl: location.href,
        };
        if (el && options.includeParent !== false && el.parentElement) {
          const p = el.parentElement.getBoundingClientRect();
          r.element.parent = { tag: el.parentElement.localName, width: Math.round(p.width), height: Math.round(p.height) };
        }
        results.push(r);
        if (groupKey) groups.set(groupKey, r);
        return r;
      },
      manual(testId, name, message, extra = {}) {
        ran.add(testId);
        return ctx.add({ testId, name, status: "manual", severity: extra.severity || "info", message, verification: "manual", ...extra });
      },
      markRan(testId) {
        ran.add(testId);
      },
      pass(testId, name, message, verification = "verified") {
        ran.add(testId);
        return ctx.add({ testId, name, status: "passed", severity: "info", verification, message: message || "No issues detected." });
      },
      skip(testId, name, reason) {
        skipped.push({ testId, name, reason });
      },
      limitation(text) {
        if (!limitations.includes(text)) limitations.push(text);
      },
      shouldRun(testId) {
        return !options.onlyTests || !options.onlyTests.length || options.onlyTests.includes(testId);
      },
      async test(id, name, fn, passMessage) {
        if (!ctx.shouldRun(id)) return;
        ctx.checkCancelled();
        currentTest = { id, name };
        currentHadFindings = false;
        const start = performance.now();
        try {
          const out = await fn();
          ran.add(id);
          if (out && out.skipped) {
            skipped.push({ testId: id, name, reason: out.skipped });
          } else if (!currentHadFindings && !(out && out.noSummary)) {
            ctx.add({
              testId: id,
              name,
              status: "passed",
              severity: "info",
              verification: out?.verification || "verified",
              message: out?.message || passMessage || "No issues detected.",
              evidence: out?.evidence,
            });
          }
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          skipped.push({ testId: id, name, reason: `Test error: ${e && e.message ? e.message : e}` });
        } finally {
          const ms = Math.round(performance.now() - start);
          if (ms > 1500) ctx.limitation(`${name} took ${ms} ms.`);
          currentTest = null;
        }
      },
      checkCancelled() {
        if (state.cancelled) throw new Cancelled("Scan cancelled");
        if (performance.now() > deadline) throw new Cancelled("Category timed out");
      },
      // Yield to the page's event loop regularly so scanning never freezes the site.
      async tick() {
        if (performance.now() - lastYield > 12) {
          await new Promise((r) => setTimeout(r, 0));
          lastYield = performance.now();
          ctx.checkCancelled();
        }
      },
      finish(durationMs, error) {
        for (const [id, n] of Object.entries(suppressed)) {
          ctx.limitation(`${id}: ${n} further distinct issue(s) not listed (limit ${maxPerTest} per test).`);
        }
        return {
          category,
          status: error ? (error instanceof Cancelled ? "cancelled" : "error") : "completed",
          error: error ? String(error.message || error) : null,
          ran: [...ran],
          skipped,
          limitations,
          extras,
          durationMs,
          viewport: viewportTag || { width: vp.width, height: vp.height },
          results,
        };
      },
    };
    return ctx;
  }

  window.__webQA = {
    version: VERSION,
    OVERLAY_HOST_ID,
    state,
    categories: {},
    Cancelled,
    h: {
      cssPath,
      describe,
      rectOf,
      refFor,
      elementByRef,
      viewport,
      isRendered,
      isVisible,
      isVisuallyHiddenPattern,
      isAriaHidden,
      isIntentionallyOffscreen,
      horizontalClipAncestor,
      clipAncestor,
      isScrollContainer,
      allElements,
      isOwnNode,
      isDisabled,
      isFocusable,
      isTabbable,
      accessibleName,
      nameFromContent,
      textSnippet,
      hitTest,
      isInViewport,
      positionedAncestor,
      openModal,
      modalInfo,
      behindModal,
      INTERACTIVE_SELECTOR,
      NATIVE_FOCUSABLE,
    },
    createContext,
    /**
     * While active, blocks native form submission and default navigation of real links. Returns a release function.
     * Default: a window capture listener cancels every submit before any page handler runs.
     * { allowPageHandlers: true }: the page's own submit handlers (custom JS validation) run first; only if none of
     * them cancelled the event is the native submission cancelled and recorded in guard.submits. Events the page
     * cancelled itself are recorded in guard.pageHandled. Call guard.settle(form) right after requestSubmit().
     */
    guardNavigation(opts = {}) {
      const guard = { submits: [], pageHandled: [], pending: null };
      const decide = (e) => {
        if (guard.pending !== e) return;
        guard.pending = null;
        if (e.defaultPrevented) guard.pageHandled.push(e.target);
        else {
          e.preventDefault();
          guard.submits.push(e.target);
        }
      };
      const onLateTarget = (e) => {
        if (e.cancelBubble) decide(e);
      };
      const onCapture = (e) => {
        if (!opts.allowPageHandlers) {
          guard.submits.push(e.target);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        guard.pending = e;
        if (e.target && e.target.addEventListener) e.target.addEventListener("submit", onLateTarget, { once: true });
      };
      const onBubble = (e) => decide(e);
      const onClick = (e) => {
        const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (a && !/^\s*(#|javascript:)/i.test(a.getAttribute("href") || "")) e.preventDefault();
      };
      guard.settle = () => {
        const e = guard.pending;
        if (!e) return;
        guard.pending = null;
        if (e.defaultPrevented) guard.pageHandled.push(e.target);
        else {
          guard.submits.push(e.target);
          window.stop();
        }
      };
      window.addEventListener("submit", onCapture, true);
      window.addEventListener("submit", onBubble, false);
      document.addEventListener("submit", onLateTarget, false);
      window.addEventListener("click", onClick, true);
      const release = () => {
        window.removeEventListener("submit", onCapture, true);
        window.removeEventListener("submit", onBubble, false);
        document.removeEventListener("submit", onLateTarget, false);
        window.removeEventListener("click", onClick, true);
      };
      release.guard = guard;
      return release;
    },
    register(category, def) {
      this.categories[category] = def;
    },
  };
})();
