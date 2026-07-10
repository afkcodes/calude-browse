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

// Per-target network log: a ring buffer of {requestId, method, url, resourceType,
// status, mimeType, hasPostData, postData, finished}. Network domain is already
// enabled per target below; this just listens and remembers what it sees so
// browser_read_network can show "what API calls did this page make" without a
// screenshot or a separate devtools session.
const NET_CAP = 300;
const networkLogs = new Map(); // targetId -> array

function attachNetworkLog(client, targetId) {
  const log = [];
  networkLogs.set(targetId, log);
  client.Network.requestWillBeSent((p) => {
    log.push({
      requestId: p.requestId,
      method: p.request.method,
      url: p.request.url,
      resourceType: p.type,
      hasPostData: !!p.request.hasPostData,
      postData: p.request.postData,
      status: null,
      mimeType: null,
      finished: false,
    });
    if (log.length > NET_CAP) log.shift();
  });
  client.Network.responseReceived((p) => {
    const e = log.find((e) => e.requestId === p.requestId);
    if (e) { e.status = p.response.status; e.mimeType = p.response.mimeType; }
  });
  client.Network.loadingFinished((p) => {
    const e = log.find((e) => e.requestId === p.requestId);
    if (e) e.finished = true;
  });
  // Clear on a top-level navigation, like devtools' network panel without
  // "preserve log" — otherwise calls from the previous page linger and confuse
  // "what does THIS page call". Truncate IN PLACE (not networkLogs.set(id, []))
  // — the requestWillBeSent/etc listeners above close over this exact `log`
  // array; replacing the map entry would leave them writing into an orphaned
  // array that getNetworkLog() (which reads the map) never sees again.
  client.Page.frameNavigated(({ frame }) => {
    if (!frame.parentId) log.length = 0;
  });
}

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
  attachNetworkLog(client, targetId);
  client.on("disconnect", () => {
    clients.delete(targetId);
    networkLogs.delete(targetId);
    if (activeId === targetId) activeId = [...clients.keys()].pop() || null;
  });
  clients.set(targetId, client);
  if (makeActive || !activeId) activeId = targetId;
}

export async function init() {
  await shutdown(); // recovery-safe: tear down any stale connection before (re)connecting
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
    networkLogs.delete(targetId);
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

// Is the CDP connection actually live? Cheap socket probe used for auto-recovery
// (a dropped Chrome/socket otherwise bricks the session until an MCP reconnect).
export async function healthy() {
  if (!browser || !activeId || !clients.has(activeId)) return false;
  try { await browser.Target.getTargets(); return true; }
  catch { return false; }
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

export function getNetworkLog(targetId) {
  return (networkLogs.get(targetId || activeId) || []).slice();
}

export function clearNetworkLog(targetId) {
  // Truncate in place — see the comment in attachNetworkLog's frameNavigated
  // handler for why networkLogs.set(id, []) would orphan the listeners' array.
  const log = networkLogs.get(targetId || activeId);
  if (log) log.length = 0;
}

export async function getResponseBody(requestId, targetId) {
  const client = clients.get(targetId || activeId);
  if (!client) throw new Error("no active browser target");
  return client.Network.getResponseBody({ requestId });
}

export async function shutdown() {
  for (const c of clients.values()) { try { await c.close(); } catch {} }
  clients.clear();
  if (browser) { try { await browser.close(); } catch {} }
  browser = null;
  activeId = null;
}
