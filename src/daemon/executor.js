// executor.js — perform actions via TRUSTED CDP input events.
//
// Input.dispatchMouseEvent / dispatchKeyEvent produce isTrusted=true events
// with real client coordinates. Combined with motion.js, the page (and any
// mouse-trajectory fingerprinter) sees a human-like interaction. These work in
// background tabs, so the user keeps their machine. The OS-level escalation
// tier (CGEvent/SendInput/uinput) plugs in here later behind a "takeover" flag.

import { setTimeout as sleep } from "node:timers/promises";
import { mousePath, typingPlan } from "./motion.js";

// Track the virtual cursor position so paths start from where we "are".
let cursor = { x: 1, y: 1 };

async function moveAlong(Input, from, to) {
  // The humanized move is cosmetic — the trusted press/release at the target are
  // what make the event isTrusted. A single mouseMoved dispatch can hang for tens
  // of seconds over an autoplaying video / heavy-compositing region, so bound each
  // step; if one stalls, abandon the path and let the caller's press land at the
  // target anyway. Never let humanization wedge the whole action.
  for (const p of mousePath(from, to)) {
    if (p.dt) await sleep(p.dt);
    const moved = await Promise.race([
      Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x, y: p.y, buttons: 0 }).then(() => true),
      sleep(1200).then(() => false),
    ]);
    cursor = { x: p.x, y: p.y };
    if (!moved) break;  // a step hung; stop moving, press will still fire at `to`
  }
  cursor = { x: to.x, y: to.y };
}

export async function moveTo(client, x, y) {
  await moveAlong(client.Input, cursor, { x, y });
}

export async function click(client, x, y) {
  const { Input } = client;
  await moveAlong(Input, cursor, { x, y });
  await sleep(40 + Math.round(Math.random() * 90)); // dwell before press
  const common = { x, y, button: "left", clickCount: 1 };
  await Input.dispatchMouseEvent({ type: "mousePressed", buttons: 1, ...common });
  await sleep(45 + Math.round(Math.random() * 60));
  await Input.dispatchMouseEvent({ type: "mouseReleased", buttons: 0, ...common });
  cursor = { x, y };
}

// Type with human cadence. Uses dispatchKeyEvent("char") for text and a real
// keyDown/keyUp for Backspace so editors/React handlers fire correctly.
export async function typeText(client, text) {
  const { Input } = client;
  for (const step of typingPlan(text)) {
    await sleep(step.dt);
    if (step.type === "backspace") {
      await Input.dispatchKeyEvent({ type: "keyDown", windowsVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
      await Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 8, key: "Backspace", code: "Backspace" });
    } else if (step.ch === "\n" || step.ch === "\r") {
      // A "char" event carrying "\n" does NOT insert a line break in a textarea
      // or contenteditable — that needs a real Enter key event. Emit one so
      // multi-line input (YAML/config, code, messages) keeps its line breaks.
      await Input.dispatchKeyEvent({ type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" });
      await Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    } else {
      await Input.dispatchKeyEvent({ type: "char", text: step.ch });
    }
  }
}

export async function pressEnter(client) {
  const { Input } = client;
  await Input.dispatchKeyEvent({ type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" });
  await Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
}

export async function scrollBy(client, dy) {
  // Scroll via JS, not a synthetic mouse wheel. dispatchMouseEvent({mouseWheel})
  // can hang for tens of seconds when the cursor sits over an autoplaying video
  // or a wheel-capturing widget (some feeds have both). window.scrollBy is
  // instant, cursor-independent, and does not wait on scroll-animation frames.
  // Fall back to the wheel event only if JS eval is somehow unavailable.
  const { Runtime, Input } = client;
  try {
    await Runtime.evaluate({
      expression: `window.scrollBy({top:${Number(dy) || 0},left:0,behavior:'instant'})`,
      awaitPromise: false, returnByValue: true,
    });
  } catch {
    await Input.dispatchMouseEvent({ type: "mouseWheel", x: cursor.x, y: cursor.y, deltaX: 0, deltaY: dy });
  }
}

// Trusted, humanized drag-and-drop: press at source, glide to target along a
// curved path while the button is held (most sortable/DnD libraries require the
// intermediate mouseMoved stream to register a real drag), then release.
export async function dragTo(client, fromX, fromY, toX, toY) {
  const { Input } = client;
  await moveAlong(Input, cursor, { x: fromX, y: fromY });
  await sleep(80 + Math.round(Math.random() * 80));
  await Input.dispatchMouseEvent({ type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1 });
  await sleep(120 + Math.round(Math.random() * 90)); // grab dwell
  for (const p of mousePath({ x: fromX, y: fromY }, { x: toX, y: toY })) {
    if (p.dt) await sleep(p.dt);
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
    cursor = { x: p.x, y: p.y };
  }
  await sleep(120 + Math.round(Math.random() * 90)); // settle before drop
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1 });
  cursor = { x: toX, y: toY };
}

// Ensure the element at (x,y) is in view; if off-screen, scroll then re-perceive
// upstream. Here we just nudge via wheel and let the caller re-perceive.
export async function ensureInView(client, model, el) {
  if (el.y >= 0 && el.y <= 720) return false; // roughly visible
  await scrollBy(client, el.y - 360);
  await sleep(400);
  return true; // signal caller to re-perceive
}

// Clear the currently-focused field (select-all + delete). Used before typing
// so a (re)type REPLACES rather than appends — fixes garble on verify-retry.
export async function clearField(client) {
  const { Input } = client;
  const a = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 };
  await Input.dispatchKeyEvent({ type: "keyDown", modifiers: 2, ...a }); // modifiers:2 = Ctrl
  await Input.dispatchKeyEvent({ type: "keyUp", modifiers: 2, ...a });
  const del = { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 };
  await Input.dispatchKeyEvent({ type: "keyDown", ...del });
  await Input.dispatchKeyEvent({ type: "keyUp", ...del });
  await sleep(30);
}
