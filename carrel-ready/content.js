/*
 * Carrel capture engine — runs in the page's isolated world.
 * Injected AFTER lib/Readability.js, so the global `Readability` is available.
 *
 * Why the conversion happens here and not in the service worker:
 * MV3 service workers have no DOM (no DOMParser), so any HTML -> blocks work
 * must happen in a context that has a document. This is also where we fix the
 * three things the official Notion clipper gets wrong: truncation, lazy images,
 * and selection-only capture.
 */
(() => {
  if (globalThis.__carrelExtractDefined) return;
  globalThis.__carrelExtractDefined = true;

  const MAX_TEXT = 1900; // Notion hard limit is 2000 chars per rich_text run; stay under.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Lazy-load trigger -------------------------------------------------
  // Many sites only load images when scrolled into view. We walk the page,
  // promote common lazy attributes to real src, then return to the top.
  async function primeLazyContent() {
    const startY = window.scrollY;
    const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
    const max = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await sleep(60);
    }
    // Promote lazy attributes that are widely used in the wild.
    document.querySelectorAll("img").forEach((img) => {
      const cand =
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-srcset");
      if (cand && !img.src) {
        try {
          img.src = cand.split(" ")[0];
        } catch (e) {}
      }
      img.loading = "eager";
    });
    window.scrollTo(0, startY);
    await sleep(120);
  }

  // ---- Inline rich text --------------------------------------------------
  function splitRuns(text, annotations, link) {
    const runs = [];
    if (!text) return runs;
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      const chunk = text.slice(i, i + MAX_TEXT);
      const rt = { type: "text", text: { content: chunk } };
      if (link) rt.text.link = { url: link };
      if (annotations && Object.keys(annotations).length) {
        rt.annotations = annotations;
      }
      runs.push(rt);
    }
    return runs;
  }

  function inlineRich(node, ctx = { ann: {}, link: null }) {
    const out = [];
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.replace(/\s+/g, " ");
        if (text) out.push(...splitRuns(text, { ...ctx.ann }, ctx.link));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const tag = child.tagName.toLowerCase();
      const next = { ann: { ...ctx.ann }, link: ctx.link };
      if (tag === "strong" || tag === "b") next.ann.bold = true;
      else if (tag === "em" || tag === "i") next.ann.italic = true;
      else if (tag === "code") next.ann.code = true;
      else if (tag === "s" || tag === "del") next.ann.strikethrough = true;
      else if (tag === "u") next.ann.underline = true;
      else if (tag === "a") {
        const href = child.getAttribute("href");
        if (href && /^https?:/i.test(absUrl(href))) next.link = absUrl(href);
      } else if (tag === "br") {
        out.push({ type: "text", text: { content: "\n" } });
        return;
      }
      out.push(...inlineRich(child, next));
    });
    return out;
  }

  function absUrl(href) {
    try {
      return new URL(href, document.baseURI).href;
    } catch (e) {
      return href;
    }
  }

  function rich(node) {
    const r = inlineRich(node).filter(
      (x) => x.text.content && x.text.content.trim() !== ""
    );
    return r.length ? r : [];
  }

  // ---- Block builders ----------------------------------------------------
  const para = (richText) => ({
    type: "paragraph",
    paragraph: { rich_text: richText },
  });

  function blocksFromElement(el, out) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Math.min(3, parseInt(tag[1], 10));
        const type = `heading_${level}`;
        const r = rich(el);
        if (r.length) out.push({ type, [type]: { rich_text: r } });
        break;
      }
      case "p": {
        const r = rich(el);
        if (r.length) out.push(para(r));
        // images embedded inside paragraphs
        el.querySelectorAll("img").forEach((img) => pushImage(img, out));
        break;
      }
      case "ul":
      case "ol": {
        const itemType =
          tag === "ul" ? "bulleted_list_item" : "numbered_list_item";
        el.querySelectorAll(":scope > li").forEach((li) => {
          const liClone = li.cloneNode(true);
          liClone
            .querySelectorAll(":scope > ul, :scope > ol")
            .forEach((n) => n.remove());
          const r = rich(liClone);
          if (r.length) out.push({ type: itemType, [itemType]: { rich_text: r } });
          // one level of nested list, flattened as further list items
          li.querySelectorAll(":scope > ul, :scope > ol").forEach((n) =>
            blocksFromElement(n, out)
          );
        });
        break;
      }
      case "blockquote": {
        const r = rich(el);
        if (r.length) out.push({ type: "quote", quote: { rich_text: r } });
        break;
      }
      case "pre": {
        const text = el.textContent || "";
        for (let i = 0; i < text.length || i === 0; i += MAX_TEXT) {
          out.push({
            type: "code",
            code: {
              language: "plain text",
              rich_text: [
                { type: "text", text: { content: text.slice(i, i + MAX_TEXT) } },
              ],
            },
          });
          if (text.length <= MAX_TEXT) break;
        }
        break;
      }
      case "figure": {
        const img = el.querySelector("img");
        if (img) pushImage(img, out);
        const cap = el.querySelector("figcaption");
        if (cap) {
          const r = rich(cap);
          if (r.length) out.push(para(r));
        }
        break;
      }
      case "img":
        pushImage(el, out);
        break;
      case "hr":
        out.push({ type: "divider", divider: {} });
        break;
      case "table":
        // Notion table blocks are verbose; for v1 flatten rows to paragraphs.
        el.querySelectorAll("tr").forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll("th,td")).map((c) =>
            (c.textContent || "").trim()
          );
          const line = cells.join("  |  ");
          if (line.trim())
            out.push(para(splitRuns(line, {}, null)));
        });
        break;
      default: {
        // Container element: descend into children.
        if (el.children && el.children.length) {
          Array.from(el.childNodes).forEach((n) => {
            if (n.nodeType === Node.ELEMENT_NODE) blocksFromElement(n, out);
            else if (n.nodeType === Node.TEXT_NODE) {
              const t = (n.textContent || "").trim();
              if (t) out.push(para(splitRuns(t, {}, null)));
            }
          });
        } else {
          const r = rich(el);
          if (r.length) out.push(para(r));
        }
      }
    }
  }

  function pushImage(img, out) {
    let src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    src = src ? absUrl(src) : "";
    if (!src || !/^https?:/i.test(src) || src.startsWith("data:")) return;
    if (src.length > 1900) return; // Notion rejects very long external URLs
    out.push({ type: "image", image: { type: "external", external: { url: src } } });
  }

  function buildBlocks(rootHtml) {
    const container = document.createElement("div");
    container.innerHTML = rootHtml;
    const out = [];
    Array.from(container.childNodes).forEach((n) => {
      if (n.nodeType === Node.ELEMENT_NODE) blocksFromElement(n, out);
      else if (n.nodeType === Node.TEXT_NODE) {
        const t = (n.textContent || "").trim();
        if (t) out.push(para(splitRuns(t, {}, null)));
      }
    });
    return out;
  }

  // ---- Public entry point ------------------------------------------------
  globalThis.carrelExtract = async function (opts = {}) {
    try {
      if (opts.loadImages !== false) await primeLazyContent();

      let title = document.title || "Untitled";
      let byline = "";
      let siteName = location.hostname;
      let excerpt = "";
      let html = "";

      const sel = window.getSelection();
      const hasSelection =
        sel && sel.rangeCount > 0 && sel.toString().trim().length > 0;

      if (opts.selectionOnly && hasSelection) {
        const frag = sel.getRangeAt(0).cloneContents();
        const wrap = document.createElement("div");
        wrap.appendChild(frag);
        html = wrap.innerHTML;
        excerpt = sel.toString().slice(0, 200);
      } else {
        // Run Readability on a CLONE so we never mutate the live page.
        const docClone = document.cloneNode(true);
        const article = new Readability(docClone, {
          charThreshold: 250,
        }).parse();
        if (article && article.content) {
          html = article.content;
          title = article.title || title;
          byline = article.byline || "";
          siteName = article.siteName || siteName;
          excerpt = article.excerpt || "";
        } else {
          // Fallback: main/article element, then body.
          const main =
            document.querySelector("article") ||
            document.querySelector("main") ||
            document.body;
          html = main ? main.innerHTML : document.body.innerHTML;
        }
      }

      const blocks = buildBlocks(html);
      const wordCount = blocks.reduce((acc, b) => {
        const key = Object.keys(b)[1] || b.type;
        const rt = b[b.type] && b[b.type].rich_text;
        if (rt) acc += rt.map((r) => r.text.content).join(" ").split(/\s+/).length;
        return acc;
      }, 0);

      return {
        ok: true,
        title: (title || "Untitled").slice(0, 1900),
        byline,
        siteName,
        excerpt,
        url: location.href,
        blocks,
        wordCount,
        usedSelection: !!(opts.selectionOnly && hasSelection),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  // Lightweight probe used by the popup to decide whether to offer
  // "selection only" without doing a full extraction.
  globalThis.carrelSelectionInfo = function () {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    return {
      hasSelection: text.length > 0,
      selectionLength: text.length,
      title: document.title || "",
      url: location.href,
    };
  };
})();
