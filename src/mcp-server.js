#!/usr/bin/env node
// mcp-server.js — exposes the human-like browser-control layer as MCP tools.
//
// THE MOAT: any MCP client (Claude Code, Claude Desktop, etc.) becomes the brain
// and drives a real Chrome through TRUSTED, humanized input over these tools.
// No API key needed here — the connecting client supplies the reasoning loop.
//
// Protocol note: stdout is the MCP channel. All logging goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as session from "./daemon/session.js";

const TOOLS = [
  {
    name: "browser_read",
    description:
      "Read the current page as a semantic model: a list of interactable elements, each with [index], role, accessible name, and current value. ALWAYS call this first, and rely on its result after every action to choose the next element by [index]. No screenshots needed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_navigate",
    description: "Navigate the browser to a URL. Returns the new page's semantic model.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_click",
    description: "Click the element with the given [index] from the latest page model, using a humanized cursor path and trusted input. Returns the updated page model.",
    inputSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
  },
  {
    name: "browser_type",
    description: "Focus the input element at [index], then type text with human cadence. Set submit=true to press Enter afterward. Returns the updated page model.",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean" } },
      required: ["index", "text"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page by dy pixels (positive = down). Returns the updated page model.",
    inputSchema: { type: "object", properties: { dy: { type: "integer" } }, required: ["dy"] },
  },
  {
    name: "browser_drag",
    description: "Drag the element at [from] onto the element at [to] — for reordering lists, moving items, or slider/drag-and-drop UIs. Uses trusted, humanized mouse motion (press, glide, release). Returns the updated page model.",
    inputSchema: { type: "object", properties: { from: { type: "integer" }, to: { type: "integer" } }, required: ["from", "to"] },
  },
  {
    name: "browser_click_xy",
    description: "FALLBACK: click at absolute viewport pixel coordinates (x, y) — for controls NOT in the page model (unlabeled/custom checkboxes, canvas, icons). Read coordinates off browser_screenshot (its pixels match these at the default 1x scale). Prefer browser_click by [index] whenever the element is in the model; this isn't risk-classified since there's no element context.",
    inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] },
  },
  {
    name: "browser_back",
    description: "Go back in browser history. Returns the updated page model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_list_tabs",
    description: "List all open tabs/popups/windows (index, url, title, which is active). Popups and new tabs opened by a click are auto-focused, so browser_read already follows them — use this to see or switch between multiple.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_switch_tab",
    description: "Switch the active tab by its index (from browser_list_tabs) or targetId. Returns the page model of that tab.",
    inputSchema: { type: "object", properties: { tab: { type: "string", description: "index (e.g. \"0\") or targetId" } }, required: ["tab"] },
  },
  {
    name: "browser_close_tab",
    description: "Close the active tab and switch to another open one. Returns its page model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the viewport. Use ONLY as a fallback when the semantic model can't describe a widget (e.g. canvas/WebGL).",
    inputSchema: { type: "object", properties: {} },
  },
  // ---- flow cache: record a task once, replay it cheaply forever ----
  {
    name: "browser_clear_trace",
    description: "Clear the recorded action trace. Call this right BEFORE driving a task you intend to save as a reusable flow.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_save_flow",
    description: "Save the actions taken since the last clear as a named, replayable flow (a deterministic macro keyed by role+name selectors). Do this after successfully completing a task.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "browser_list_flows",
    description: "List saved flows (name, host, step count, number of typeable slots).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_run_flow",
    description:
      "Replay a saved flow WITHOUT reasoning each step (fast + cheap + deterministic). 'overrides' maps a 0-based type-step ordinal to replacement text (e.g. {\"0\":\"new query\"}) to reuse the flow with different input. If a step's target can't be found the replay stops and returns the page so you can take over from there.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, overrides: { type: "object", additionalProperties: { type: "string" } } },
      required: ["name"],
    },
  },
  // ---- safety: confirmation gate + kill switch ----
  {
    name: "browser_confirm",
    description: "Approve (or cancel) a pending gated action by its token. Destructive/sensitive actions return a token instead of executing; this proceeds. If the policy requires HUMAN approval, this will report it is still awaiting an out-of-band approval.",
    inputSchema: { type: "object", properties: { token: { type: "string" }, approve: { type: "boolean", description: "false to cancel" } }, required: ["token"] },
  },
  {
    name: "browser_halt",
    description: "KILL SWITCH: immediately block all further browser actions until resumed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_resume",
    description: "Release the kill switch so actions can run again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_safety_status",
    description: "Report whether the kill switch is engaged and the current safety policy.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "calude-browse", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "browser_read":     return text((await session.read()).text);
      case "browser_navigate": return formatAction(await session.navigate(args.url));
      case "browser_click":    return formatAction(await session.click(args.index));
      case "browser_type":     return formatAction(await session.type(args.index, args.text, !!args.submit));
      case "browser_confirm":  return formatAction(await session.confirm(args.token, args.approve !== false));
      case "browser_halt":     session.halt(true);  return text("🛑 KILL SWITCH ENGAGED — all actions blocked. Call browser_resume to continue.");
      case "browser_resume":   session.halt(false); return text("✅ resumed — actions enabled.");
      case "browser_safety_status": return text(JSON.stringify(session.safetyStatus(), null, 2));
      case "browser_scroll":   return text((await session.scroll(args.dy)).text);
      case "browser_drag":     return formatAction(await session.drag(args.from, args.to));
      case "browser_click_xy": return formatAction(await session.clickXY(args.x, args.y));
      case "browser_back":     return text((await session.back()).text);
      case "browser_list_tabs": return text(JSON.stringify(await session.listTabs(), null, 2));
      case "browser_switch_tab": return text((await session.switchTab(args.tab)).text);
      case "browser_close_tab":  return text((await session.closeTab()).text);
      case "browser_screenshot": {
        const data = await session.screenshot();
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }
      case "browser_clear_trace": session.clearTrace(); return text("trace cleared — drive the task now, then browser_save_flow.");
      case "browser_save_flow":   return text(`saved flow ${JSON.stringify(await session.saveFlow(args.name))}`);
      case "browser_list_flows":  return text(JSON.stringify(await session.listFlows(), null, 2));
      case "browser_run_flow": {
        const r = await session.runFlow(args.name, args.overrides || {});
        const header = r.ok
          ? `FLOW OK — replayed ${r.stepsRun}/${r.total} steps.`
          : `FLOW STOPPED at step ${r.failedStep} (${r.stepsRun}/${r.total} done). ${r.reason}`;
        return text(`${header}\n\nPAGE:\n${r.page}`);
      }
      default:
        return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    }
  } catch (e) {
    console.error(`[mcp] ${name} failed:`, e.message);
    return { isError: true, content: [{ type: "text", text: `ERROR: ${e.message}` }] };
  }
});

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

// Render the safety-gate envelope returned by gated session actions.
function formatAction(res) {
  switch (res.status) {
    case "confirm":
      return text(
        `⚠️ CONFIRMATION REQUIRED (${res.risk}): ${res.summary}\n` +
        `reason: ${res.reason}\n` +
        `→ to proceed: browser_confirm {"token":"${res.token}"}\n` +
        `→ to cancel:  browser_confirm {"token":"${res.token}","approve":false}`
      );
    case "waiting":
      return text(`⏳ awaiting HUMAN approval — ${res.summary}\n${res.how}`);
    case "cancelled":
      return text(`✋ cancelled: ${res.summary}`);
    default:
      return text(res.text);
  }
}

async function shutdown() {
  await session.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] calude-browse server ready on stdio");
