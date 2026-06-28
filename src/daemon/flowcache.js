// flowcache.js — persist completed tasks as replayable macros.
//
// A flow is an ordered list of steps. Element-targeting steps store a DURABLE
// semantic selector (role + accessible name + type) captured at record time,
// NOT the volatile [index]. On replay the session re-resolves each target
// against a fresh page model, so the macro survives layout/index churn. If a
// target can't be matched, replay stops and the client (LLM) takes over.

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLOW_DIR = path.join(ROOT, "flows");

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

export async function save(name, steps, meta = {}) {
  await mkdir(FLOW_DIR, { recursive: true });
  const flow = { name, steps, host: meta.host || null, savedAt: new Date().toISOString() };
  await writeFile(path.join(FLOW_DIR, slug(name) + ".json"), JSON.stringify(flow, null, 2));
  return flow;
}

export async function load(name) {
  const file = path.join(FLOW_DIR, slug(name) + ".json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`no saved flow named "${name}"`);
  }
}

export async function list() {
  try {
    const files = await readdir(FLOW_DIR);
    const flows = [];
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      try {
        const flow = JSON.parse(await readFile(path.join(FLOW_DIR, f), "utf8"));
        const types = flow.steps.filter((s) => s.kind === "type").length;
        flows.push({ name: flow.name, host: flow.host, steps: flow.steps.length, typeSlots: types });
      } catch {}
    }
    return flows;
  } catch {
    return [];
  }
}
