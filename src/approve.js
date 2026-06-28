#!/usr/bin/env node
// approve.js — the HUMAN side of the confirmation gate / kill switch.
//
// When safety.json has "confirmedBy":"human", a gated action waits until a
// human runs this with the token. Also toggles the kill switch out-of-band.
//
//   node src/approve.js <token>     approve a pending gated action
//   node src/approve.js --halt      engage the kill switch (stop everything)
//   node src/approve.js --resume    release the kill switch
//   node src/approve.js --list      list pending confirmations

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as safety from "./daemon/safety.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PENDING_DIR = path.join(ROOT, "pending");
const arg = process.argv[2];

if (!arg) {
  console.log("usage: node src/approve.js <token> | --halt | --resume | --list");
  process.exit(1);
}
if (arg === "--halt") { safety.setHalt(true); console.log("🛑 kill switch engaged (.halt written)"); }
else if (arg === "--resume") { safety.setHalt(false); console.log("✅ resumed (.halt removed)"); }
else if (arg === "--list") {
  let files = [];
  try { files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json")); } catch {}
  if (!files.length) { console.log("(no pending confirmations)"); }
  for (const f of files) console.log(fs.readFileSync(path.join(PENDING_DIR, f), "utf8"));
} else {
  safety.humanApprove(arg);
  console.log(`👍 approved ${arg} — the daemon will execute it on the next browser_confirm call.`);
}
