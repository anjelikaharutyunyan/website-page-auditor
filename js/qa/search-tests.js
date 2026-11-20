// Search functionality QA. Static inspection by default; a controlled test query is only sent when the user
// explicitly enables it. Navigating submissions are performed by the background worker, which then verifies
// the resulting page with QA.searchVerify().
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const WORDS = /search|\bfind\b|lookup|query|поиск|найти|buscar|recherche|suche|cerca|zoek|szukaj/i;
  const NAMES = /^(q|s|k|query|search|keyword|keywords|term|terms|searchterm|search_query|search-term|text|w)$/i;
  const LOADING_SEL = '[aria-busy="true"], [role=progressbar], [class*="spinner" i], [class*="loading" i], [class*="loader" i]';
  function isTextLike(el) {
    return el.matches("input:not([type]), input[type=text], input[type=search], textarea, [role=searchbox], [role=combobox], [contenteditable=true]");
  }

  function discover() {
    const found = new Set();
    document.querySelectorAll("input[type=search], [role=searchbox], [role=search] input, form[role=search] input, search input").forEach((el) => found.add(el));
    document.querySelectorAll("input:not([type]), input[type=text], [role=combobox]").forEach((el) => {
      const hint = [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.className, el.labels ? [...el.labels].map((l) => l.textContent).join(" ") : "", el.form?.getAttribute("action") || "", el.form?.getAttribute("role") || ""].join(" ");
      if (NAMES.test(el.name || "") || WORDS.test(hint)) found.add(el);
    });
    return [...found].filter((el) => isTextLike(el) && !h.isOwnNode(el)).map((input) => ({ input, form: input.form || null, button: findButton(input) }));
  }

  function findButton(input) {
    if (input.form) {
      const subs = QA.formHelpers ? QA.formHelpers.submitButtons(input.form) : [];
      if (subs.length) return subs[0];
    }
    let scope = input.parentElement;
    for (let i = 0; scope && i < 3; i++, scope = scope.parentElement) {
      const btns = [...scope.querySelectorAll("button, [role=button], input[type=submit], input[type=button], a[role=button]")].filter((b) => b !== input);
      const named = btns.find((b) => WORDS.test([h.accessibleName(b).name, b.className, b.id].join(" ")));
      if (named) return named;
      if (btns.length === 1) return btns[0];
    }
    return null;
  }

  async function run(ctx) {
    const searches = discover();
    ctx.extras.searchControls = searches.map((s) => ({ input: h.cssPath(s.input), form: s.form ? h.cssPath(s.form) : null, button: s.button ? h.cssPath(s.button) : null, visible: h.isVisible(s.input) }));
    if (!searches.length) {
      ctx.skip("search.discovery", "Search controls", "No search field detected (checked input type, role, name, label, placeholder and nearby buttons).");
      return [];
    }
    const T = (id, name) => ({ id, name, n: 0 });
    const tests = {
      submit: T("search.submit-mechanism", "Search has a submit mechanism"),
      button: T("search.button-state", "Search button is enabled"),
      param: T("search.query-parameter", "Query is submitted as a parameter"),
      visible: T("search.visibility", "Search field is visible at this viewport"),
    };
    const add = (k, p) => {
      tests[k].n++;
      ctx.add({ testId: tests[k].id, name: tests[k].name, ...p });
    };

    for (const s of searches) {
      await ctx.tick();
      const { input, form, button } = s;
      const visible = h.isVisible(input);
      if (!visible) {
        const toggle = document.querySelector('[aria-controls][aria-expanded="false"], button[aria-label*="search" i], [class*="search-toggle" i], [class*="search-open" i]');
        add("visible", {
          element: input,
          status: "manual",
          severity: toggle ? "info" : "low",
          verification: "manual",
          message: `Search field is not visible at ${innerWidth}×${innerHeight}${toggle ? " — probably behind a toggle; open it and verify search works there" : " and no obvious toggle was found; verify search is reachable"}.`,
          fix: "Ensure search stays reachable at every breakpoint.",
        });
        continue;
      }
      if (form) {
        const blockers = [...form.elements].filter((f) => f.localName === "input" && /^(text|search|url|tel|email|password|number|date)$/.test(f.type || "text"));
        if (!button && blockers.length > 1) {
          add("submit", { element: input, status: "warning", severity: "medium", verification: "inferred", message: "Search form has several text fields and no submit button, so Enter will not submit it.", fix: "Add a submit button (it can be visually an icon)." });
        }
        const action = form.getAttribute("action");
        const method = (form.getAttribute("method") || "get").toLowerCase();
        if (action !== null && !input.name) {
          add("param", { element: input, status: "failed", severity: "high", verification: "verified", message: "Search input has no name attribute; a native submission of this form sends no query.", actual: "no name", expected: 'name="q" (or similar)', fix: "Add a name attribute to the search input." });
        } else if (action !== null && method === "post") {
          add("param", { element: form, status: "warning", severity: "low", verification: "verified", message: 'Search form uses method="post": result pages cannot be bookmarked, shared or reloaded without a resubmission prompt.', actual: "POST", expected: "GET with the query in the URL", fix: 'Use method="get".' });
        }
      } else if (!button) {
        add("submit", { element: input, status: "manual", severity: "low", verification: "manual", message: "Search field is outside a form and has no detectable button. It may use live (as-you-type) search via script — verify that typing or pressing Enter produces results.", fix: "Wrap the field in a <form role=search> with a submit button for a robust fallback." });
      }
      if (button && (button.disabled || button.getAttribute("aria-disabled") === "true")) {
        add("button", { element: button, status: "warning", severity: "medium", verification: "inferred", message: "Search button is disabled in its initial state. It may enable after typing — verify.", fix: "Keep the button enabled and handle empty queries with a message." });
      }
    }

    // Active controlled query (opt-in)
    const primary = searches.find((s) => h.isVisible(s.input));
    const activeId = "search.controlled-query";
    const activeName = "Controlled test query";
    if (ctx.shouldRun(activeId)) {
      ctx.markRan(activeId);
      if (!ctx.options.searchQueryTest) {
        ctx.manual(activeId, activeName, 'Search was not executed (no query is sent without permission). Enable "Allow a controlled search query" in settings, or test manually: empty query, whitespace-only query, a normal query via button and via Enter, a query with no results, and the same at mobile width.');
      } else if (!primary) {
        ctx.manual(activeId, activeName, "No visible search field at this viewport, so no test query was sent. Open the search (e.g. a search icon) and test it manually.");
      } else if (!textTarget(primary.input)) {
        ctx.manual(activeId, activeName, `The search control ${h.cssPath(primary.input)} is not a text field the extension can type into. Test search manually.`);
      } else {
        // Submitted by the background worker at the end of the scan: a search may navigate the tab, which would
        // abort a script waiting inside the page and leave later categories inspecting the results page.
        const query = String(ctx.options.searchQuery || "test").trim().slice(0, 60) || "test";
        ctx.extras.searchPlan = { input: h.cssPath(primary.input), form: primary.form ? h.cssPath(primary.form) : null, button: primary.button ? h.cssPath(primary.button) : null, query, startUrl: location.href };
      }
    }
    return Object.values(tests).map((t) => ({ id: t.id, name: t.name, found: t.n }));
  }

  function textTarget(el) {
    if (!el) return null;
    if (el.matches("input, textarea") || el.isContentEditable) return el;
    return el.querySelector("input:not([type=hidden]), textarea, [contenteditable=true]");
  }

  function typeQuery(el, query) {
    el.focus({ preventScroll: true });
    QA.formHelpers.nativeSetValue(el, query);
    const last = query.slice(-1);
    el.dispatchEvent(new KeyboardEvent("keyup", { key: last, bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  let mo = null;
  let mutationCount = 0;
  function snapshot() {
    if (!mo) {
      mo = new MutationObserver((l) => (mutationCount += l.length));
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
      setTimeout(() => {
        mo && mo.disconnect();
        mo = null;
      }, 15000);
    }
    return { url: location.href, mutations: mutationCount, text: (document.body.innerText || "").length };
  }
  function diff(a, b) {
    return { urlChanged: a.url !== b.url, url: b.url, mutations: b.mutations - a.mutations, textDelta: b.text - a.text };
  }

  function submitPrimary(s) {
    if (s.form && typeof s.form.requestSubmit === "function") s.form.requestSubmit(s.button && s.button.form === s.form ? s.button : undefined);
    else if (s.button) s.button.click();
    else pressEnter(s.input);
  }

  function loadingStillVisible() {
    return [...document.querySelectorAll(LOADING_SEL)].filter((e) => h.isVisible(e) && !h.isOwnNode(e));
  }

  const NO_RESULTS = /\b(no (search )?(results|matches|items|products|records)( were)?( found)?|nothing (was )?found|did not match any|0 (results|items|products|matches)|couldn'?t find|could not find|no products were found)\b|ничего не найдено|не найдено|нет результатов|ничего не нашлось|по вашему запросу ничего/i;
  const ITEM_SEL = 'a[href], li, article, tr, h2, h3, h4, [class*="result" i], [class*="product" i], [class*="item" i], [class*="card" i], [class*="hit" i]';

  // Innermost visible result-like elements whose text contains the query (the search box and its form excluded).
  function matchingItems(query, inputEl) {
    const q = query.toLowerCase();
    const form = inputEl && (inputEl.form || inputEl.closest("form, [role=search], search"));
    const hits = [];
    const all = document.querySelectorAll(ITEM_SEL);
    for (let i = 0; i < all.length && i < 4000; i++) {
      const el = all[i];
      if (h.isOwnNode(el) || (form && form.contains(el)) || (inputEl && el.contains(inputEl))) continue;
      if (!(el.textContent || "").toLowerCase().includes(q)) continue;
      if (!h.isVisible(el)) continue;
      hits.push(el);
    }
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  }

  function noResultsShown() {
    const text = document.body.innerText || "";
    const m = text.match(NO_RESULTS);
    return m ? m[0] : null;
  }

  function pageSnapshot(query, inputEl) {
    const s = snapshot();
    s.items = new Set(matchingItems(query, inputEl));
    s.noResults = noResultsShown();
    return s;
  }

  function verifyOutcome(ctx, id, name, query, before, inputEl, startUrl, navigated) {
    const params = new URL(location.href).searchParams;
    const q = query.toLowerCase();
    const inUrl = [...params.values()].some((v) => v.toLowerCase().includes(q));
    const d = before ? diff(before, snapshot()) : null;
    const urlChanged = location.href !== startUrl;
    const loading = loadingStillVisible();
    const nav = performance.getEntriesByType("navigation")[0];
    const httpStatus = navigated && nav ? nav.responseStatus : 0;
    const noResults = noResultsShown();
    const newNoResults = noResults && !(before && before.noResults === noResults) ? noResults : null;
    let items = matchingItems(query, inputEl);
    if (before) items = items.filter((el) => !before.items.has(el));
    else items = items.filter((el) => !el.closest("header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]"));
    const countText = ((document.body.innerText || "").match(/\b\d[\d\s,.]*\s+(results?|items?|products?|matches|hits|товар\S*|результат\S*)\b/i) || [])[0] || null;
    const responded = urlChanged || inUrl || !!newNoResults || items.length > 0 || (d && d.mutations > 5);
    const evidence = { query, startUrl, finalUrl: location.href, queryInUrl: inUrl, matchingResultItems: items.length, examples: items.slice(0, 3).map((el) => U.truncate((el.textContent || "").trim().replace(/\s+/g, " "), 80)), resultCountText: countText, noResultsText: newNoResults, domMutations: d ? d.mutations : null, httpStatus: httpStatus || "unavailable" };
    const target = inputEl && inputEl.isConnected ? inputEl : null;
    if (httpStatus >= 400) {
      ctx.add({ testId: id, name, status: "failed", severity: "high", verification: "verified", message: `Search results page returned HTTP ${httpStatus}.`, evidence, fix: "Investigate the search endpoint." });
      return;
    }
    if (loading.length) {
      ctx.add({ testId: id, name, element: loading[0], status: "warning", severity: "medium", verification: "verified", message: "A loading indicator is still visible several seconds after the search.", evidence, fix: "Make sure loading state is cleared on success and on error." });
    }
    if (items.length) {
      ctx.add({ testId: id, name, element: items[0], status: "passed", severity: "info", verification: "verified", message: `Search works: "${query}" returned ${items.length} visible result item(s) containing the query${countText ? ` (page says "${countText.trim()}")` : ""}, e.g. "${evidence.examples[0]}". Ranking and completeness still need a human check.`, evidence });
    } else if (newNoResults) {
      ctx.add({ testId: id, name, element: target, status: "warning", severity: "medium", verification: "verified", message: `Search for "${query}" shows "${newNoResults}". If the site has content containing "${query}", search is not working. Set a query that definitely exists on the site in Settings → Test query and re-run.`, evidence, fix: "Check the search index/endpoint for this query." });
    } else if (responded) {
      ctx.add({ testId: id, name, element: target, status: "warning", severity: "medium", verification: "inferred", message: `The page reacted to "${query}" (${[urlChanged && "URL changed", inUrl && "query in URL", d && d.mutations > 5 && `${d.mutations} DOM updates`].filter(Boolean).join(", ") || "content changed"}), but no visible result contains "${query}" and no "no results" message was found. Results may be irrelevant, rendered in an unusual way, or the query does not exist on the site.`, evidence, fix: "Run the search manually and check that results match the query." });
    } else {
      ctx.add({ testId: id, name, element: target, status: "failed", severity: "high", verification: "inferred", message: `Search did not respond to "${query}": URL unchanged, no results, no "no results" message and no page updates. Search appears broken (or renders inside an iframe/canvas).`, evidence, fix: "Run the search manually and check the console/network panel." });
    }
    if (navigated) {
      const box = discover().find((s) => h.isVisible(s.input));
      const el = box && textTarget(box.input);
      if (el && el.value !== undefined && !el.value) {
        ctx.add({ testId: "search.query-retained", name: "Results page keeps the query in the search box", element: el, status: "warning", severity: "low", verification: "verified", message: `The results page shows an empty search box instead of "${query}", so users cannot see or refine what they searched for.`, fix: "Pre-fill the search field with the current query on the results page." });
      }
    }
  }

  // Called by the background worker after the submission, on whichever document the tab is showing.
  QA.searchVerify = function (query, startUrl, options = {}) {
    const ctx = QA.createContext("search", options);
    ctx.markRan("search.controlled-query");
    const started = performance.now();
    const pending = QA.state.searchPending;
    const sameDoc = !!(pending && pending.query === query);
    const inputEl = sameDoc ? pending.input : null;
    verifyOutcome(ctx, "search.controlled-query", "Controlled test query", query, sameDoc ? pending.before : null, inputEl, startUrl, !sameDoc);
    if (sameDoc) {
      QA.state.searchPending = null;
      if (inputEl && inputEl.isConnected && location.href === startUrl) QA.formHelpers.nativeSetValue(inputEl, "");
    }
    return ctx.finish(Math.round(performance.now() - started));
  };

  // Types the query and submits it the way a user would. The submission is deferred so this call returns before
  // any navigation starts.
  QA.searchSubmit = function (plan) {
    const box = document.querySelector(plan.input);
    const input = textTarget(box);
    if (!input) return { ok: false, error: "the search field is no longer in the page" };
    const form = (plan.form && document.querySelector(plan.form)) || input.form || null;
    const button = (plan.button && document.querySelector(plan.button)) || findButton(input);
    QA.state.searchPending = { query: plan.query, input, before: pageSnapshot(plan.query, input) };
    try {
      typeQuery(input, plan.query);
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
    setTimeout(() => {
      try {
        submitPrimary({ form, input, button });
      } catch {}
    }, 600);
    return { ok: true, mode: form ? "form" : button ? "button" : "enter" };
  };

  QA.register("search", {
    label: "Search",
    custom: run,
  });
})();
