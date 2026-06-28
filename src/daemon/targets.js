// targets.js — multi-target manager: tracks every page/tab/popup, keeps a
// per-target CDP client, and tracks which one is "active". When a click opens a
// popup or new tab (window.open, target=_blank, OAuth windows), it auto-focuses
// it so the copilot can read/drive it — the single-tab limitation is gone.

import CDP from "chrome-remote-interface";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.CDP_PORT || 9222);

let browser = null;             // browser-level CDP connection (Target domain)
const clients = new Map();      // targetId -> per-target CDP client
let activeId = null;

async function enableDomains(client) {
  const { Page, DOM, Runtime, Network } = client;
  await Promise.all([Page.enable(), DOM.enable(), Runtime.enable(), Network.enable()]);
  await Page.addScriptToEvaluateOnNewDocument({
    source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
  }).catch(() => {});
}

async function addTarget(targetId, makeActive) {
  if (clients.has(targetId)) { if (makeActive) activeId = targetId; return; }
  // brief retry: a just-created target's ws endpoint can lag a beat
  let client;
  for (let i = 0; i < 6 && !client; i++) {
    try { client = await CDP({ port: PORT, target: targetId }); }
    catch { await sleep(150); }
  }
  if (!client) return;
  await enableDomains(client);
  client.on("disconnect", () => {
    clients.delete(targetId);
    if (activeId === targetId) activeId = [...clients.keys()].pop() || null;
  });
  clients.set(targetId, client);
  if (makeActive || !activeId) activeId = targetId;
}

export async function init() {
  if (browser) return;
  const { webSocketDebuggerUrl } = await CDP.Version({ port: PORT });
  browser = await CDP({ target: webSocketDebuggerUrl });
  await browser.Target.setDiscoverTargets({ discover: true });

  // Auto-attach to popups/new tabs opened from a page (they carry an openerId).
  browser.Target.targetCreated(async ({ targetInfo }) => {
    if (targetInfo.type !== "page") return;
    const isPopup = !!targetInfo.openerId;
    try { await addTarget(targetInfo.targetId, isPopup); } catch {}
  });
  browser.Target.targetDestroyed(({ targetId }) => {
    const c = clients.get(targetId);
    if (c) c.close().catch(() => {});
    clients.delete(targetId);
    if (activeId === targetId) activeId = [...clients.keys()].pop() || null;
  });

  // Attach to any page targets that already exist.
  const { targetInfos } = await browser.Target.getTargets();
  for (const t of targetInfos.filter((t) => t.type === "page")) {
    await addTarget(t.targetId, false);
  }
  if (!activeId && clients.size) activeId = [...clients.keys()][0];
}

export function active() {
  const c = clients.get(activeId);
  if (!c) throw new Error("no active browser target — call ensure()/read() first");
  return c;
}

export async function list() {
  const { targetInfos } = await browser.Target.getTargets();
  const byId = new Map(targetInfos.map((t) => [t.targetId, t]));
  // Stable open-order indices (first-attached tab = 0), not Chrome's report order.
  const out = [];
  let i = 0;
  for (const id of clients.keys()) {
    const t = byId.get(id);
    if (t && t.type === "page") out.push({ index: i++, targetId: id, url: t.url, title: t.title, active: id === activeId });
  }
  return out;
}

export async function switchTo(ref) {
  // ref may be a targetId or a 0-based index into list()
  if (clients.has(ref)) { activeId = ref; return; }
  const pages = await list();
  const byIndex = pages[Number(ref)];
  if (byIndex && clients.has(byIndex.targetId)) { activeId = byIndex.targetId; return; }
  throw new Error(`unknown tab "${ref}" — use browser_list_tabs`);
}

export async function closeActive() {
  const id = activeId;
  if (!id) throw new Error("no active tab to close");
  try { await browser.Target.closeTarget({ targetId: id }); } catch {}
  clients.delete(id);
  activeId = [...clients.keys()].pop() || null;
}

export function count() { return clients.size; }

export async function shutdown() {
  for (const c of clients.values()) { try { await c.close(); } catch {} }
  clients.clear();
  if (browser) { try { await browser.close(); } catch {} }
  browser = null;
  activeId = null;
}
