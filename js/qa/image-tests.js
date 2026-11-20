// Image QA: loading, alternatives, geometry (distortion vs. intentional cropping), container fit, weight.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i;

  function resourceIndex() {
    const map = new Map();
    for (const e of performance.getEntriesByType("resource")) map.set(e.name, e);
    return map;
  }

  function sizeInfo(index, url) {
    if (!url) return { bytes: null, note: "no URL" };
    if (url.startsWith("data:")) return { bytes: Math.round((url.length - url.indexOf(",") - 1) * 0.75), note: "inline data URI (approximate)" };
    const e = index.get(url);
    if (!e) return { bytes: null, note: "not in Resource Timing (cached before page load, buffer full, or blob URL)" };
    const bytes = e.encodedBodySize || e.transferSize || 0;
    if (!bytes) return { bytes: null, note: "cross-origin without Timing-Allow-Origin — size not exposed to the page", status: e.responseStatus || null };
    return { bytes, decodedBytes: e.decodedBodySize || null, note: e.transferSize === 0 ? "served from cache" : "Resource Timing", status: e.responseStatus || null };
  }

  function contentBox(el, cs) {
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    return { width: Math.max(0, el.clientWidth - pl - pr), height: Math.max(0, el.clientHeight - pt - pb) };
  }

  function withTimeout(promise, ms, fallback) {
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  }

  async function settlePending(imgs) {
    const pending = imgs.filter((img) => !img.complete && img.loading !== "lazy" && (img.currentSrc || img.getAttribute("src")));
    if (!pending.length) return;
    await withTimeout(
      Promise.all(pending.map((img) => new Promise((res) => {
        img.addEventListener("load", res, { once: true });
        img.addEventListener("error", res, { once: true });
      }))),
      3000
    );
  }

  async function isBroken(img) {
    if (!img.complete) return null;
    if (img.naturalWidth > 0) return false;
    try {
      await withTimeout(img.decode(), 2000, "timeout");
      return false; // decodable but no intrinsic size (e.g. SVG without width/height)
    } catch {
      return true;
    }
  }

  function blockContainer(el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const d = getComputedStyle(p).display;
      if (d !== "inline" && d !== "contents" && p.localName !== "picture") return p;
      p = p.parentElement;
    }
    return p;
  }

  function probe(url) {
    return withTimeout(
      new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res({ ok: false });
        im.src = url;
      }),
      4000,
      { ok: null }
    );
  }

  async function run(ctx) {
    const index = resourceIndex();
    const imgs = [...document.images].filter((i) => !h.isOwnNode(i));
    const dpr = window.devicePixelRatio || 1;
    const inventory = [];
    ctx.extras.imageInventory = inventory;
    await settlePending(imgs);

    const tests = {
      broken: { id: "images.broken", name: "Broken or failed images", n: 0 },
      src: { id: "images.missing-src", name: "Images without a source", n: 0 },
      alt: { id: "images.missing-alt", name: "Missing alt attribute", n: 0 },
      emptyAlt: { id: "images.empty-alt-meaningful", name: "Empty alt on potentially meaningful image", n: 0 },
      altQuality: { id: "images.alt-quality", name: "Unhelpful alt text", n: 0 },
      zero: { id: "images.zero-size", name: "Images with zero rendered size", n: 0 },
      distorted: { id: "images.distorted", name: "Distorted (stretched/squashed) images", n: 0 },
      outside: { id: "images.outside-container", name: "Images extending outside their container", n: 0 },
      upscaled: { id: "images.upscaled", name: "Upscaled (blurry) images", n: 0 },
      oversized: { id: "images.oversized-source", name: "Oversized image sources", n: 0 },
      dims: { id: "images.missing-dimensions", name: "Missing width/height (layout shift risk)", n: 0 },
      tall: { id: "images.unexpectedly-large", name: "Unexpectedly large rendered images", n: 0 },
      bg: { id: "images.background-broken", name: "Broken CSS background images", n: 0 },
    };
    const add = (key, partial) => {
      tests[key].n++;
      ctx.add({ testId: tests[key].id, name: tests[key].name, ...partial });
    };

    for (const img of imgs) {
      await ctx.tick();
      const cs = getComputedStyle(img);
      const src = img.currentSrc || img.src || "";
      const rawSrc = img.getAttribute("src");
      const rendered = h.isRendered(img, cs);
      const r = img.getBoundingClientRect();
      const box = contentBox(img, cs);
      const size = sizeInfo(index, src);
      const lazyPending = !img.complete && (img.loading === "lazy");
      const entry = {
        src: U.truncate(src || rawSrc || "", 300),
        kind: "img",
        selector: h.cssPath(img),
        ref: h.refFor(img),
        natural: { width: img.naturalWidth, height: img.naturalHeight },
        rendered: { width: Math.round(box.width), height: Math.round(box.height) },
        objectFit: cs.objectFit,
        objectPosition: cs.objectPosition,
        fileSize: size.bytes,
        fileSizeNote: size.note,
        state: "loaded",
      };
      inventory.length < 300 && inventory.push(entry);

      // --- source & load state
      if (!rawSrc && !img.getAttribute("srcset") && !img.closest("picture")?.querySelector("source[srcset]")) {
        const lazyAttr = ["data-src", "data-lazy", "data-original", "data-srcset"].find((a) => img.hasAttribute(a));
        entry.state = lazyAttr ? "lazy placeholder" : "no source";
        if (!lazyAttr && rendered) {
          add("src", {
            element: img,
            status: "failed",
            severity: "medium",
            verification: "verified",
            message: "<img> has no src/srcset, so nothing can be displayed.",
            actual: "no src or srcset",
            expected: "a valid image URL",
            fix: "Provide a src (and srcset if responsive), or remove the element.",
          });
        }
        continue;
      }
      if (lazyPending) {
        entry.state = "lazy, not loaded yet";
        continue;
      }
      if (!img.complete) {
        entry.state = "still loading after 3s";
        ctx.limitation("Some images were still loading after 3 seconds and were not evaluated for load errors.");
        continue;
      }
      const broken = (size.status && size.status >= 400) || (await isBroken(img));
      if (broken) {
        entry.state = "broken";
        add("broken", {
          element: img,
          status: "failed",
          severity: r.width * r.height > 10000 ? "high" : "medium",
          verification: "verified",
          message: `Image failed to load${size.status ? ` (HTTP ${size.status})` : ""}.`,
          actual: `naturalWidth 0 after load; src ${U.truncate(src, 120)}`,
          expected: "image decodes successfully",
          evidence: { src, httpStatus: size.status || "unavailable" },
          fix: "Check the URL, file permissions, CORS/hotlink protection and the image format.",
        });
        continue;
      }

      // --- alternatives
      const decorative = img.getAttribute("role") === "presentation" || img.getAttribute("role") === "none" || h.isAriaHidden(img);
      const tiny = (img.naturalWidth <= 2 && img.naturalHeight <= 2) || (rendered && r.width <= 2 && r.height <= 2);
      const named = img.getAttribute("aria-label") || img.getAttribute("aria-labelledby") || img.getAttribute("title");
      if (!decorative && !tiny && !img.hasAttribute("alt") && !named) {
        const inNamedControl = (() => {
          const c = img.closest("a[href], button");
          if (!c) return false;
          return (c.innerText || "").trim().length > 0;
        })();
        add("alt", {
          element: img,
          status: "failed",
          severity: inNamedControl ? "low" : "medium",
          verification: "verified",
          message: "Image has no alt attribute; screen readers may announce the file name.",
          actual: "alt attribute missing",
          expected: 'alt="description" for meaningful images, alt="" for decorative ones',
          evidence: { src },
          fix: inNamedControl ? 'The surrounding control already has text; add alt="" so the image is ignored.' : "Add an alt text describing the image's purpose, or alt=\"\" if it is purely decorative.",
        });
      } else if (img.getAttribute("alt") === "" && !decorative && rendered && r.width >= 200 && r.height >= 120 && !img.closest("a[href], button")) {
        const hasCaption = !!img.closest("figure")?.querySelector("figcaption");
        if (!hasCaption) {
          add("emptyAlt", {
            element: img,
            status: "warning",
            severity: "low",
            verification: "inferred",
            message: `Large image (${Math.round(r.width)}×${Math.round(r.height)}px) is marked decorative with alt="". Verify it carries no information.`,
            actual: 'alt=""',
            expected: "Descriptive alt if the image conveys content",
            evidence: { src },
            fix: "If the image conveys information, describe it in alt; otherwise keep alt=\"\".",
          });
        }
      } else if (img.hasAttribute("alt")) {
        const alt = img.getAttribute("alt").trim();
        const fileName = (src.split("/").pop() || "").split("?")[0];
        if (alt && (IMG_EXT_RE.test(alt) || /^(image|img|photo|picture|graphic|untitled|dsc_?\d+)$/i.test(alt) || (fileName && alt === fileName))) {
          add("altQuality", {
            element: img,
            status: "warning",
            severity: "low",
            verification: "inferred",
            message: `Alt text "${U.truncate(alt, 60)}" looks like a file name or generic placeholder.`,
            actual: `alt="${U.truncate(alt, 60)}"`,
            expected: "Alt text describing the image's content or function",
            fix: "Write alt text that conveys what the image shows or does.",
          });
        }
      }

      if (!rendered || tiny) {
        entry.state = rendered ? "tracking pixel / tiny" : "not rendered (hidden)";
        continue;
      }

      // --- geometry
      if (r.width === 0 || r.height === 0) {
        add("zero", {
          element: img,
          status: "warning",
          severity: "medium",
          verification: "verified",
          message: `Loaded image (${img.naturalWidth}×${img.naturalHeight}) renders at ${Math.round(r.width)}×${Math.round(r.height)}px, so it is invisible.`,
          actual: `${Math.round(r.width)}×${Math.round(r.height)}px rendered`,
          expected: "non-zero rendered size, or hide it explicitly",
          evidence: { width: cs.width, height: cs.height, maxWidth: cs.maxWidth },
          fix: "Check width/height: 0, a collapsed flex item (min-width: 0 with no basis) or a zero-size parent.",
        });
        continue;
      }

      const fit = U.analyzeImageFit({
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        boxWidth: box.width,
        boxHeight: box.height,
        objectFit: cs.objectFit,
      });
      Object.assign(entry, {
        naturalRatio: fit.naturalRatio,
        renderedRatio: fit.renderedRatio,
        croppedPercent: Math.round(fit.croppedFraction * 100),
        distorted: fit.distorted,
        letterboxed: fit.letterboxed,
      });
      entry.croppingLikely = fit.croppedFraction > 0.01 ? "yes (object-fit)" : "no";
      entry.cropAssessment = fit.croppedFraction > 0.01 ? (fit.croppedFraction > 0.45 ? "needs manual inspection" : "likely intentional (object-fit: " + cs.objectFit + ")") : "n/a";

      const svg = /\.svg(\?|#|$)/i.test(src) || src.startsWith("data:image/svg");
      if (fit.distorted && !svg) {
        add("distorted", {
          element: img,
          status: "failed",
          severity: "medium",
          verification: "verified",
          message: `Image is stretched: natural ratio ${fit.naturalRatio} vs rendered ratio ${fit.renderedRatio} (${Math.round(fit.ratioDelta * 100)}% off) with object-fit: ${cs.objectFit}.`,
          actual: `${img.naturalWidth}×${img.naturalHeight} drawn into ${Math.round(box.width)}×${Math.round(box.height)}`,
          expected: "rendered aspect ratio equals natural aspect ratio, or object-fit: cover/contain",
          evidence: { naturalRatio: fit.naturalRatio, renderedRatio: fit.renderedRatio, objectFit: cs.objectFit, cssWidth: cs.width, cssHeight: cs.height },
          fix: "Set only one dimension (height: auto), or use object-fit: cover/contain when both are fixed.",
        });
      }

      // Clipped by an overflow:hidden ancestor
      const clip = h.clipAncestor(img, 6);
      if (clip && !h.isScrollContainer(clip.el, clip.cs) && !h.isIntentionallyOffscreen(img)) {
        const cr = clip.el.getBoundingClientRect();
        const iw = Math.max(0, Math.min(r.right, cr.right) - Math.max(r.left, cr.left));
        const ih = Math.max(0, Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top));
        const visible = (iw * ih) / (r.width * r.height);
        if (visible < 0.95 && visible > 0) {
          entry.croppingLikely = "yes (container overflow)";
          const ccs = clip.cs;
          const deliberate = ccs.aspectRatio !== "auto" || /px$/.test(ccs.height) || ccs.borderRadius !== "0px";
          entry.cropAssessment = deliberate ? "likely intentional (fixed-size/rounded container)" : "needs manual inspection";
        }
      }

      // Extends outside its (non-clipping) container
      const parent = blockContainer(img);
      if (parent && cs.position !== "absolute" && cs.position !== "fixed") {
        const pcs = getComputedStyle(parent);
        if (pcs.overflowX === "visible") {
          const pr = parent.getBoundingClientRect();
          const contentRight = pr.right - (parseFloat(pcs.paddingRight) || 0) - (parseFloat(pcs.borderRightWidth) || 0);
          const overBy = r.right - contentRight;
          if (overBy > 2) {
            add("outside", {
              element: img,
              status: "failed",
              severity: "medium",
              verification: "verified",
              message: `Image is ${Math.round(overBy)}px wider than its container's content box; it does not scale with the layout.`,
              actual: `image ${Math.round(r.width)}px wide, container content ${Math.round(contentRight - pr.left - (parseFloat(pcs.paddingLeft) || 0))}px`,
              expected: "image fits its container",
              evidence: { container: h.cssPath(parent), cssWidth: cs.width, maxWidth: cs.maxWidth, widthAttr: img.getAttribute("width") },
              fix: "Add max-width: 100%; height: auto to images.",
            });
          }
        }
      }

      // Pixel density
      const nW = img.naturalWidth;
      const nH = img.naturalHeight;
      if (!svg && nW >= 50 && box.width * dpr > nW * 1.5 && box.height * dpr > nH * 1.5) {
        add("upscaled", {
          element: img,
          status: "warning",
          severity: "low",
          verification: "verified",
          message: `Image is displayed at ${Math.round((box.width * dpr) / nW * 10) / 10}× its natural resolution (DPR ${dpr}) and will look blurry.`,
          actual: `natural ${nW}×${nH}, rendered ${Math.round(box.width)}×${Math.round(box.height)} CSS px`,
          expected: `natural width ≥ ${Math.round(box.width * dpr)}px`,
          fix: "Serve a larger source (srcset with 2x candidates) or render the image smaller.",
        });
      }
      const factor = U.oversizeFactor({ naturalWidth: nW, naturalHeight: nH, renderedWidth: box.width, renderedHeight: box.height, dpr });
      const big = size.bytes && size.bytes > 1024 * 1024;
      if (!svg && ((factor && factor > 4 && nW * nH > 1000000) || big)) {
        add("oversized", {
          element: img,
          status: "warning",
          severity: big ? "medium" : "low",
          verification: size.bytes ? "verified" : "inferred",
          message: `Source is ${nW}×${nH} (${U.formatBytes(size.bytes)}${size.bytes ? "" : ": " + size.note}) but only ${Math.round(box.width)}×${Math.round(box.height)} CSS px are displayed${factor ? ` — ~${factor}× more pixels than needed at DPR ${dpr}` : ""}.`,
          actual: `${nW}×${nH}, ${U.formatBytes(size.bytes)}`,
          expected: "source close to rendered size × device pixel ratio",
          evidence: { naturalWidth: nW, naturalHeight: nH, fileSize: size.bytes, fileSizeNote: size.note, pixelFactor: factor },
          fix: "Serve responsive sizes with srcset/sizes and a modern format (WebP/AVIF).",
        });
      }

      if (!img.hasAttribute("width") && !img.hasAttribute("height") && cs.aspectRatio === "auto" && cs.position !== "absolute" && cs.position !== "fixed" && !/px$/.test(img.style.height || "")) {
        add("dims", {
          element: img,
          status: "warning",
          severity: "low",
          verification: "inferred",
          message: "No width/height attributes or CSS aspect-ratio: the browser cannot reserve space before the image loads (layout shift).",
          actual: "no intrinsic size hints",
          expected: 'width/height attributes (e.g. width="800" height="600") or aspect-ratio',
          fix: `Add width="${nW}" height="${nH}" attributes (CSS can still scale the image).`,
        });
      }

      if (r.height > innerHeight * 2 && r.width >= innerWidth * 0.5) {
        add("tall", {
          element: img,
          status: "warning",
          severity: "low",
          verification: "inferred",
          message: `Image renders ${Math.round(r.height)}px tall — more than two viewport heights.`,
          actual: `${Math.round(r.width)}×${Math.round(r.height)}px`,
          expected: `≤ ${innerHeight * 2}px tall`,
          fix: "Constrain the height (max-height + object-fit) or check for a missing height/width rule.",
        });
      }
    }

    if (!ctx.options.skipBackgroundImages) await backgroundImages(ctx, index, inventory, add);
    ctx.extras.imageSummary = {
      images: imgs.length,
    };
    return tests;
  }

  async function backgroundImages(ctx, index, inventory, add) {
    const bgMap = new Map();
    const { list } = h.allElements(document.body, 4000);
    for (const el of list) {
      await ctx.tick();
      const bi = getComputedStyle(el).backgroundImage;
      if (!bi || bi === "none" || !bi.includes("url(")) continue;
      for (const m of bi.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        const url = m[1];
        if (url.startsWith("data:")) continue;
        if (!bgMap.has(url)) bgMap.set(url, el);
      }
    }
    const urls = [...bgMap.keys()].slice(0, 40);
    if (bgMap.size > 40) ctx.limitation(`Only the first 40 of ${bgMap.size} CSS background images were load-checked.`);
    const probes = await Promise.all(urls.map(async (u) => [u, sizeInfo(index, u), await probe(u)]));
    for (const [url, size, res] of probes) {
      const el = bgMap.get(url);
      const ecs = getComputedStyle(el);
      const er = el.getBoundingClientRect();
      inventory.length < 300 && inventory.push({
        src: U.truncate(url, 300),
        kind: "css background",
        selector: h.cssPath(el),
        ref: h.refFor(el),
        natural: { width: res.w || 0, height: res.h || 0 },
        rendered: { width: Math.round(er.width), height: Math.round(er.height) },
        objectFit: `background-size: ${ecs.backgroundSize}`,
        objectPosition: ecs.backgroundPosition,
        fileSize: size.bytes,
        fileSizeNote: size.note,
        state: res.ok === false ? "broken" : res.ok ? "loaded" : "unknown (timeout)",
        croppingLikely: /cover/.test(ecs.backgroundSize) ? "yes (background-size: cover)" : "unknown",
        cropAssessment: /cover/.test(ecs.backgroundSize) ? "likely intentional (background-size: cover)" : "n/a",
      });
      if (res.ok === false || (size.status && size.status >= 400)) {
        add("bg", {
          element: el,
          status: "failed",
          severity: er.width * er.height > 40000 ? "high" : "medium",
          verification: "verified",
          message: `CSS background image failed to load${size.status ? ` (HTTP ${size.status})` : ""}.`,
          actual: `background-image: url(${U.truncate(url, 100)})`,
          expected: "image loads",
          evidence: { url, httpStatus: size.status || "unavailable" },
          fix: "Fix the URL (relative URLs resolve against the stylesheet, not the page) or the server response.",
        });
      }
    }
    if (urls.length) ctx.limitation("Background images were load-checked by re-requesting their URLs (normally answered from the browser cache).");
  }

  // Images run as a single pass for performance; expose each logical check as its own test entry.
  QA.register("images", {
    label: "Images",
    custom: async (ctx) => {
      const tests = await run(ctx);
      return Object.values(tests).map((t) => ({ id: t.id, name: t.name, found: t.n }));
    },
  });
})();
