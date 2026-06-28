// agent.js — the brain. A Claude tool-use loop over the semantic page model.
//
// Spike form: a single capable observe→act→verify loop. The planner/executor
// split and the deterministic flow-cache (replay learned site macros, fall back
// to the model only on failure) layer on top of this later.

import Anthropic from "@anthropic-ai/sdk";
import { perceive, renderForModel } from "./perception.js";
import * as exec from "./executor.js";
import { setTimeout as sleep } from "node:timers/promises";

const MODEL = process.env.CALUDE_MODEL || "claude-sonnet-4-6";

const TOOLS = [
  { name: "navigate", description: "Go to a URL.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "click", description: "Click the interactable element with this index from the page model.",
    input_schema: { type: "object", properties: { index: { type: "integer" }, reason: { type: "string" } }, required: ["index"] } },
  { name: "type", description: "Click an input element by index, then type text into it.",
    input_schema: { type: "object", properties: { index: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean", description: "press Enter after" } }, required: ["index", "text"] } },
  { name: "scroll", description: "Scroll the page by dy pixels (positive = down).",
    input_schema: { type: "object", properties: { dy: { type: "integer" } }, required: ["dy"] } },
  { name: "done", description: "The task is complete. Provide a short result summary.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
];

const SYSTEM = `You are a browser copilot that operates a real Chrome browser like a human.
You are given a SEMANTIC PAGE MODEL: a list of interactable elements, each with an index [n], role, name, and current value.
Choose ONE tool call per turn. Refer to elements ONLY by their [index].
After each action you will receive the updated page model so you can verify the effect and self-correct.
Be efficient. When the goal is achieved, call "done".`;

async function snapshot(client) {
  const model = await perceive(client);
  return { model, text: renderForModel(model) };
}

export async function runTask(client, goal, { maxSteps = 20 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — use --no-llm for the scripted demo.");
  const anthropic = new Anthropic({ apiKey });

  let { model, text } = await snapshot(client);
  const messages = [
    { role: "user", content: `GOAL: ${goal}\n\nCURRENT PAGE:\n${text}` },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages,
    });
    messages.push({ role: "assistant", content: res.content });

    const toolUse = res.content.find((c) => c.type === "tool_use");
    if (!toolUse) {
      const t = res.content.find((c) => c.type === "text");
      console.log("[agent] (no tool) " + (t?.text || ""));
      break;
    }

    const { name, input } = toolUse;
    console.log(`[agent] step ${step + 1}: ${name} ${JSON.stringify(input)}`);
    let resultText;
    try {
      resultText = await applyAction(client, name, input, model);
      if (name === "done") { console.log("[agent] DONE: " + input.summary); return input.summary; }
    } catch (e) {
      resultText = "ERROR: " + e.message;
    }

    await sleep(600); // let the page settle
    ({ model, text } = await snapshot(client));
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: `${resultText}\n\nUPDATED PAGE:\n${text}` }],
    });
  }
  console.log("[agent] step budget exhausted");
  return null;
}

async function applyAction(client, name, input, model) {
  const find = (i) => {
    const el = model.elements.find((e) => e.i === i);
    if (!el) throw new Error(`no element [${i}] in page model`);
    return el;
  };
  switch (name) {
    case "navigate":
      await client.Page.navigate({ url: input.url });
      await client.Page.loadEventFired();
      return `navigated to ${input.url}`;
    case "click": {
      const el = find(input.index);
      await exec.click(client, el.x, el.y);
      return `clicked [${input.index}] ${el.role} "${el.name}"`;
    }
    case "type": {
      const el = find(input.index);
      await exec.click(client, el.x, el.y);
      await exec.typeText(client, input.text);
      if (input.submit) await exec.pressEnter(client);
      return `typed into [${input.index}]${input.submit ? " + Enter" : ""}`;
    }
    case "scroll":
      await exec.scrollBy(client, input.dy);
      return `scrolled ${input.dy}px`;
    case "done":
      return input.summary;
    default:
      throw new Error("unknown tool " + name);
  }
}
