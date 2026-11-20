// Practical automated accessibility checks. These do not establish WCAG conformance.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const VALID_ROLES = new Set(
    "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(" ")
  );
  const IDREF_ATTRS = ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-errormessage", "aria-details", "aria-flowto"];

  async function ariaReferences(ctx) {
    const sel = IDREF_ATTRS.map((a) => `[${a}]`).join(",") + ", label[for]";
    for (const el of document.querySelectorAll(sel)) {
      await ctx.tick();
      if (h.isOwnNode(el)) continue;
      const attrs = el.localName === "label" && el.hasAttribute("for") ? ["for"] : IDREF_ATTRS.filter((a) => el.hasAttribute(a));
      for (const attr of attrs) {
        const ids = (el.getAttribute(attr) || "").trim().split(/\s+/).filter(Boolean);
        const missing = ids.filter((id) => !document.getElementById(id));
        if (!missing.length) continue;
        const soft = attr === "aria-controls" || attr === "aria-owns";
        ctx.add({
          element: el,
          status: soft ? "warning" : "failed",
          severity: soft ? "low" : "medium",
          verification: soft ? "inferred" : "verified",
          message: `${attr} references missing id(s): ${missing.map((m) => `"${U.truncate(m, 30)}"`).join(", ")}.${soft ? " The controlled element may be rendered only when opened." : ""}`,
          actual: `${attr}="${U.truncate(el.getAttribute(attr), 80)}"`,
          expected: "every referenced id exists in the document",
          fix: "Fix the id reference (ids are case-sensitive) or render the referenced element.",
        });
      }
    }
  }

  async function duplicateIds(ctx) {
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]")) {
      if (h.isOwnNode(el)) continue;
      const list = seen.get(el.id) || [];
      list.push(el);
      seen.set(el.id, list);
    }
    const referenced = new Set();
    for (const el of document.querySelectorAll([...IDREF_ATTRS.map((a) => `[${a}]`), "label[for]"].join(","))) {
      for (const a of [...IDREF_ATTRS, "for"]) (el.getAttribute(a) || "").split(/\s+/).filter(Boolean).forEach((id) => referenced.add(id));
    }
    for (const [id, els] of seen) {
      await ctx.tick();
      if (els.length < 2 || !id.trim()) continue;
      const ref = referenced.has(id);
      ctx.add({
        element: els[1],
        status: ref ? "failed" : "warning",
        severity: ref ? "medium" : "low",
        verification: "verified",
        message: `id "${U.truncate(id, 40)}" is used ${els.length} times${ref ? " and is referenced by a label/ARIA attribute, which will resolve to the first one only" : ""}.`,
        actual: `${els.length} elements`,
        expected: "unique ids",
        evidence: { elements: els.slice(0, 5).map((e) => h.cssPath(e)) },
        fix: "Make ids unique (component instances often duplicate them).",
      });
    }
  }

  async function documentBasics(ctx) {
    const lang = document.documentElement.getAttribute("lang");
    if (!lang || !lang.trim()) {
      ctx.add({ testId: "a11y.lang", name: "Document language", element: document.documentElement, status: "failed", severity: "medium", verification: "verified", message: "<html> has no lang attribute; screen readers may use the wrong pronunciation.", actual: "no lang", expected: 'lang="en" (or the page language)', fix: "Add lang to the <html> element." });
    } else {
      let valid = true;
      try {
        Intl.getCanonicalLocales(lang.trim());
      } catch {
        valid = false;
      }
      if (!valid) ctx.add({ testId: "a11y.lang", name: "Document language", element: document.documentElement, status: "failed", severity: "medium", verification: "verified", message: `lang="${lang}" is not a valid BCP 47 language tag.`, actual: lang, expected: "valid tag such as en, en-GB, ru", fix: "Correct the lang value." });
      else ctx.pass("a11y.lang", "Document language", `lang="${lang}"`);
    }
    ctx.markRan("a11y.lang");

    const title = (document.title || "").trim();
    const generic = /^(untitled|document|home|index|page|react app|vite app|new tab|title|my app|welcome)$/i;
    if (!title) {
      ctx.add({ testId: "a11y.title", name: "Page title", selector: "head > title", status: "failed", severity: "medium", verification: "verified", message: "Page has no <title> (or it is empty).", actual: "empty title", expected: "descriptive unique title", fix: "Add a <title> describing the page." });
    } else if (generic.test(title)) {
      ctx.add({ testId: "a11y.title", name: "Page title", selector: "head > title", status: "warning", severity: "low", verification: "verified", message: `Page title "${title}" is generic.`, actual: title, expected: "title describing this page and the site", fix: "Use a specific title such as \"Product name – Site\"." });
    } else ctx.pass("a11y.title", "Page title", `Title: "${U.truncate(title, 80)}"`);
    ctx.markRan("a11y.title");

    const vp = document.querySelector('meta[name="viewport"]');
    const content = (vp && vp.getAttribute("content")) || "";
    const noScale = /user-scalable\s*=\s*(no|0)/i.test(content);
    const maxScale = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
    if (noScale || (maxScale && parseFloat(maxScale[1]) < 2)) {
      ctx.add({ testId: "a11y.zoom", name: "Pinch zoom allowed", selector: 'meta[name="viewport"]', status: "failed", severity: "medium", verification: "verified", message: `The viewport meta tag disables zoom (${content}).`, actual: content, expected: "zoom allowed (no user-scalable=no, maximum-scale ≥ 2)", fix: "Remove user-scalable=no and maximum-scale restrictions." });
    } else ctx.pass("a11y.zoom", "Pinch zoom allowed", vp ? "Viewport meta tag allows zooming." : "No viewport meta tag restricting zoom.");
    ctx.markRan("a11y.zoom");

    if (!document.querySelector("main, [role=main]")) {
      ctx.add({ testId: "a11y.landmarks", name: "Main landmark", selector: "body", status: "warning", severity: "low", verification: "verified", message: "No <main> landmark; screen-reader users cannot jump to the main content.", fix: "Wrap the primary content in <main>." });
    } else ctx.pass("a11y.landmarks", "Main landmark", "A main landmark exists.");
    ctx.markRan("a11y.landmarks");
    return { noSummary: true };
  }

  async function headings(ctx) {
    const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].filter((e) => h.isVisible(e) && !h.isAriaHidden(e) && !h.isOwnNode(e));
    if (!hs.length) {
      ctx.add({ status: "warning", severity: "low", verification: "verified", selector: "body", message: "The page has no visible headings, so it cannot be navigated by heading.", fix: "Structure content with h1–h6." });
      return;
    }
    const level = (e) => (e.getAttribute("role") === "heading" ? parseInt(e.getAttribute("aria-level") || "2", 10) : parseInt(e.localName[1], 10));
    const h1s = hs.filter((e) => level(e) === 1);
    if (!h1s.length) ctx.add({ element: hs[0], status: "warning", severity: "low", verification: "verified", message: "No visible h1 on the page.", fix: "Add one h1 describing the page." });
    let prev = 0;
    for (const e of hs) {
      await ctx.tick();
      const l = level(e);
      if (!h.nameFromContent(e)) {
        ctx.add({ element: e, status: "failed", severity: "low", verification: "verified", message: `Empty <${e.localName}> heading.`, fix: "Remove the empty heading or give it text." });
      }
      if (prev && l > prev + 1) {
        ctx.add({ element: e, status: "warning", severity: "low", verification: "verified", message: `Heading level jumps from h${prev} to h${l}.`, actual: `h${prev} → h${l}`, expected: `h${prev + 1} or higher`, fix: "Do not skip heading levels; use CSS for visual size." });
      }
      prev = l;
    }
  }

  async function hiddenFocusable(ctx) {
    for (const container of document.querySelectorAll('[aria-hidden="true"]')) {
      await ctx.tick();
      if (h.isOwnNode(container)) continue;
      const focusables = [container, ...container.querySelectorAll(h.NATIVE_FOCUSABLE + ", [tabindex]")].filter((el) => h.isTabbable(el) && h.isVisible(el) && !el.matches(":disabled"));
      if (!focusables.length) continue;
      ctx.add({
        element: container,
        status: "failed",
        severity: "high",
        verification: "verified",
        message: `aria-hidden="true" region contains ${focusables.length} focusable element(s): keyboard users reach controls that screen readers announce as nothing.`,
        actual: `${focusables.length} tabbable inside aria-hidden`,
        expected: "no focusable content inside aria-hidden (use inert)",
        evidence: { focusable: focusables.slice(0, 5).map((e) => h.cssPath(e)) },
        fix: "Use the inert attribute, or remove the focusable elements from the tab order while hidden.",
      });
    }
  }

  async function tabindexPositive(ctx) {
    for (const el of document.querySelectorAll("[tabindex]")) {
      if (parseInt(el.getAttribute("tabindex"), 10) > 0 && !h.isOwnNode(el)) {
        ctx.add({ element: el, status: "warning", severity: "low", verification: "verified", message: `tabindex="${el.getAttribute("tabindex")}" overrides the natural tab order.`, actual: el.getAttribute("tabindex"), expected: '0 or -1', fix: "Use tabindex=\"0\" and order the DOM instead." });
      }
    }
  }

  async function roles(ctx) {
    for (const el of document.querySelectorAll("[role]")) {
      await ctx.tick();
      if (h.isOwnNode(el)) continue;
      const roles = el.getAttribute("role").trim().split(/\s+/);
      const first = roles[0];
      if (first && !VALID_ROLES.has(first) && !/^(doc|graphics)-/.test(first)) {
        ctx.add({ element: el, status: "failed", severity: "low", verification: "verified", message: `role="${first}" is not a valid ARIA role.`, fix: "Use a valid role or remove it." });
      }
      if ((first === "presentation" || first === "none") && h.isFocusable(el)) {
        ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: `Focusable element has role="${first}"; browsers ignore the role and the element's semantics are confusing.`, fix: "Remove the role or make the element non-focusable." });
      }
      if (first === "tab" && !el.closest("[role=tablist]") && !document.querySelector(`[role=tablist][aria-owns~="${CSS.escape(el.id || "_")}"]`)) {
        ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: 'role="tab" is not inside a role="tablist".', fix: "Wrap tabs in an element with role=tablist." });
      }
      if (first === "menuitem" && !el.closest("[role=menu], [role=menubar], [role=group]")) {
        ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: 'role="menuitem" is not inside a menu or menubar.', fix: "Use role=menu/menubar on the container, or use plain links/buttons for site navigation." });
      }
      if (first === "option" && !el.closest("[role=listbox], [role=combobox], datalist, select, [role=group]")) {
        ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: 'role="option" is not inside a listbox.', fix: "Put options inside an element with role=listbox." });
      }
      if (first === "combobox" && !el.hasAttribute("aria-expanded") && h.isVisible(el)) {
        ctx.add({ element: el, status: "warning", severity: "low", verification: "verified", message: "Combobox does not expose aria-expanded.", fix: "Set aria-expanded to reflect whether the popup is open." });
      }
    }
    // Nested interactive content
    for (const el of document.querySelectorAll("a[href] a[href], a[href] button, button a[href], button button, a[href] input, button input, a[href] select, button select")) {
      if (h.isOwnNode(el)) continue;
      ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: `Interactive <${el.localName}> nested inside another interactive element; behaviour and announcements are unpredictable.`, fix: "Restructure so interactive elements are siblings." });
    }
    // Disabled styling without disabled semantics
    for (const el of document.querySelectorAll('[class~="disabled"], [class*="is-disabled"], [class*="--disabled"]')) {
      if (h.isOwnNode(el) || !h.isVisible(el)) continue;
      if (h.isDisabled(el) || !h.isFocusable(el)) continue;
      ctx.add({ element: el, status: "warning", severity: "low", verification: "inferred", message: "Element is styled as disabled (class) but is still focusable and not marked disabled/aria-disabled.", fix: "Add disabled (native) or aria-disabled=\"true\" and prevent activation." });
    }
  }

  async function dialogs(ctx) {
    for (const el of document.querySelectorAll("dialog, [role=dialog], [role=alertdialog]")) {
      await ctx.tick();
      if (!h.isVisible(el) || h.isOwnNode(el)) continue;
      const { name } = h.accessibleName(el);
      if (!name) {
        ctx.add({ element: el, status: "failed", severity: "medium", verification: "verified", message: "Open dialog has no accessible name (aria-labelledby/aria-label).", fix: "Point aria-labelledby at the dialog heading." });
      }
      let modal = el.getAttribute("aria-modal") === "true";
      try {
        modal = modal || el.matches("dialog:modal");
      } catch {}
      const r = el.getBoundingClientRect();
      if (!modal && r.width * r.height > innerWidth * innerHeight * 0.3) {
        ctx.add({ element: el, status: "warning", severity: "low", verification: "inferred", message: "Large open dialog is not modal (no aria-modal / showModal()); background content remains reachable for keyboard and screen-reader users.", fix: "Open it with dialog.showModal() or set aria-modal=\"true\" and make the background inert." });
      }
    }
  }

  async function focusVisibility(ctx) {
    const id = "a11y.focus-visible";
    const name = "Visible focus indicator";
    ctx.markRan(id);
    if (!ctx.options.interactiveTests) {
      ctx.manual(id, name, 'Focus indicators were not tested (would move focus). Tab through the page and confirm every focused control has a clearly visible indicator, or enable "Interactive tests".');
      return;
    }
    const targets = [...document.querySelectorAll(h.NATIVE_FOCUSABLE + ", [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !h.isOwnNode(el) && h.isTabbable(el) && h.isVisible(el) && h.isInViewport(el.getBoundingClientRect()))
      .slice(0, 25);
    const prev = document.activeElement;
    const props = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderTopColor", "borderBottomColor", "backgroundColor", "color", "textDecorationLine"];
    let ok = 0;
    for (const el of targets) {
      await ctx.tick();
      const before = getComputedStyle(el);
      const b = Object.fromEntries(props.map((p) => [p, before[p]]));
      el.focus({ preventScroll: true, focusVisible: true });
      if (document.activeElement !== el) continue;
      const after = getComputedStyle(el);
      const changed = props.some((p) => after[p] !== b[p]) && !(after.outlineStyle === "none" && after.boxShadow === b.boxShadow && after.borderTopColor === b.borderTopColor && after.backgroundColor === b.backgroundColor && after.color === b.color && after.textDecorationLine === b.textDecorationLine);
      el.blur();
      if (changed) ok++;
      else ctx.add({ testId: id, name, element: el, status: "warning", severity: "medium", verification: "inferred", message: "No style change detected on programmatic focus (outline, shadow, border, background, colour). Styles on child/pseudo elements are not detected — confirm with the keyboard.", fix: "Provide a :focus-visible style (e.g. outline: 2px solid)." });
    }
    if (prev && prev.focus && prev !== document.body) prev.focus({ preventScroll: true });
    if (ok) ctx.add({ testId: id, name, status: "passed", severity: "info", verification: "inferred", message: `${ok} of ${targets.length} sampled focusable element(s) changed style on focus.` });
  }

  const TESTS = [
    { id: "a11y.aria-references", name: "Valid ARIA/label id references", run: ariaReferences, pass: "All id references resolve." },
    { id: "a11y.duplicate-ids", name: "Duplicate ids", run: duplicateIds, pass: "No duplicate ids." },
    { id: "a11y.document", name: "Language, title, zoom and landmarks", run: documentBasics, pass: "Document basics checked." },
    { id: "a11y.headings", name: "Heading structure", run: headings, pass: "Heading levels are sequential with an h1." },
    { id: "a11y.hidden-focusable", name: "Focusable content inside aria-hidden", run: hiddenFocusable, pass: "No focusable elements inside aria-hidden regions." },
    { id: "a11y.positive-tabindex", name: "Positive tabindex", run: tabindexPositive, pass: "No positive tabindex values." },
    { id: "a11y.roles", name: "Roles and widget structure", run: roles, pass: "Roles are valid and composite widgets are structured correctly." },
    { id: "a11y.dialogs", name: "Dialog labelling and modality", run: dialogs, pass: "No open dialogs with missing names." },
  ];

  QA.register("accessibility", {
    label: "Accessibility",
    tests: TESTS,
    after: async (ctx) => {
      if (ctx.shouldRun("a11y.focus-visible")) await focusVisibility(ctx);
    },
    manual: [
      { id: "a11y.screen-reader", name: "Screen-reader walkthrough", message: "Use NVDA/VoiceOver/TalkBack to read the page: names, roles, states and live announcements need human verification." },
      { id: "a11y.reflow-zoom", name: "200% zoom and 320px reflow", message: "Zoom to 200% and 400% (or use the 320px responsive preset): content must reflow without loss or two-dimensional scrolling." },
      { id: "a11y.wcag-scope", name: "Scope of automated checks", message: "These automated checks cover a subset of WCAG 2.2 success criteria. A passing result here does not mean the page conforms to WCAG." },
    ],
  });
})();
