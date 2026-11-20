// Layout & visual inspection tests. Uses computed styles and real bounding rectangles only.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;

  const TEXT_LEAF_RE = /^(p|h[1-6]|li|dt|dd|td|th|label|button|a|span|strong|em|small|blockquote|figcaption|caption|legend|summary|div)$/;

  function hasDirectText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
    return false;
  }

  // Truncation by line-clamp is a design decision, even when the box is shorter than the clamped lines.
  // The clamp may sit on a wrapper of the text element, so a few ancestors are checked too.
  function lineClamped(el) {
    for (let n = el, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      const cs = getComputedStyle(n);
      const v = cs.webkitLineClamp || cs.getPropertyValue("line-clamp");
      if (v && v !== "none") return true;
    }
    return false;
  }

  function docSize() {
    const de = document.documentElement;
    const b = document.body;
    return {
      scrollWidth: Math.max(de.scrollWidth, b ? b.scrollWidth : 0),
      scrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
      clientWidth: de.clientWidth,
      clientHeight: de.clientHeight,
    };
  }

  function overflowFix(el, cs) {
    const tips = [];
    if (/px$/.test(cs.width) && el.style && el.style.width) tips.push("replace the fixed inline width with max-width: 100%");
    if (parseFloat(cs.minWidth) > document.documentElement.clientWidth) tips.push(`min-width (${cs.minWidth}) is wider than the viewport`);
    if (el.localName === "img" || el.localName === "video" || el.localName === "iframe") tips.push("add max-width: 100%; height: auto");
    if (cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre") tips.push(`white-space: ${cs.whiteSpace} prevents wrapping`);
    if (cs.display === "flex" && cs.flexWrap === "nowrap") tips.push("flex container does not wrap (flex-wrap: nowrap)");
    if (cs.display === "grid") tips.push(`check grid-template-columns (${cs.gridTemplateColumns.slice(0, 60)})`);
    tips.push("constrain the element with max-width/min-width: 0, allow wrapping, or move it into a horizontally scrollable wrapper");
    return tips.join("; ");
  }

  // ---------------------------------------------------------------- tests

  async function horizontalOverflow(ctx) {
    const ds = docSize();
    const vw = ds.clientWidth;
    const csHtml = getComputedStyle(document.documentElement);
    const csBody = getComputedStyle(document.body);
    const clippedByRoot = /hidden|clip/.test(csHtml.overflowX) || /hidden|clip/.test(csBody.overflowX);
    const pageScrolls = ds.scrollWidth > vw + 1 && !clippedByRoot;

    const { list } = h.allElements();
    const culprits = [];
    for (const el of list) {
      await ctx.tick();
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const left = r.left + scrollX;
      const right = r.right + scrollX;
      const over = Math.max(0, right - vw, -left);
      if (over <= 1) continue;
      if (!h.isRendered(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" && (r.right <= 0 || r.left >= innerWidth)) continue; // off-canvas drawer
      if (h.isVisuallyHiddenPattern(el, cs)) continue;
      const clip = h.horizontalClipAncestor(el);
      if (clip && clip.el !== document.body) continue; // contained by a scroller / clipping wrapper (carousels etc.)
      if (h.isIntentionallyOffscreen(el)) continue;
      culprits.push({ el, cs, over, left, right });
    }
    // Only report the outermost culprit of each subtree.
    const set = new Set(culprits.map((c) => c.el));
    const top = culprits.filter((c) => {
      for (let p = c.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    top.sort((a, b) => b.over - a.over);

    if (pageScrolls) {
      ctx.add({
        element: document.documentElement,
        status: "failed",
        severity: "high",
        verification: "verified",
        message: `The page scrolls horizontally: document is ${ds.scrollWidth}px wide in a ${vw}px viewport.`,
        actual: `document scrollWidth ${ds.scrollWidth}px`,
        expected: `≤ ${vw}px (no horizontal scrolling)`,
        evidence: { documentWidth: ds.scrollWidth, viewportWidth: vw, culprits: top.length },
        fix: top.length ? `Fix the ${Math.min(top.length, 25)} listed element(s) that extend past the viewport.` : "Find the element extending past the right edge (often 100vw + scrollbar, negative margins or wide fixed widths).",
      });
    } else if (clippedByRoot && top.length) {
      ctx.limitation("Root overflow-x is hidden/clip, so overflowing content is cut off rather than scrollable.");
    }

    for (const c of top.slice(0, 25)) {
      const r = c.el.getBoundingClientRect();
      ctx.add({
        testId: "layout.outside-viewport",
        name: "Element extends outside the viewport",
        element: c.el,
        status: pageScrolls ? "failed" : "warning",
        severity: pageScrolls ? "high" : "medium",
        verification: "verified",
        message: pageScrolls
          ? `Extends ${Math.round(c.over)}px beyond the viewport and causes horizontal scrolling.`
          : `Extends ${Math.round(c.over)}px beyond the viewport; the part outside is cut off by overflow-x on the root.`,
        actual: `left ${Math.round(c.left)}px, right ${Math.round(c.right)}px, width ${Math.round(r.width)}px`,
        expected: `within 0–${vw}px`,
        evidence: {
          computedWidth: c.cs.width,
          minWidth: c.cs.minWidth,
          maxWidth: c.cs.maxWidth,
          position: c.cs.position,
          display: c.cs.display,
          whiteSpace: c.cs.whiteSpace,
          viewportWidth: vw,
        },
        fix: overflowFix(c.el, c.cs),
      });
    }
    return { evidence: { documentWidth: ds.scrollWidth, viewportWidth: vw }, message: `Document width ${ds.scrollWidth}px fits the ${vw}px viewport.` };
  }

  async function textClipping(ctx) {
    const { list } = h.allElements();
    for (const el of list) {
      await ctx.tick();
      if (!TEXT_LEAF_RE.test(el.localName) || !hasDirectText(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents") continue;
      if (!h.isVisible(el) || h.isVisuallyHiddenPattern(el, cs) || h.isAriaHidden(el)) continue;
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
      const hClip = /hidden|clip/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
      const vClip = /hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + Math.max(4, lineH * 0.5);
      if (!hClip && !vClip) continue;
      if (lineClamped(el)) continue;
      if (hClip && cs.textOverflow === "ellipsis") continue;
      const r = el.getBoundingClientRect();
      ctx.add({
        element: el,
        status: "failed",
        severity: "medium",
        verification: "verified",
        message: `Text is clipped by overflow: ${hClip ? `${el.scrollWidth - el.clientWidth}px horizontally` : ""}${hClip && vClip ? " and " : ""}${vClip ? `${el.scrollHeight - el.clientHeight}px vertically` : ""}.`,
        actual: `content ${el.scrollWidth}×${el.scrollHeight}px, box ${el.clientWidth}×${el.clientHeight}px (${Math.round(r.width)}×${Math.round(r.height)} rendered)`,
        expected: "All text visible inside its box",
        evidence: { overflowX: cs.overflowX, overflowY: cs.overflowY, height: cs.height, whiteSpace: cs.whiteSpace, fontSize: cs.fontSize, lineHeight: cs.lineHeight },
        fix: vClip ? "Remove the fixed height/max-height or use min-height so the box grows with its text." : "Allow wrapping (white-space: normal, overflow-wrap: anywhere) or add text-overflow: ellipsis with a full-text alternative.",
      });
    }
  }

  async function textOverflow(ctx) {
    const { list } = h.allElements();
    for (const el of list) {
      await ctx.tick();
      if (!hasDirectText(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents" || cs.overflowX !== "visible") continue;
      if (el.scrollWidth <= el.clientWidth + 2) continue;
      if (!h.isVisible(el) || h.isVisuallyHiddenPattern(el, cs)) continue;
      const r = el.getBoundingClientRect();
      let maxRight = 0;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tr = range.getBoundingClientRect();
        maxRight = Math.max(maxRight, tr.right);
      }
      const spill = maxRight - r.right;
      if (spill <= 3) continue;
      ctx.add({
        element: el,
        status: "failed",
        severity: "medium",
        verification: "verified",
        message: `Text spills ${Math.round(spill)}px outside its container (usually a long word, URL or white-space: nowrap).`,
        actual: `text extends to x=${Math.round(maxRight)}px, box ends at x=${Math.round(r.right)}px`,
        expected: "Text wraps inside the box",
        evidence: { whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak, width: cs.width },
        fix: "Add overflow-wrap: anywhere (or word-break: break-word) and avoid white-space: nowrap on long text.",
      });
    }
  }

  async function collapsedContent(ctx) {
    const { list } = h.allElements();
    const controlled = new Set();
    document.querySelectorAll('[aria-expanded="false"][aria-controls]').forEach((t) => t.getAttribute("aria-controls").split(/\s+/).forEach((id) => controlled.add(id)));
    for (const el of list) {
      await ctx.tick();
      if (!/^(video|iframe|canvas|object|embed|p|h[1-6]|button|section|article|main|ul|ol|table|form|div)$/.test(el.localName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) continue;
      if (!h.isRendered(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "contents" || cs.position === "absolute" || cs.position === "fixed") continue;
      if (h.isAriaHidden(el) || (el.id && controlled.has(el.id))) continue;
      const media = /^(video|iframe|canvas|object|embed)$/.test(el.localName);
      // With overflow: visible the content still paints outside a zero-size box, so it is not hidden.
      if (!media && !(/hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(cs.overflowY))) continue;
      if (!media && (el.textContent || "").trim().length <= 2) continue;
      // Collapsed accordions/details are intentional.
      if (el.closest("details:not([open])") || el.closest('[aria-hidden="true"], [hidden]')) continue;
      const ancestorCollapsed = (() => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const pr = p.getBoundingClientRect();
          if (pr.width === 0 || pr.height === 0) return true;
        }
        return false;
      })();
      if (ancestorCollapsed) continue; // report only the outermost collapsed box
      ctx.add({
        element: el,
        status: "warning",
        severity: "medium",
        verification: "inferred",
        message: `Element has content but renders at ${Math.round(r.width)}×${Math.round(r.height)}px, so its content is not visible.`,
        actual: `${Math.round(r.width)}×${Math.round(r.height)}px`,
        expected: "Non-zero size when the content is meant to be visible",
        evidence: { display: cs.display, height: cs.height, maxHeight: cs.maxHeight, width: cs.width, overflow: cs.overflow },
        fix: "If the content should be visible, remove height/max-height: 0 or the zero width; if it is a collapsed panel, mark it with hidden/aria-hidden or aria-expanded on its toggle.",
      });
    }
  }

  async function overlappingSiblings(ctx) {
    const containers = new Set();
    const modal = h.openModal();
    if (modal) ctx.limitation(`A modal is open (${h.cssPath(modal)}): overlap and fixed-element checks looked only inside it, not at the page behind it. Close the modal and rescan to check the page.`);
    const { list } = h.allElements(modal || document.body);
    if (modal && modal.children.length >= 2) containers.add(modal);
    for (const el of list) {
      if (el.children.length >= 2 && el.children.length <= 60) containers.add(el);
    }
    let checked = 0;
    for (const parent of containers) {
      await ctx.tick();
      if (checked++ > 1500) {
        ctx.limitation("Overlap check limited to the first 1500 containers.");
        break;
      }
      const pcs = getComputedStyle(parent);
      if (pcs.display === "none" || pcs.display === "contents") continue;
      const kids = [];
      for (const c of parent.children) {
        const cs = getComputedStyle(c);
        if (cs.position === "absolute" || cs.position === "fixed" || cs.display === "none" || cs.display === "contents") continue;
        if (cs.transform !== "none" || cs.float !== "none") continue;
        const r = c.getBoundingClientRect();
        if (r.width < 24 || r.height < 12) continue;
        if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
        kids.push({ c, r, cs });
      }
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].r;
          const b = kids[j].r;
          const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ix <= 2 || iy <= 2) continue;
          const area = ix * iy;
          const smaller = Math.min(a.width * a.height, b.width * b.height);
          if (area < 64 || area / smaller < 0.1) continue;
          const negMargin = [kids[i].cs, kids[j].cs].some((cs) => /^-/.test(cs.marginTop) || /^-/.test(cs.marginLeft) || /^-/.test(cs.marginRight) || /^-/.test(cs.marginBottom));
          if (negMargin && smaller < 64 * 64) continue; // avatar stacks and similar deliberate overlaps
          ctx.add({
            element: kids[j].c,
            status: "warning",
            severity: "medium",
            verification: negMargin ? "inferred" : "verified",
            message: `Overlaps its sibling ${h.cssPath(kids[i].c)} by ${Math.round(ix)}×${Math.round(iy)}px (${Math.round((area / smaller) * 100)}% of the smaller box).`,
            actual: `intersection ${Math.round(ix)}×${Math.round(iy)}px`,
            expected: "In-flow siblings do not overlap",
            evidence: { sibling: h.cssPath(kids[i].c), parentDisplay: pcs.display, negativeMargin: negMargin, siblingRect: h.rectOf(kids[i].c) },
            fix: negMargin ? "Check whether the negative margin is intentional." : "Look for fixed heights with overflowing content, grid items placed in the same cell, or line-height/height mismatches.",
          });
        }
      }
    }
  }

  async function contentOverflowFixedHeight(ctx) {
    const { list } = h.allElements(h.openModal() || document.body);
    for (const el of list) {
      await ctx.tick();
      if (el.children.length === 0 && !hasDirectText(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "visible" || cs.display === "inline" || cs.display === "contents") continue;
      if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight === 0) continue;
      if (!h.isVisible(el) || lineClamped(el)) continue;
      // Only interesting when the spill lands on the next sibling.
      const next = el.nextElementSibling;
      if (!next || !h.isVisible(next)) continue;
      const r = el.getBoundingClientRect();
      const nr = next.getBoundingClientRect();
      const spillBottom = r.top + el.scrollHeight;
      if (!(nr.top < spillBottom - 2 && nr.top >= r.bottom - 2)) continue;
      ctx.add({
        element: el,
        status: "failed",
        severity: "medium",
        verification: "verified",
        message: `Content is ${el.scrollHeight - el.clientHeight}px taller than this box and spills onto the following element.`,
        actual: `content height ${el.scrollHeight}px, box height ${el.clientHeight}px`,
        expected: "Box grows with content or content fits",
        evidence: { height: cs.height, maxHeight: cs.maxHeight, nextElement: h.cssPath(next) },
        fix: "Replace height with min-height, or allow the content to wrap/shrink.",
      });
    }
  }

  function fixedBars(modalInfo = h.modalInfo()) {
    const bars = [];
    const isModalPart = (el) => modalInfo && [modalInfo.root, modalInfo.backdrop].some((m) => m && (m === el || m.contains(el) || el.contains(m)));
    for (const el of document.querySelectorAll("body *")) {
      if (h.isOwnNode(el) || isModalPart(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed") continue;
      if (!h.isVisible(el) || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      bars.push({ el, cs, r });
    }
    return bars;
  }

  async function obscuredByFixed(ctx) {
    const modal = h.modalInfo();
    if (modal) return { skipped: "A modal is open; the page behind it is covered by design. Close the modal and rescan to check fixed header/footer overlap." };
    const bars = fixedBars(modal).filter(({ r }) => r.width >= innerWidth * 0.5 && r.height < innerHeight * 0.5);
    const topBars = bars.filter(({ r }) => r.top <= 1);
    const bottomBars = bars.filter(({ r }) => r.bottom >= innerHeight - 1);
    if (!topBars.length && !bottomBars.length) return { message: "No full-width fixed header/footer bars found." };
    const topH = Math.max(0, ...topBars.map((b) => b.r.bottom));
    const bottomH = Math.max(0, ...bottomBars.map((b) => innerHeight - b.r.top));
    const docH = docSize().scrollHeight;
    const inBar = (el) => bars.some((b) => b.el.contains(el) || el.contains(b.el));
    const candidates = document.querySelectorAll("h1,h2,h3,p,img,button,a[href],input,select,textarea,[role=button]");
    for (const el of candidates) {
      await ctx.tick();
      if (inBar(el) || !h.isVisible(el) || h.isVisuallyHiddenPattern(el)) continue;
      const r = el.getBoundingClientRect();
      const docTop = r.top + scrollY;
      const docBottom = r.bottom + scrollY;
      let which = null;
      let overlap = 0;
      if (topH && docTop < topH - 2 && docBottom > 0) {
        which = "header";
        overlap = Math.min(topH, docBottom) - docTop;
      } else if (bottomH && docBottom > docH - bottomH + 2) {
        which = "footer";
        overlap = docBottom - (docH - bottomH);
      }
      if (!which || overlap < Math.min(8, r.height / 2)) continue;
      const bar = which === "header" ? topBars[0] : bottomBars[0];
      ctx.add({
        element: el,
        status: "failed",
        severity: el.matches("button,a[href],input,select,textarea,[role=button]") ? "high" : "medium",
        verification: "inferred",
        message: `Can never be fully scrolled out from under the fixed ${which} (${Math.round(which === "header" ? topH : bottomH)}px); ${Math.round(overlap)}px stays covered.`,
        actual: `element spans ${Math.round(docTop)}–${Math.round(docBottom)}px of a ${docH}px document`,
        expected: `content starts below ${Math.round(topH)}px / ends above ${Math.round(docH - bottomH)}px`,
        evidence: { fixedElement: h.cssPath(bar.el), fixedHeight: Math.round(bar.r.height), documentHeight: docH },
        fix: which === "header" ? "Add padding-top (or scroll-padding-top) equal to the header height to the page body." : "Add padding-bottom equal to the fixed footer height to the page body.",
      });
    }
  }

  async function overlaysBeyondViewport(ctx) {
    const sel = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal="true"], [role=menu], [role=listbox], [role=tooltip], [popover]';
    for (const el of document.querySelectorAll(sel)) {
      await ctx.tick();
      if (!h.isVisible(el) || h.isAriaHidden(el)) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      const out = {
        top: Math.max(0, -r.top),
        left: Math.max(0, -r.left),
        right: Math.max(0, r.right - document.documentElement.clientWidth),
        bottom: Math.max(0, r.bottom - innerHeight),
      };
      const fixed = cs.position === "fixed" || el.matches("dialog:modal");
      const scrollsInside = h.isScrollContainer(el, cs);
      const horiz = out.left + out.right > 2;
      const vert = out.top + out.bottom > 2;
      if (!horiz && !(vert && fixed)) continue;
      if (vert && !horiz && scrollsInside) continue;
      ctx.add({
        element: el,
        status: "failed",
        severity: el.matches('dialog, [role=dialog], [role=alertdialog], [aria-modal="true"]') ? "high" : "medium",
        verification: "verified",
        message: `Open ${el.getAttribute("role") || el.localName} extends beyond the viewport (top ${Math.round(out.top)}px, right ${Math.round(out.right)}px, bottom ${Math.round(out.bottom)}px, left ${Math.round(out.left)}px); that part cannot be reached${fixed ? " because it is fixed-positioned" : ""}.`,
        actual: `${Math.round(r.width)}×${Math.round(r.height)}px at (${Math.round(r.left)}, ${Math.round(r.top)})`,
        expected: `fits within ${document.documentElement.clientWidth}×${innerHeight}px or scrolls internally`,
        evidence: { position: cs.position, maxHeight: cs.maxHeight, overflowY: cs.overflowY, overflowBy: out },
        fix: "Constrain with max-width/max-height (e.g. calc(100vh - 2rem)) and overflow: auto; flip/shift dropdowns that would open off-screen.",
      });
    }
  }

  const TESTS = [
    { id: "layout.horizontal-overflow", name: "Horizontal page overflow", run: horizontalOverflow },
    { id: "layout.text-clipped", name: "Text clipped by its container", run: textClipping, pass: "No clipped text found." },
    { id: "layout.text-overflow", name: "Text overflowing its container", run: textOverflow, pass: "No text spilling outside its box." },
    { id: "layout.collapsed-content", name: "Content collapsed to zero size", run: collapsedContent, pass: "No visible content collapsed to zero size." },
    { id: "layout.overlapping-siblings", name: "Overlapping in-flow elements", run: overlappingSiblings, pass: "No overlapping in-flow siblings." },
    { id: "layout.content-overflow-fixed-height", name: "Content overflowing a fixed-height box", run: contentOverflowFixedHeight, pass: "No fixed-height boxes spilling onto neighbours." },
    { id: "layout.obscured-by-fixed", name: "Content obscured by fixed header/footer", run: obscuredByFixed, pass: "No content permanently hidden behind fixed bars." },
    { id: "layout.overlay-beyond-viewport", name: "Dialogs/menus beyond the viewport", run: overlaysBeyondViewport, pass: "Open dialogs, menus and popovers fit the viewport." },
  ];

  QA.register("layout", {
    label: "Layout",
    tests: TESTS,
  });
  QA.layoutTests = Object.fromEntries(TESTS.map((t) => [t.id, t]));
})();
