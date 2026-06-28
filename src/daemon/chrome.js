// chrome.js — launch or attach to the user's real Chrome over CDP.
//
// Design note: we drive the user's REAL Chrome (real profile, cookies, TLS
// fingerprint) rather than a headless/automation build. That real-browser
// posture is the single best anti-detection stance there is. We talk to it
// over the DevTools Protocol on a remote-debugging port.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import CDP from "chrome-remote-interface";

const CHROME_BIN = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
const DEBUG_PORT = Number(process.env.CDP_PORT || 9222);

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
  const profileDir = process.env.CHROME_PROFILE || "/tmp/calude-chrome-profile";
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "about:blank",
  ];
  console.error(`[chrome] launching ${CHROME_BIN} on :${DEBUG_PORT}`);
  const proc = spawn(CHROME_BIN, args, { stdio: "ignore", detached: false });

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
