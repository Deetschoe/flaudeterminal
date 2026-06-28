'use strict';

// ---------------------------------------------------------------------------
// lib/sand.js — SAND: a tactile falling-sand cellular-automaton sandbox.
//
// You drive a cursor around a truecolor half-block canvas and paint particles
// that obey little physics laws: SAND falls and piles into slopes, WATER falls
// and levels itself out, EMBER glows and floats upward, PLANT creeps and grows
// where it touches water, and STONE just sits there being a wall. Materials
// interact — water flows around sand, embers light plants on fire, etc.
//
// The world is a grid of cells, one cell per HALF-BLOCK pixel, so the grid is
// W × H where W = core.cols() and H = (core.rows()-1)*2 (bottom terminal row is
// reserved for the HUD). Each frame we step the automaton bottom-up (so falling
// reads cleanly) and render every cell into a core.PixelBuffer with a little
// per-grain shading so big drifts of one material still feel alive and grainy.
// Pure render-from-the-top each frame (PixelBuffer.emit homes the cursor) so
// there's no flicker. frame()/key() never throw — the playground stays alive.
// ---------------------------------------------------------------------------

const Vis = require('/Users/dieterschoening/Developer/Flaude/lib/visuals');

// --- material ids -----------------------------------------------------------
const EMPTY = 0;
const SAND  = 1;
const WATER = 2;
const STONE = 3;
const EMBER = 4;   // rises, flickers, sets PLANT alight, evaporates WATER
const PLANT = 5;   // static-ish; sprouts upward when next to WATER
const FIRE  = 6;   // short-lived; burns PLANT, then dies to EMBER/smoke

// Materials you can actively paint, in cycle order. (FIRE & EMBER are mostly
// emergent, but EMBER is fun to paint directly, so it stays in the palette.)
const PALETTE = [SAND, WATER, EMBER, PLANT, STONE];

// Human-readable names for the HUD, indexed by material id.
const NAMES = {
  [EMPTY]: 'empty', [SAND]: 'SAND', [WATER]: 'WATER', [STONE]: 'STONE',
  [EMBER]: 'EMBER', [PLANT]: 'PLANT', [FIRE]: 'FIRE',
};

// Base colors + a "shade range" used for subtle per-grain variation. Each grain
// stores its own little brightness seed (0..255) so a dune of sand isn't one
// flat color but a speckle of warm tones. lo/hi multiply the base color.
const MAT = {
  [SAND]:  { base: [222, 184, 110], lo: 0.78, hi: 1.12 },  // warm dune ochre
  [WATER]: { base: [54, 138, 222],  lo: 0.70, hi: 1.18 },  // cool river blue
  [STONE]: { base: [120, 120, 134], lo: 0.85, hi: 1.05 },  // flat grey slate
  [EMBER]: { base: [255, 120, 40],  lo: 0.65, hi: 1.30 },  // glowing orange coal
  [PLANT]: { base: [60, 190, 80],   lo: 0.72, hi: 1.15 },  // living green
  [FIRE]:  { base: [255, 200, 60],  lo: 0.80, hi: 1.25 },  // bright yellow flame
};

const BG = [8, 8, 14];   // near-black canvas with a faint cool tint

// Clamp helpers (reuse visuals' clamp255 to stay dependency-free).
const clamp255 = Vis.clamp255;

module.exports = {
  name: 'SAND',
  blurb: 'paint falling sand, water & sparks',
  color: 'gold',
  audio: false,

  create(core) {
    // --- mutable simulation state ----------------------------------------
    const st = {
      buf: null,           // PixelBuffer, lazily (re)sized to the terminal
      W: 0, H: 0,          // grid dimensions (== buffer dims)
      cell: null,          // Uint8Array  W*H — material id per cell
      shade: null,         // Uint8Array  W*H — per-grain brightness seed 0..255
      life: null,          // Uint8Array  W*H — countdown for transient cells (fire)
      t: 0,                // frame counter (drives flicker / gradients)
      cx: 0, cy: 0,        // cursor position in GRID coords (cell space)
      brush: 2,            // brush radius (in cells)
      mat: 0,              // index into PALETTE → current material
      gravityDown: true,   // g flips gravity for falling materials
      flash: 0,            // brief HUD flash on material / size change
      painting: false,     // held-paint hint (we emit on every space tap)
    };

    // Ensure the grid + framebuffer match the current terminal size. We reserve
    // the bottom terminal row for the HUD → H = (rows-1)*2 pixel rows. On a
    // resize we rebuild the grid, preserving as much of the old world as fits
    // (anchored top-left) so a stray resize doesn't wipe your sculpture.
    function ensure() {
      const W = Math.max(2, core.cols() | 0);
      const H = Math.max(2, (Math.max(2, core.rows() | 0) - 1) * 2);
      if (st.cell && W === st.W && H === st.H) return st.buf;

      const nc = new Uint8Array(W * H);
      const ns = new Uint8Array(W * H);
      const nl = new Uint8Array(W * H);
      if (st.cell) {
        // copy the overlapping top-left region of the old world
        const cw = Math.min(W, st.W), ch = Math.min(H, st.H);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const o = y * st.W + x, n = y * W + x;
            nc[n] = st.cell[o]; ns[n] = st.shade[o]; nl[n] = st.life[o];
          }
        }
      }
      st.cell = nc; st.shade = ns; st.life = nl;
      st.W = W; st.H = H;

      // keep cursor inside the new bounds
      if (st.cx >= W) st.cx = W - 1; if (st.cx < 0) st.cx = 0;
      if (st.cy >= H) st.cy = H - 1; if (st.cy < 0) st.cy = 0;
      // if cursor was never placed (fresh start) center it
      if (st.cx === 0 && st.cy === 0) { st.cx = (W / 2) | 0; st.cy = (H / 3) | 0; }

      if (!st.buf) st.buf = new core.PixelBuffer(W, H);
      else st.buf.resize(W, H);
      return st.buf;
    }

    // index helper
    const idx = (x, y) => y * st.W + x;
    const inb = (x, y) => x >= 0 && y >= 0 && x < st.W && y < st.H;

    // place a single grain, stamping a fresh shade seed (and life for fire).
    function put(x, y, m) {
      if (!inb(x, y)) return;
      const i = idx(x, y);
      st.cell[i] = m;
      st.shade[i] = (Math.random() * 256) | 0;
      st.life[i] = m === FIRE ? (20 + ((Math.random() * 22) | 0)) : 0;
    }

    // paint a soft circular brush of the current material at (gx,gy).
    function paint(gx, gy, m) {
      const r = st.brush;
      const r2 = (r + 0.5) * (r + 0.5);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const x = gx + dx, y = gy + dy;
          if (!inb(x, y)) continue;
          if (m === EMPTY) { put(x, y, EMPTY); continue; }
          // sparse painting for gassy/liquid mats so brushes feel airy, not
          // like solid slabs; solids fill fully.
          if (m === EMBER && Math.random() < 0.45) continue;
          if (m === WATER && Math.random() < 0.12) continue;
          put(x, y, m);
        }
      }
    }

    // density ranking — used so heavier things sink through lighter ones.
    function density(m) {
      switch (m) {
        case STONE: return 100;
        case PLANT: return 90;   // rooted, won't be displaced by water
        case SAND:  return 60;
        case WATER: return 30;
        case FIRE:  return 5;
        case EMBER: return 2;    // very light → rises
        default:    return 0;    // empty
      }
    }

    // swap two cells (material + shade + life travel together).
    function swap(a, b) {
      const cm = st.cell[a]; st.cell[a] = st.cell[b]; st.cell[b] = cm;
      const sm = st.shade[a]; st.shade[a] = st.shade[b]; st.shade[b] = sm;
      const lm = st.life[a]; st.life[a] = st.life[b]; st.life[b] = lm;
    }

    // ---- the simulation step --------------------------------------------
    // We sweep bottom-up for downward gravity (and top-down when flipped) so a
    // falling grain is processed before the cell it's about to fall into. A
    // per-row alternating x-direction avoids a left-biased drift in piles.
    function step() {
      const W = st.W, H = st.H, cell = st.cell, life = st.life;
      const dir = st.gravityDown ? 1 : -1;        // "down" in grid space
      const yStart = st.gravityDown ? H - 1 : 0;
      const yEnd   = st.gravityDown ? -1 : H;
      const yStep  = st.gravityDown ? -1 : 1;

      for (let y = yStart; y !== yEnd; y += yStep) {
        const leftToRight = ((y + st.t) & 1) === 0;
        const xStart = leftToRight ? 0 : W - 1;
        const xEnd   = leftToRight ? W : -1;
        const xStep  = leftToRight ? 1 : -1;

        for (let x = xStart; x !== xEnd; x += xStep) {
          const i = y * W + x;
          const m = cell[i];
          if (m === EMPTY || m === STONE) continue;

          // -- transient life / reactions ---------------------------------
          if (m === FIRE) {
            // fire ignites adjacent plant, evaporates water, then ages out.
            igniteAround(x, y);
            if (life[i] > 0) life[i]--;
            if (life[i] === 0) {
              // burns down to a brief ember or just smoke (empty)
              cell[i] = Math.random() < 0.4 ? EMBER : EMPTY;
              if (cell[i] === EMBER) { st.shade[i] = (Math.random() * 256) | 0; life[i] = 0; }
              continue;
            }
          }

          if (m === PLANT) {
            // plant grows upward into empty space when watered nearby; it is
            // otherwise static, so it just continues (no fall).
            growPlant(x, y);
            continue;
          }

          if (m === EMBER) {
            stepRiser(x, y, dir);
            continue;
          }

          if (m === SAND) {
            stepPowder(x, y, dir);
            continue;
          }

          if (m === WATER) {
            stepLiquid(x, y, dir);
            continue;
          }
        }
      }
    }

    // powder (sand): falls straight; if blocked, slides into a diagonal below;
    // it can also sink through water (denser), displacing it upward.
    function stepPowder(x, y, dir) {
      const W = st.W, cell = st.cell;
      const ny = y + dir;
      if (ny < 0 || ny >= st.H) return;
      const below = ny * W + x;
      const here = y * W + x;
      // straight down into empty or water
      if (cell[below] === EMPTY || cell[below] === WATER) { swap(here, below); return; }
      // try diagonals (randomized order to avoid bias)
      const first = Math.random() < 0.5 ? -1 : 1;
      for (const s of [first, -first]) {
        const nx = x + s;
        if (nx < 0 || nx >= W) continue;
        const d = ny * W + nx;
        if (cell[d] === EMPTY || cell[d] === WATER) { swap(here, d); return; }
      }
    }

    // riser (ember): the inverse of powder — drifts "up" against gravity, with
    // a lateral wobble, fizzling out occasionally so plumes thin as they climb.
    function stepRiser(x, y, dir) {
      const W = st.W, cell = st.cell, here = y * W + x;
      if (Math.random() < 0.03) { cell[here] = EMPTY; return; } // fizzle
      const up = -dir;
      const ny = y + up;
      if (ny < 0 || ny >= st.H) { cell[here] = EMPTY; return; } // off the top → gone
      const above = ny * W + x;
      // evaporate water it floats into; otherwise rise into empty
      if (cell[above] === WATER) { cell[above] = EMPTY; }
      if (cell[above] === EMPTY) {
        // mostly straight up, sometimes a diagonal wobble
        if (Math.random() < 0.6) { swap(here, above); return; }
      }
      const s = Math.random() < 0.5 ? -1 : 1;
      const nx = x + s;
      if (nx < 0 || nx >= W) return;
      const diag = ny * W + nx;
      if (cell[diag] === EMPTY) { swap(here, diag); return; }
      // stuck under a ceiling → spread sideways a touch
      const side = y * W + nx;
      if (cell[side] === EMPTY) swap(here, side);
    }

    // liquid (water): falls; if blocked, falls diagonally; if that's blocked,
    // it spreads sideways to seek its own level. The sideways search scans a
    // few cells so puddles flatten quickly rather than crawling one step/frame.
    function stepLiquid(x, y, dir) {
      const W = st.W, cell = st.cell, here = y * W + x;
      const ny = y + dir;
      if (ny >= 0 && ny < st.H) {
        const below = ny * W + x;
        if (cell[below] === EMPTY) { swap(here, below); return; }
        // diagonal down
        const first = Math.random() < 0.5 ? -1 : 1;
        for (const s of [first, -first]) {
          const nx = x + s;
          if (nx < 0 || nx >= W) continue;
          const d = ny * W + nx;
          if (cell[d] === EMPTY) { swap(here, d); return; }
        }
      }
      // spread sideways toward the nearer open cell (level-seeking)
      const dir1 = Math.random() < 0.5 ? -1 : 1;
      for (const s of [dir1, -dir1]) {
        const reach = 4;
        for (let k = 1; k <= reach; k++) {
          const nx = x + s * k;
          if (nx < 0 || nx >= W) break;
          const c = y * W + nx;
          if (cell[c] !== EMPTY) break;          // blocked → stop scanning this way
          // prefer to flow where it can also drop next
          const dn = (y + dir) * W + nx;
          if (y + dir >= 0 && y + dir < st.H && cell[dn] === EMPTY) { swap(here, c); return; }
          if (k === 1) { swap(here, c); return; } // otherwise just shuffle one step
        }
      }
    }

    // plant: occasionally sprouts a new plant cell upward (toward the light) if
    // there's water adjacent — so plants "drink" and climb. Capped growth via
    // randomness keeps it from filling the screen.
    function growPlant(x, y) {
      const W = st.W, cell = st.cell;
      if (Math.random() > 0.06) return;          // slow growth
      // need water somewhere in the neighborhood to grow
      let watered = false;
      for (let dy = -1; dy <= 1 && !watered; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inb(nx, ny) && cell[ny * W + nx] === WATER) { watered = true; break; }
        }
      if (!watered) return;
      // grow upward (against gravity) into empty space, with a slight wander
      const up = st.gravityDown ? -1 : 1;
      const sx = x + ((Math.random() * 3) | 0) - 1;
      const ny = y + up;
      if (inb(sx, ny) && cell[ny * W + sx] === EMPTY) {
        put(sx, ny, PLANT);
        // drinking consumes a nearby water cell sometimes
        if (Math.random() < 0.5) {
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const wx = x + dx, wy = y + dy;
              if (inb(wx, wy) && cell[wy * W + wx] === WATER) { cell[wy * W + wx] = EMPTY; return; }
            }
        }
      }
    }

    // fire/ember reactions: ignite neighboring plant, boil away neighboring
    // water (steam = empty). Called by FIRE cells each step.
    function igniteAround(x, y) {
      const W = st.W, cell = st.cell;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (!inb(nx, ny)) continue;
          const j = ny * W + nx;
          if (cell[j] === PLANT && Math.random() < 0.5) {
            cell[j] = FIRE; st.life[j] = 16 + ((Math.random() * 16) | 0);
          } else if (cell[j] === WATER && Math.random() < 0.6) {
            cell[j] = EMPTY;  // doused / steamed away
          }
        }
    }

    // embers also lightly ignite plants they brush past (sparks). Folded into
    // the riser path via a small chance check here.
    function emberSpark(x, y) {
      const W = st.W, cell = st.cell;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inb(nx, ny) && cell[ny * W + nx] === PLANT && Math.random() < 0.04) {
            cell[ny * W + nx] = FIRE; st.life[ny * W + nx] = 18;
          }
        }
    }

    // ---- color for a cell ------------------------------------------------
    // base material color * per-grain shade, with live flicker for fire/ember.
    function colorOf(m, i) {
      const def = MAT[m];
      if (!def) return BG;
      // shade seed → 0..1 → mapped into [lo,hi]
      const sshade = st.shade[i] / 255;
      let k = def.lo + (def.hi - def.lo) * sshade;
      if (m === FIRE) {
        // animated flicker so flames shimmer frame to frame
        k *= 0.8 + 0.4 * Math.abs(Math.sin((st.t * 0.5) + i * 0.7));
      } else if (m === EMBER) {
        k *= 0.7 + 0.5 * Math.abs(Math.sin((st.t * 0.3) + i * 1.3));
      } else if (m === WATER) {
        // a gentle caustic ripple
        k *= 0.92 + 0.12 * Math.sin((st.t * 0.12) + i * 0.25);
      }
      const b = def.base;
      return [b[0] * k, b[1] * k, b[2] * k];
    }

    // ---- the public instance --------------------------------------------
    return {
      enter() {
        st.t = 0;
        st.flash = 36;
      },

      exit() {
        // drop the (potentially large) buffers; host handles screen/timers.
        st.buf = null; st.cell = null; st.shade = null; st.life = null;
        st.W = st.H = 0;
      },

      frame() {
        try {
          const buf = ensure();
          const W = st.W, H = st.H;
          if (W < 2 || H < 2) return;

          st.t++;
          if (st.flash > 0) st.flash--;

          // 1) advance physics
          step();

          // ember sparks are a cheap second pass (kept separate so the main
          // step stays readable); sample only a few cells to stay light.
          if ((st.t & 3) === 0) {
            const cell = st.cell;
            for (let i = 0; i < cell.length; i += 7) {
              if (cell[i] === EMBER) emberSpark(i % W, (i / W) | 0);
            }
          }

          // 2) render the grid into the framebuffer
          buf.clear(BG);
          const cell = st.cell;
          for (let y = 0; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const i = row + x;
              const m = cell[i];
              if (m === EMPTY) continue;
              buf.set(x, y, colorOf(m, i));
            }
          }

          // 3) cursor / brush outline drawn on top (a bright ring so it reads
          // over any material). Use additive so it glows rather than erases.
          drawCursor(buf);

          core.out.write(buf.emit());

          // 4) HUD on the reserved bottom terminal row
          drawHud();
        } catch (e) {
          // never throw out of a frame — keep the playground alive.
        }
      },

      key(s) {
        try {
          switch (s) {
            case 'q':
            case '\x1b':                              // lone escape → menu
              return 'menu';

            case '\x1b[A': case '\x1bOA':             // up
              st.cy = Math.max(0, st.cy - 1); break;
            case '\x1b[B': case '\x1bOB':             // down
              st.cy = Math.min(Math.max(0, st.H - 1), st.cy + 1); break;
            case '\x1b[D': case '\x1bOD':             // left
              st.cx = Math.max(0, st.cx - 1); break;
            case '\x1b[C': case '\x1bOC':             // right
              st.cx = Math.min(Math.max(0, st.W - 1), st.cx + 1); break;

            // Shift + arrows → dash 4 cells at once (hold shift to fly around)
            case '\x1b[1;2A': st.cy = Math.max(0, st.cy - 4); break;
            case '\x1b[1;2B': st.cy = Math.min(Math.max(0, st.H - 1), st.cy + 4); break;
            case '\x1b[1;2D': st.cx = Math.max(0, st.cx - 4); break;
            case '\x1b[1;2C': st.cx = Math.min(Math.max(0, st.W - 1), st.cx + 4); break;

            case ' ':                                 // emit current material
              paint(st.cx, st.cy, PALETTE[st.mat]);
              st.painting = true;
              break;

            case '\t':                                // cycle material
              st.mat = (st.mat + 1) % PALETTE.length;
              st.flash = 30;
              break;

            case ']': case '+': case '=':             // bigger brush
              st.brush = Math.min(12, st.brush + 1); st.flash = 24; break;
            case '[': case '-': case '_':             // smaller brush
              st.brush = Math.max(0, st.brush - 1); st.flash = 24; break;

            case 'c': case 'C':                       // clear the world
              if (st.cell) { st.cell.fill(EMPTY); st.life.fill(0); }
              st.flash = 30; break;

            case 'g': case 'G':                       // flip gravity
              st.gravityDown = !st.gravityDown; st.flash = 30; break;

            case 'x': case 'X': case 'e': case 'E':   // eraser (bonus QoL)
              paint(st.cx, st.cy, EMPTY); break;
          }
        } catch (e) { /* keys must never throw */ }
        return undefined;
      },
    };

    // ---- helpers that need `st` in scope (declared after return is fine in
    // JS function hoisting; kept here to keep the instance object tidy) ------

    function drawCursor(buf) {
      const W = st.W, H = st.H;
      const r = st.brush;
      const cx = st.cx, cy = st.cy;
      // pulsing ring color from the flaude palette, tinted by current material
      const matCol = MAT[PALETTE[st.mat]].base;
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(st.t * 0.18));
      const ring = [
        clamp255(220 * pulse + matCol[0] * 0.15),
        clamp255(220 * pulse + matCol[1] * 0.15),
        clamp255(240 * pulse + matCol[2] * 0.15),
      ];
      if (r <= 0) {
        // single-cell cursor: just light the center
        if (inb(cx, cy)) buf.add(cx, cy, ring, 1);
        return;
      }
      // draw a thin circle outline at radius r
      const steps = Math.max(8, (r * 6) | 0);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(a) * r);
        const y = Math.round(cy + Math.sin(a) * r);
        if (x >= 0 && y >= 0 && x < W && y < H) buf.add(x, y, ring, 1);
      }
      // crosshair center dot
      if (inb(cx, cy)) buf.add(cx, cy, ring, 1);
    }

    function drawHud() {
      const rows = Math.max(2, core.rows() | 0);
      const cols = Math.max(2, core.cols() | 0);
      const cur = PALETTE[st.mat];
      const label = ' SAND · ' + NAMES[cur] + ' · brush ' + st.brush +
        (st.gravityDown ? '' : ' · ↑grav') + '  ';
      const title = core.theme.gradient(label, st.t,
        { palette: Vis.P4, speed: 0.12, spread: 0.5 });
      const hint = '←↑↓→ move  space paint  tab mat  [ ] size  g grav  c clear  esc menu';
      const room = Math.max(0, cols - label.length - 1);
      const hud = title + core.theme.fg([150, 150, 175]) + hint.slice(0, room) + core.RESET;
      core.out.write(core.at(rows, 1) + hud);
    }
  },
};
