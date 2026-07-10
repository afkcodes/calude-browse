# calude-browse

A human-like AI browser copilot. It drives the user's **real Chrome** over the
DevTools Protocol — **trusted input events** + **accessibility-tree perception**
— so it operates the browser the way a person does, not by screenshotting and
clicking pixels.

## Why this architecture

- **Real Chrome, real profile** → best anti-detection posture (real cookies, TLS,
  fingerprint), not a headless automation build.
- **Trusted CDP input** (`Input.dispatchMouseEvent` / `dispatchKeyEvent`) →
  `isTrusted=true` events that behave like real input and work in background tabs.
- **Semantic page model** (roles + names + geometry) instead of screenshots →
  cheaper, more robust, survives restyling.
- **Humanized motion** (Bézier paths, velocity curves, typing cadence) → serves
  transparency, real automation, and behavioral anti-detection at once.

## Layout

```
src/
  cli.js                entry point
  daemon/
    chrome.js           launch/attach the user's Chrome over CDP
    perception.js       AX/DOM -> compact semantic page model
    motion.js           humanized Bézier paths + typing cadence (pure math)
    executor.js         trusted CDP input: move / click / type / scroll
    agent.js            Claude tool-use loop (observe -> act -> verify)
```

## Use it as an MCP server (the moat)

The human-like browser-control layer is exposed over MCP, so **any MCP client
becomes the brain** — Claude Code, Claude Desktop, or our own agent — and drives
a real Chrome through trusted, humanized input. No API key required here; the
connecting client supplies the reasoning loop.

Tools: `browser_read`, `browser_read_text` (page prose), `browser_navigate`,
`browser_click`, `browser_click_xy`, `browser_type`, `browser_press` (named
keys — Escape/arrows/Tab), `browser_select` (native dropdowns), `browser_drag`,
`browser_scroll`, `browser_back`,
`browser_screenshot` (vision fallback), tabs (`browser_list_tabs`,
`browser_switch_tab`, `browser_close_tab`), the flow cache (`browser_clear_trace`, `browser_save_flow`,
`browser_list_flows`, `browser_run_flow`), and safety (`browser_confirm`,
`browser_halt`, `browser_resume`, `browser_safety_status`).

**Claude Code** — a project-scoped `.mcp.json` is already committed here, so just
run Claude Code in this directory and approve the server. Or register it anywhere:

```bash
claude mcp add calude-browse -- node /home/ashish/projects/calude_browse/src/mcp-server.js
```

**Claude Desktop / other clients** — add to the client's MCP config:

```json
{ "mcpServers": { "calude-browse": {
  "command": "node",
  "args": ["/home/ashish/projects/calude_browse/src/mcp-server.js"]
} } }
```

Then just ask: *"read the page, search for X, open the first result."* The client
calls `browser_*` tools; element indexes from the latest `browser_read` stay valid.

## Run standalone

Scripted demo (no API key — exercises perception + trusted input + motion):

```bash
npm run demo
# or target a page:  node src/cli.js --no-llm --start https://example.com
```

Bring-your-own-LLM agent loop (API key path):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli.js "search for the latest Claude model and open the first result"
```

Env: `CHROME_BIN`, `CDP_PORT` (9222), `CHROME_PROFILE`, `CALUDE_MODEL`.

## Flow cache (record once, replay forever)

A flow is a completed task compiled into a deterministic macro. Each element step
stores a **durable selector** (role + accessible name + type) captured at record
time — not the volatile `[index]` — so replay survives layout/index churn. On
replay the session re-resolves each target against a fresh page model; if a target
can't be found the replay stops and hands the live page back so the LLM can take
over from that step. Flows live in `flows/<name>.json`.

```
browser_clear_trace                      # start recording
… drive the task (navigate/type/click) …
browser_save_flow {name: "ddg-search"}   # compile to a macro
browser_run_flow  {name: "ddg-search",   # replay — no LLM reasoning per step
                   overrides: {"0": "new query"}}   # reuse with different input
```

`overrides` maps a 0-based type-step ordinal to replacement text, so one flow
handles any search query / form value. Verified: a recorded DuckDuckGo search
replays with a different query by re-resolving the box semantically.

## Safety gates

Before the copilot can touch real logged-in accounts, every **mutating** action
passes through `daemon/safety.js`:

- **Risk classifier** — clicks on irreversible/outbound targets (delete, purchase,
  pay, transfer, send, publish, log out…) are `destructive`; typing into
  password/card/OTP fields is `sensitive`; everything else is `safe`.
- **Policy** (`safety.json`) — each risk maps to `allow | confirm | block`.
  Gated actions return a `CONFIRMATION REQUIRED` token instead of executing;
  `browser_confirm {token}` proceeds, `{token, approve:false}` cancels.
- **Blocklist always hard-blocks** — a `blocklist` regex match forces a `block`
  regardless of the risk policy, so it can never be downgraded to a
  self-approvable `confirm`. `allowlist` forces `allow`.
- **`click_xy` is risk-classified** when its coordinates land on a known model
  element (it routes through the same gate as `browser_click`, so a coordinate
  click onto a "Delete"/"Send" control can't bypass the policy); it stays
  unclassified only when it lands on empty/unknown space.
- **Human-in-the-loop** — set `"confirmedBy":"human"` and approval must come
  out-of-band: a person runs `node src/approve.js <token>`. The agent cannot
  self-approve. (Default `"agent"` for local/dev convenience.)
- **Kill switch** — `browser_halt` / `browser_resume`, or out-of-band
  `node src/approve.js --halt`. A `.halt` sentinel file is checked before every
  action, **before every flow-replay step, and before executing an approved
  confirmation** — so a human can freeze the copilot instantly even mid-task or
  mid-replay. A halt mid-approval leaves the action pending (approve it after
  resume); a halt mid-replay stops cleanly and reports where.
- **Audit log** — every decision is appended to `logs/actions.jsonl`
  (timestamp, action, risk, decision, token).
- **Replay is gated too** — `browser_run_flow` re-classifies each recorded
  click/type/drag/select step and stops if it's destructive/sensitive/blocked,
  so a saved macro can never silently do something risky.

```bash
node src/approve.js --list        # see pending confirmations
node src/approve.js <token>       # human approves a gated action
node src/approve.js --halt        # emergency stop
```

## Skill (for Claude Code)

`skill/calude-browse/SKILL.md` teaches any agent how to drive this copilot well
(the read→act→verify loop, every `browser_*` tool, the flow cache, the safety
gates, and the gotchas). Install it so it auto-triggers on browser tasks:

```bash
cp -r skill/calude-browse ~/.claude/skills/calude-browse
```

## Perception scaling & overlays

The semantic page model is bounded by `CALUDE_MAX_ELEMENTS` (default 400). When a
modal/dialog/overlay is open, its controls are emitted **first** so a long list
behind it can never truncate the fields you need — and the model reports the
`FOCUSED OVERLAY` plus how many elements were truncated. (Learned the hard way
driving GA4's channel-groups admin, which blows past a naive cap.)

## Multi-target (popups, new tabs, OAuth windows)

The session tracks every page/tab/popup via a target manager. A click that opens
a popup or new tab (`window.open`, `target=_blank`, OAuth consent windows)
**auto-focuses it**, so the next `browser_read` and subsequent actions operate on
it with no extra step. `browser_list_tabs` shows all open tabs in stable
open-order (index 0 = first tab), and `browser_switch_tab` / `browser_close_tab`
move between or close them. This is what lets the copilot drive flows like a
verification popup end-to-end instead of handing it off.

## Coordinate-click fallback

Most controls are clicked by `[index]`. For ones that aren't in the model at all
— unlabeled/custom checkboxes, canvas, bare icons — `browser_click_xy {x, y}`
clicks at absolute viewport pixels read off `browser_screenshot` (1:1 at default
scale). Perception also now keeps **unnamed checkboxes/radios/switches** (they
used to be dropped for having no accessible name), so most of these are
addressable by index again; `click_xy` is the last-resort fallback. When its
coordinates land on a known model element it's risk-classified through the same
gate as `browser_click` (so it can't bypass the policy); it stays unclassified
only when it lands on empty/unknown space, and always honors the kill switch.

## Drag-and-drop

`browser_drag {from, to}` performs a trusted, humanized drag — press at the
source, glide along a curved path with the button held (the intermediate
`mouseMoved` stream is what most sortable/DnD libraries actually require), then
release on the target. Works for list reordering, sliders, and DnD UIs; recorded
into flows and replayed like any other step.

## Verify-and-retry

Every live click/type and every replayed flow step is verified: the session
fingerprints the page model before/after and re-resolves the target by its
semantic selector on retry (coords may be stale if the page shifted). A click
that changes nothing is retried once, then flagged; a type is confirmed by
checking the field's value reflects the typed text (or, on submit, that the page
changed). The result text carries a note when verification fails, so the client
knows to take another approach rather than assuming success.

## Roadmap (next)

1. ~~Flow cache~~ ✓ — replay cheaply, fall back to the model only on failure.
2. ~~Safety gates~~ ✓ — risk classifier, confirm gate, kill switch, audit log.
3. ~~Verify-and-retry~~ ✓ — detect no-op actions, re-resolve and retry.
4. ~~Perception scaling + overlay priority~~ ✓ — configurable cap, dialogs first.
5. ~~Drag-and-drop~~ ✓ — trusted humanized drag for reorder/DnD.
6. ~~Coordinate-click fallback + unnamed-toggle perception~~ ✓ — `browser_click_xy`.
7. ~~Multi-target / popup + new-tab following~~ ✓ — auto-focus, list/switch/close tabs.
8. ~~Connection auto-recovery~~ ✓ — `ensure()` health-checks the socket; relaunches/re-attaches on a dropped connection.
9. ~~Type replaces, not appends~~ ✓ — `clearField()` before typing (fixes retry garble).
10. ~~iframe / shadow-DOM perception~~ ✓ — recursive walk pierces same-origin iframes (with coordinate offsets) + open shadow roots.
11. ~~Keyboard, native-select & prose-read tools~~ ✓ — `browser_press` (Escape/arrows/Tab), `browser_select` (native dropdowns), `browser_read_text`.
12. ~~Safety hardening~~ ✓ — blocklist hard-blocks; kill switch covers flow replay + pending approvals; `click_xy` is risk-classified when it lands on a model element; settle-after-click instead of a fixed sleep.
13. OS-level input escalation ("takeover mode") for the hardest anti-bot walls; planner/executor split; native HTML5 drag.
14. Vision fallback for canvas/WebGL widgets.
15. Thin MV3 extension UI talking to this daemon via native messaging.
