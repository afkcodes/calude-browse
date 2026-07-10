---
name: calude-browse
description: >-
  Drive a real Chrome browser like a human via the calude-browse MCP server —
  trusted input + accessibility-tree perception (no screenshots), with popups,
  tabs, iframes and shadow DOM all handled. Use this skill WHENEVER the user
  wants to control, automate, or act inside a real web browser: clicking through
  a site, filling/submitting forms, operating a logged-in dashboard (GA4, Search
  Console, Cloudflare, Stripe, admin panels, CMS), reordering lists, multi-tab or
  OAuth-popup flows, or recording a repeatable browser task — even if they don't
  say "calude-browse", "MCP", or "browser automation". Also use it when asked to
  read a page's interactive elements, run a saved browser flow, or "do X in the
  browser for me". NOT for scraping static HTML (use fetch/curl/WebFetch) and NOT
  for defeating captchas or fraud-gated public sign-ups (those are bot-walled —
  tell the user to use their normal browser).
---

# calude-browse — human-like browser copilot

calude-browse drives the user's **real Chrome** over the DevTools Protocol with
**trusted input events** and an **accessibility-tree page model** (no screenshots).
The reasoning loop is *yours* — the MCP server is just the hands and eyes. It shines
at **authenticated, complex-UI work** (dashboards, admin panels, multi-step forms),
which is exactly the work other tools can't do.

## Setup (once)
The MCP server lives at `/home/ashish/projects/calude_browse`. Register it:
```bash
claude mcp add calude-browse -- node /home/ashish/projects/calude_browse/src/mcp-server.js
```
Or rely on the project-scoped `.mcp.json` if running inside that repo. Tools appear as
`mcp__calude-browse__browser_*`. **After any code change to the server, the user must
reconnect the MCP** (`/mcp` → reconnect, or restart) — the server loads at startup.
Chrome persists on `:9222` across a reconnect, so logins survive.

## The core loop: read → act → verify
This is the whole discipline. Do not skip it.

1. **`browser_read` first.** It returns a compact list of interactable elements, each
   with a stable `[index]`, role, accessible name, and current value. You act by
   `[index]`, so you must have a fresh read.
2. **Act** with one tool (`browser_click`, `browser_type`, …) referencing an `[index]`
   from the *latest* read.
3. **The result of every action is the updated page model** — read it to confirm the
   action did what you expected before choosing the next step. Indexes are only valid
   against the most recent model; after navigation or any DOM change, the previous
   indexes are stale.

Why this matters: the model is semantic, not pixel-based, so it survives restyling and
is cheap — but indexes shift as the page changes, so always reason from the freshest
model.

## Tools

**Perceive**
- `browser_read` — the semantic page model. Your primary sense. Call it first and after
  anything uncertain. It also reports a `FOCUSED OVERLAY` (a dialog's controls are
  listed first) and how many elements were truncated.
- `browser_read_text {max_chars?}` — the page's visible prose (body innerText). The
  **cheap way to read messages, errors, and body copy** that `browser_read` (interactables
  only) omits — reach for this before spending a `browser_screenshot` on vision.
- `browser_screenshot` — PNG, **fallback only** for things the model can't describe
  (canvas/WebGL, or to find coordinates for `browser_click_xy`).

**Navigate**
- `browser_navigate {url}` · `browser_back` · `browser_scroll {dy}` (positive = down).
- Tabs/popups: `browser_list_tabs`, `browser_switch_tab {tab}` (index or targetId),
  `browser_close_tab`. **Popups, new tabs, and OAuth windows auto-focus** — after a
  click that opens one, the next `browser_read` is already on it. Use `list_tabs` to
  see/switch when several are open.

**Act**
- `browser_click {index}` — humanized cursor path + trusted click.
- `browser_type {index, text, submit?}` — focuses the field, **replaces** its contents
  (it clears first), types with human cadence; `submit:true` presses Enter.
- `browser_click_xy {x, y}` — **fallback** click at viewport pixels (read coords off a
  screenshot) for controls not in the model (custom/unlabeled widgets, canvas). Prefer
  `browser_click` by index whenever the element is in the model. **Risk-classified when the
  point lands on a known model element** (routes through the same gate as `browser_click`,
  so it can't sneak a destructive click past the policy); unclassified only on empty space.
- `browser_press {key}` — press one named key: **Escape** (close dialogs/menus), **arrows**
  (walk custom dropdowns/menus), **Tab** (move between fields), Enter/Backspace/Delete/
  PageUp/PageDown/Home/End.
- `browser_select {index, value}` — pick an option in a **NATIVE `<select>`** dropdown;
  `value` is the option's value or its visible label. **Custom (non-native) dropdowns are
  click + arrow keys instead** (`browser_click` the control, then `browser_press` arrows + Enter).
- `browser_drag {from, to}` — drag one element onto another (reorder lists, sliders, DnD).

**Flow cache** — record a task once, replay it cheaply forever:
- `browser_clear_trace` → drive the task → `browser_save_flow {name}` → later
  `browser_run_flow {name, overrides?}`. Replay re-resolves each step by its semantic
  selector (role+name), so it survives layout churn; `overrides` (a map of 0-based
  type-step ordinal → text, e.g. `{"0":"new query"}`) reuses a flow with different
  input. If a step can't be located or is gated, replay stops and hands you the page.
- `browser_list_flows` lists saved flows.

**Safety** (gates on mutating actions):
- Destructive (delete/buy/pay/send/publish…) and sensitive (password/card/OTP) actions
  return a **CONFIRMATION REQUIRED** token instead of executing. Call
  `browser_confirm {token}` to proceed, or `{token, approve:false}` to cancel. (With the
  policy set to human approval, a person must approve out-of-band — surface that to the
  user.)
- **Blocklist entries always hard-block** — a `safety.json` blocklist match can't be
  self-approved (it forces a block regardless of policy); no token is offered.
- `browser_halt` / `browser_resume` — kill switch. `browser_safety_status` — current state.
  **Halt stops flow replays too** (checked before every replayed step) and refuses to run an
  already-approved action while engaged — resume, then re-run / re-approve.

## Key behaviors & gotchas (learned the hard way)
- **Read before you act, re-read after.** Stale indexes are the #1 source of wrong clicks.
  An index is only valid against the model from the *most recent* read. Never carry an
  index across a navigate, a scroll, or any DOM change — resolve it again from a fresh read.
- **Never act on an `[inert]` element.** When a modal is open, everything behind it is
  emitted with normal indexes but tagged `[inert]`. Clicking or typing there is a silent
  no-op, or worse lands in a lookalike control that shares the foreground element's
  accessible name (e.g. a background composer named the same as the one in the dialog).
  `browser_click`/`browser_type` refuse inert targets and name the correct index instead —
  act on the control *inside* the dialog.
- **A navigate is settled, but a read on a fresh SPA route may not be.** `browser_navigate`
  waits for the page to stop changing before returning. If you open a route another way
  (a click that mounts a dialog/panel), give it a beat and re-read until the element count
  looks right — SPAs paint a skeleton (a title + a few elements) that briefly looks stable.
- **Credential fields and secret-bearing URLs are redacted** in the model (`«redacted»`,
  `data:«inline»`). This is deliberate: browsers autofill saved passwords, so a naive read
  of a login page would otherwise leak them into the transcript. The model still shows the
  field is filled; you just can't read the value. Do not try to route around it — if a task
  needs a credential typed, that's a stop-and-ask-the-user moment, not an automation step.
- **Long pages / dialogs:** when a modal is open its controls are surfaced first; the
  model is capped (default 400 elements, `CALUDE_MAX_ELEMENTS`) and reports truncation.
- **Off-model controls:** if a checkbox/button isn't in the model, screenshot it and use
  `browser_click_xy` with the coordinates.
- **iframes & shadow DOM:** same-origin iframes and open shadow roots ARE perceived and
  clickable. **Cross-origin iframes (e.g. hCaptcha) are not** — Same-Origin Policy hides
  them; you can't read or reliably click inside them.
- **Account creation & fraud-gated sign-ups are bot-walled.** Cloudflare/hCaptcha/fraud
  heuristics block the automated browser by design (we've seen F6S pause, SaaSHub
  captcha, Google-signup-disabled). Do **not** try to brute-force these — tell the user
  to do the sign-up in their normal browser, then drive the authenticated session.
- **Logins & security walls are a HARD STOP.** The copilot uses the user's real Chrome
  session. If a page redirects to a login, shows a captcha, or throws an unusual-activity
  interstitial, stop and hand back to the user — never type credentials or automate through
  a security check.
- **Dropped connection self-heals:** if Chrome closes, the next action relaunches/
  re-attaches automatically (a fresh launch loses logins, though).

### If you drive it from a script instead of the MCP tools
The verbs above are the supported surface. If you wrap the server in your own long-lived
session (one process, many calls), three things bite:
- **One session per task, not one process per call.** Spawning a fresh server per call
  re-attaches Chrome and drifts onto stray `about:blank` targets. Keep one session open.
- **Bound every call and kill the child on exit.** A hung CDP call otherwise wedges the
  run, and a killed parent leaves an orphaned node process attached to Chrome (they
  accumulate and contend, turning fast calls into 30s+ stalls). Use a per-call timeout and
  a SIGTERM/atexit hard-kill of the child.
- **Parse to compact structure, don't hoard raw models.** A read is 5–15k chars; keep only
  the fields you need (role, name, index) so your own context doesn't balloon over a sweep.

## When to use it — and when not
**Great fit (use it):** logged-in dashboards and admin panels (analytics, ad/SEO
consoles, CMS, CRM, cloud providers), multi-step forms, reordering/drag UIs, multi-tab
and OAuth-popup flows, recording a repeatable internal workflow, reading a page's
structure.

**Wrong tool (don't):** scraping static HTML or JSON (use `curl`/`WebFetch` — faster and
no browser needed); defeating captchas or creating accounts on fraud-protected public
sites (bot-walled — hand to the user); anything that needs to read inside a cross-origin
iframe.

## A typical task
> "In the analytics dashboard, create a new channel group called X and add a channel."

1. `browser_navigate` to the dashboard → `browser_read`.
2. Click through the nav by index, re-reading at each step; when a slide-over/dialog
   opens, its controls are surfaced first.
3. `browser_type` into fields (it replaces existing values); for an unlabeled checkbox,
   `browser_screenshot` + `browser_click_xy`.
4. Before a final destructive/irreversible "Save/Delete/Submit", expect a confirm token;
   show the user what's about to happen and `browser_confirm`.
5. To make it repeatable: `browser_clear_trace` before, `browser_save_flow` after.

Full architecture and design notes: the repo `README.md` at
`/home/ashish/projects/calude_browse`.
