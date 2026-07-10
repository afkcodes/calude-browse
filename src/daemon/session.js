// session.js — a stateful browser session over a MULTI-TARGET browser: the
// "current page model" (element indexes), a recorded action TRACE, flow replay,
// and a target manager so popups/new tabs/OAuth windows are followed too.
//
// All actions run against the ACTIVE target (targets.active()). When a click
// opens a popup/new tab, the manager auto-focuses it, so the next read() and
// subsequent actions operate on it automatically.

import { launchChrome } from "./chrome.js";
import { perceive, renderForModel } from "./perception.js";
import * as exec from "./executor.js";
import * as flowcache from "./flowcache.js";
import * as safety from "./safety.js";
import * as tabs from "./targets.js";
import { setTimeout as sleep } from "node:timers/promises";

let started = false;
let launched = null;
let model = null;   // last perceived page model — element indexes resolve against this
let trace = [];     // recorded steps since the last clearTrace()
let replaying = false;

const C = () => tabs.active(); // the active target's CDP client

export async function ensure() {
  if (started && await tabs.healthy()) return;
  // First run, or the CDP socket died (Chrome closed/crashed) — (re)launch and
  // (re)attach so a dropped connection self-heals instead of bricking the session.
  launched = await launchChrome();
  await tabs.init();
  started = true;
}

export async function read() {
  await ensure();
  model = await perceive(C());
  let text = renderForModel(model);
  if (tabs.count() > 1) text += `\n[${tabs.count()} tabs open — browser_list_tabs / browser_switch_tab to move between them]`;
  return { model, text };
}

// ---- helpers ---------------------------------------------------------------

function findEl(i) {
  const el = model?.elements.find((e) => e.i === i);
  if (!el) throw new Error(`no element [${i}] in the current page model — call browser_read first`);
  // A modal is open and this element is behind it. Clicking/typing here is a
  // silent no-op at best, and at worst lands in a lookalike control behind the
  // dialog that shares its accessible name (e.g. two `textbox "Post text"`).
  if (el.inert) {
    const alt = model.elements.find((e) => !e.inert && e.role === el.role && e.name === el.name);
    throw new Error(
      `element [${i}] "${el.name}" is INERT — it sits behind the open ${model.overlay || "dialog"}.`
      + (alt ? ` Use [${alt.i}] instead (same role/name, inside the dialog).`
             : ` Act on a control inside the dialog, or close it first.`)
    );
  }
  return el;
}

const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
const matchOf = (el) => ({ role: el.role, name: el.name, type: el.type });

function matchEl(m, near) {
  const cands = (model?.elements || []).filter(
    (e) => e.role === m.role && (m.name ? norm(e.name) === norm(m.name) : true) && (m.type ? e.type === m.type : true)
  );
  if (cands.length <= 1) return cands[0] || null;
  // Multiple candidates matching {role, name, type}. If the caller passed the
  // intended element's position, pick the nearest one. This disambiguates both
  // UNNAMED duplicates (an unlabeled <textarea> vs the page's search box) AND
  // duplicates that share the SAME accessible name (e.g. a subreddit's
  // "description" and "sidebar" textareas, both named by their identical text) —
  // without a position hint, either would otherwise collapse to the first in DOM
  // order and land the action in the wrong field.
  if (near) {
    const d2 = (e) => (e.x - near.x) ** 2 + (e.y - near.y) ** 2;
    return cands.reduce((best, e) => (d2(e) < d2(best) ? e : best));
  }
  return cands[0];
}

function record(step) {
  if (!replaying) trace.push(step);
}

function fpOf(m) {
  if (!m) return "";
  return `${m.url}|${m.title}|` + m.elements.map((e) => `${e.role}:${e.name}:${e.value || ""}`).join(";");
}

// Wait until the page stops changing, instead of guessing a fixed delay.
// The load event fires when the document is done, but SPA routes keep mounting
// afterwards (a route that mounts a dialog well after load). Reading too
// early yields a half-built model whose indexes are garbage against the settled
// page — the caller then types into whatever now occupies that index.
//
// Settled = TWO consecutive identical fingerprints (3 matching samples) with a
// non-empty title. One match is not enough: SPAs paint a skeleton that sits
// still for a beat (some apps render a title and a few elements before hydrating),
// and a single stable pair accepts that skeleton. A nearly-empty model is the
// tell, so an element count below MIN_RICH also has to outlast a grace period
// before we believe it. Bounded; returns whatever it has when the budget ends.
const MIN_RICH = 5;
const SPARSE_GRACE_MS = 2500;
async function settle(maxMs = 10000, quietMs = 300) {
  const t0 = Date.now();
  let prev = null;
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    let snap;
    try { snap = await perceive(C()); } catch { await sleep(quietMs); continue; }
    const fp = fpOf(snap);
    stable = prev !== null && fp === prev ? stable + 1 : 0;
    prev = fp;
    // A rich, stable model IS a loaded page — some apps leave document.title
    // empty long after hydration, so requiring a title burned the
    // full timeout on pages that were already done. Title only matters as
    // corroboration when the model is sparse.
    const rich = (snap.elements?.length || 0) >= MIN_RICH;
    if (stable >= 2 && (rich || (snap.title && Date.now() - t0 >= SPARSE_GRACE_MS))) return true;
    await sleep(quietMs);
  }
  return false;
}

async function navigateRaw(url) {
  await C().Page.navigate({ url });
  // loadEventFired NEVER resolves when Chrome is already on this URL or the SPA
  // does an in-page route change — and an unresolved promise is not a rejected
  // one, so .catch() cannot save you. Race it against a deadline; settle() below
  // is what actually establishes readiness anyway.
  await Promise.race([
    C().Page.loadEventFired().catch(() => {}),
    sleep(2500),
  ]);
  await settle();
  return read();
}

async function clickVerified(match, fallback) {
  let snap = { text: "" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = fpOf(model);
    const target = matchEl(match, fallback) || fallback;
    if (!target) return { text: "(target no longer present)" };
    await exec.click(C(), target.x, target.y);
    await sleep(700);
    snap = await read();
    if (fpOf(snap.model) !== before) {
      return { text: snap.text + (attempt > 1 ? "\n(verified after retry)" : "") };
    }
    if (attempt < 2) await sleep(450);
  }
  return { text: snap.text + "\n(⚠ click produced no detectable page change after 2 attempts — element may be inert or its effect isn't reflected in the page model)" };
}

async function typeVerified(match, text, submit, fallback) {
  let snap = { text: "" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = fpOf(model);
    const target = matchEl(match, fallback) || fallback;
    if (!target) return { text: "(input no longer present)" };
    await exec.click(C(), target.x, target.y);
    await exec.clearField(C()); // replace, don't append — fixes garble on retry
    await exec.typeText(C(), text);
    if (submit) await exec.pressEnter(C());
    await sleep(900);
    snap = await read();
    // Verify the type took. The page model TRUNCATES each element's value to 80
    // chars, so checking value.includes(fullText) always fails for long inputs —
    // which used to trigger a needless second (identical) type. Instead treat the
    // (possibly truncated) field value as a PREFIX of what we typed: if the field
    // holds a non-empty substring of our text, it landed.
    const v = norm(matchEl(match, fallback)?.value || "");
    const ok = submit ? fpOf(snap.model) !== before : (v.length > 0 && norm(text).includes(v));
    if (ok) return { text: snap.text + (attempt > 1 ? "\n(verified after retry)" : "") };
    if (attempt < 2) await sleep(350);
  }
  return { text: snap.text + "\n(⚠ typed text not reflected after 2 attempts — the field may not have focused)" };
}

// ---- safety gate -----------------------------------------------------------
async function gate(action, el, params, run) {
  safety.assertNotHalted();
  const verdict = safety.classify(action, el, params?.text || "");
  const decision = safety.decide(verdict.risk);
  if (decision === "block") {
    safety.log({ action: verdict.desc, risk: verdict.risk, reason: verdict.reason, decision: "blocked" });
    throw new Error(`BLOCKED by safety policy: ${verdict.desc} (${verdict.reason})`);
  }
  if (decision === "confirm") {
    const token = safety.registerPending(verdict.desc, verdict.risk, run);
    safety.log({ action: verdict.desc, risk: verdict.risk, reason: verdict.reason, decision: "awaiting-confirm", token });
    return { status: "confirm", token, risk: verdict.risk, reason: verdict.reason, summary: verdict.desc };
  }
  safety.log({ action: verdict.desc, risk: verdict.risk, decision: "allowed" });
  const out = await run();
  return { status: "done", text: out.text };
}

// ---- public actions --------------------------------------------------------

export async function navigate(url) {
  await ensure();
  return gate("navigate", { role: "url", name: url }, { url }, async () => {
    record({ kind: "navigate", url });
    return navigateRaw(url);
  });
}

export async function click(i) {
  await ensure();
  const el = findEl(i);
  return gate("click", el, {}, async () => {
    record({ kind: "click", match: matchOf(el) });
    return clickVerified(matchOf(el), el);
  });
}

export async function type(i, text, submit) {
  await ensure();
  const el = findEl(i);
  return gate("type", el, { text }, async () => {
    record({ kind: "type", match: matchOf(el), text, submit: !!submit });
    return typeVerified(matchOf(el), text, !!submit, el);
  });
}

export async function drag(fromI, toI) {
  await ensure();
  const from = findEl(fromI);
  const to = findEl(toI);
  return gate("drag", from, {}, async () => {
    record({ kind: "drag", from: matchOf(from), to: matchOf(to) });
    await exec.dragTo(C(), from.x, from.y, to.x, to.y);
    await sleep(700);
    return read();
  });
}

export async function confirm(token, approve = true) {
  const r = await safety.approve(token, approve);
  if (r.cancelled) return { status: "cancelled", summary: r.summary };
  if (r.waiting) return { status: "waiting", summary: r.summary, how: r.how, file: r.file };
  return { status: "done", text: r.result.text, summary: r.summary };
}

export function halt(on) { return safety.setHalt(on); }
export function safetyStatus() { return { halted: safety.isHalted(), policy: safety.policy() }; }

export async function clickXY(x, y) {
  await ensure();
  safety.assertNotHalted();
  safety.log({ action: `click_xy (${x},${y})`, risk: "unclassified", decision: "allowed" });
  record({ kind: "click_xy", x, y });
  await exec.click(C(), x, y);
  await sleep(700);
  return { status: "done", text: (await read()).text };
}

export async function scroll(dy) {
  await ensure();
  safety.assertNotHalted();
  record({ kind: "scroll", dy });
  await exec.scrollBy(C(), dy);
  await sleep(500);
  return read();
}

export async function back() {
  await ensure();
  safety.assertNotHalted();
  record({ kind: "back" });
  await C().Runtime.evaluate({ expression: "history.back()" });
  await sleep(900);
  return read();
}

export async function screenshot() {
  await ensure();
  const { data } = await C().Page.captureScreenshot({ format: "png" });
  return data;
}

// ---- tabs / targets --------------------------------------------------------

export async function listTabs() { await ensure(); return tabs.list(); }

export async function switchTab(ref) {
  await ensure();
  await tabs.switchTo(ref);
  return read();
}

export async function closeTab() {
  await ensure();
  await tabs.closeActive();
  await sleep(300);
  return read();
}

// ---- flow cache ------------------------------------------------------------

export function clearTrace() { trace = []; }
export function getTrace() { return trace.slice(); }

export async function saveFlow(name) {
  if (trace.length === 0) throw new Error("nothing recorded — drive the task first, then save");
  const host = (() => { try { return new URL(model?.url || "").hostname; } catch { return null; } })();
  const flow = await flowcache.save(name, trace.slice(), { host });
  return { name: flow.name, steps: flow.steps.length, host: flow.host };
}

export async function listFlows() { return flowcache.list(); }

export async function runFlow(name, overrides = {}) {
  await ensure();
  const flow = await flowcache.load(name);
  replaying = true;
  let typeOrdinal = 0;
  let stepsRun = 0;
  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      if (step.kind === "navigate") { await navigateRaw(step.url); stepsRun++; continue; }
      if (step.kind === "scroll") { await exec.scrollBy(C(), step.dy); await sleep(500); await read(); stepsRun++; continue; }
      if (step.kind === "back") { await C().Runtime.evaluate({ expression: "history.back()" }); await sleep(900); await read(); stepsRun++; continue; }
      if (step.kind === "click_xy") { await exec.click(C(), step.x, step.y); await sleep(700); await read(); stepsRun++; continue; }
      if (step.kind === "drag") {
        await read();
        const f = matchEl(step.from), t = matchEl(step.to);
        if (!f || !t) {
          return { ok: false, failedStep: i, stepsRun, total: flow.steps.length,
            reason: `guard failed: could not locate drag ${f ? "target" : "source"} — take over from here`, page: renderForModel(model) };
        }
        await exec.dragTo(C(), f.x, f.y, t.x, t.y);
        await sleep(700); await read();
        stepsRun++; continue;
      }

      await read();
      const el = matchEl(step.match);
      if (!el) {
        return {
          ok: false, failedStep: i, stepsRun, total: flow.steps.length,
          reason: `guard failed: could not locate ${step.match.role} "${step.match.name}" — take over from here`,
          page: renderForModel(model),
        };
      }
      const verdict = safety.classify(step.kind, el, step.text || "");
      if (safety.decide(verdict.risk) !== "allow") {
        safety.log({ action: verdict.desc, risk: verdict.risk, decision: "replay-stopped", flow: name });
        return {
          ok: false, failedStep: i, stepsRun, total: flow.steps.length,
          reason: `safety gate: step is ${verdict.risk} (${verdict.reason}) — perform this step manually so it goes through confirmation`,
          page: renderForModel(model),
        };
      }
      if (step.kind === "click") await clickVerified(step.match, el);
      else if (step.kind === "type") {
        const text = overrides[typeOrdinal] ?? overrides[String(typeOrdinal)] ?? step.text;
        typeOrdinal++;
        await typeVerified(step.match, text, step.submit, el);
      }
      stepsRun++;
    }
    return { ok: true, stepsRun, total: flow.steps.length, page: renderForModel(model) };
  } finally {
    replaying = false;
  }
}

export async function close() {
  await tabs.shutdown();
  started = false;
  return launched;
}
