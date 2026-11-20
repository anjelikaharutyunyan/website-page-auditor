// Dashboard for the popup and the side panel. All page work happens in the background worker; this file only
// renders state and sends requests.
(() => {
  "use strict";
  const U = self.__webQAUtils;
  const $ = (id) => document.getElementById(id);
  const t = (key, subs) => {
    const msg = subs === undefined ? chrome.i18n.getMessage(key) : chrome.i18n.getMessage(key, subs);
    return msg || key;
  };
  const tf = (value) => (typeof value === "string" && self.__findingText ? self.__findingText(value) : value);

  const isPanel = !chrome.extension.getViews({ type: "popup" }).includes(window);
  document.documentElement.classList.toggle("is-panel", isPanel);

  const CATEGORY_ORDER = ["layout", "responsive", "images", "links", "interactions", "forms", "search", "accessibility", "elements"];
  const CATEGORY_LABEL = {
    layout: "uiCategoryLayout", responsive: "uiCategoryResponsive", images: "uiCategoryImages",
    links: "uiCategoryLinks", interactions: "uiCategoryInteractions", forms: "uiCategoryForms",
    search: "uiCategorySearch", accessibility: "uiCategoryAccessibility", elements: "uiCategoryElements",
  };
  const CATEGORY_HINT = {
    layout: "uiHintLayout", responsive: "uiHintResponsive", images: "uiHintImages",
    links: "uiHintLinks", interactions: "uiHintInteractions", forms: "uiHintForms",
    search: "uiHintSearch", accessibility: "uiHintAccessibility", elements: "uiHintElements",
  };
  const STATUS_LABEL = { failed: t("uiIssueFound"), warning: t("uiPossibleIssue"), manual: t("uiReviewManually"), passed: t("uiNoIssueFound") };
  const VERIFICATION_LABEL = { verified: t("uiMeasuredOnPage"), inferred: t("uiInferredHeuristic"), manual: t("uiNeedsHumanReview") };
  const SEVERITY_LABEL = { high: t("uiSeverityHigh"), medium: t("uiSeverityMedium"), low: t("uiSeverityLow"), info: t("uiSeverityInfo") };
  const EVIDENCE_LABEL = { coveredBy: t("uiCoveredBy"), coveringZIndex: t("uiCoveringZIndex"), coveringPosition: t("uiCoveringPosition"), testedAtScrollY: t("uiTestedAtScrollY") };

  // One label per finding: measured failures, inferred findings, undecidable items and passes.
  function resultLabel(r) {
    if (r.status === "passed") return { text: t("uiNoIssueFound"), cls: "verified" };
    if (r.status === "manual" || r.verification === "manual") return { text: t("uiCheckManually"), cls: "manual" };
    if (r.status === "failed" && r.verification === "verified") return { text: t("uiIssueFound"), cls: "verified" };
    return { text: t("uiPossibleIssue"), cls: "inferred" };
  }
  const OUTLINE_TOOLS = [
    ["showElementTagNames", "uiOutlineTagNames"],
    ["outlineBlockLevelElements", "uiOutlineBlock"],
    ["outlineAbsolutePositionedElements", "uiOutlineAbsolute"],
    ["outlineRelativePositionedElements", "uiOutlineRelative"],
    ["outlineFixedPositionedElements", "uiOutlineFixed"],
    ["outlineFloatedElements", "uiOutlineFloated"],
    ["outlineHeadings", "uiOutlineHeadings"],
    ["outlineTables", "uiOutlineTables"],
    ["outlineTableCells", "uiOutlineCells"],
    ["outlineTableCaptions", "uiOutlineCaptions"],
    ["outlineFrames", "uiOutlineFrames"],
    ["outlineExternalLinks", "uiOutlineExternal"],
    ["outlineNonSecureElements", "uiOutlineInsecure"],
    ["outlineDeprecatedElements", "uiOutlineDeprecated"],
  ];
  const OPTION_LABEL = {
    interactiveTests: "uiCheckTabsFocus",
    formInteractive: "uiCheckForms",
    searchQueryTest: "uiTestSearch",
    checkExternalLinks: "uiCheckExternalLinks",
    checkSameOriginLinks: "uiCheckSameSiteLinks",
  };
  const VIEWPORT_LABEL = {
    "mobile-s": "uiVpSmallMobile",
    mobile: "uiVpTypicalMobile",
    "mobile-l": "uiVpLargeMobile",
    tablet: "uiVpTablet",
    laptop: "uiVpLaptop",
    desktop: "uiVpDesktop",
  };
  const OUTLINE_STATUS = {
    Applied: "uiOutlineApplied",
    Reverted: "uiOutlineReverted",
    "Nothing to revert": "uiNothingToRevert",
    "Reverted all": "uiRevertedAll",
    "All outlines removed": "uiOutlinesRemoved",
    "No matching elements found": "uiNoMatchingElements",
  };
  const PAGE_SIZE = 150;

  const app = {
    tab: null,
    tabId: null,
    report: null,
    scan: null,
    settings: null,
    aids: {},
    seo: null,
    seoRunning: false,
    seoExpanded: new Set(),
    seoOpenGroups: new Set(),
    seoFilter: "",
    seoProgress: null,
    consented: false,
    view: "results",
    access: null,
    expanded: new Set(),
    openGroups: new Set(),
    shown: {},
    filters: { status: "", severity: "" },
    selected: new Set(),
    capturing: false,
    pdf: [],
    pdfOpen: new Set(),
  };
  // Session storage survives navigation and tab switches but not a browser restart.
  const PDF_KEY = "pdfReport";
  let tabLoadGeneration = 0;

  // ---------------------------------------------------------------- utilities

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }

  function localizeDocument() {
    const locale = chrome.i18n.getUILanguage() || "en";
    document.documentElement.lang = locale.replace("_", "-");
    document.title = t("extensionName");
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const value = t(node.dataset.i18n);
      if (value && value !== node.dataset.i18n) node.textContent = value;
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
      node.setAttribute("aria-label", t(node.dataset.i18nAria));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
  }

  function send(type, data = {}) {
    return chrome.runtime.sendMessage({ type, tabId: app.tabId, ...data }).catch((e) => ({ ok: false, message: e.message }));
  }

  let toastTimer = 0;
  function toast(message, kind = "info") {
    const t = $("toast");
    t.textContent = message;
    t.className = `toast show toast-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), kind === "danger" ? 7000 : 4000);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function vpText(v) {
    return v ? `${v.width}×${v.height}` : "";
  }

  function pageOrigin() {
    const url = (app.access && app.access.url) || (app.tab && app.tab.url);
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch {
      return null;
    }
  }

  function scanning() {
    return app.scan && app.scan.status === "running";
  }

  // ---------------------------------------------------------------- state loading

  async function loadTab(tab) {
    if (!tab || !app.consented) return;
    const generation = ++tabLoadGeneration;
    const changed = app.tabId !== tab.id;
    app.tab = tab;
    app.tabId = tab.id;
    if (changed) {
      app.expanded.clear();
      app.openGroups.clear();
      app.seoExpanded.clear();
      app.seoOpenGroups.clear();
      app.seoFilter = "";
      app.seoProgress = null;
      app.shown = {};
      app.selected.clear();
    }
    const access = await send("qa:checkAccess");
    if (generation !== tabLoadGeneration || app.tabId !== tab.id) return;
    // tab update events can queue overlapping checks; discard one if the browser has already
    // navigated this tab again while the extension was checking access.
    const latestTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!latestTab || (tab.url && latestTab.url !== tab.url) || generation !== tabLoadGeneration) return;
    app.tab = latestTab;
    app.access = access;
    // Covers navigations the background could not see (no URL in tab events without host access).
    if (app.access && app.access.ok) await send("qa:clearIfRouteChanged", { url: app.access.url });
    if (generation !== tabLoadGeneration) return;
    await refreshState(generation);
    if (generation !== tabLoadGeneration) return;
    renderAll();
    autoRunSeo();
  }

  async function refreshState(generation = null) {
    const st = await send("qa:getState");
    if (!st || st.ok === false) {
      if (generation !== null && generation !== tabLoadGeneration) return;
      toast((st && st.message) || t("uiBackgroundUnreachable"), "danger");
      return;
    }
    if (generation !== null && generation !== tabLoadGeneration) return;
    app.report = st.report;
    app.scan = st.scan;
    app.settings = st.settings;
    app.aids = st.aids || {};
    app.seo = st.seo || null;
  }

  async function saveSettings(patch) {
    const res = await send("qa:saveSettings", { settings: patch });
    if (res && res.ok) app.settings = res.settings;
    return res;
  }

  // ---------------------------------------------------------------- rendering

  function renderAll() {
    renderHeader();
    renderProgress();
    renderCategories();
    renderSummary();
    renderResults();
    renderLimitations();
    renderImages();
    renderSeo();
    renderTools();
    renderSettings();
    renderPdf();
  }

  function renderHeader() {
    const url = (app.access && app.access.url) || (app.tab && app.tab.url) || "";
    $("pageUrl").textContent = url || (app.tab && app.tab.title) || t("uiUnknownPage");
    $("pageUrl").title = url;
    $("openSidePanel").classList.toggle("d-none", isPanel || !chrome.sidePanel);
    const banner = $("accessBanner");
    const a = app.access;
    if (a && !a.ok) {
      banner.classList.remove("d-none");
      $("accessText").textContent = a.message || t("uiCannotAccessPage");
      $("grantAccess").classList.toggle("d-none", !!a.restricted || !pageOrigin());
    } else banner.classList.add("d-none");
  }

  function renderProgress() {
    const s = app.scan;
    const running = scanning();
    const blocked = app.access && !app.access.ok;
    $("runAll").disabled = running || blocked;
    $("cancelScan").classList.toggle("d-none", !running);
    document.querySelectorAll("[data-run-cat]").forEach((b) => (b.disabled = running || blocked));
    document.querySelectorAll("[data-rerun]").forEach((b) => (b.disabled = running || blocked));
    const box = $("progress");
    if (!s || s.status === "completed") {
      box.classList.add("d-none");
      return;
    }
    box.classList.remove("d-none");
    box.dataset.status = s.status;
    const pct = s.total ? Math.round((Math.min(s.done, s.total) / s.total) * 100) : 0;
    $("progressFill").style.width = `${s.status === "running" ? Math.max(4, pct) : 100}%`;
    const text = s.status === "running" ? `${s.current || t("uiWorking")} (${s.done}/${s.total})` : s.status === "error" ? t("uiAuditFailed", [s.error || ""]) : s.current || s.status;
    $("progressText").textContent = text;
  }

  function renderCategories() {
    const grid = $("categoryGrid");
    grid.textContent = "";
    const byCat = app.report ? app.report.summary.byCategory : {};
    for (const cat of CATEGORY_ORDER) {
      const c = byCat[cat];
      const meta = app.report && app.report.categories && app.report.categories[cat];
      const counts = c
        ? el("div", { class: "cat-counts" },
            el("span", { class: "n-failed", title: STATUS_LABEL.failed, text: c.failed }),
            el("span", { class: "n-warning", title: STATUS_LABEL.warning, text: c.warning }),
            el("span", { class: "n-manual", title: STATUS_LABEL.manual, text: c.manual }),
            el("span", { class: "n-passed", title: STATUS_LABEL.passed, text: c.passed }))
        : el("div", { class: "cat-counts muted", text: meta ? (meta.status === "error" ? t("uiSkippedError") : t("uiNoFindings")) : t("uiNotRunYet") });
      const card = el("div", { class: `cat-card${meta && meta.status === "error" ? " cat-error" : ""}`, dataset: { cat } },
        el("div", { class: "cat-name" }, t(CATEGORY_LABEL[cat])),
        el("div", { class: "cat-hint", text: t(CATEGORY_HINT[cat]) }),
        counts,
        el("button", {
          class: "btn btn-xs cat-run",
          type: "button",
          dataset: { runCat: cat },
          "aria-label": `${t("uiRunCategory")}: ${t(CATEGORY_LABEL[cat])}`,
          title: `${t("uiRunCategory")}: ${t(CATEGORY_LABEL[cat])}`,
          onclick: () => startScan([cat], { merge: true }),
        }));
      grid.append(card);
    }
    renderProgress();
  }

  function renderSummary() {
    const r = app.report;
    $("summary").classList.toggle("d-none", !r);
    $("filters").classList.toggle("d-none", !r);
    $("exportBar").classList.toggle("d-none", !r);
    $("emptyState").classList.toggle("d-none", !!r);
    if (!r) return;
    const s = r.summary;
    $("countFailed").textContent = s.byStatus.failed;
    $("countWarning").textContent = s.byStatus.warning;
    $("countManual").textContent = s.byStatus.manual;
    $("countPassed").textContent = s.byStatus.passed;
    document.querySelectorAll("[data-filter-status]").forEach((b) => b.classList.toggle("active", app.filters.status === b.dataset.filterStatus));

    const chips = $("severityChips");
    chips.textContent = "";
    chips.append(el("span", { class: "muted", text: t("uiOpenIssuesBySeverity") }));
    for (const sev of U.SEVERITIES.filter((s) => s !== "info")) {
      const severityLabel = t(`uiSeverity${sev[0].toUpperCase()}${sev.slice(1)}`);
      chips.append(el("button", { class: `sev-chip${app.filters.severity === sev ? " active" : ""}`, dataset: { sev }, type: "button", "aria-pressed": String(app.filters.severity === sev), onclick: () => setFilter({ severity: app.filters.severity === sev ? "" : sev }) }, `${severityLabel} ${s.bySeverity[sev] || 0}`));
    }

    const m = r.meta || {};
    const meta = $("reportMeta");
    meta.textContent = "";
    const ms = m.durationMs || 0;
    const duration = ms < 1000 ? t("uiMilliseconds", [String(ms)]) : t("uiSeconds", [(ms / 1000).toFixed(1)]);
    const updated = m.updatedAt ? t("uiUpdatedAt", [fmtTime(m.updatedAt)]) : "";
    meta.append(el("div", {}, el("b", { text: t("uiAuditedPrefix") }), `${fmtTime(m.startedAt)}${updated} · ${duration} · ${t("uiBaseViewport", [vpText(m.baseViewport)])}`));
    if (m.viewportsTested && m.viewportsTested.length) {
      meta.append(el("div", {}, el("b", { text: t("uiViewportsPrefix") }), m.viewportsTested.map((v) => `${v.width}×${v.height}${v.approximate ? t("uiActualSize", [`${v.actualWidth}×${v.actualHeight}`]) : ""}${v.method === "window" ? t("uiWindowResizeBracket") : ""}`).join(", ")));
    }
    const enabled = Object.entries(m.options || {}).filter(([k, v]) => v === true && k !== "checkSameOriginLinks").map(([k]) => (OPTION_LABEL[k] ? t(OPTION_LABEL[k]) : k));
    meta.append(el("div", {}, el("b", { text: t("uiActiveTestsPrefix") }), enabled.length ? enabled.join(", ") : t("uiReadOnlyChecks")));
    if (m.cancelled) meta.append(el("div", { class: "warn-text", text: t("uiAuditStoppedEarly") }));
    const cur = app.access && app.access.url;
    if (cur && m.url && cur !== m.url) meta.append(el("div", { class: "warn-text", text: t("uiReportOtherPage", [m.url]) }));

    $("filterStatus").value = app.filters.status;
    $("filterSeverity").value = app.filters.severity;
  }

  function setFilter(patch) {
    Object.assign(app.filters, patch);
    app.shown = {};
    renderSummary();
    renderResults();
  }

  function filteredResults() {
    const f = app.filters;
    return app.report.results.filter((r) => {
      if (f.status && r.status !== f.status) return false;
      if (f.severity && r.severity !== f.severity) return false;
      return true;
    });
  }

  function renderResults() {
    const list = $("resultsList");
    list.textContent = "";
    renderSelection();
    if (!app.report) return;
    const items = filteredResults();
    if (!items.length) {
      list.append(el("p", { class: "hint", text: t("uiNoFilterResults") }));
      return;
    }
    for (const status of U.STATUSES) {
      const group = items.filter((r) => r.status === status);
      if (!group.length) continue;
      const det = el("details", { class: `group group-${status}`, open: app.openGroups.has(status) || app.filters.status === status });
      det.addEventListener("toggle", () => (det.open ? app.openGroups.add(status) : app.openGroups.delete(status)));
      det.append(el("summary", {}, STATUS_LABEL[status], " ", el("span", { class: "count", text: group.length })));
      const limit = app.shown[status] || PAGE_SIZE;
      for (const r of group.slice(0, limit)) det.append(resultNode(r));
      if (group.length > limit) {
        det.append(el("button", { class: "btn btn-sm show-more", type: "button", onclick: () => {
          app.shown[status] = limit + PAGE_SIZE;
          renderResults();
        } }, t("uiShowMore", [String(Math.min(PAGE_SIZE, group.length - limit))])));
      }
      list.append(det);
    }
    renderProgress();
  }

  function resultKey(r) {
    return `${r.status}|${U.resultKey(r)}`;
  }

  function resultNode(r) {
    const key = resultKey(r);
    const open = app.expanded.has(key);
    const node = el("div", { class: `result status-${r.status}${open ? " open" : ""}` });
    const head = el("button", { class: "result-head", type: "button", "aria-expanded": String(open) },
      el("span", { class: `sev sev-${r.severity}`, text: SEVERITY_LABEL[r.severity] || r.severity }),
      el("span", { class: "result-name", text: tf(r.name) }),
      el("span", { class: "chip", text: CATEGORY_LABEL[r.category] ? t(CATEGORY_LABEL[r.category]) : (U.CATEGORIES[r.category] || r.category) }),
      r.category === "responsive" && r.viewport ? el("span", { class: "chip chip-vp", text: vpText(r.viewport) }) : null,
      el("span", { class: `chip ver-${resultLabel(r).cls}`, text: resultLabel(r).text }),
      r.occurrences > 1 ? el("span", { class: "chip chip-repeat", title: `${t("uiRepeated")} ×${r.occurrences}`, text: `${t("uiRepeated")} ×${r.occurrences}` }) : null,
      el("span", { class: "result-msg", text: tf(r.message) }));
    head.addEventListener("click", () => {
      if (app.expanded.has(key)) app.expanded.delete(key);
      else {
        app.expanded.add(key);
        if (r.selector || r.ref) highlight(r);
      }
      node.replaceWith(resultNode(r));
    });
    node.append(el("div", { class: "result-row" }, selectBox(`a|${key}`, tf(r.name)), head));
    if (open) node.append(resultBody(r));
    return node;
  }

  function resultBody(r) {
    const body = el("div", { class: "result-body" });
    body.append(el("p", { text: tf(r.message) }));
    if (r.selector) {
      body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiLocator") }), el("code", { text: r.selector }),
        el("button", { class: "btn btn-xs", type: "button", onclick: () => navigator.clipboard.writeText(r.selector).then(() => toast(`${t("uiLocator")} ${t("uiCopy").toLowerCase()}`)) }, t("uiCopy"))));
    }
    const e = r.element;
    if (e) {
      const desc = `<${e.tag}>${e.classes && e.classes.length ? " ." + e.classes.join(".") : ""}${e.rect ? ` — ${e.rect.width}×${e.rect.height} at (${e.rect.x}, ${e.rect.y})` : ""}${e.parent ? `; parent <${e.parent.tag}> ${e.parent.width}×${e.parent.height}` : ""}`;
      body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiElement") }), el("span", { text: desc })));
    }
    if (r.actual !== undefined && r.actual !== null) body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiActual") }), el("span", { text: tf(String(r.actual)) })));
    if (r.expected !== undefined && r.expected !== null) body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiExpected") }), el("span", { text: tf(String(r.expected)) })));
    if (r.fix) body.append(el("div", { class: "kv-row fix" }, el("b", { text: t("uiSuggestedFix") }), el("span", { text: tf(r.fix) })));
    if (r.viewport) {
      const tested = r.category === "responsive";
      body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiViewport") }), el("span", { text: `${vpText(r.viewport)}${r.viewport.label ? ` (${r.viewport.label})` : ""}${r.viewport.method === "window" ? t("uiViaWindowResize") : ""}${tested ? t("uiViewportRestored") : ""}` })));
    }
    const instances = r.instances || [];
    if (r.occurrences > 1) {
      body.append(el("div", { class: "kv-row repeat-note" }, el("b", { text: t("uiRepeated") }),
        el("span", { text: t("uiRepeatedExplanation", [String(r.occurrences)]) })));
      if (instances.length > 1) {
        const list = el("ol", { class: "instance-list" });
        for (const i of instances) list.append(el("li", {}, el("code", { text: i.selector || "" })));
        const more = r.occurrences > instances.length ? t("uiFirstListed", [String(instances.length)]) : "";
        body.append(el("details", { class: "evidence" }, el("summary", { text: `${t("uiAllLocations")}${more}` }), list));
      }
    }
    if (r.evidence && Object.keys(r.evidence).length) {
      const evidenceTable = el("table", { class: "kv" });
      for (const [k, v] of Object.entries(r.evidence)) {
        if (v === null || v === undefined || v === "") continue;
        evidenceTable.append(el("tr", {}, el("th", { text: k }), el("td", { text: typeof v === "object" ? JSON.stringify(v) : String(v) })));
      }
      for (const th of evidenceTable.querySelectorAll("th")) th.textContent = EVIDENCE_LABEL[th.textContent] || th.textContent;
      body.append(el("details", { class: "evidence" }, el("summary", { text: t("uiEvidence") }), evidenceTable));
    }
    body.append(el("div", { class: "meta-line", text: `${chrome.i18n.getMessage("uiTestLabel", [r.testId]) || `Test ${r.testId}`} · ${VERIFICATION_LABEL[r.verification] || r.verification} · ${chrome.i18n.getMessage("uiSeverityLabel", [SEVERITY_LABEL[r.severity] || r.severity]) || `severity ${r.severity}`}` }));
    const actions = el("div", { class: "result-actions" });
    if (r.selector || r.ref) {
      actions.append(el("button", { class: "btn btn-xs", type: "button", onclick: () => highlight(r) }, r.occurrences > 1 ? t("uiHighlightFirst") : t("uiHighlight")));
      if (instances.length > 1) actions.append(el("button", { class: "btn btn-xs", type: "button", onclick: () => highlightAll(r) }, chrome.i18n.getMessage("uiHighlightAll", [String(instances.length)]) || `Highlight all ${instances.length}`));
    }
    actions.append(el("button", { class: "btn btn-xs", type: "button", dataset: { rerun: "1" }, disabled: scanning(), onclick: () => rerun(r) }, t("uiRerunTest")));
    body.append(actions);
    return body;
  }

  function renderLimitations() {
    const box = $("limitations");
    const list = $("limitationsList");
    list.textContent = "";
    const r = app.report;
    if (!r) {
      box.classList.add("d-none");
      return;
    }
    const items = [];
    for (const [cat, v] of Object.entries(r.categories || {})) {
      const label = CATEGORY_LABEL[cat] ? t(CATEGORY_LABEL[cat]) : (U.CATEGORIES[cat] || cat);
      if (v.error) items.push([label, t("uiSkippedCategoryError", [tf(v.error)])]);
      for (const sk of v.skipped || []) items.push([label, t("uiSkippedNamed", [tf(sk.name), tf(sk.reason)])]);
      for (const l of v.limitations || []) items.push([label, tf(l)]);
    }
    for (const l of r.limitations || []) items.push([t("uiGeneral"), tf(l)]);
    $("limitationsCount").textContent = items.length;
    box.classList.toggle("d-none", !items.length);
    for (const [label, text] of items) list.append(el("li", {}, el("b", { text: `${label}: ` }), text));
  }

  // ---------------------------------------------------------------- SEO

  const SEO_STATUS_LABEL = { passed: t("uiNoIssueFound"), issue: t("uiIssueFound"), warning: t("uiPossibleIssue"), skipped: t("uiCouldntCompare") };
  let ogMeasure = { url: null, promise: null };

  // Loaded in a detached Image, never inserted into the page. The size is known as soon as the image header
  // arrives, so the request is dropped then instead of downloading the whole file.
  function measureImage(url, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      let poll = 0;
      let timer = 0;
      const finish = (size) => {
        clearInterval(poll);
        clearTimeout(timer);
        img.onload = img.onerror = null;
        img.removeAttribute("src");
        resolve(size);
      };
      const read = () => img.naturalWidth > 0 && img.naturalHeight > 0 && (finish({ width: img.naturalWidth, height: img.naturalHeight }), true);
      img.onload = () => read() || finish(null);
      img.onerror = () => finish(null);
      poll = setInterval(read, 50);
      timer = setTimeout(() => finish(null), timeoutMs);
      img.src = url;
    });
  }

  function ogImageSize(url) {
    if (!url || !/^(https?:|data:image\/)/i.test(url)) return Promise.resolve(null);
    if (ogMeasure.url !== url) ogMeasure = { url, promise: measureImage(url) };
    return ogMeasure.promise;
  }

  const SEO_GROUPS = ["issue", "warning", "skipped", "passed"].map((s) => [s, SEO_STATUS_LABEL[s]]);
  const SEO_RESULT_CLASS = { issue: "failed", warning: "warning", passed: "passed", skipped: "skipped" };

  // Shape expected by highlight()/highlightAll(), shared with the Results tab.
  function seoTarget(c, inst, instances) {
    return { name: tf(c.name), severity: c.status === "issue" ? "high" : "medium", status: SEO_STATUS_LABEL[c.status], message: tf(inst.label || c.detail), selector: inst.selector, ref: inst.ref, instances };
  }

  function seoLocations(c) {
    const it = c.items;
    const list = el("ol", { class: "instance-list seo-locations" });
    for (const g of it.groups) {
      const first = g.instances[0];
      list.append(el("li", {},
        el("div", { class: "seo-loc-head" },
          el("code", { text: first.selector }),
          g.count > 1 ? el("span", { class: "chip chip-repeat", title: t("uiRepeatedStructure", [String(g.count)]), text: `${t("uiRepeated")} ×${g.count}` }) : null),
        first.label ? el("div", { class: "seo-detail", text: tf(first.label) }) : null,
        el("div", { class: "result-actions" },
          el("button", { class: "btn btn-xs", type: "button", onclick: () => highlight(seoTarget(c, first)) }, g.count > 1 ? t("uiHighlightFirst") : t("uiHighlight")),
          g.count > 1 ? el("button", { class: "btn btn-xs", type: "button", onclick: () => highlightAll(seoTarget(c, first, g.instances)) }, t("uiHighlightAll", [String(g.count)])) : null)));
    }
    const all = it.groups.flatMap((g) => g.instances);
    const more = it.total > it.listed ? t("uiFirstListed", [String(it.listed)]) : "";
    return [
      el("div", { class: "kv-row" }, el("b", { text: t("uiAffected") }), el("span", { text: t("uiElementCount", [String(it.total), more]) }),
        all.length > 1 ? el("button", { class: "btn btn-xs", type: "button", onclick: () => highlightAll(seoTarget(c, all[0], all)) }, t("uiHighlightAll", [String(all.length)])) : null),
      list,
    ];
  }

  function seoBody(c, s) {
    const body = el("div", { class: "result-body" });
    if (c.detail) body.append(el("p", { text: tf(c.detail) }));
    body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiValue") }), el("span", { text: tf(c.value) })));
    if (c.id === "seo.title-length" && s.title) body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiTitleLabel") }), el("code", { text: s.title })));
    if (c.id === "seo.og-image" && s.ogImage.present) {
      body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiUrlLabel") }), el("code", { text: s.ogImage.url || s.ogImage.content })));
      const size = el("span", { text: t("uiMeasuring") });
      body.append(el("div", { class: "kv-row" }, el("b", { text: t("uiDimensions") }), size));
      ogImageSize(s.ogImage.url).then((d) => (size.textContent = d ? `${d.width} × ${d.height} px` : t("uiUnavailable")));
    }
    if (c.items && c.items.groups.length) body.append(...seoLocations(c));
    return body;
  }

  function seoNode(c, s) {
    const open = app.seoExpanded.has(c.id);
    const node = el("div", { class: `result status-${SEO_RESULT_CLASS[c.status]}${open ? " open" : ""}`, dataset: { seoCheck: c.id } });
    const head = el("button", { class: "result-head", type: "button", "aria-expanded": String(open) },
      el("span", { class: `seo-status seo-status-${c.status}`, text: SEO_STATUS_LABEL[c.status] || c.status }),
      el("span", { class: "result-name", text: tf(c.name) }),
      el("span", { class: "chip seo-value", text: tf(c.value) }),
      c.detail ? el("span", { class: "result-msg", text: tf(c.detail) }) : null);
    head.addEventListener("click", () => {
      if (app.seoExpanded.has(c.id)) app.seoExpanded.delete(c.id);
      else {
        app.seoExpanded.add(c.id);
        const first = c.items && c.items.groups[0] && c.items.groups[0].instances[0];
        if (first) highlight(seoTarget(c, first));
      }
      node.replaceWith(seoNode(c, s));
    });
    node.append(el("div", { class: "result-row" }, selectBox(`s|${c.id}`, tf(c.name)), head));
    if (open) node.append(seoBody(c, s));
    return node;
  }

  const SEO_COUNT_ID = { issue: "seoCountIssue", warning: "seoCountWarning", skipped: "seoCountSkipped", passed: "seoCountPassed" };

  function renderSeoProgress() {
    const p = app.seoProgress;
    const box = $("seoProgress");
    if (!p) {
      box.classList.add("d-none");
      return;
    }
    box.classList.remove("d-none");
    box.dataset.status = p.status;
    const pct = p.total ? Math.round((Math.min(p.done, p.total) / p.total) * 100) : 0;
    $("seoProgressFill").style.width = `${p.status === "running" ? Math.max(4, pct) : 100}%`;
    $("seoProgressText").textContent = p.status === "running" ? `${p.current} (${p.done}/${p.total})` : t("uiSeoFailed", [p.error || ""]);
  }

  function setSeoFilter(status) {
    app.seoFilter = status;
    renderSeo();
  }

  function renderSeo() {
    const s = app.seo;
    const f = app.seoFilter;
    $("seoEmpty").classList.toggle("d-none", !!s);
    $("seoResults").classList.toggle("d-none", !s);
    $("seoSummary").classList.toggle("d-none", !s);
    $("seoFilters").classList.toggle("d-none", !s);
    $("seoMeta").textContent = s ? t("uiAnalyzed", [s.url]) : "";
    renderSeoProgress();
    renderSelection();
    const list = $("seoChecks");
    list.textContent = "";
    if (!s) return;
    for (const [status, id] of Object.entries(SEO_COUNT_ID)) $(id).textContent = s.checks.filter((c) => c.status === status).length;
    document.querySelectorAll("[data-seo-filter]").forEach((b) => b.classList.toggle("active", f === b.dataset.seoFilter));
    $("seoFilterStatus").value = f;
    const group = (key, cls, label, nodes) => {
      const det = el("details", { class: `group group-${cls}`, open: app.seoOpenGroups.has(key) || f === key });
      det.addEventListener("toggle", () => (det.open ? app.seoOpenGroups.add(key) : app.seoOpenGroups.delete(key)));
      det.append(el("summary", {}, label, " ", el("span", { class: "count", text: nodes.length })), ...nodes);
      list.append(det);
    };
    for (const [status, label] of SEO_GROUPS) {
      if (f && f !== status) continue;
      const checks = s.checks.filter((c) => c.status === status);
      if (checks.length) group(status, SEO_RESULT_CLASS[status], label, checks.map((c) => seoNode(c, s)));
    }
    if (f) {
      if (!list.childElementCount) list.append(el("p", { class: "hint", text: t("uiNoFilterResults") }));
      return;
    }
    group("info", "info", t("uiInformation"), [
      seoInfoNode(t("uiH3Count"), String(s.info.h3), t("uiH3CountNote")),
      seoInfoNode(t("uiWordCount"), String(s.info.words), t("uiWordCountNote", [s.info.scope])),
      seoInfoNode(t("uiInternalLinks"), String(s.info.links.internal), t("uiInternalLinksNote")),
      seoInfoNode(t("uiExternalLinksInfo"), String(s.info.links.external), t("uiExternalLinksNote")),
    ]);
  }

  function seoInfoNode(name, value, note) {
    return el("div", { class: "result status-info", dataset: { seoInfo: name } },
      el("div", { class: "result-head seo-static" },
        el("span", { class: "seo-status seo-status-info", text: t("uiInfo") }),
        el("span", { class: "result-name", text: name }),
        el("span", { class: "chip seo-value", text: value }),
        el("span", { class: "result-msg", text: note })));
  }

  async function runSeo() {
    if (app.seoRunning || !app.tabId) return;
    const tabId = app.tabId;
    app.seoRunning = true;
    app.seoExpanded.clear();
    app.seoProgress = { status: "running", done: 0, total: 2, current: t("uiAnalyzingPage") };
    renderSeo();
    const res = await send("qa:seo");
    const stale = () => app.tabId !== tabId;
    if (!stale() && res && res.ok) {
      app.seo = res.seo;
      const og = res.seo.ogImage;
      app.seoProgress = { status: "running", done: 1, total: 2, current: t("uiMeasuringOg") };
      renderSeo();
      if (og && og.present && og.url) await ogImageSize(og.url);
    }
    app.seoRunning = false;
    if (stale()) {
      app.seoProgress = null;
      return renderSeo();
    }
    if (res && res.ok) app.seoProgress = null;
    else {
      const message = (res && res.message) || t("uiSeoCouldNotRun");
      app.seoProgress = { status: "error", error: message };
      toast(message, "warning");
    }
    renderSeo();
  }

  // Runs every time the SEO tab is opened, and again when the page reloads or changes while it is open.
  function autoRunSeo() {
    if (app.view !== "seo" || app.seoRunning || !(app.access && app.access.ok)) return;
    runSeo();
  }

  // ---------------------------------------------------------------- images

  // Page blob: URLs and unreachable files cannot load in the extension page; those fall back to the address.
  function imagePreview(src) {
    const text = () => el("span", { class: "src-text", text: U.truncate(src || "", 90) });
    if (!src || !/^(https?:|data:image\/)/i.test(src)) return text();
    const img = el("img", { class: "thumb", src, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.replaceWith(text()), { once: true });
    return img;
  }

  function renderImages() {
    const cat = app.report && app.report.categories && app.report.categories.images;
    const inv = cat && cat.extras && cat.extras.imageInventory;
    $("imagesEmpty").classList.toggle("d-none", !!(inv && inv.length));
    $("imagesTable").classList.toggle("d-none", !(inv && inv.length));
    const summary = $("imagesSummary");
    summary.textContent = "";
    if (cat && cat.extras && cat.extras.imageSummary) {
      const s = cat.extras.imageSummary;
      summary.append(el("div", { text: Object.entries(s).filter(([k]) => k !== "note").map(([k, v]) => `${k === "images" ? t("uiImagesCount") : k}: ${v}`).join(" · ") }));
    }
    const tbody = $("imagesTable").querySelector("tbody");
    tbody.textContent = "";
    if (!inv) return;
    for (const i of inv) {
      const size = i.fileSize !== null && i.fileSize !== undefined ? U.formatBytes(i.fileSize) : i.fileSizeNote || t("uiUnknownSize");
      const row = el("tr", { class: i.state && i.state !== "loaded" ? "row-warn" : "", title: t("uiClickToHighlight") },
        el("td", { class: "src", title: i.src || "" }, el("span", { class: "chip", text: tf(i.kind) }), imagePreview(i.src)),
        el("td", { text: i.natural ? `${i.natural.width}×${i.natural.height}` : "—" }),
        el("td", { text: i.rendered ? `${i.rendered.width}×${i.rendered.height}` : "—" }),
        el("td", { text: [i.objectFit, i.objectPosition].filter(Boolean).join(" ") || "—" }),
        el("td", { text: size }),
        el("td", { text: [tf(i.croppingLikely), i.croppedPercent ? t("uiPercentHidden", [String(i.croppedPercent)]) : "", tf(i.cropAssessment)].filter(Boolean).join(" · ") || "—" }));
      if (i.selector || i.ref) row.addEventListener("click", () => highlight({ name: t("uiImage"), severity: "info", status: "", message: i.src, selector: i.selector, ref: i.ref }));
      tbody.append(row);
    }
  }

  // ---------------------------------------------------------------- PDF report

  function selectBox(id, label) {
    return el("input", {
      type: "checkbox",
      class: "pick",
      checked: app.selected.has(id),
      title: t("uiSelectFinding"),
      "aria-label": `${t("uiSelectFinding")}: ${label}`,
      onchange: (e) => {
        if (e.target.checked) app.selected.add(id);
        else app.selected.delete(id);
        renderSelection();
      },
    });
  }

  function seoShownChecks() {
    return app.seo ? app.seo.checks.filter((c) => !app.seoFilter || c.status === app.seoFilter) : [];
  }

  function pageInfo(url) {
    return { url: url || (app.access && app.access.url) || (app.tab && app.tab.url) || "", title: (app.tab && app.tab.title) || "" };
  }

  // Stored in English like the reports; report.html translates when it renders.
  function auditSnapshot(r) {
    return {
      kind: "audit",
      key: `a|${resultKey(r)}`,
      testId: r.testId,
      category: r.category,
      status: r.status,
      severity: r.severity,
      verification: r.verification,
      name: r.name,
      message: r.message || "",
      selector: r.selector || "",
      actual: r.actual === undefined || r.actual === null ? null : String(r.actual),
      expected: r.expected === undefined || r.expected === null ? null : String(r.expected),
      fix: r.fix || "",
      viewport: r.viewport ? { width: r.viewport.width, height: r.viewport.height, label: r.viewport.label || "" } : null,
      occurrences: r.occurrences || 1,
      locations: (r.instances || []).map((i) => i.selector).filter(Boolean).slice(0, 25),
    };
  }

  function seoSnapshot(c) {
    const groups = (c.items && c.items.groups) || [];
    return {
      kind: "seo",
      key: `s|${c.id}`,
      testId: c.id,
      category: "seo",
      status: c.status,
      name: c.name,
      value: c.value === undefined || c.value === null ? "" : String(c.value),
      message: c.detail || "",
      total: c.items ? c.items.total : 0,
      locations: groups.slice(0, 25).map((g) => ({ selector: g.instances[0].selector, label: g.instances[0].label || "", count: g.count })),
    };
  }

  // What to photograph for a finding. Responsive findings measured at another size are photographed with
  // that size emulated again.
  function auditCapture(r) {
    if (!r.ref && !r.selector) return null;
    const shot = { target: { ref: r.ref, selector: r.selector }, severity: r.severity };
    const base = app.report.meta && app.report.meta.baseViewport;
    if (r.category === "responsive" && r.viewport && (!base || r.viewport.width !== base.width || r.viewport.height !== base.height)) {
      shot.viewport = { width: r.viewport.width, height: r.viewport.height, mobile: r.viewport.width < 1024 };
    }
    return shot;
  }

  function seoCapture(c) {
    const first = c.items && c.items.groups[0] && c.items.groups[0].instances[0];
    return first ? { target: { ref: first.ref, selector: first.selector }, severity: c.status === "issue" ? "high" : "medium" } : null;
  }

  function selectedItems() {
    const out = [];
    if (app.report) {
      const page = pageInfo(app.report.meta && app.report.meta.url);
      for (const r of app.report.results) if (app.selected.has(`a|${resultKey(r)}`)) out.push({ page, ...auditSnapshot(r), capture: auditCapture(r) });
    }
    if (app.seo) {
      const page = pageInfo(app.seo.url);
      for (const c of app.seo.checks) if (app.selected.has(`s|${c.id}`)) out.push({ page, ...seoSnapshot(c), capture: seoCapture(c) });
    }
    return out;
  }

  function syncSelectAll(box, ids) {
    const on = ids.filter((id) => app.selected.has(id)).length;
    box.checked = ids.length > 0 && on === ids.length;
    box.indeterminate = on > 0 && on < ids.length;
    box.disabled = !ids.length;
  }

  function renderSelection() {
    const n = selectedItems().length;
    for (const id of ["addSelected", "seoAddSelected"]) {
      $(id).textContent = t("uiAddSelected", [String(n)]);
      $(id).disabled = !n || app.capturing;
    }
    syncSelectAll($("selectShown"), app.report ? filteredResults().map((r) => `a|${resultKey(r)}`) : []);
    syncSelectAll($("seoSelectShown"), seoShownChecks().map((c) => `s|${c.id}`));
  }

  function selectShown(ids, on) {
    for (const id of ids) {
      if (on) app.selected.add(id);
      else app.selected.delete(id);
    }
  }

  async function loadPdf() {
    const data = await chrome.storage.session.get(PDF_KEY).catch(() => ({}));
    app.pdf = (data[PDF_KEY] && data[PDF_KEY].items) || [];
  }

  async function savePdf(items) {
    if (items.length) await chrome.storage.session.set({ [PDF_KEY]: { items } });
    else await chrome.storage.session.remove(PDF_KEY);
    app.pdf = items;
  }

  function pdfPages() {
    const pages = new Map();
    for (const i of app.pdf) {
      if (!pages.has(i.page.url)) pages.set(i.page.url, { url: i.page.url, title: i.page.title, items: [] });
      pages.get(i.page.url).items.push(i);
    }
    return [...pages.values()];
  }

  async function dropShots(keys) {
    if (keys.length) await chrome.storage.session.remove(keys).catch(() => {});
  }

  async function addSelected() {
    if (app.capturing) return;
    const picked = selectedItems();
    if (!picked.length) return toast(t("uiNothingSelected"), "warning");
    app.capturing = true;
    renderSelection();
    try {
      const wanted = picked.map((p, i) => (p.capture ? { id: String(i), ...p.capture } : null)).filter(Boolean);
      let shots = {};
      if (wanted.length) {
        toast(t("uiTakingScreenshots", [String(wanted.length)]));
        const res = await send("qa:captureFindings", { targets: wanted });
        if (res && res.ok) shots = res.shots || {};
      }
      const now = new Date().toISOString();
      const byId = new Map(app.pdf.map((i) => [i.id, i]));
      const replaced = [];
      let storageFull = false;
      for (const [idx, { capture, ...item }] of picked.entries()) {
        const id = `${item.page.url}|${item.key}`;
        const old = byId.get(id);
        const image = shots[String(idx)];
        if (image && !storageFull) {
          const key = `pdfShot:${crypto.randomUUID()}`;
          try {
            await chrome.storage.session.set({ [key]: image });
            item.shot = key;
            if (old && old.shot) replaced.push(old.shot);
          } catch {
            storageFull = true;
          }
        }
        if (!item.shot && old && old.shot) item.shot = old.shot;
        byId.set(id, { ...item, id, addedAt: now });
      }
      const items = [...byId.values()];
      try {
        await savePdf(items);
      } catch {
        return toast(t("uiPdfStorageFull"), "danger");
      }
      await dropShots(replaced);
      app.selected.clear();
      const missing = wanted.length - Object.keys(shots).length;
      const added = t("uiAddedToPdf", [String(picked.length), String(items.length), String(pdfPages().length)]);
      if (storageFull) toast(`${added} ${t("uiShotsStorageFull")}`, "warning");
      else if (missing > 0) toast(`${added} ${t("uiShotsMissing", [String(missing)])}`, "warning");
      else toast(added);
    } finally {
      app.capturing = false;
      renderResults();
      renderSeo();
      renderPdf();
    }
  }

  async function removePdf(keep) {
    const removed = app.pdf.filter((x) => !keep(x));
    await savePdf(app.pdf.filter(keep));
    await dropShots(removed.map((x) => x.shot).filter(Boolean));
    renderPdf();
  }

  function pdfStatus(i) {
    return i.kind === "seo"
      ? { text: SEO_STATUS_LABEL[i.status] || i.status, cls: SEO_RESULT_CLASS[i.status] || "info" }
      : { text: STATUS_LABEL[i.status] || i.status, cls: i.status };
  }

  function shotThumb(key, name) {
    const img = el("img", { class: "pdf-thumb", alt: `${t("uiScreenshot")}: ${name}` });
    chrome.storage.session.get(key).then((d) => (d[key] ? (img.src = d[key]) : img.remove())).catch(() => img.remove());
    return el("div", { class: "pdf-shot" }, img);
  }

  function renderPdf() {
    const pages = pdfPages();
    const n = app.pdf.length;
    $("pdfTabCount").textContent = n ? String(n) : "";
    $("pdfTabCount").classList.toggle("d-none", !n);
    $("pdfEmpty").classList.toggle("d-none", !!n);
    $("downloadPdf").disabled = !n;
    $("clearPdf").disabled = !n;
    $("pdfSummary").textContent = n ? t("uiPdfSummary", [String(n), String(pages.length)]) : "";
    const list = $("pdfPages");
    list.textContent = "";
    for (const p of pages) {
      const det = el("details", { class: "group pdf-page", open: app.pdfOpen.has(p.url) });
      det.addEventListener("toggle", () => (det.open ? app.pdfOpen.add(p.url) : app.pdfOpen.delete(p.url)));
      det.append(el("summary", {}, el("span", { text: p.title || p.url }), " ", el("span", { class: "count", text: p.items.length })));
      det.append(el("div", { class: "pdf-page-url", text: p.url }));
      for (const i of p.items) {
        const status = pdfStatus(i);
        det.append(el("div", { class: `result status-${status.cls}` },
          el("div", { class: "result-head seo-static" },
            el("span", { class: `chip pdf-status pdf-status-${status.cls}`, text: status.text }),
            el("span", { class: "result-name", text: tf(i.name) }),
            el("span", { class: "spacer" }),
            el("button", { class: "btn btn-xs btn-link-danger", type: "button", "aria-label": `${t("uiRemove")}: ${tf(i.name)}`, onclick: () => removePdf((x) => x.id !== i.id) }, t("uiRemove")),
            i.message ? el("span", { class: "result-msg", text: tf(i.message) }) : null),
          i.shot ? shotThumb(i.shot, tf(i.name)) : null));
      }
      det.append(el("div", { class: "result-actions" },
        el("button", { class: "btn btn-xs btn-link-danger", type: "button", onclick: () => removePdf((x) => x.page.url !== p.url) }, t("uiRemovePage"))));
      list.append(det);
    }
  }

  // ---------------------------------------------------------------- visual aids

  function renderTools() {
    const make = (container, tools) => {
      container.textContent = "";
      for (const [name, label] of tools) {
        const on = !!app.aids[name];
        container.append(el("button", { class: `tool-btn${on ? " active" : ""}`, type: "button", "aria-pressed": String(on), onclick: () => toggleAid(name, !on) }, t(label)));
      }
    };
    make($("outlineTools"), OUTLINE_TOOLS);
  }

  async function toggleAid(tool, on) {
    const res = await send("qa:visualAid", { tool, on });
    const outlineMessage = (message) => {
      if (OUTLINE_STATUS[message]) return t(OUTLINE_STATUS[message]);
      const unknown = String(message || "").match(/^Unknown function: (.+)$/);
      return unknown ? t("uiUnknownOutline", [unknown[1]]) : message;
    };
    if (!res || res.ok === false) toast(outlineMessage(res && res.message) || t("uiCouldNotOutline"), "warning");
    else if (res.count !== undefined) toast(res.count === 1 ? t("uiOutlineCountOne", [outlineMessage(res.message)]) : t("uiOutlineCountMany", [outlineMessage(res.message), String(res.count)]));
    await refreshState();
    renderTools();
  }

  // ---------------------------------------------------------------- settings

  function renderSettings() {
    const s = app.settings;
    if (!s) return;
    document.querySelectorAll("[data-setting]").forEach((input) => {
      const k = input.dataset.setting;
      if (input.type === "checkbox") input.checked = !!s[k];
      else input.value = s[k] ?? "";
    });
    const presets = $("viewportPresets");
    presets.textContent = "";
    for (const p of U.VIEWPORT_PRESETS) {
      const on = s.viewports.includes(p.id);
      presets.append(el("div", { class: "viewport-row" },
        el("label", {}, el("input", { type: "checkbox", checked: on, onchange: (e) => {
          const set = new Set(app.settings.viewports);
          e.target.checked ? set.add(p.id) : set.delete(p.id);
          saveSettings({ viewports: U.VIEWPORT_PRESETS.map((x) => x.id).filter((id) => set.has(id)) });
        } }), ` ${VIEWPORT_LABEL[p.id] ? t(VIEWPORT_LABEL[p.id]) : p.label} — ${p.width}×${p.height}`)));
    }
    const custom = $("customViewports");
    custom.textContent = "";
    (s.customViewports || []).forEach((v, idx) => {
      const row = el("div", { class: "viewport-row" });
      const toggle = el("input", {
        type: "checkbox",
        checked: v.enabled !== false,
        onchange: (e) => {
          const list = app.settings.customViewports.slice();
          list[idx] = { ...list[idx], enabled: e.target.checked };
          saveSettings({ customViewports: list });
        },
      });
      row.append(el("label", {}, toggle, ` ${v.label || t("uiCustomViewport")} — ${v.width}×${v.height}`));
      row.append(el("button", {
        class: "btn btn-xs btn-link-danger",
        type: "button",
        onclick: async () => {
          const list = app.settings.customViewports.slice();
          list.splice(idx, 1);
          await saveSettings({ customViewports: list });
          renderSettings();
        },
      }, t("uiRemove")));
      custom.append(row);
    });
    renderExternalAccessAction();
  }

  async function renderExternalAccessAction() {
    const option = document.querySelector('[data-setting="checkExternalLinks"]');
    const row = $("externalAccessAction");
    if (!option || !row) return;
    const hasAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
    row.classList.toggle("d-none", !option.checked || hasAccess);
  }

  // ---------------------------------------------------------------- actions

  async function startScan(categories, extra = {}) {
    app.expanded.clear();
    app.scan = { status: "running", done: 0, total: categories.length, current: t("uiStarting") };
    renderProgress();
    const res = await send("qa:start", { categories, ...extra });
    if (!res || !res.ok) {
      app.scan = null;
      renderProgress();
      toast((res && res.message) || t("uiCouldNotStart"), "danger");
    }
  }

  function rerun(r) {
    if (r.category === "responsive" && r.viewport) {
      return runViewport({ label: r.viewport.label || t("uiViewport"), width: r.viewport.width, height: r.viewport.height, mobile: r.viewport.width < 1024 });
    }
    return startScan([r.category], { onlyTests: [r.sourceTest || r.testId], merge: true });
  }

  function runViewport(vp) {
    return startScan(["responsive"], { viewports: [vp], merge: true });
  }

  // Audit findings carry a raw status; search appearance targets already carry their label.
  function statusText(r) {
    return r.testId ? resultLabel(r).text : r.status;
  }

  async function highlight(r) {
    const lines = r.fix ? [`${t("uiFixPrefix")}: ${tf(r.fix)}`] : [];
    const res = await send("qa:highlight", { target: { ref: r.ref, selector: r.selector }, info: { title: tf(r.name), severity: SEVERITY_LABEL[r.severity] || r.severity, status: statusText(r), message: tf(r.message), lines, dismissLabel: t("uiDismissHighlight") } });
    if (!res || !res.ok) toast((res && res.message) || t("uiCouldNotHighlight"), "warning");
    else if (res.message) toast(res.message);
  }

  async function highlightAll(r) {
    const targets = r.instances.map((i) => ({ ref: i.ref, selector: i.selector, severity: r.severity, status: statusText(r), title: tf(r.name) }));
    const res = await send("qa:highlightMany", { targets });
    if (!res || !res.ok) toast((res && res.message) || t("uiCouldNotHighlightMany"), "warning");
    else toast(res.count === targets.length ? t("uiHighlightedCount", [String(res.count)]) : t("uiHighlightedPartial", [String(res.count), String(targets.length)]), res.count ? "info" : "warning");
  }

  function showView(name) {
    document.querySelectorAll(".view-tab").forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("d-none", v.id !== `view-${name}`));
    const opened = app.view !== name;
    app.view = name;
    if (opened) autoRunSeo();
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    document.querySelectorAll(".view-tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    $("runAll").addEventListener("click", () => startScan(CATEGORY_ORDER.slice(), { merge: false }));
    document.querySelectorAll("[data-seo-filter]").forEach((b) => b.addEventListener("click", () => setSeoFilter(app.seoFilter === b.dataset.seoFilter ? "" : b.dataset.seoFilter)));
    $("seoFilterStatus").addEventListener("change", (e) => setSeoFilter(e.target.value));
    $("seoResetFilters").addEventListener("click", () => setSeoFilter(""));
    $("cancelScan").addEventListener("click", async () => {
      const res = await send("qa:cancel");
      if (!res.ok) toast(res.message, "warning");
    });
    $("openSidePanel").addEventListener("click", async () => {
      try {
        await chrome.sidePanel.open({ tabId: app.tabId });
        window.close();
      } catch (e) {
        toast(t("uiCouldNotOpenPanel", [e.message]), "danger");
      }
    });
    const grant = async () => {
      const origin = pageOrigin();
      if (!origin) return;
      const ok = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      toast(ok ? t("uiAccessGranted", [origin]) : t("uiAccessDenied"), ok ? "info" : "warning");
      if (ok) await loadTab(await chrome.tabs.get(app.tabId));
    };
    $("grantAccess").addEventListener("click", grant);
    document.querySelectorAll("[data-filter-status]").forEach((b) => b.addEventListener("click", () => setFilter({ status: app.filters.status === b.dataset.filterStatus ? "" : b.dataset.filterStatus })));
    $("filterStatus").addEventListener("change", (e) => setFilter({ status: e.target.value }));
    $("filterSeverity").addEventListener("change", (e) => setFilter({ severity: e.target.value }));
    $("resetFilters").addEventListener("click", () => setFilter({ status: "", severity: "" }));

    $("selectShown").addEventListener("change", (e) => {
      if (!app.report) return;
      selectShown(filteredResults().map((r) => `a|${resultKey(r)}`), e.target.checked);
      renderResults();
    });
    $("seoSelectShown").addEventListener("change", (e) => {
      selectShown(seoShownChecks().map((c) => `s|${c.id}`), e.target.checked);
      renderSeo();
    });
    $("addSelected").addEventListener("click", addSelected);
    $("seoAddSelected").addEventListener("click", addSelected);
    $("downloadPdf").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("report.html?print=1") }));
    $("clearPdf").addEventListener("click", async () => {
      await savePdf([]);
      const all = await chrome.storage.session.get(null).catch(() => ({}));
      await dropShots(Object.keys(all).filter((k) => k.startsWith("pdfShot:")));
      renderPdf();
      toast(t("uiPdfCleared"));
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes[PDF_KEY]) return;
      app.pdf = (changes[PDF_KEY].newValue && changes[PDF_KEY].newValue.items) || [];
      renderPdf();
    });

    $("clearReport").addEventListener("click", async () => {
      await send("qa:clearHighlights");
      await send("qa:clearReport");
      await refreshState();
      renderAll();
    });

    $("resetAids").addEventListener("click", () => toggleAid("resetAll", false));
    document.querySelectorAll("[data-setting]").forEach((input) => input.addEventListener("change", async () => {
      const k = input.dataset.setting;
      let v;
      if (input.type === "checkbox") v = input.checked;
      else if (input.type === "number") {
        v = Math.max(Number(input.min) || 0, Math.min(Number(input.max) || 1e6, Math.round(Number(input.value) || 0)));
        input.value = v;
      } else v = input.value.trim().slice(0, 60) || (k === "searchQuery" ? "test" : "");
      if (k === "checkExternalLinks" && v) {
        const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
        if (!ok) {
          input.checked = false;
          await saveSettings({ [k]: false });
          await renderExternalAccessAction();
          toast(t("uiExternalPermissionNeeded"), "warning");
          return;
        }
      }
      if (k === "checkExternalLinks" && !v) await chrome.permissions.remove({ origins: ["<all_urls>"] }).catch(() => {});
      await saveSettings({ [k]: v });
      if (k === "checkExternalLinks") await renderExternalAccessAction();
    }));
    $("grantExternalAccess").addEventListener("click", async () => {
      const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
      if (ok) {
        const option = document.querySelector('[data-setting="checkExternalLinks"]');
        option.checked = true;
        await saveSettings({ checkExternalLinks: true });
      }
      await renderExternalAccessAction();
      toast(ok ? t("uiExternalGranted") : t("uiExternalDenied"), ok ? "info" : "warning");
    });
    $("customViewportForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const width = Math.round(Number($("customWidth").value));
      const height = Math.round(Number($("customHeight").value));
      if (!(width >= 200 && width <= 3840 && height >= 200 && height <= 2160)) {
        toast(t("uiViewportRangeError"), "warning");
        return;
      }
      const label = $("customLabel").value.trim().slice(0, 20) || t("uiCustomViewport");
      const list = (app.settings.customViewports || []).filter((v) => !(v.width === width && v.height === height));
      list.push({ label, width, height, enabled: true });
      await saveSettings({ customViewports: list.slice(-10) });
      e.target.reset();
      renderSettings();
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.tabId !== app.tabId) return;
      if (msg.type === "qa:progress") {
        const wasRunning = scanning();
        if (msg.scan.status === "running" && !wasRunning) app.expanded.clear();
        app.scan = msg.scan;
        renderProgress();
        if (msg.scan.status !== "running" && (wasRunning || msg.scan.status !== "running")) {
          refreshState().then(() => {
            renderAll();
            if (msg.scan.status === "error") toast(msg.scan.error, "danger");
          });
        }
      } else if (msg.type === "qa:cleared") {
        app.expanded.clear();
        app.openGroups.clear();
        app.seoExpanded.clear();
        app.seoOpenGroups.clear();
        app.seoFilter = "";
        app.seoProgress = null;
        app.shown = {};
        app.selected.clear();
        loadTab(app.tab);
      }
    });

    if (isPanel) {
      chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
        const win = await chrome.windows.getCurrent();
        if (windowId === win.id) loadTab(await chrome.tabs.get(tabId));
      });
      chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
        if (tabId === app.tabId && (info.status === "complete" || info.url)) loadTab(tab);
      });
    }
  }

  // ---------------------------------------------------------------- consent

  function showConsent(on) {
    $("consent").classList.toggle("d-none", !on);
    $("appBody").classList.toggle("d-none", on);
  }

  async function openDashboard() {
    showConsent(false);
    // popup.html?tabId=N opens the dashboard for a specific tab (used when the dashboard is opened as a page).
    const forced = Number(new URLSearchParams(location.search).get("tabId"));
    const tab = forced ? await chrome.tabs.get(forced).catch(() => null) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    await loadPdf();
    renderPdf();
    await loadTab(tab);
  }

  function bindConsent() {
    $("acceptConsent").addEventListener("click", async () => {
      const res = await send("qa:setConsent", { accepted: true });
      if (!res || !res.ok) return toast((res && res.message) || t("uiCouldNotSaveChoice"), "danger");
      app.consented = true;
      await openDashboard();
    });
    $("declineConsent").addEventListener("click", () => {
      toast(t("uiNothingRead"));
      setTimeout(() => window.close(), 1500);
    });
    $("withdrawConsent").addEventListener("click", async () => {
      const res = await send("qa:setConsent", { accepted: false });
      if (!res || !res.ok) return toast((res && res.message) || t("uiCouldNotWithdraw"), "danger");
      app.consented = false;
      Object.assign(app, { report: null, scan: null, seo: null, seoProgress: null, aids: {}, pdf: [] });
      app.selected.clear();
      renderPdf();
      showConsent(true);
      toast(t("uiConsentWithdrawn"));
    });
  }

  async function init() {
    localizeDocument();
    bind();
    bindConsent();
    const res = await send("qa:getConsent");
    app.consented = !!(res && res.accepted);
    if (app.consented) await openDashboard();
    else showConsent(true);
  }

  init().catch((e) => toast(t("uiDashboardFailed", [e.message]), "danger"));
})();
