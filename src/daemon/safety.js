// safety.js — risk classification, policy, kill switch, audit log, and a
// two-step confirmation gate for irreversible/outbound actions.
//
// Threat model: the MCP client (an LLM) drives the browser. We must not let it
// silently delete data, spend money, or send messages on the user's behalf, and
// a human must be able to STOP everything instantly. So:
//   - every mutating action is classified and run through a policy;
//   - destructive/sensitive actions require explicit confirmation, which can be
//     gated on a HUMAN out-of-band approval (not agent self-approval);
//   - a filesystem kill-switch is checked before every action;
//   - everything is appended to an audit log.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAFETY_FILE = path.join(ROOT, "safety.json");
const HALT_FILE = path.join(ROOT, ".halt");
const LOG_FILE = path.join(ROOT, "logs", "actions.jsonl");
const PENDING_DIR = path.join(ROOT, "pending");

const DEFAULT_POLICY = {
  destructive: "confirm", // allow | confirm | block
  sensitive: "confirm",
  confirmedBy: "agent",   // "agent" = the LLM may approve its own confirm step;
                          // "human" = approval must come from `calude approve <token>`
  blocklist: [],          // regex strings -> force block
  allowlist: [],          // regex strings -> force allow
};

let _memHalt = false;

export function policy() {
  try {
    return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(SAFETY_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

// ---- classification --------------------------------------------------------

// Truly irreversible / outbound / financial intent. Deliberately NOT triggered
// by generic "submit"/"search" so everyday navigation isn't gated to death.
const DESTRUCTIVE =
  /\b(delete|remove|deactivate|close account|delete account|unsubscribe|buy now|purchase|place order|pay now|checkout|confirm (payment|order|purchase)|transfer|withdraw|send (money|payment|email|message)|publish|post tweet|log ?out|sign ?out)\b/i;
const SENSITIVE_FIELD = /\b(password|passcode|card number|credit card|cvv|cvc|ssn|social security|account number|routing|otp|one[- ]time)\b/i;

export function classify(action, el = {}, text = "") {
  const desc = `${action} ${el.role || ""} "${el.name || ""}" ${el.value || ""}`.trim();
  const pol = policy();

  // A blocklist match FORCES a block regardless of policy: carry force:"block"
  // so decide() cannot map it through the (default "confirm") destructive policy
  // and let the agent self-approve it.
  for (const re of pol.blocklist) if (new RegExp(re, "i").test(desc)) return { risk: "destructive", force: "block", reason: `matches blocklist /${re}/`, desc };
  for (const re of pol.allowlist) if (new RegExp(re, "i").test(desc)) return { risk: "safe", reason: "allowlisted", desc };

  if (action === "type") {
    if (el.type === "password" || SENSITIVE_FIELD.test(`${el.name} ${el.type} ${text}`)) {
      return { risk: "sensitive", reason: "entering a credential/payment field", desc };
    }
  }
  if (action === "click" && DESTRUCTIVE.test(`${el.name} ${el.value}`)) {
    return { risk: "destructive", reason: `target looks irreversible/outbound: "${el.name}"`, desc };
  }
  return { risk: "safe", reason: "", desc };
}

export function decide(risk) {
  // Accepts a verdict object OR a bare risk string. A verdict may carry
  // force:"block" (blocklist match) which overrides policy — a blocklisted
  // action can never be downgraded to a self-approvable "confirm".
  if (risk && typeof risk === "object") {
    if (risk.force) return risk.force;
    risk = risk.risk;
  }
  if (risk === "safe") return "allow";
  return policy()[risk] || "confirm";
}

// ---- kill switch -----------------------------------------------------------

export function isHalted() { return _memHalt || fs.existsSync(HALT_FILE); }
export function assertNotHalted() {
  if (isHalted()) throw new Error("HALTED: kill switch is engaged — call browser_resume (or remove the .halt file) to continue");
}
export function setHalt(on) {
  _memHalt = !!on;
  try { on ? fs.writeFileSync(HALT_FILE, new Date().toISOString()) : fs.existsSync(HALT_FILE) && fs.unlinkSync(HALT_FILE); } catch {}
  return on;
}

// ---- audit log -------------------------------------------------------------

export function log(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// ---- confirmation gate -----------------------------------------------------

const pending = new Map(); // token -> { summary, risk, run }

export function registerPending(summary, risk, run) {
  const token = crypto.randomUUID().slice(0, 8);
  pending.set(token, { summary, risk, run });
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, token + ".json"), JSON.stringify({ token, summary, risk, ts: new Date().toISOString() }, null, 2));
  } catch {}
  return token;
}

function cleanup(token) {
  pending.delete(token);
  for (const ext of [".json", ".approved"]) {
    try { fs.unlinkSync(path.join(PENDING_DIR, token + ext)); } catch {}
  }
}

// Approve/cancel a pending action. In "human" mode, approval is only honored if
// a human created pending/<token>.approved (via `calude approve <token>`).
export async function approve(token, ok = true) {
  const p = pending.get(token);
  if (!p) throw new Error(`unknown or expired confirmation token "${token}"`);
  if (!ok) { log({ action: p.summary, risk: p.risk, decision: "cancelled" }); cleanup(token); return { cancelled: true, summary: p.summary }; }

  if (policy().confirmedBy === "human" && !fs.existsSync(path.join(PENDING_DIR, token + ".approved"))) {
    return { waiting: true, summary: p.summary, file: path.join(PENDING_DIR, token + ".json"), how: `a human must run:  node src/approve.js ${token}` };
  }
  // Kill switch covers approved actions too: if halted, throw WITHOUT consuming
  // the token so the action stays pending and can be approved after resume.
  assertNotHalted();
  log({ action: p.summary, risk: p.risk, decision: "confirmed-executed" });
  const result = await p.run();
  cleanup(token);
  return { result, summary: p.summary };
}

// Used by the approve CLI to mark a human approval.
export function humanApprove(token) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR, token + ".approved"), new Date().toISOString());
}

export { LOG_FILE, HALT_FILE };
