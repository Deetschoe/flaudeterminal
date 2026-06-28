'use strict';

// ---------------------------------------------------------------------------
// lib/visuals.js — pure, stateless rendering helpers shared by every Flaude
// experience. No process state, no I/O: just color math, the flamboyant
// 4-tone palette, animated gradient text, and two ways to draw a frame
// (a per-pixel sampler and a z-buffered PixelBuffer for 3D).
// ---------------------------------------------------------------------------

const CSI = '\x1b[';
const RESET = CSI + '0m';

// A wardrobe of curated, characterful palettes. Each has its own mood — this is
// the "diversity of colors" the UI flows through, not one generic rainbow. The
// active one is chosen in config (/theme) and threaded through every gradient.
const PALETTES = {
  flow:   [[222, 86, 86], [224, 64, 140], [150, 50, 200], [120, 28, 60]],           // #de5656 coral-red → fuchsia → purple → wine (the default)
  flaude: [[255, 196, 75], [255, 46, 166], [138, 91, 255], [33, 230, 193]],         // gold·magenta·violet·aqua
  sunset: [[255, 214, 120], [255, 122, 80], [232, 49, 132], [120, 51, 168]],        // peach→coral→pink→plum
  vapor:  [[255, 120, 200], [120, 220, 255], [180, 150, 255], [120, 255, 214]],     // pink·cyan·lavender·mint
  ember:  [[255, 226, 150], [255, 150, 40], [224, 54, 38], [120, 24, 74]],          // hearth gold→fire→ash
  forest: [[214, 255, 120], [60, 220, 130], [22, 160, 160], [240, 210, 90]],        // lime·emerald·teal·gold
  ice:    [[236, 255, 255], [150, 226, 255], [96, 150, 255], [180, 160, 255]],      // frost·sky·blue·periwinkle
  candy:  [[255, 150, 200], [150, 255, 214], [255, 240, 150], [200, 160, 255]],     // bubblegum·mint·lemon·lilac
  neon:   [[57, 255, 20], [0, 234, 255], [255, 0, 200], [255, 234, 0]],             // rave greens·cyan·pink·yellow
};
const PALETTE_NAMES = Object.keys(PALETTES);

// Flaude's signature palette — the default. Other modules can still import P4.
const P4 = PALETTES.flow;

// Per-experience signature colors, drawn from / around the palette so the menu
// stays cohesive while each mode still feels distinct.
const EXP_COLORS = {
  gold:    [255, 196, 75],
  magenta: [255, 46, 166],
  violet:  [138, 91, 255],
  aqua:    [33, 230, 193],
  white:   [240, 240, 255],
};

const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x | 0);
const fg = (c) => CSI + '38;2;' + clamp255(c[0]) + ';' + clamp255(c[1]) + ';' + clamp255(c[2]) + 'm';
const bg = (c) => CSI + '48;2;' + clamp255(c[0]) + ';' + clamp255(c[1]) + ';' + clamp255(c[2]) + 'm';

// Interpolate a palette (array of [r,g,b] stops) at t in 0..1 (clamped ends).
function ramp(palette, t) {
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const n = palette.length - 1;
  const x = t * n;
  let i = Math.floor(x);
  if (i > n - 1) i = n - 1;
  const f = x - i;
  const a = palette[i], b = palette[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Cyclic interpolation through a palette (wraps around) at phase p — for
// endlessly flowing gradients. p is unbounded; only its fractional ring matters.
function cyc(palette, p) {
  const n = palette.length;
  p -= Math.floor(p / n) * n; // wrap into [0, n)
  const i = Math.floor(p);
  const f = p - i;
  const a = palette[i % n], b = palette[(i + 1) % n];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Animated multi-color gradient text. `phase` is a frame counter; `speed` is how
// fast the color wave travels along the string; `spread` how tight the bands are.
function gradient(str, phase, opts) {
  const o = opts || {};
  const palette = o.palette || P4;
  const speed = o.speed == null ? 0.08 : o.speed;
  const spread = o.spread == null ? 0.55 : o.spread;
  const bold = o.bold !== false;
  let s = bold ? CSI + '1m' : '';
  for (let i = 0; i < str.length; i++) {
    s += fg(cyc(palette, i * spread - phase * speed)) + str[i];
  }
  return s + RESET;
}

const center = (width, w) => Math.max(1, Math.floor((width - w) / 2) + 1);
const at = (row, col) => CSI + row + ';' + col + 'H' + CSI + 'K'; // move + clear line

// ---------------------------------------------------------------------------
// fullFrame — per-pixel sampler renderer. Fills a W×H pixel grid (H pixel rows)
// using the "half-block" trick: one terminal cell = ▀ with the top pixel as the
// foreground and the bottom pixel as the background, doubling vertical
// resolution. Color escapes are emitted only when they change (diffed).
// sample(u, v) receives normalized coords in 0..1 and returns [r,g,b].
// Returns a string that overwrites the screen from the top (no clear → no
// flicker). H should be even.
// ---------------------------------------------------------------------------
function fullFrame(W, H, sample) {
  if (W < 2 || H < 2) return '';
  const parts = [CSI + 'H'];
  let lfR = -1, lfG = -1, lfB = -1, lbR = -1, lbG = -1, lbB = -1;
  for (let cy = 0; cy < H; cy += 2) {
    for (let cx = 0; cx < W; cx++) {
      const u = cx / (W - 1);
      const top = sample(u, cy / (H - 1));
      const bot = sample(u, (cy + 1) / (H - 1));
      const tr = clamp255(top[0]), tg = clamp255(top[1]), tb = clamp255(top[2]);
      const br = clamp255(bot[0]), bgc = clamp255(bot[1]), bb = clamp255(bot[2]);
      if (tr !== lfR || tg !== lfG || tb !== lfB) { parts.push(CSI + '38;2;' + tr + ';' + tg + ';' + tb + 'm'); lfR = tr; lfG = tg; lfB = tb; }
      if (br !== lbR || bgc !== lbG || bb !== lbB) { parts.push(CSI + '48;2;' + br + ';' + bgc + ';' + bb + 'm'); lbR = br; lbG = bgc; lbB = bb; }
      parts.push('▀');
    }
    parts.push(RESET + '\r\n');
    lfR = lfG = lfB = lbR = lbG = lbB = -1;
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// PixelBuffer — a W×H RGB framebuffer with a z-buffer, for plotting points and
// lines (3D). Write with set()/add(), then emit() a diffed half-block string.
// Depth convention: LARGER depth = nearer the camera = wins the z-test.
// ---------------------------------------------------------------------------
class PixelBuffer {
  constructor(W, H) { this.resize(W, H); }
  resize(W, H) {
    this.W = W; this.H = H;
    this.col = new Float32Array(W * H * 3);
    this.z = new Float32Array(W * H);
    this.clear();
  }
  clear(c) {
    const r = c ? c[0] : 0, g = c ? c[1] : 0, b = c ? c[2] : 0;
    const col = this.col;
    for (let i = 0, n = this.W * this.H; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
    this.z.fill(-Infinity);
  }
  // opaque write with z-test
  set(x, y, c, depth) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const idx = y * this.W + x;
    const d = depth == null ? Infinity : depth;
    if (d < this.z[idx]) return;
    this.z[idx] = d;
    const o = idx * 3;
    this.col[o] = c[0]; this.col[o + 1] = c[1]; this.col[o + 2] = c[2];
  }
  // additive blend (for glows / overlapping points), ignores z
  add(x, y, c, k) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const o = (y * this.W + x) * 3;
    const m = k == null ? 1 : k;
    this.col[o] += c[0] * m; this.col[o + 1] += c[1] * m; this.col[o + 2] += c[2] * m;
  }
  emit() {
    const W = this.W, H = this.H, col = this.col;
    const parts = [CSI + 'H'];
    let lfR = -1, lfG = -1, lfB = -1, lbR = -1, lbG = -1, lbB = -1;
    for (let cy = 0; cy < H - 1; cy += 2) {
      for (let cx = 0; cx < W; cx++) {
        let o = (cy * W + cx) * 3;
        const tr = clamp255(col[o]), tg = clamp255(col[o + 1]), tb = clamp255(col[o + 2]);
        o = ((cy + 1) * W + cx) * 3;
        const br = clamp255(col[o]), bgc = clamp255(col[o + 1]), bb = clamp255(col[o + 2]);
        if (tr !== lfR || tg !== lfG || tb !== lfB) { parts.push(CSI + '38;2;' + tr + ';' + tg + ';' + tb + 'm'); lfR = tr; lfG = tg; lfB = tb; }
        if (br !== lbR || bgc !== lbG || bb !== lbB) { parts.push(CSI + '48;2;' + br + ';' + bgc + ';' + bb + 'm'); lbR = br; lbG = bgc; lbB = bb; }
        parts.push('▀');
      }
      parts.push(RESET + '\r\n');
      lfR = lfG = lfB = lbR = lbG = lbB = -1;
    }
    return parts.join('');
  }
}

module.exports = {
  CSI, RESET, P4, PALETTES, PALETTE_NAMES, EXP_COLORS,
  clamp255, fg, bg, ramp, cyc, gradient, center, at,
  fullFrame, PixelBuffer,
};
