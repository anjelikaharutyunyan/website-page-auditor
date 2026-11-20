// Links & navigation QA. Same-origin URL checks are bounded HEAD requests; external URLs are only
// collected here and checked by the background worker when the user enables it.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const GENERIC_TEXT = /^(click here|here|read more|more|learn more|details|link|this|continue|go|more info|see more|view more|подробнее|далее|здесь)$/i;

  function collect() {
    return [...document.querySelectorAll("a, area[href]")].filter((a) => !h.isOwnNode(a));
  }

  function looksClickable(el) {
    return getComputedStyle(el).cursor === "pointer" || el.hasAttribute("onclick");
  }

  function isSpa() {
    return !!document.querySelector("#root, #app, #__next, #__nuxt, [ng-version], [data-reactroot], [data-v-app], #svelte");
  }

  async function fetchStatus(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res = await fetch(url, { method: "HEAD", credentials: "same-origin", redirect: "follow", cache: "no-store", signal: ctl.signal });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: "GET", credentials: "same-origin", redirect: "follow", cache: "no-store", signal: ctl.signal });
        ctl.abort(); // headers are enough; do not download the body
      }
      return { status: res.status, redirected: res.redirected, finalUrl: res.url, contentType: res.headers.get("content-type") };
    } catch (e) {
      if (e.name === "AbortError") return { error: "timeout" };
      return { error: String(e.message || e) };
    } finally {
      clearTimeout(t);
    }
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

  async function runStatic(ctx) {
    const links = collect();
    const page = location.href;
    const ext = new Map();
    const internal = new Map();
    const byName = new Map();
    const T = (id, name) => ({ id, name, n: 0 });
    const tests = {
      dest: T("links.no-destination", "Links without a usable destination"),
      malformed: T("links.malformed", "Malformed or suspicious URLs"),
      fragment: T("links.broken-fragment", "Broken in-page anchors"),
      blank: T("links.target-blank", "target=_blank configuration"),
      keyboard: T("links.keyboard", "Links not reachable by keyboard"),
      name: T("links.no-name", "Links without an accessible name"),
      generic: T("links.ambiguous-text", "Generic or ambiguous link text"),
      pe: T("links.pointer-events", "Links with pointer-events: none"),
      covered: T("links.covered", "Links covered by other elements"),
    };
    const add = (k, p) => {
      tests[k].n++;
      ctx.add({ testId: tests[k].id, name: tests[k].name, ...p });
    };
    const modal = h.openModal();
    if (modal) ctx.limitation(`A modal is open (${h.cssPath(modal)}): links behind it were not hit-tested (they are covered by design).`);

    for (const a of links) {
      await ctx.tick();
      const visible = h.isVisible(a) && !h.isVisuallyHiddenPattern(a);
      const raw = a.getAttribute("href");
      const hidden = !visible || h.isAriaHidden(a);

      if (raw === null) {
        if (a.localName === "a" && !hidden && looksClickable(a) && !a.hasAttribute("tabindex") && !a.getAttribute("role")) {
          add("keyboard", {
            element: a,
            status: "failed",
            severity: "medium",
            verification: "verified",
            message: "<a> without href looks clickable but is not focusable, so keyboard users cannot activate it.",
            actual: "no href, no tabindex",
            expected: "a real href, or a <button> for actions",
            fix: "Give the link an href, or use a <button type=\"button\"> for in-page actions.",
          });
        }
        continue;
      }
      const c = U.classifyHref(raw, page);

      if (!hidden) {
        if (c.kind === "empty" || c.kind === "placeholder" || (c.kind === "javascript" && c.noop)) {
          const actionLike = a.getAttribute("role") === "button" || a.hasAttribute("onclick") || a.hasAttribute("aria-controls") || a.hasAttribute("aria-expanded") || a.hasAttribute("data-toggle") || a.hasAttribute("data-bs-toggle");
          add("dest", {
            element: a,
            status: "warning",
            severity: actionLike ? "low" : "medium",
            verification: "inferred",
            message: actionLike
              ? `Link with href="${U.truncate(raw, 40)}" is used as a button. It works only with JavaScript and is announced as a link.`
              : `Link has href="${U.truncate(raw, 40)}" — no destination. Script handlers (if any) cannot be detected, so verify it does something.`,
            actual: `href="${U.truncate(raw, 60)}"`,
            expected: "a real URL, or a <button> for actions",
            fix: actionLike ? "Use <button type=\"button\"> for actions." : "Point the link to a real URL or replace it with a button.",
          });
        } else if (c.kind === "malformed" || (c.issues && c.issues.length)) {
          add("malformed", {
            element: a,
            status: c.kind === "malformed" ? "failed" : "warning",
            severity: "medium",
            verification: "verified",
            message: `Suspicious URL: ${(c.issues || []).join(", ")}.`,
            actual: `href="${U.truncate(raw, 120)}"`,
            expected: "a well-formed URL",
            fix: "Correct the href value (scheme, slashes, encoding).",
          });
        }
      }

      if ((c.kind === "fragment" || (c.kind === "same-origin" && c.samePage)) && c.fragment && !/^[!/]/.test(c.fragment) && c.fragment !== "top") {
        const target = document.getElementById(c.fragment) || document.getElementsByName(c.fragment)[0];
        if (!target) {
          add("fragment", {
            element: a,
            status: "failed",
            severity: "low",
            verification: "verified",
            message: `In-page anchor "#${U.truncate(c.fragment, 50)}" has no matching id or name on this page.`,
            actual: "no element with that id/name",
            expected: `an element with id="${U.truncate(c.fragment, 50)}"`,
            fix: "Add the missing id or correct the fragment. (Content rendered later by scripts may add it.)",
          });
        }
      }
      if (c.kind === "same-origin" && !c.samePage) {
        const key = c.url.split("#")[0];
        if (!internal.has(key)) internal.set(key, { url: key, el: a });
      }
      if (c.kind === "external") {
        const key = c.url.split("#")[0];
        if (!ext.has(key)) ext.set(key, { url: key, selector: h.cssPath(a), ref: h.refFor(a), text: h.textSnippet(a, 60) });
      }

      if (a.getAttribute("target") === "_blank") {
        const rel = (a.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        if (rel.includes("opener")) {
          add("blank", {
            element: a,
            status: "warning",
            severity: "medium",
            verification: "verified",
            message: 'target="_blank" with rel="opener" gives the new page access to window.opener (reverse tabnabbing).',
            actual: `rel="${a.getAttribute("rel")}"`,
            expected: 'rel="noopener"',
            fix: 'Remove "opener" from rel unless the integration requires it.',
          });
        } else if (c.kind === "external" && !rel.includes("noopener") && !rel.includes("noreferrer")) {
          add("blank", {
            element: a,
            status: "warning",
            severity: "info",
            verification: "verified",
            message: 'External target="_blank" link without rel="noopener". Current browsers imply noopener, older ones do not.',
            actual: `rel="${a.getAttribute("rel") || ""}"`,
            expected: 'rel="noopener"',
            fix: 'Add rel="noopener" (and noreferrer if referrer should not be sent).',
          });
        }
      }

      if (hidden) continue;
      const ti = a.getAttribute("tabindex");
      if (ti !== null && parseInt(ti, 10) < 0 && !a.closest('[role=menu], [role=tablist], [role=listbox], [role=toolbar], [role=tree], [role=grid], [role=radiogroup]')) {
        add("keyboard", {
          element: a,
          status: "warning",
          severity: "medium",
          verification: "verified",
          message: 'Visible link has tabindex="-1" and is skipped by the Tab key.',
          actual: `tabindex="${ti}"`,
          expected: "reachable with Tab (no negative tabindex)",
          fix: "Remove the negative tabindex unless focus is managed by a composite widget.",
        });
      }

      const { name } = h.accessibleName(a);
      if (!name) {
        add("name", {
          element: a,
          status: "failed",
          severity: "high",
          verification: "verified",
          message: "Link has no accessible name (no text, alt text or aria-label). Screen readers announce only the URL or \"link\".",
          actual: "empty accessible name",
          expected: "descriptive link text",
          evidence: { href: U.truncate(raw, 120) },
          fix: "Add visible text, an aria-label, or alt text on the image inside the link.",
        });
      } else {
        if (GENERIC_TEXT.test(name.trim())) {
          const key = name.trim().toLowerCase();
          if (!byName.has(key)) byName.set(key, new Set());
          byName.get(key).add(c.url || raw);
        }
      }

      const cs = getComputedStyle(a);
      if (cs.pointerEvents === "none" && a.getAttribute("aria-disabled") !== "true") {
        add("pe", {
          element: a,
          status: "warning",
          severity: "medium",
          verification: "verified",
          message: "Link has pointer-events: none, so mouse clicks do nothing while keyboard activation still works.",
          actual: "pointer-events: none",
          expected: "clickable, or marked aria-disabled and removed from the tab order",
          fix: "Remove pointer-events: none, or disable it consistently (aria-disabled, no href).",
        });
      }

      const hit = h.behindModal(a, modal) ? { state: "clear" } : h.hitTest(a);
      if (hit.state === "covered" || (hit.state === "partial" && hit.blockedPoints >= 3)) {
        const fixedBy = h.positionedAncestor(hit.by);
        add("covered", {
          element: a,
          status: hit.state === "covered" ? "failed" : "warning",
          severity: hit.state === "covered" ? "high" : "medium",
          verification: "verified",
          message: `${hit.state === "covered" ? "Link centre" : `${hit.blockedPoints}/${hit.testedPoints} sample points`} is covered by ${h.cssPath(hit.by)}${fixedBy ? " (fixed/sticky)" : ""}; clicks go to that element instead.`,
          actual: `top element at link position: ${h.cssPath(hit.by)}`,
          expected: "the link itself receives the click",
          evidence: { coveredBy: h.cssPath(hit.by), coveringPosition: getComputedStyle(hit.by).position, testedAtScrollY: Math.round(scrollY) },
          fix: "Adjust z-index/stacking, add pointer-events: none to decorative overlays, or move the overlapping element.",
        });
      }
    }

    for (const [text, urls] of byName) {
      const first = links.find((a) => (h.accessibleName(a).name || "").trim().toLowerCase() === text);
      if (urls.size < 2) {
        add("generic", {
          element: first,
          status: "warning",
          severity: "low",
          verification: "inferred",
          message: `Link text "${text}" does not describe its destination. It can be acceptable when the surrounding sentence or heading gives the context — verify.`,
          actual: `"${text}"`,
          expected: "link text that makes sense on its own",
          fix: 'Use descriptive text (e.g. "Download the 2026 price list") or add context with aria-label/aria-describedby.',
        });
        continue;
      }
      add("generic", {
        element: first,
        status: "warning",
        severity: "low",
        verification: "verified",
        message: `${urls.size} links share the text "${text}" but lead to different destinations; out of context they are indistinguishable.`,
        actual: `"${text}" → ${urls.size} different URLs`,
        expected: "unique, descriptive link text per destination",
        evidence: { destinations: [...urls].slice(0, 10) },
        fix: 'Make each link text describe its destination, or add context with aria-label/aria-describedby.',
      });
    }

    ctx.extras.externalLinks = [...ext.values()].slice(0, 200);
    ctx.extras.linkCounts = { total: links.length, internalUnique: internal.size, externalUnique: ext.size };
    return { tests, internal };
  }

  async function checkInternal(ctx, internal) {
    const id = "links.internal-http";
    const name = "Same-origin link HTTP status";
    if (!ctx.shouldRun(id)) return;
    ctx.markRan(id);
    const opts = ctx.options;
    if (opts.checkSameOriginLinks === false) {
      ctx.manual(id, name, `${internal.size} same-origin link(s) were not requested because same-origin checks are disabled in settings.`);
      return;
    }
    if (!/^https?:$/.test(location.protocol)) {
      ctx.skip(id, name, "Same-origin HTTP checks need an http(s) page.");
      return;
    }
    const all = [...internal.values()];
    const safe = all.filter((x) => !U.DESTRUCTIVE_URL_RE.test(x.url) && !x.el.hasAttribute("download"));
    const skippedUnsafe = all.length - safe.length;
    const max = opts.maxLinkChecks || 40;
    const list = safe.slice(0, max);
    if (safe.length > max) ctx.limitation(`Only ${max} of ${safe.length} unique same-origin URLs were requested (setting: max link checks).`);
    if (skippedUnsafe) ctx.limitation(`${skippedUnsafe} same-origin URL(s) were not requested because they look like logout/delete/cart/checkout actions.`);
    const results = await pool(list, 4, async (x) => {
      ctx.checkCancelled();
      return { x, r: await fetchStatus(x.url, 8000) };
    });
    let ok = 0;
    for (const { x, r } of results) {
      if (r.error) {
        ctx.add({ testId: id, name, element: x.el, status: "warning", severity: "low", verification: "inferred", message: `Request failed: ${r.error}.`, actual: r.error, expected: "HTTP response", evidence: { url: x.url }, fix: "Check the URL manually; the server may block automated requests." });
        continue;
      }
      const v = U.interpretHttpStatus(r.status);
      if (v.status === "passed") {
        ok++;
        continue;
      }
      ctx.add({
        testId: id,
        name,
        element: x.el,
        status: v.status,
        severity: v.severity,
        verification: v.unverifiable ? "inferred" : "verified",
        message: v.unverifiable ? `Server answered HTTP ${r.status}; the link may require login or blocks automated checks.` : `Same-origin link returns HTTP ${r.status}.`,
        actual: `HTTP ${r.status}`,
        expected: "HTTP 2xx/3xx",
        evidence: { url: x.url, finalUrl: r.finalUrl, redirected: r.redirected },
        fix: r.status === 404 || r.status === 410 ? "Fix or remove the link, or add a redirect for the moved page." : "Investigate the server response.",
      });
    }
    if (ok && list.length) {
      ctx.add({
        testId: id,
        name,
        status: "passed",
        severity: "info",
        verification: "verified",
        message: `${ok} of ${list.length} same-origin URL(s) answered with HTTP 2xx/3xx.${isSpa() ? " Note: this looks like a single-page app — a 200 response may just be the app shell, so client-side routes still need to be opened to confirm they render." : ""}`,
      });
    }
  }

  QA.register("links", {
    label: "Links",
    custom: async (ctx) => {
      const { tests, internal } = await runStatic(ctx);
      await checkInternal(ctx, internal);
      const ext = ctx.extras.externalLinks.length;
      if (ext && ctx.options.checkExternalLinks !== true) {
        ctx.manual("links.external", "External link destinations", `${ext} unique external link(s) were not requested. Turn on "Check external links" in Settings (Chrome asks you to allow access to all sites) to send cookie-free HEAD requests to them.`, { evidence: { examples: ctx.extras.externalLinks.slice(0, 10).map((l) => l.url) } });
      }
      if (isSpa()) {
        ctx.manual("links.client-routes", "Client-side routes", "This page looks like a single-page application. HTTP status checks cannot confirm client-side routes; open key navigation links and confirm the right view renders (no blank screen or in-app 404).", { severity: "low" });
      }
      ctx.manual("links.navigation-behaviour", "Navigation menus", "Open and close every navigation menu (desktop and mobile), check the current page is indicated, and verify submenus are reachable by keyboard.");
      return Object.values(tests).map((t) => ({ id: t.id, name: t.name, found: t.n }));
    },
  });
})();
