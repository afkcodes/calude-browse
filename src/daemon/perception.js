// perception.js — build a compact SEMANTIC PAGE MODEL (no screenshots).
//
// We extract the page's interactable elements with their accessible role and
// name (the accessibility-tree idea), plus geometry, by running an extractor
// in the page context via Runtime.evaluate. Each element gets a stable index
// the agent refers to ("click [12]"). This is tokens-cheap and robust to
// restyling in a way pixel coordinates never are.
//
// Two behaviours that matter on heavy pages (learned driving GA4 admin):
//   - the element budget is configurable (CALUDE_MAX_ELEMENTS, default 400);
//   - if a modal/dialog/overlay is open, its controls are emitted FIRST so a
//     long list behind it can never truncate the fields you actually need.

// This function is stringified and executed inside the page. `maxElements` is
// substituted in at call time.
function PAGE_EXTRACTOR(maxElements) {
  const INTERACTIVE = "a,button,input,textarea,select,summary,[role],[onclick],[contenteditable='true'],[tabindex]";
  const ROLE_FROM_TAG = { A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" };
  // Roles worth keeping even when they have no accessible name (a bare checkbox
  // in a table row, an unlabeled radio, etc. — these were getting dropped).
  const KEEP_UNNAMED = ["input", "textbox", "combobox", "searchbox", "checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    return ROLE_FROM_TAG[el.tagName] || el.tagName.toLowerCase();
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    if (el.tagName === "INPUT") {
      if (el.labels && el.labels[0]) return el.labels[0].textContent.trim();
      if (el.placeholder) return el.placeholder.trim();
      if (el.name) return el.name;
      if (el.value && el.type === "submit") return el.value;
    }
    if (el.getAttribute("title")) return el.getAttribute("title").trim();
    if (el.getAttribute("alt")) return el.getAttribute("alt").trim();
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 120);
  }

  function visible(el, r) {
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    return true;
  }

  // The topmost open overlay/dialog (if any). Later-in-DOM wins, which is
  // almost always the most recently opened (and visually frontmost) layer.
  function topOverlay() {
    const ds = Array.prototype.slice
      .call(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog'))
      .filter((d) => {
        const r = d.getBoundingClientRect();
        const s = getComputedStyle(d);
        return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
      });
    return ds.length ? ds[ds.length - 1] : null;
  }
  const overlay = topOverlay();

  const items = [];
  const seen = new Set();
  let scanned = 0;

  // Recursively collect interactables across the top document, open shadow
  // roots, and SAME-ORIGIN iframes. (ox,oy) is the frame's offset in the top
  // viewport, so child coordinates map to where CDP Input must actually click;
  // shadow roots share their host's coordinate space, so they inherit the
  // parent offset. Cross-origin iframes throw on contentDocument → skipped.
  function collect(root, ox, oy) {
    let nodes;
    // Walk ALL elements (not just interactive ones) so non-interactive shadow
    // hosts (e.g. a bare <div>) and iframes are found and descended into.
    try { nodes = root.querySelectorAll("*"); } catch { return; }
    for (const el of nodes) {
      if (++scanned > 8000) return; // pathological-page guard
      if (el.shadowRoot) collect(el.shadowRoot, ox, oy); // pierce open shadow DOM
      const tag = el.tagName;
      if (tag === "IFRAME" || tag === "FRAME") { // descend same-origin frames
        let doc = null;
        try { doc = el.contentDocument; } catch { doc = null; } // cross-origin → null
        if (doc) { const fr = el.getBoundingClientRect(); collect(doc, ox + fr.left, oy + fr.top); }
        continue;
      }
      let interactive = false;
      try { interactive = el.matches(INTERACTIVE); } catch {}
      if (!interactive) continue;
      const rr = el.getBoundingClientRect();
      const r = {
        x: rr.x + ox, y: rr.y + oy, left: rr.left + ox, top: rr.top + oy,
        right: rr.right + ox, bottom: rr.bottom + oy, width: rr.width, height: rr.height,
      };
      if (!visible(el, r)) continue;
      const key = Math.round(r.x) + ":" + Math.round(r.y) + ":" + el.tagName;
      if (seen.has(key)) continue;
      seen.add(key);
      const role = roleOf(el);
      const name = accessibleName(el);
      if (!name && !KEEP_UNNAMED.includes(role)) continue;
      items.push({
        el, role, name,
        type: el.getAttribute("type") || undefined,
        value: (el.value || "").slice(0, 80) || undefined,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        pri: overlay && overlay.contains(el) ? 0 : 1,
      });
    }
  }
  collect(document, 0, 0);

  // Overlay contents first. Array.sort is stable, so DOM order is preserved
  // within each priority band.
  items.sort((a, b) => a.pri - b.pri);
  const limited = items.slice(0, maxElements);
  const elements = limited.map((it, i) => ({
    i, role: it.role, name: it.name, type: it.type, value: it.value, x: it.x, y: it.y, w: it.w, h: it.h,
  }));

  let overlayName = null;
  if (overlay) {
    overlayName = overlay.getAttribute("aria-label")
      || overlay.querySelector("h1,h2,[role='heading']")?.textContent?.trim()?.slice(0, 80)
      || "dialog";
  }
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    scrollMax: document.body ? Math.round(document.body.scrollHeight - innerHeight) : 0,
    overlay: overlayName,
    truncated: Math.max(0, items.length - limited.length),
    elements,
  };
}

export async function perceive(client) {
  const { Runtime } = client;
  const max = Number(process.env.CALUDE_MAX_ELEMENTS || 400);
  const expr = `(${PAGE_EXTRACTOR.toString()})(${max})`;
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });
  if (exceptionDetails) {
    throw new Error("perception failed: " + (exceptionDetails.exception?.description || exceptionDetails.text));
  }
  return result.value;
}

// Render the page model as a compact, token-efficient string for the LLM.
export function renderForModel(model) {
  const lines = model.elements.map((e) => {
    const bits = [`[${e.i}]`, e.role];
    if (e.type) bits.push(`(${e.type})`);
    if (e.name) bits.push(`"${e.name}"`);
    if (e.value) bits.push(`= "${e.value}"`);
    return bits.join(" ");
  });
  const scroll = model.scrollMax > 0 ? ` scroll ${model.scrollY}/${model.scrollMax}` : "";
  const overlay = model.overlay ? `\nFOCUSED OVERLAY: ${model.overlay} (its controls are listed first)` : "";
  const trunc = model.truncated ? `\n… (${model.truncated} more interactable elements not shown — raise CALUDE_MAX_ELEMENTS or scroll)` : "";
  return `URL: ${model.url}\nTITLE: ${model.title}${scroll}${overlay}\nELEMENTS:\n${lines.join("\n")}${trunc}`;
}
