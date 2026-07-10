#!/usr/bin/env node
// cli.js — entry point. Launch/attach Chrome, then either run an LLM-driven
// task or a scripted no-LLM demo that exercises the CDP perception + trusted
// input + motion layers without needing an API key.

import { launchChrome, attach } from "./daemon/chrome.js";
import { perceive, renderForModel } from "./daemon/perception.js";
import * as exec from "./daemon/executor.js";
import * as session from "./daemon/session.js";
import { runTask } from "./daemon/agent.js";
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs(argv) {
  const args = { noLlm: false, start: null, goal: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-llm") args.noLlm = true;
    else if (a === "--start") args.start = argv[++i];
    else rest.push(a);
  }
  args.goal = rest.join(" ").trim() || null;
  return args;
}

async function navigate(client, url) {
  await client.Page.navigate({ url });
  // loadEventFired NEVER resolves when Chrome is already on this URL or the SPA
  // does an in-page route change — and an unresolved promise is not a rejected
  // one, so .catch() cannot save you. Race it against a deadline (same pattern
  // as session.navigateRaw).
  await Promise.race([
    client.Page.loadEventFired().catch(() => {}),
    sleep(2500),
  ]);
  await sleep(800);
}

// Scripted demo: prove perception + humanized type/submit work end to end.
async function scriptedDemo(client, start) {
  const url = start || "https://lite.duckduckgo.com/lite/";
  console.log(`[demo] navigating to ${url}`);
  await navigate(client, url);

  let model = await perceive(client);
  console.log("\n=== PAGE MODEL ===\n" + renderForModel(model) + "\n");

  const box = model.elements.find((e) => e.role === "textbox" || e.type === "text" || e.type === "search" || e.role === "searchbox");
  if (box) {
    console.log(`[demo] typing into [${box.i}] "${box.name}" with human cadence...`);
    await exec.click(client, box.x, box.y);
    await exec.typeText(client, "anthropic claude");
    await exec.pressEnter(client);
    await sleep(1500);
    model = await perceive(client);
    console.log("\n=== RESULTS PAGE MODEL ===\n" + renderForModel(model) + "\n");
  } else {
    console.log("[demo] no input found; perception-only demo complete.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Scripted --no-llm demo stays on the raw client path (no LLM, no session).
  if (args.noLlm) {
    const proc = await launchChrome();
    const client = await attach();
    console.log("[cdp] attached.");
    try {
      await scriptedDemo(client, args.start);
    } finally {
      await client.close();
      if (proc) console.log("[chrome] launched instance left running on debug port.");
    }
    return;
  }

  if (!args.goal) {
    console.error('Usage: node src/cli.js "your goal here"   (or --no-llm for the scripted demo)');
    process.exit(1);
  }
  // LLM path: the session module owns its Chrome connection (launch/attach,
  // auto-recovery) and applies the safety gates + verify-retry, so we no longer
  // attach our own client here.
  try {
    if (args.start) await session.navigate(args.start);
    const result = await runTask(args.goal);
    console.log("\n=== RESULT ===\n" + (result ?? "(incomplete)"));
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
