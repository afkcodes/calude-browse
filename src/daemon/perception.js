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

  // NEVER emit the contents of a credential field. Browsers autofill saved
  // passwords, so a plain read of a login page would otherwise leak the
  // password verbatim into the model, the transcript, and any logs. The model
  // still needs to KNOW the field is filled (to decide whether to type), so we
  // report a placeholder instead of the value.
  const SENSITIVE_NAME = /pass|pwd|otp|mfa|2fa|totp|cvv|cvc|card|iban|ssn|secret|token|api[-_ ]?key/i;
  function redactedValue(el) {
    const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    const hay = [type, el.name, el.id, el.getAttribute && el.getAttribute("autocomplete"),
                 el.getAttribute && el.getAttribute("aria-label"), el.placeholder]
      .filter(Boolean).join(" ");
    const sensitive = type === "password" || SENSITIVE_NAME.test(hay);
    const raw = (el.value || "");
    if (!raw) return undefined;
    if (sensitive) return "«redacted»";
    return raw.slice(0, 80) || undefined;
  }

  // For a native <select>, list its option labels (token-cheap): up to 12,
  // trimmed and capped ~40 chars each, plus a "(+N more)" marker if truncated.
  function optionsOf(el) {
    if (el.tagName !== "SELECT") return undefined;
    const opts = Array.prototype.slice.call(el.options || []);
    if (!opts.length) return undefined;
    const labels = opts.slice(0, 12).map((o) => (o.label || o.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40));
    const more = opts.length - labels.length;
    if (more > 0) labels.push("(+" + more + " more)");
    return labels;
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
        value: redactedValue(el),
        options: optionsOf(el),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        pri: overlay && overlay.contains(el) ? 0 : 1,
        // Behind an open modal: still painted and hit-testable, but the dialog
        // swallows input. Acting here silently does nothing (or worse, hits a
        // lookalike control that shares the foreground element's accessible
        // name (a background composer behind a compose dialog, say).
        inert: overlay ? !overlay.contains(el) : false,
      });
    }
  }
  collect(document, 0, 0);

  // Overlay contents first. Array.sort is stable, so DOM order is preserved
  // within each priority band.
  items.sort((a, b) => a.pri - b.pri);
  const limited = items.slice(0, maxElements);
  const elements = limited.map((it, i) => ({
    i, role: it.role, name: it.name, type: it.type, value: it.value, options: it.options, x: it.x, y: it.y, w: it.w, h: it.h,
    inert: it.inert || undefined,
  }));

  let overlayName = null;
  if (overlay) {
    overlayName = overlay.getAttribute("aria-label")
      || overlay.querySelector("h1,h2,[role='heading']")?.textContent?.trim()?.slice(0, 80)
      || "dialog";
  }
  // Query strings and fragments routinely carry one-time tokens, session ids and
  // API keys (OAuth callbacks, magic links, password-reset links). Emitting the
  // raw href would put them in the model and the transcript.
  function safeUrl() {
    try {
      const u = new URL(location.href);
      const SENS = /token|secret|password|passwd|pwd|api[-_]?key|access|auth|session|code|otp|signature|sig/i;
      let touched = false;
      for (const k of Array.from(u.searchParams.keys())) {
        if (SENS.test(k)) { u.searchParams.set(k, "«redacted»"); touched = true; }
      }
      if (u.hash && SENS.test(u.hash)) { u.hash = "#«redacted»"; touched = true; }
      if (u.protocol === "data:") return "data:«inline»";
      return touched ? u.toString() : location.href;
    } catch { return location.href; }
  }

  return {
    url: safeUrl(),
    title: document.title,
    scrollY: Math.round(scrollY),
    scrollMax: document.body ? Math.round(document.body.scrollHeight - innerHeight) : 0,
    overlay: overlayName,
    truncated: Math.max(0, items.length - limited.length),
    elements,
  };
}

// Thrown when the page's JS thread is wedged (heavy video/compositing, an
// infinite loop) so Runtime.evaluate never returns. Callers can catch this and
// recover (navigate away resets the renderer) instead of hanging forever.
export class PageFrozenError extends Error {
  constructor() { super("page perception timed out — renderer thread is frozen"); this.name = "PageFrozenError"; }
}

export async function perceive(client, timeoutMs = 8000) {
  const { Runtime } = client;
  const max = Number(process.env.CALUDE_MAX_ELEMENTS || 400);
  const expr = `(${PAGE_EXTRACTOR.toString()})(${max})`;
  // The extractor runs in the page's JS context; if that thread is frozen the
  // evaluate never resolves. Bound it so a wedged tab can't hang the whole tool.
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new PageFrozenError()), timeoutMs); });
  let res;
  try {
    res = await Promise.race([
      Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: false }),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (res.exceptionDetails) {
    throw new Error("perception failed: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

// Render the page model as a compact, token-efficient string for the LLM.
export function renderForModel(model) {
  const lines = model.elements.map((e) => {
    const bits = [`[${e.i}]`, e.role];
    if (e.type) bits.push(`(${e.type})`);
    if (e.name) bits.push(`"${e.name}"`);
    if (e.value) bits.push(`= "${e.value}"`);
    if (e.options) bits.push(`options: [${e.options.join(" | ")}]`);
    if (e.inert) bits.push("[inert: behind the dialog — do not act on this]");
    return bits.join(" ");
  });
  const scroll = model.scrollMax > 0 ? ` scroll ${model.scrollY}/${model.scrollMax}` : "";
  const overlay = model.overlay
    ? `\nFOCUSED OVERLAY: ${model.overlay} (its controls are listed first; everything marked [inert] is behind it)`
    : "";
  const trunc = model.truncated ? `\n… (${model.truncated} more interactable elements not shown — raise CALUDE_MAX_ELEMENTS or scroll)` : "";
  return `URL: ${model.url}\nTITLE: ${model.title}${scroll}${overlay}\nELEMENTS:\n${lines.join("\n")}${trunc}`;
}
