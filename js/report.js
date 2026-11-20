// Printable report for the findings collected in the dashboard's PDF report list. Opened with ?print=1 it
// shows the browser's print window straight away, where "Save as PDF" writes the file.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const t = (key, subs) => (subs === undefined ? chrome.i18n.getMessage(key) : chrome.i18n.getMessage(key, subs)) || key;
  const tf = (value) => (typeof value === "string" && self.__findingText ? self.__findingText(value) : value);

  const PDF_KEY = "pdfReport";
  const CATEGORY_LABEL = {
    layout: "uiCategoryLayout", responsive: "uiCategoryResponsive", images: "uiCategoryImages",
    links: "uiCategoryLinks", interactions: "uiCategoryInteractions", forms: "uiCategoryForms",
    search: "uiCategorySearch", accessibility: "uiCategoryAccessibility", elements: "uiCategoryElements",
    seo: "uiTabSearchAppearance",
  };
  const SEVERITY_LABEL = { critical: "uiSeverityCritical", high: "uiSeverityHigh", medium: "uiSeverityMedium", low: "uiSeverityLow", info: "uiSeverityInfo" };
  const AUDIT_STATUS = { failed: "uiIssueFound", warning: "uiPossibleIssue", manual: "uiReviewManually", passed: "uiNoIssueFound" };
  const SEO_STATUS = { issue: "uiIssueFound", warning: "uiPossibleIssue", skipped: "uiCouldntCompare", passed: "uiNoIssueFound" };
  const SEO_CLASS = { issue: "failed", warning: "warning", skipped: "skipped", passed: "passed" };
  const CLASS_LABEL = { failed: "uiIssueFound", warning: "uiPossibleIssue", manual: "uiReviewManually", skipped: "uiCouldntCompare", passed: "uiNoIssueFound" };
  const ORDER = ["failed", "warning", "manual", "skipped", "passed"];
  const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }

  function statusOf(i) {
    if (i.kind === "seo") return { cls: SEO_CLASS[i.status] || "skipped", text: t(SEO_STATUS[i.status] || "uiCouldntCompare") };
    return { cls: i.status, text: t(AUDIT_STATUS[i.status] || "uiPossibleIssue") };
  }

  function sortItems(items) {
    const rank = (list, v) => (list.indexOf(v) < 0 ? list.length : list.indexOf(v));
    return items.slice().sort((a, b) => rank(ORDER, statusOf(a).cls) - rank(ORDER, statusOf(b).cls) || rank(SEVERITY_ORDER, a.severity) - rank(SEVERITY_ORDER, b.severity));
  }

  function counts(items) {
    const box = el("div", { class: "counts" });
    for (const cls of ORDER) {
      const n = items.filter((i) => statusOf(i).cls === cls).length;
      if (n) box.append(el("span", { class: `count st-${cls}`, text: `${t(CLASS_LABEL[cls])}: ${n}` }));
    }
    return box;
  }

  function finding(i, shots) {
    const status = statusOf(i);
    const rows = el("dl");
    const add = (label, value, cls) => {
      if (value === null || value === undefined || value === "") return;
      rows.append(el("dt", { text: label }), value.nodeType ? value : el("dd", { class: cls, text: value }));
    };
    if (i.kind === "seo") add(t("uiValue"), tf(i.value));
    if (i.selector) add(t("uiLocator"), el("dd", {}, el("code", { text: i.selector })));
    add(t("uiActual"), tf(i.actual));
    add(t("uiExpected"), tf(i.expected));
    add(t("uiSuggestedFix"), tf(i.fix), "fix");
    if (i.viewport) add(t("uiViewport"), `${i.viewport.width}×${i.viewport.height}${i.viewport.label ? ` (${i.viewport.label})` : ""}`);
    if (i.occurrences > 1) add(t("uiRepeated"), t("uiRepeatedExplanation", [String(i.occurrences)]));
    if (i.kind === "seo" && i.total) add(t("uiAffected"), t("uiElementCount", [String(i.total), ""]));
    if (i.locations && i.locations.length > (i.kind === "seo" ? 0 : 1)) {
      const list = el("ol");
      for (const loc of i.locations) {
        if (typeof loc === "string") list.append(el("li", {}, el("code", { text: loc })));
        else list.append(el("li", {}, el("code", { text: loc.selector }), loc.count > 1 ? ` ×${loc.count}` : "", loc.label ? el("div", { text: tf(loc.label) }) : null));
      }
      add(t("uiAllLocations"), el("dd", {}, list));
    }
    return el("article", { class: `finding st-${status.cls}` },
      el("div", { class: "head" },
        el("span", { class: "chip status", text: status.text }),
        i.severity && i.kind !== "seo" ? el("span", { class: "chip", text: t(SEVERITY_LABEL[i.severity] || "uiSeverityInfo") }) : null,
        el("span", { class: "chip", text: t(CATEGORY_LABEL[i.category] || "uiGeneral") })),
      el("h3", { text: tf(i.name) }),
      i.message ? el("p", { text: tf(i.message) }) : null,
      i.shot && shots[i.shot] ? el("figure", { class: "shot" }, el("img", { src: shots[i.shot], alt: `${t("uiScreenshot")}: ${tf(i.name)}` })) : null,
      rows.childElementCount ? rows : null);
  }

  function render(items, shots) {
    const root = $("report");
    root.textContent = "";
    const pages = new Map();
    for (const i of items) {
      if (!pages.has(i.page.url)) pages.set(i.page.url, { url: i.page.url, title: i.page.title, items: [] });
      pages.get(i.page.url).items.push(i);
    }
    root.append(
      el("h1", { text: t("uiReportTitle") }),
      el("p", { class: "meta", text: `${t("extensionName")} · ${t("uiGeneratedAt", [new Date().toLocaleString()])}` }),
      el("p", { class: "meta", text: t("uiPdfSummary", [String(items.length), String(pages.size)]) }),
      counts(items));
    for (const p of pages.values()) {
      root.append(el("section", { class: "page" },
        el("h2", { text: p.title || p.url }),
        el("div", { class: "url", text: p.url }),
        counts(p.items),
        sortItems(p.items).map((i) => finding(i, shots))));
    }
  }

  async function init() {
    document.documentElement.lang = (chrome.i18n.getUILanguage() || "en").replace("_", "-");
    document.querySelectorAll("[data-i18n]").forEach((node) => (node.textContent = t(node.dataset.i18n)));
    // Chrome suggests the document title as the PDF file name.
    document.title = `${t("uiReportTitle")} ${new Date().toISOString().slice(0, 10)}`;
    $("print").addEventListener("click", () => window.print());
    const data = await chrome.storage.session.get(PDF_KEY).catch(() => ({}));
    const items = (data[PDF_KEY] && data[PDF_KEY].items) || [];
    if (!items.length) {
      $("print").disabled = true;
      $("report").append(el("p", { class: "empty", text: t("uiPdfReportEmpty") }));
      return;
    }
    const keys = items.map((i) => i.shot).filter(Boolean);
    const shots = keys.length ? await chrome.storage.session.get(keys).catch(() => ({})) : {};
    render(items, shots);
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
    if (new URLSearchParams(location.search).get("print")) setTimeout(() => window.print(), 300);
  }

  init();
})();
