// agent.js — the brain. A Claude tool-use loop over the semantic page model.
//
// This standalone loop drives the browser THROUGH the session module (not raw
// exec/perceive), so it inherits the same lessons the MCP path already has:
// safety gates + confirmation, verify-and-retry, settle-before-read, the audit
// log, and multi-tab following. The session owns its own Chrome connection.

import Anthropic from "@anthropic-ai/sdk";
import * as session from "./session.js";

const MODEL = process.env.CALUDE_MODEL || "claude-sonnet-5";

const TOOLS = [
  { name: "navigate", description: "Go to a URL.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "click", description: "Click the interactable element with this index from the page model.",
    input_schema: { type: "object", properties: { index: { type: "integer" }, reason: { type: "string" } }, required: ["index"] } },
  { name: "type", description: "Click an input element by index, then type text into it.",
    input_schema: { type: "object", properties: { index: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean", description: "press Enter after" } }, required: ["index", "text"] } },
  { name: "scroll", description: "Scroll the page by dy pixels (positive = down).",
    input_schema: { type: "object", properties: { dy: { type: "integer" } }, required: ["dy"] } },
  { name: "confirm", description: "Approve (or cancel) a pending gated action by its token. Destructive/sensitive actions return a token instead of executing; this proceeds (or cancels with approve:false).",
    input_schema: { type: "object", properties: { token: { type: "string" }, approve: { type: "boolean" } }, required: ["token"] } },
  { name: "done", description: "The task is complete. Provide a short result summary.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
];

const SYSTEM = `You are a browser copilot that operates a real Chrome browser like a human.
You are given a SEMANTIC PAGE MODEL: a list of interactable elements, each with an index [n], role, name, and current value.
Choose ONE tool call per turn. Refer to elements ONLY by their [index].
After each action you will receive the updated page model so you can verify the effect and self-correct.
Some actions (destructive/sensitive: delete, pay, send, publish, credentials…) do NOT execute immediately — they return a CONFIRMATION token. Decide, then call "confirm" with the token to proceed (or approve:false to cancel).
Be efficient. When the goal is achieved, call "done".`;

// Render a gated session envelope as text for the LLM. On a plain "done" the
// text IS the updated page model, so no separate re-read is needed.
function envelopeText(res) {
  switch (res.status) {
    case "confirm":
      return `CONFIRMATION REQUIRED (${res.risk}): ${res.summary}\nreason: ${res.reason}\n→ call confirm {"token":"${res.token}"} to proceed, or {"token":"${res.token}","approve":false} to cancel.`;
    case "waiting":
      return `AWAITING HUMAN APPROVAL — ${res.summary}\n${res.how}`;
    case "cancelled":
      return `cancelled: ${res.summary}`;
    default:
      return res.text;
  }
}

export async function runTask(goal, { maxSteps = 20 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — use --no-llm for the scripted demo.");
  const anthropic = new Anthropic({ apiKey });

  const text = (await session.read()).text;
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
    if (name === "done") { console.log("[agent] DONE: " + input.summary); return input.summary; }

    let resultText;
    try {
      resultText = await applyAction(name, input);
    } catch (e) {
      resultText = "ERROR: " + e.message;
    }

    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }],
    });
  }
  console.log("[agent] step budget exhausted");
  return null;
}

// Session actions already settle, verify-and-retry, and re-read — the envelope's
// text carries the updated page model.
async function applyAction(name, input) {
  switch (name) {
    case "navigate": return envelopeText(await session.navigate(input.url));
    case "click":    return envelopeText(await session.click(input.index));
    case "type":     return envelopeText(await session.type(input.index, input.text, !!input.submit));
    case "scroll":   return (await session.scroll(input.dy)).text;
    case "confirm":  return envelopeText(await session.confirm(input.token, input.approve !== false));
    default:         throw new Error("unknown tool " + name);
  }
}
