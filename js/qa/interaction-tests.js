// Clickable elements, cursor behaviour, focusability, overlaps and (opt-in) reversible state toggles.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const COMPOSITE = '[role=menu], [role=menubar], [role=tablist], [role=listbox], [role=toolbar], [role=tree], [role=grid], [role=radiogroup], [role=treegrid]';
  const ROLE_NEEDS_FOCUS = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|slider|spinbutton|textbox|searchbox|treeitem)$/;

  function interactiveElements() {
    return [...document.querySelectorAll(h.INTERACTIVE_SELECTOR)].filter((el) => !h.isOwnNode(el));
  }

  function isNativeInteractive(el) {
    return el.matches("a[href], area[href], button, input:not([type=hidden]), select, textarea, summary, label, option, details, video[controls], audio[controls], iframe");
  }

  function insideInteractive(el) {
    return !!el.parentElement?.closest("a[href], button, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [onclick]");
  }

  function hasInteractiveDescendant(el) {
    return !!el.querySelector("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [tabindex]:not([tabindex='-1'])");
  }

  function pointerOrigins(limit = 6000) {
    const out = [];
    const { list } = h.allElements(document.body, limit);
    for (const el of list) {
      const cs = getComputedStyle(el);
      if (cs.cursor !== "pointer") continue;
      const p = el.parentElement;
      if (p && getComputedStyle(p).cursor === "pointer") continue; // inherited
      out.push(el);
    }
    return out;
  }

  async function run(ctx) {
    const T = (id, name) => ({ id, name, n: 0 });
    const tests = {
      name: T("interactions.no-name", "Controls without an accessible name"),
      semantic: T("interactions.non-semantic-clickable", "Clickable-looking elements without semantics"),
      focus: T("interactions.not-focusable", "Interactive elements that cannot receive keyboard focus"),
      zero: T("interactions.zero-size", "Focusable elements with zero size"),
      type: T("interactions.button-type", "Buttons without explicit type in forms"),
      aria: T("interactions.aria-state", "Custom controls missing semantics"),
    };
    const add = (k, p) => {
      tests[k].n++;
      ctx.add({ testId: tests[k].id, name: tests[k].name, ...p });
    };
    const els = interactiveElements();
    for (const el of els) {
      await ctx.tick();
      const cs = getComputedStyle(el);
      const rendered = h.isRendered(el, cs);
      if (!rendered || h.isAriaHidden(el)) continue;
      const r = el.getBoundingClientRect();
      const role = el.getAttribute("role") || "";
      const disabled = h.isDisabled(el);
      const isLink = el.matches("a[href], area[href]");
      const srOnly = h.isVisuallyHiddenPattern(el, cs);

      if ((r.width === 0 || r.height === 0) && h.isTabbable(el) && !srOnly) {
        add("zero", {
          element: el,
          status: "warning",
          severity: "medium",
          verification: "verified",
          message: `Focusable ${el.localName} renders at ${Math.round(r.width)}×${Math.round(r.height)}px: keyboard users can tab to something they cannot see.`,
          actual: `${Math.round(r.width)}×${Math.round(r.height)}px, tabbable`,
          expected: "visible when focusable, or removed from the tab order",
          fix: "Hide it with display:none/hidden when not in use, or give it a visible size (skip links: show on :focus).",
        });
        continue;
      }
      if (r.width === 0 || r.height === 0) continue;

      if (!isLink && el.matches("button, input[type=button], input[type=submit], input[type=reset], input[type=image], summary, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=option], [role=combobox]")) {
        const { name } = h.accessibleName(el);
        if (!name && !srOnly) {
          add("name", {
            element: el,
            status: "failed",
            severity: "high",
            verification: "verified",
            message: `${role || el.localName} has no accessible name; screen readers announce only "${role || "button"}".`,
            actual: "empty accessible name",
            expected: "visible text, aria-label or aria-labelledby",
            evidence: { innerHTML: U.truncate(el.innerHTML.replace(/\s+/g, " "), 160) },
            fix: "Add text, or aria-label on icon-only buttons (and alt/aria-hidden on the icon).",
          });
        }
      }

      if (role && ROLE_NEEDS_FOCUS.test(role) && !isNativeInteractive(el) && !el.hasAttribute("tabindex") && !disabled && !el.closest(COMPOSITE + ", [aria-activedescendant]")) {
        add("focus", {
          element: el,
          status: "failed",
          severity: "medium",
          verification: "verified",
          message: `Element has role="${role}" but no tabindex, so it cannot be reached with the keyboard.`,
          actual: "not focusable",
          expected: 'tabindex="0" (and Enter/Space handlers), or a native element',
          fix: role === "button" ? 'Use <button type="button">, or add tabindex="0" plus Enter/Space key handling.' : 'Add tabindex="0" and keyboard handling, or use the native element.',
        });
      } else if (isNativeInteractive(el) && el.getAttribute("tabindex") !== null && parseInt(el.getAttribute("tabindex"), 10) < 0 && !disabled && !isLink && !el.closest(COMPOSITE) && !srOnly) {
        add("focus", {
          element: el,
          status: "warning",
          severity: "medium",
          verification: "verified",
          message: `Visible ${el.localName} has tabindex="${el.getAttribute("tabindex")}" and is skipped by the Tab key.`,
          actual: `tabindex="${el.getAttribute("tabindex")}"`,
          expected: "reachable with Tab",
          fix: "Remove the negative tabindex unless focus is managed by a composite widget.",
        });
      }

      if (el.localName === "button" && !el.hasAttribute("type") && el.form) {
        const buttons = el.form.querySelectorAll("button:not([type]), button[type=submit], input[type=submit]");
        const text = (h.accessibleName(el).name || "").toLowerCase();
        const nonSubmitText = /^(cancel|close|back|add|remove|delete|toggle|show|hide|edit|clear|reset|\+|-|×|x|more|less|prev|previous|next|upload|browse)\b/.test(text);
        if (buttons.length > 1 || nonSubmitText) {
          add("type", {
            element: el,
            status: "warning",
            severity: nonSubmitText ? "medium" : "low",
            verification: "inferred",
            message: `<button> without type inside a form defaults to type="submit"${nonSubmitText ? `, but its label "${U.truncate(text, 30)}" suggests it is not a submit button` : ` (form has ${buttons.length} implicit/explicit submit buttons)`}.`,
            actual: "no type attribute (submit)",
            expected: 'type="button" for non-submit actions, type="submit" for the submit button',
            fix: 'Add an explicit type="button" or type="submit".',
          });
        }
      }

    }

    // Clickable-looking elements without semantics
    for (const el of pointerOrigins()) {
      await ctx.tick();
      if (isNativeInteractive(el) || el.getAttribute("role") || el.hasAttribute("tabindex") || el.isContentEditable) continue;
      if (insideInteractive(el) || hasInteractiveDescendant(el)) continue;
      if (!h.isVisible(el) || h.isAriaHidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const inlineHandler = el.hasAttribute("onclick");
      add("semantic", {
        element: el,
        status: inlineHandler ? "failed" : "manual",
        severity: "medium",
        verification: inlineHandler ? "verified" : "manual",
        message: inlineHandler
          ? `<${el.localName}> has an onclick handler but no role or tabindex: it works with a mouse only.`
          : `<${el.localName}> shows a pointer cursor but has no link/button semantics. Script listeners cannot be detected from an extension: if it is clickable, keyboard and screen-reader users cannot use it; if it is not, the cursor is misleading.`,
        actual: `cursor: pointer on <${el.localName}> without role/tabindex`,
        expected: "a <button>/<a href>, or role + tabindex + key handling",
        fix: "Use a native button/link, or remove cursor: pointer from non-interactive elements.",
      });
    }

    // aria-expanded / aria-haspopup on non-focusable, role-less elements
    for (const el of document.querySelectorAll("[aria-expanded], [aria-haspopup]")) {
      await ctx.tick();
      if (h.isOwnNode(el) || !h.isVisible(el)) continue;
      if (isNativeInteractive(el) || el.getAttribute("role") || el.hasAttribute("tabindex")) continue;
      add("aria", {
        element: el,
        status: "failed",
        severity: "medium",
        verification: "verified",
        message: `<${el.localName}> exposes ${el.hasAttribute("aria-expanded") ? "aria-expanded" : "aria-haspopup"} but is not focusable and has no role — the state is announced on nothing a user can operate.`,
        actual: "state attribute on non-interactive element",
        expected: 'a <button> (or role="button" tabindex="0") carrying the state',
        fix: "Move the aria-expanded/aria-haspopup attribute to the actual toggle button.",
      });
    }

    // Disabled controls: summary for manual review
    const disabled = els.filter((el) => h.isDisabled(el) && h.isVisible(el));
    if (disabled.length) {
      ctx.manual("interactions.disabled-controls", "Disabled controls", `${disabled.length} visible control(s) are disabled. Verify each is meant to be disabled in this state and that users can tell why.`, {
        severity: "low",
        evidence: { controls: disabled.slice(0, 15).map((el) => h.cssPath(el)) },
      });
    }

    return tests;
  }

  // ---------------- opt-in reversible state toggles ----------------

  function panelFor(el) {
    const ids = (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)).find(Boolean) || null;
  }

  async function stateToggles(ctx) {
    const id = "interactions.state-toggle";
    const name = "Disclosures, tabs and accordions change state";
    if (!ctx.shouldRun(id)) return;
    ctx.markRan(id);
    const widgets = [...document.querySelectorAll("details > summary, [aria-expanded][aria-controls], [role=tab]")]
      .filter((el) => !h.isOwnNode(el) && h.isVisible(el) && !h.isDisabled(el))
      .filter((el) => !el.matches("a[href]:not([href^='#']):not([href^='javascript'])"))
      .filter((el) => !(el.matches("button") && el.form && (el.type === "submit")))
      .filter((el) => !U.DESTRUCTIVE_RE.test(h.accessibleName(el).name || ""));
    if (!widgets.length) {
      ctx.pass(id, name, "No disclosure, accordion or tab widgets found.");
      return;
    }
    if (!ctx.options.interactiveTests) {
      ctx.manual(id, name, `${widgets.length} disclosure/accordion/tab widget(s) found. Enable "Interactive tests" in settings to toggle them automatically (each toggle is reverted), or open and close each one manually.`, {
        evidence: { widgets: widgets.slice(0, 15).map((el) => h.cssPath(el)) },
      });
      return;
    }
    const release = QA.guardNavigation();
    let ok = 0;
    try {
      for (const el of widgets.slice(0, 15)) {
        ctx.checkCancelled();
        if (el.localName === "summary") {
          const details = el.parentElement;
          const was = details.open;
          details.open = !was;
          await new Promise((r) => setTimeout(r, 100));
          const changed = details.open !== was;
          details.open = was;
          if (changed) ok++;
          else ctx.add({ testId: id, name, element: el, status: "failed", severity: "medium", verification: "verified", message: "<details> did not change its open state.", fix: "Check scripts that prevent the toggle event." });
          continue;
        }
        const isTab = el.getAttribute("role") === "tab";
        const previouslySelected = isTab ? el.closest("[role=tablist]")?.querySelector('[role=tab][aria-selected="true"]') : null;
        if (isTab && previouslySelected === el) continue;
        const attr = isTab ? "aria-selected" : "aria-expanded";
        const before = el.getAttribute(attr);
        const panel = panelFor(el);
        const panelBefore = panel ? h.isVisible(panel) : null;
        let mutations = 0;
        const mo = new MutationObserver((list) => (mutations += list.length));
        mo.observe(document.body, { subtree: true, attributes: true, childList: true });
        el.click();
        await new Promise((r) => setTimeout(r, 400));
        mo.disconnect();
        const after = el.getAttribute(attr);
        const panelAfter = panel ? h.isVisible(panel) : null;
        const stateChanged = before !== after;
        const expectedOpen = after === "true";
        if (stateChanged && panel && panelAfter !== expectedOpen) {
          ctx.add({ testId: id, name, element: el, status: "failed", severity: "medium", verification: "verified", message: `${attr} changed to "${after}" but the controlled panel ${h.cssPath(panel)} is ${panelAfter ? "visible" : "hidden"}.`, actual: `${attr}="${after}", panel ${panelAfter ? "visible" : "hidden"}`, expected: `panel ${expectedOpen ? "visible" : "hidden"}`, fix: "Keep the ARIA state and the panel visibility in sync." });
        } else if (!stateChanged && panel && panelAfter !== panelBefore) {
          ctx.add({ testId: id, name, element: el, status: "warning", severity: "medium", verification: "verified", message: `The panel toggled but ${attr} stayed "${before}", so assistive technology gets the wrong state.`, actual: `${attr}="${after}"`, expected: `${attr} updated`, fix: `Update ${attr} when toggling.` });
        } else if (!stateChanged && !mutations) {
          ctx.add({ testId: id, name, element: el, status: "warning", severity: "medium", verification: "inferred", message: "Clicking produced no detectable DOM or state change within 400 ms.", actual: "no change", expected: "the widget opens/closes or selects", fix: "Verify the widget's click handler." });
        } else ok++;
        // Restore
        if (isTab && previouslySelected) previouslySelected.click();
        else if (stateChanged || mutations) el.click();
        await new Promise((r) => setTimeout(r, 250));
        if (!isTab && el.getAttribute(attr) !== before) ctx.limitation(`Could not restore the original state of ${h.cssPath(el)}.`);
      }
    } finally {
      release();
    }
    if (ok) ctx.add({ testId: id, name, status: "passed", severity: "info", verification: "verified", message: `${ok} widget(s) toggled state correctly and were restored.` });
  }

  QA.register("interactions", {
    label: "Interactions",
    custom: async (ctx) => {
      const tests = await run(ctx);
      await stateToggles(ctx);
      return Object.values(tests).map((t) => ({ id: t.id, name: t.name, found: t.n }));
    },
    manual: [
      {
        id: "interactions.keyboard-walkthrough",
        name: "Keyboard walkthrough",
        message: "Tab through the page: every control must be reachable in a logical order, operable with Enter/Space/arrow keys, and Escape must close menus and dialogs.",
      },
    ],
  });
})();
