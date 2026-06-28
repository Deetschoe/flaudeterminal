'use strict';

// ---------------------------------------------------------------------------
// lib/orbit.js — ORBIT: a hand-spun 3D simulation for the terminal.
//
// Rotating wireframe/point-cloud shapes and a fly-through starfield, drawn with
// truecolor half-blocks through core.PixelBuffer (z-buffered, so nearer points
// occlude farther ones). Everything auto-rotates; the arrow keys nudge angular
// velocity, +/- zoom, and the whole thing is shaded by depth + position for a
// vivid, alive feel. Pure render-from-the-top each frame (no clear → no flicker).
// ---------------------------------------------------------------------------

const Vis = require('/Users/dieterschoening/Developer/Flaude/lib/visuals');

// Color moods — each is a palette we cycle points through. 'c' steps the mood.
const MOODS = [
  Vis.P4,                                              // 0: full flaude rainbow
  [[255, 196, 75], [255, 46, 166], [138, 91, 255]],   // 1: sunset (gold→magenta→violet)
  [[33, 230, 193], [138, 91, 255], [255, 46, 166]],   // 2: nebula (aqua→violet→magenta)
  [[20, 30, 90], [33, 230, 193], [240, 255, 255]],    // 3: ice (deep blue→aqua→white)
  [[255, 46, 166], [255, 196, 75], [33, 230, 193]],   // 4: candy
];

const SCENES = ['CUBE', 'TORUS', 'SPHERE', 'STARFIELD'];

const TAU = Math.PI * 2;

module.exports = {
  name: 'ORBIT',
  blurb: 'a hand-spun 3D simulation — rotate it with the keys',
  color: 'gold',
  audio: false,
  create(core) {
    // --- mutable simulation state ----------------------------------------
    const st = {
      buf: null,           // PixelBuffer, lazily (re)sized to the terminal
      bw: 0, bh: 0,        // last buffer dims (to detect resize)
      t: 0,                // frame counter (drives the color flow)
      scene: 0,            // index into SCENES
      mood: 0,             // index into MOODS
      yaw: 0, pitch: 0.35, // current orientation (radians)
      vyaw: 0.012,         // angular velocity — auto-spins by default
      vpitch: 0.004,
      zoom: 1,             // user zoom multiplier
      paused: false,
      // starfield is a fixed set of seeded stars streaming toward the camera
      stars: null,
      flash: 0,            // brief HUD flash timer on scene/mood change
    };

    // Deterministic per-index pseudo-random in 0..1 (no per-frame Math.random,
    // so the starfield never flickers — each star keeps its identity).
    function rnd(i, salt) {
      const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
      return x - Math.floor(x);
    }

    function makeStars() {
      const n = 360;
      const s = new Array(n);
      for (let i = 0; i < n; i++) {
        s[i] = {
          x: (rnd(i, 1) - 0.5) * 2.2,
          y: (rnd(i, 2) - 0.5) * 2.2,
          z: rnd(i, 3),          // 0..1 position along the tunnel
          spd: 0.004 + rnd(i, 4) * 0.01,
        };
      }
      st.stars = s;
    }
    makeStars();

    // Ensure the framebuffer matches the current terminal size. We reserve the
    // bottom terminal row for the HUD, so H = (rows-1)*2 pixel rows.
    function ensureBuf() {
      const W = Math.max(2, core.cols() | 0);
      const H = Math.max(2, (Math.max(2, core.rows() | 0) - 1) * 2);
      if (!st.buf) { st.buf = new core.PixelBuffer(W, H); st.bw = W; st.bh = H; }
      else if (W !== st.bw || H !== st.bh) { st.buf.resize(W, H); st.bw = W; st.bh = H; }
      return st.buf;
    }

    // Rotate a point by yaw (around Y) then pitch (around X).
    function rot(x, y, z, cy, sy, cp, sp) {
      // yaw
      let nx = x * cy + z * sy;
      let nz = -x * sy + z * cy;
      // pitch
      let ny = y * cp - nz * sp;
      nz = y * sp + nz * cp;
      return [nx, ny, nz];
    }

    // Project + plot one 3D point into the buffer with depth shading.
    // x,y,z are model coords (~ -1..1). col is its base color.
    function plot(buf, x, y, z, cy, sy, cp, sp, scale, focal, col, glow) {
      const W = buf.W, H = buf.H;
      const p = rot(x, y, z, cy, sy, cp, sp);
      const px = p[0], py = p[1], pz = p[2];
      const s = focal / (focal + pz);
      if (s <= 0) return;                 // behind the camera
      const sx = W / 2 + px * s * scale;
      const sy2 = H / 2 + py * s * scale;  // half-blocks ≈ square, so no extra squash
      if (sx < 0 || sx >= W || sy2 < 0 || sy2 >= H) return;
      // depth: nearer (smaller pz) → larger value → wins z-test & brighter.
      const depth = s;
      const bright = 0.35 + 0.65 * Math.min(1, s * 0.8);
      const c = [col[0] * bright, col[1] * bright, col[2] * bright];
      buf.set(sx, sy2, c, depth);
      if (glow) {
        // a soft additive halo to make dense clouds feel luminous
        buf.add(sx, sy2, [c[0] * 0.4, c[1] * 0.4, c[2] * 0.4], 0.5);
      }
    }

    // Draw a 3D line as a series of plotted points (for wireframes).
    function line(buf, a, b, cy, sy, cp, sp, scale, focal, palette, phase) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const steps = Math.max(2, Math.ceil(len * scale * 0.5));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const col = Vis.cyc(palette, phase + f * 1.3);
        plot(buf, a[0] + dx * f, a[1] + dy * f, a[2] + dz * f,
          cy, sy, cp, sp, scale, focal, col, false);
      }
    }

    // ---- scenes ----------------------------------------------------------

    function drawCube(buf, cy, sy, cp, sp, scale, focal, pulse) {
      const palette = MOODS[st.mood];
      const v = [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      const phase = st.t * 0.02;
      for (let e = 0; e < edges.length; e++) {
        line(buf, v[edges[e][0]], v[edges[e][1]], cy, sy, cp, sp,
          scale * 0.9 * pulse, focal, palette, phase + e * 0.15);
      }
    }

    function drawTorus(buf, cy, sy, cp, sp, scale, focal, pulse) {
      const palette = MOODS[st.mood];
      const R = 0.7, r = 0.32;
      const NU = 46, NV = 18;
      const phase = st.t * 0.02;
      for (let i = 0; i < NU; i++) {
        const u = (i / NU) * TAU;
        const cu = Math.cos(u), su = Math.sin(u);
        for (let j = 0; j < NV; j++) {
          const vv = (j / NV) * TAU;
          const cv = Math.cos(vv), sv = Math.sin(vv);
          const x = (R + r * cv) * cu;
          const y = (R + r * cv) * su;
          const z = r * sv;
          const col = Vis.cyc(palette, phase + i * 0.08 + j * 0.04);
          plot(buf, x, y, z, cy, sy, cp, sp, scale * pulse, focal, col, true);
        }
      }
    }

    function drawSphere(buf, cy, sy, cp, sp, scale, focal, pulse) {
      const palette = MOODS[st.mood];
      const N = 620;            // fibonacci-sphere points → even coverage
      const ga = Math.PI * (3 - Math.sqrt(5));
      const phase = st.t * 0.02;
      for (let i = 0; i < N; i++) {
        const yy = 1 - (i / (N - 1)) * 2;     // -1..1
        const rad = Math.sqrt(Math.max(0, 1 - yy * yy));
        const th = ga * i;
        const x = Math.cos(th) * rad;
        const z = Math.sin(th) * rad;
        const col = Vis.cyc(palette, phase + (yy + 1) * 0.9);
        plot(buf, x, yy, z, cy, sy, cp, sp, scale * 0.95 * pulse, focal, col, true);
      }
    }

    function drawStarfield(buf, scale, focal, pulse) {
      const palette = MOODS[st.mood];
      const W = buf.W, H = buf.H;
      const stars = st.stars;
      // The yaw/pitch velocity gently steers the tunnel; zoom widens the throat.
      const steerX = Math.sin(st.yaw) * 0.6;
      const steerY = Math.sin(st.pitch) * 0.6;
      const phase = st.t * 0.03;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (!st.paused) {
          s.z -= s.spd * (1.4 - Math.min(1.3, st.zoom));
          if (s.z <= 0.02) {
            // recycle to the far end with a fresh lateral seed
            s.z += 1;
            s.x = (rnd(i, 1 + s.z) - 0.5) * 2.2;
            s.y = (rnd(i, 2 + s.z) - 0.5) * 2.2;
          }
        }
        const z = s.z;
        const persp = (focal * 0.5) / z;       // closer (small z) → bigger spread
        const sx = W / 2 + (s.x + steerX) * persp * scale * 0.5;
        const sy = H / 2 + (s.y + steerY) * persp * scale * 0.5;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        const near = 1 - z;                     // 0 far .. 1 near
        const col = Vis.cyc(palette, phase + i * 0.05 + near * 2);
        const bright = 0.2 + near * near * 0.8;
        const depth = near;
        buf.set(sx, sy, [col[0] * bright, col[1] * bright, col[2] * bright], depth);
        // a little streak toward the center sells the speed
        if (near > 0.55) {
          const tx = W / 2 + (s.x + steerX) * persp * scale * 0.5 * 0.92;
          const ty = H / 2 + (s.y + steerY) * persp * scale * 0.5 * 0.92;
          buf.add(tx, ty, [col[0] * 0.3, col[1] * 0.3, col[2] * 0.3], 0.5);
        }
      }
      // brighten the vanishing point so it reads as a tunnel
      buf.add((W / 2) | 0, (H / 2) | 0, [60, 60, 80], 1);
    }

    // ---- the public instance --------------------------------------------
    return {
      enter() {
        // screen is already cleared by the host; just (re)settle state.
        st.t = 0;
        st.flash = 24;
      },

      exit() {
        // drop the (potentially large) framebuffer; host handles timers/audio.
        st.buf = null;
        st.bw = st.bh = 0;
      },

      frame() {
        try {
          const buf = ensureBuf();
          const W = buf.W, H = buf.H;
          if (W < 2 || H < 4) { return; } // too tiny to draw anything meaningful

          // advance time + orientation
          if (!st.paused) {
            st.t++;
            st.yaw += st.vyaw;
            st.pitch += st.vpitch;
            // gentle damping so nudges ease back toward the lazy auto-spin
            st.vyaw += (0.012 - st.vyaw) * 0.01;
            st.vpitch += (0.004 - st.vpitch) * 0.01;
          }
          if (st.flash > 0) st.flash--;

          // optional audio flair (off by default) — pulse scale + brightness
          let pulse = 1;
          if (core.audio && core.audio.on) {
            pulse = 1 + (core.audio.level || 0) * 0.25 + (core.audio.beat || 0) * 0.15;
          }

          buf.clear([2, 2, 6]); // near-black with a faint cool tint

          const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw);
          const cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
          // base scale follows the smaller dimension so shapes fit any terminal
          const baseScale = Math.min(W, H) * 0.34 * st.zoom;
          const focal = 3.2;

          switch (st.scene) {
            case 0: drawCube(buf, cy, sy, cp, sp, baseScale, focal, pulse); break;
            case 1: drawTorus(buf, cy, sy, cp, sp, baseScale, focal, pulse); break;
            case 2: drawSphere(buf, cy, sy, cp, sp, baseScale, focal, pulse); break;
            case 3: drawStarfield(buf, baseScale, focal, pulse); break;
          }

          core.out.write(buf.emit());

          // ---- HUD (bottom terminal row) ----
          const rows = Math.max(2, core.rows() | 0);
          const name = SCENES[st.scene];
          const moodName = ['rainbow', 'sunset', 'nebula', 'ice', 'candy'][st.mood] || '';
          const status = st.paused ? ' [PAUSED]' : '';
          const hint = '←→ yaw  ↑↓ pitch  +/- zoom  n scene  c color  space pause  r reset  esc menu';
          const label = ' ORBIT · ' + name + ' · ' + moodName + status + '  ';
          const title = core.theme.gradient(label, st.t,
            { palette: MOODS[st.mood], speed: 0.12, spread: 0.5 });
          // pack title + hints, trimmed to width
          const room = Math.max(0, (core.cols() | 0) - label.length - 1);
          const hud = title + core.theme.fg([150, 150, 175]) + hint.slice(0, room) + core.RESET;
          core.out.write(core.at(rows, 1) + hud);
        } catch (e) {
          // never throw out of a frame — swallow and keep the playground alive
        }
      },

      key(s) {
        try {
          switch (s) {
            case 'q':
            case '\x1b':            // lone escape → back to menu
              return 'menu';

            case '\x1b[D': case '\x1bOD':           // left  → yaw -
              st.vyaw -= 0.02; break;
            case '\x1b[C': case '\x1bOC':           // right → yaw +
              st.vyaw += 0.02; break;
            case '\x1b[A': case '\x1bOA':           // up    → pitch -
              st.vpitch -= 0.015; break;
            case '\x1b[B': case '\x1bOB':           // down  → pitch +
              st.vpitch += 0.015; break;

            case '+': case '=': case ']':           // zoom in
              st.zoom = Math.min(4, st.zoom * 1.12); break;
            case '-': case '_': case '[':           // zoom out
              st.zoom = Math.max(0.25, st.zoom / 1.12); break;

            case 'n': case 'N':                     // next scene
              st.scene = (st.scene + 1) % SCENES.length; st.flash = 30; break;
            case 'p': case 'P':                     // previous scene (bonus)
              st.scene = (st.scene + SCENES.length - 1) % SCENES.length; st.flash = 30; break;

            case 'c': case 'C':                     // cycle color mood
              st.mood = (st.mood + 1) % MOODS.length; st.flash = 30; break;

            case ' ':                               // pause / resume
              st.paused = !st.paused; st.flash = 30; break;

            case 'r': case 'R':                     // reset orientation + zoom
              st.yaw = 0; st.pitch = 0.35;
              st.vyaw = 0.012; st.vpitch = 0.004;
              st.zoom = 1; st.flash = 30; break;
          }
        } catch (e) { /* keys must never throw */ }
        return undefined;
      },
    };
  },
};
