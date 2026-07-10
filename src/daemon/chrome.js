// chrome.js — launch or attach to the user's real Chrome over CDP.
//
// Design note: we drive the user's REAL Chrome (real profile, cookies, TLS
// fingerprint) rather than a headless/automation build. That real-browser
// posture is the single best anti-detection stance there is. We talk to it
// over the DevTools Protocol on a remote-debugging port.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";

const DEBUG_PORT = Number(process.env.CDP_PORT || 9222);

// Per-OS Chrome/Chromium locations, checked in order. CHROME_BIN always wins.
const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    (process.env["PROGRAMFILES"] || "C:\\Program Files") + "\\Google\\Chrome\\Application\\chrome.exe",
    (process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)") + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe" : null,
  ],
};

// Resolved lazily inside launchChrome(), NOT at module load: attaching to an
// already-running Chrome on :9222 must work on a machine where we can't find
// (or don't have) a local binary.
export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = (CHROME_CANDIDATES[process.platform] || CHROME_CANDIDATES.linux).filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(
    `no Chrome/Chromium binary found for ${process.platform} — set CHROME_BIN. Tried:\n  ` + candidates.join("\n  ")
  );
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

// Launch Chrome with remote debugging against a dedicated profile so we never
// clobber the user's day-to-day session during the spike. Swap --user-data-dir
// for the real profile path when you want logged-in sessions.
export async function launchChrome() {
  if (await portOpen(DEBUG_PORT)) {
    console.error(`[chrome] reusing existing instance on :${DEBUG_PORT}`);
    return null;
  }
  const chromeBin = findChrome();
  const profileDir = process.env.CHROME_PROFILE || path.join(os.tmpdir(), "calude-chrome-profile");
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "about:blank",
  ];
  console.error(`[chrome] launching ${chromeBin} on :${DEBUG_PORT}`);
  const proc = spawn(chromeBin, args, { stdio: "ignore", detached: false });

  for (let i = 0; i < 40; i++) {
    if (await portOpen(DEBUG_PORT)) break;
    await sleep(250);
  }
  if (!(await portOpen(DEBUG_PORT))) {
    throw new Error(`Chrome did not open debugging port :${DEBUG_PORT}`);
  }
  return proc;
}

// Attach CDP to the active page target and enable the domains we use.
export async function attach() {
  const client = await CDP({ port: DEBUG_PORT });
  const { Page, DOM, Runtime, Input, Network } = client;
  await Promise.all([Page.enable(), DOM.enable(), Runtime.enable(), Network.enable()]);
  // Reduce the most obvious automation tell before any page script runs.
  await Page.addScriptToEvaluateOnNewDocument({
    source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
  });
  return client;
}

export { DEBUG_PORT };
