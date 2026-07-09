// motion.js — humanized motion math. Pure functions; no I/O.
//
// Serves three goals at once: transparency (the user can watch it),
// real automation, and behavioral anti-detection (mouse-trajectory
// fingerprinters see a plausible human path, not a teleport).

// Deterministic-ish jitter without Math.random (kept seedable for replay).
let _seed = 0x2545f491;
function rnd() {
  _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5;
  return ((_seed >>> 0) % 100000) / 100000;
}
export function reseed(s) { _seed = (s >>> 0) || 0x2545f491; }

const lerp = (a, b, t) => a + (b - a) * t;
// ease-in-out — fast across distance, decelerate on approach (Fitts-ish).
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
  const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
  return { x, y };
}

// Build a curved cursor path from `from` to `to` as timed mouseMoved steps.
// Returns [{x, y, dt}] where dt is ms to wait before emitting that point.
export function mousePath(from, to, opts = {}) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return [{ x: to.x, y: to.y, dt: 0 }];

  // Control points bow the path to one side; magnitude scales with distance.
  const bow = Math.min(dist * 0.18, 90) * (rnd() < 0.5 ? -1 : 1);
  const nx = -(to.y - from.y) / dist, ny = (to.x - from.x) / dist; // unit normal
  const c1 = { x: lerp(from.x, to.x, 0.33) + nx * bow * (0.6 + rnd() * 0.4),
               y: lerp(from.y, to.y, 0.33) + ny * bow * (0.6 + rnd() * 0.4) };
  const c2 = { x: lerp(from.x, to.x, 0.66) + nx * bow * (0.3 + rnd() * 0.4),
               y: lerp(from.y, to.y, 0.66) + ny * bow * (0.3 + rnd() * 0.4) };

  const steps = Math.max(12, Math.min(60, Math.round(dist / 8)));
  const totalMs = lerp(180, 620, Math.min(1, dist / 1200)); // longer for farther
  const path = [];
  let prevT = 0;
  for (let s = 1; s <= steps; s++) {
    const t = ease(s / steps);
    const p = cubicBezier(from, c1, c2, to, t);
    // micro-jitter, fading out near the target
    const jit = (1 - t) * 1.5;
    path.push({
      x: Math.round(p.x + (rnd() - 0.5) * jit),
      y: Math.round(p.y + (rnd() - 0.5) * jit),
      dt: Math.max(2, Math.round((t - prevT) * totalMs)),
    });
    prevT = t;
  }
  // Slight overshoot + correction near the end (human-like).
  if (dist > 120) {
    const over = { x: to.x + (rnd() - 0.5) * 10, y: to.y + (rnd() - 0.5) * 10 };
    path.push({ x: Math.round(over.x), y: Math.round(over.y), dt: 18 });
    path.push({ x: to.x, y: to.y, dt: 40 + Math.round(rnd() * 50) });
  } else {
    path[path.length - 1] = { x: to.x, y: to.y, dt: path[path.length - 1].dt };
  }
  return path;
}

// Per-keystroke delays with natural variance, word-boundary pauses, and the
// occasional typo→backspace→retype. Returns a list of key actions.
export function typingPlan(text) {
  const plan = [];
  // Long content (configs, wiki pages, multi-paragraph messages) at full human
  // cadence takes minutes and the CDP WebSocket doesn't survive that — it drops
  // mid-type. So above a threshold, type FAST (still trusted key events, just
  // little/no inter-key delay and no typo simulation). Short fields keep the
  // human cadence that matters for anti-detection.
  const fast = text.length > 400;
  for (const ch of text) {
    if (!fast && rnd() < 0.04 && /[a-z]/i.test(ch)) {
      const wrong = String.fromCharCode(ch.charCodeAt(0) + (rnd() < 0.5 ? 1 : -1));
      plan.push({ type: "char", ch: wrong, dt: keyDelay(wrong, fast) });
      plan.push({ type: "backspace", dt: 80 + rnd() * 120 });
    }
    plan.push({ type: "char", ch, dt: keyDelay(ch, fast) });
  }
  return plan;
}

function keyDelay(ch, fast) {
  if (fast) return 2 + Math.round(rnd() * 8); // ~2-10ms/char: ~1700 chars in ~15s
  let base = 55 + rnd() * 90;          // ~55-145ms typical
  if (ch === " ") base += rnd() * 90;  // pause at word boundaries
  if (/[.,!?]/.test(ch)) base += rnd() * 140;
  return Math.round(base);
}
