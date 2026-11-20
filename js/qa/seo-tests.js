// SEO tab: read-only DOM analysis of the current page. Not a scan category; called on demand by the SEO tab.
// Nothing is executed in or injected into the page's own JavaScript context.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const MAX_ITEMS = 200;
  const TITLE_MIN = 30;
  const TITLE_MAX = 65;
  const NON_TEXT = new Set(["script", "style", "noscript", "template", "head", "svg", "math", "iframe", "object", "canvas", "textarea", "select"]);
  const GTAG_SRC_RE = /\/\/(www\.)?googletagmanager\.com\/gtag\/js/i;
  const GTM_SRC_RE = /\/\/(www\.)?googletagmanager\.com\/gtm\.js/i;
  const GTAG_CALL_RE = /\bgtag\s*\(\s*['"](config|js)['"]/;
  const GTAG_ID_RE = /\bgtag\s*\(\s*['"]config['"]\s*,\s*['"]([^'"]+)['"]/g;

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const chars = (s) => [...s].length;

  function tagId(src) {
    try {
      return new URL(src, document.baseURI).searchParams.get("id");
    } catch {
      return null;
    }
  }

  // Locations of the offending elements, grouped like repeated results: elements whose selectors differ only by
  // position or numbers (one component used many times) form one group.
  function locate(els, label) {
    const groups = new Map();
    for (const el of els.slice(0, MAX_ITEMS)) {
      const selector = h.cssPath(el);
      const pattern = U.selectorPattern(selector);
      if (!groups.has(pattern)) groups.set(pattern, { pattern, count: 0, instances: [] });
      const g = groups.get(pattern);
      g.count++;
      g.instances.push({ selector, ref: h.refFor(el), label: label(el) });
    }
    return { total: els.length, listed: Math.min(els.length, MAX_ITEMS), groups: [...groups.values()] };
  }

  function linkCounts(anchors) {
    // Must classify links exactly like the "outlineExternalLinks" visual aid.
    let internal = 0;
    let external = 0;
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      let u;
      try {
        u = new URL(href, location.href);
      } catch {
        continue;
      }
      if (u.origin !== location.origin) external++;
      else internal++;
    }
    return { internal, external };
  }

  function pageTitle() {
    const el = [...document.getElementsByTagName("title")].find((t) => !t.closest("svg"));
    return el ? norm(el.textContent) : null;
  }

  function wordCount() {
    const main = [...document.querySelectorAll("main, [role='main']")].find((m) => h.isVisible(m));
    const root = main || document.body;
    if (!root) return { words: 0, scope: "none" };
    const hidden = new Map();
    const isHidden = (el) => {
      if (!el || el === root.parentElement) return false;
      if (hidden.has(el)) return hidden.get(el);
      const v = NON_TEXT.has(el.localName) || h.isOwnNode(el) || !h.isRendered(el) || h.isVisuallyHiddenPattern(el) || isHidden(el.parentElement);
      hidden.set(el, v);
      return v;
    };
    let words = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue;
      if (!text || !text.trim() || isHidden(n.parentElement)) continue;
      for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) words++;
    }
    return { words, scope: main ? "main" : "body" };
  }

  function googleTag() {
    const evidence = new Set();
    const ids = new Set();
    for (const s of document.scripts) {
      const src = s.getAttribute("src");
      if (src) {
        if (GTAG_SRC_RE.test(src)) {
          evidence.add("gtag.js script");
          if (tagId(src)) ids.add(tagId(src));
        } else if (GTM_SRC_RE.test(src)) {
          evidence.add("Google Tag Manager script (gtm.js)");
          if (tagId(src)) ids.add(tagId(src));
        }
        continue;
      }
      const text = (s.textContent || "").slice(0, 200000);
      if (GTAG_CALL_RE.test(text)) {
        evidence.add("gtag() initialization");
        for (const m of text.matchAll(GTAG_ID_RE)) ids.add(m[1]);
      }
    }
    // Covers tags loaded by another script whose <script> element is no longer in the DOM.
    for (const e of performance.getEntriesByType("resource")) {
      if (GTAG_SRC_RE.test(e.name)) evidence.add("gtag.js request");
      else if (GTM_SRC_RE.test(e.name)) evidence.add("gtm.js request");
    }
    return { found: evidence.size > 0, evidence: [...evidence], ids: [...ids] };
  }

  function ogImage() {
    const meta = document.querySelector('meta[property="og:image" i]');
    const content = meta ? (meta.getAttribute("content") || "").trim() : "";
    if (!content) return { present: false, content: "", url: null };
    let url = null;
    try {
      url = new URL(content, document.baseURI).href;
    } catch {}
    return { present: true, content, url };
  }

  function analyze() {
    const checks = [];
    const add = (id, name, status, value, detail, items) => checks.push({ id, name, status, value, detail: detail || "", items: items || null });
    const text = (el) => h.textSnippet(el, 80) || "(no text)";

    const h1s = [...document.getElementsByTagName("h1")];
    add("seo.h1-count", "H1 tag count", h1s.length === 1 ? "passed" : "issue", String(h1s.length),
      h1s.length === 0 ? "The page has no <h1>." : h1s.length > 1 ? "The page has more than one <h1>." : "",
      h1s.length > 1 ? locate(h1s, text) : null);

    const title = pageTitle();
    const titleLen = title ? chars(title) : 0;
    if (!title) add("seo.title-length", "Title tag length", "issue", "0 characters", title === null ? "The page has no <title> tag." : "The <title> tag is empty.");
    else add("seo.title-length", "Title tag length", titleLen >= TITLE_MIN && titleLen <= TITLE_MAX ? "passed" : "issue", `${titleLen} characters`,
      titleLen < TITLE_MIN ? `Shorter than ${TITLE_MIN} characters.` : titleLen > TITLE_MAX ? `Longer than ${TITLE_MAX} characters.` : "");

    const h1Text = h1s.length === 1 ? norm(h1s[0].textContent) : "";
    if (h1s.length !== 1 || !title || !h1Text) {
      const why = !title ? "the title is missing or empty" : h1s.length === 0 ? "the page has no <h1>" : h1s.length > 1 ? "the page has more than one <h1>" : "the <h1> is empty";
      add("seo.h1-title-similarity", "H1 and title similarity", "skipped", "Couldn't compare", `Couldn't compare because ${why}.`);
    } else {
      add("seo.h1-title-similarity", "H1 and title similarity", h1Text === title ? "issue" : "passed", h1Text === title ? "Identical" : "Different",
        h1Text === title ? "The <h1> text is identical to the <title>." : "");
    }

    const h2Count = document.getElementsByTagName("h2").length;
    add("seo.h2-exists", "H2 tag existence", h2Count ? "passed" : "issue", String(h2Count), h2Count ? "" : "The page has no <h2>.");

    const imgs = [...document.getElementsByTagName("img")].filter((el) => !h.isOwnNode(el));
    const imgsNoAlt = imgs.filter((el) => !el.hasAttribute("alt"));
    const noAlt = imgsNoAlt.length;
    add("seo.img-alt", "Image alt attributes", noAlt ? "issue" : "passed", `${noAlt} of ${imgs.length} missing`,
      noAlt ? `${noAlt} image(s) have no alt attribute.` : "",
      noAlt ? locate(imgsNoAlt, (el) => U.truncate(el.currentSrc || el.getAttribute("src") || "(no src)", 120)) : null);

    const anchors = [...document.getElementsByTagName("a")].filter((el) => !h.isOwnNode(el));
    const anchorsNoHref = anchors.filter((el) => !el.hasAttribute("href"));
    const noHref = anchorsNoHref.length;
    add("seo.a-href", "Anchor href attributes", noHref ? "issue" : "passed", `${noHref} of ${anchors.length} missing`,
      noHref ? `${noHref} anchor(s) have no href attribute.` : "",
      noHref ? locate(anchorsNoHref, text) : null);

    const gt = googleTag();
    add("seo.google-tag", "Google tag", gt.found ? "passed" : "warning", gt.found ? "Detected" : "Not detected",
      gt.found ? `${gt.evidence.join(", ")}${gt.ids.length ? ` · ID: ${gt.ids.join(", ")}` : ""}` : "No gtag.js script, Google tag request or gtag() configuration found.");

    const og = ogImage();
    add("seo.og-image", "Open Graph image", og.present ? "passed" : "issue", og.present ? "Present" : "Missing",
      og.present ? "" : 'No <meta property="og:image"> with a non-empty content attribute.');

    return {
      url: location.href,
      checks,
      info: { h3: document.getElementsByTagName("h3").length, ...wordCount(), links: linkCounts(anchors) },
      title,
      titleLength: titleLen,
      imageTotal: imgs.length,
      imageMissingAlt: noAlt,
      anchorTotal: anchors.length,
      anchorMissingHref: noHref,
      ogImage: og,
    };
  }

  QA.seo = { analyze };
})();
