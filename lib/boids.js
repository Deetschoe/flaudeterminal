'use strict';

// ---------------------------------------------------------------------------
// lib/boids.js — BOIDS: a living flock that swirls and flees.
//
// Reynolds' classic flocking model (separation + alignment + cohesion) rendered
// in truecolor half-blocks through core.PixelBuffer. A few dozen "birds" swirl
// with emergent, lifelike motion, each tinted by its heading from a curated
// multi-color mood palette (NOT a uniform rainbow wash). Every frame the buffer
// is faded ~0.8 so the flock leaves glowing motion trails.
//
// The flock has personality: it's drawn toward an arrow-key ATTRACTOR/cursor,
// flees a PREDATOR you can drop with `p`, and scatters in a startle burst on
// `space`. +/- grow/shrink the flock, `c` cycles the color mood.
//
// Render-from-the-top each frame (no clear → no flicker). Never throws from
// frame()/key(); robust on tiny and huge terminals alike.
// ---------------------------------------------------------------------------

const Vis = require('/Users/dieterschoening/Developer/Flaude/lib/visuals');

const TAU = Math.PI * 2;

// Color moods — each is a curated palette the boids are tinted through by
// heading. Distinct, vivid bands rather than a smooth full-spectrum wash. 'c'
// steps the mood. These wrap cyclically (last → first) for seamless hue rings.
const MOODS = [
  { name: 'flaude', pal: Vis.P4 },                                  // gold→magenta→violet→aqua
  { name: 'sunset', pal: [[255, 96, 60], [255, 196, 75], [255, 46, 166], [138, 91, 255]] },
  { name: 'reef',   pal: [[33, 230, 193], [60, 180, 255], [138, 91, 255], [120, 255, 160]] },
  { name: 'ember',  pal: [[255, 80, 40], [255, 160, 40], [255, 220, 120], [200, 40, 80]] },
  { name: 'aurora', pal: [[60, 255, 160], [33, 230, 193], [80, 140, 255], [200, 90, 255]] },
];

// Background tints per mood — a faint cool/warm wash so trails sit on a mood.
const MOOD_BG = [
  [3, 3, 8], [8, 3, 6], [2, 6, 8], [8, 4, 3], [2, 6, 6],
];

module.exports = {
  name: 'BOIDS',
  blurb: 'a living flock that swirls and flees',
  color: 'aqua',
  audio: false,
  create(core) {
    // --- mutable simulation state ----------------------------------------
    const st = {
      buf: null,          // PixelBuffer, lazily (re)sized to the terminal
      bw: 0, bh: 0,       // last buffer pixel dims (to detect resize)
      t: 0,               // frame counter (drives the color flow + HUD)
      boids: [],          // array of {x,y,vx,vy} in pixel space
      want: 0,            // desired flock size (grown/shrunk with +/-)
      mood: 0,            // index into MOODS
      // attractor / cursor — the flock is gently drawn here. Steered by arrows.
      ax: 0, ay: 0,
      attract: true,      // attractor active? (always on; arrows move it)
      // predator — boids flee it. Toggled with `p`; rides near the attractor.
      predator: false,
      px: 0, py: 0,
      scatter: 0,         // startle-burst timer; while >0 boids fly apart
      flash: 0,           // brief HUD flash on mood / mode change
      msg: '',            // transient HUD message
    };

    // Tunable flocking parameters (in pixel units; the perception radius scales
    // a touch with the buffer so behaviour feels consistent across sizes).
    const P = {
      maxSpeed: 0.9,      // velocity cap (pixels/frame)
      minSpeed: 0.28,     // keep birds gliding, never frozen
      perception: 7.0,    // neighbour radius for alignment + cohesion
      sepRadius: 2.6,     // tighter radius for separation (personal space)
      wSep: 0.045,        // separation weight (push apart)
      wAli: 0.05,         // alignment weight (match heading)
      wCoh: 0.0009,       // cohesion weight (steer to local center)
      wAttract: 0.0012,   // pull toward the cursor/attractor
      wFlee: 6.0,         // flee strength near the predator (inverse-square)
      fleeRadius: 16,     // predator influence radius
      wander: 0.012,      // tiny per-boid heading drift for organic motion
      edge: 'wrap',       // 'wrap' toroidal world (smoothest swirl)
    };

    // Deterministic per-index pseudo-random in 0..1 — used for stable per-boid
    // "wander phase" so motion is organic but never frame-to-frame jittery.
    function rnd(i, salt) {
      const x = Math.sin(i * 12.9898 + (salt || 0) * 78.233) * 43758.5453;
      return x - Math.floor(x);
    }

    // Ensure the framebuffer matches the terminal. Bottom terminal row is the
    // HUD, so H = (rows-1)*2 pixel rows. On resize we keep the flock but clamp
    // positions back inside the new world.
    function ensureBuf() {
      const W = Math.max(2, core.cols() | 0);
      const H = Math.max(2, (Math.max(2, core.rows() | 0) - 1) * 2);
      if (!st.buf) {
        st.buf = new core.PixelBuffer(W, H); st.bw = W; st.bh = H;
        // first sizing — seed the cursor/predator at center and stock the flock
        st.ax = W / 2; st.ay = H / 2; st.px = W / 2; st.py = H / 2;
        if (st.want === 0) st.want = defaultCount(W, H);
        stock(W, H);
      } else if (W !== st.bw || H !== st.bh) {
        st.buf.resize(W, H); st.bw = W; st.bh = H;
        // clamp everything into the new bounds
        st.ax = Math.min(W - 1, Math.max(0, st.ax));
        st.ay = Math.min(H - 1, Math.max(0, st.ay));
        st.px = Math.min(W - 1, Math.max(0, st.px));
        st.py = Math.min(H - 1, Math.max(0, st.py));
        for (let i = 0; i < st.boids.length; i++) {
          const b = st.boids[i];
          if (b.x < 0) b.x = 0; else if (b.x >= W) b.x = W - 1;
          if (b.y < 0) b.y = 0; else if (b.y >= H) b.y = H - 1;
        }
        stock(W, H);
      }
      return st.buf;
    }

    // A sensible default flock size scaled to the canvas area.
    function defaultCount(W, H) {
      const n = Math.round((W * H) / 220);
      return Math.min(120, Math.max(14, n));
    }

    // Spawn a single boid with a random position + gentle random heading.
    function spawn(W, H, i) {
      const ang = rnd(i, 7) * TAU;
      const spd = P.minSpeed + rnd(i, 9) * (P.maxSpeed - P.minSpeed);
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        seed: i,                 // stable identity for the wander phase
      };
    }

    // Grow/shrink the live flock to match st.want (clamped to canvas capacity).
    function stock(W, H) {
      const cap = Math.max(2, Math.min(300, Math.floor((W * H) / 24)));
      const want = Math.max(2, Math.min(cap, st.want | 0));
      st.want = want;
      while (st.boids.length < want) st.boids.push(spawn(W, H, st.boids.length + st.t));
      if (st.boids.length > want) st.boids.length = want;
    }

    // Cap a boid's speed into [minSpeed, maxSpeed] (keeps the flock gliding).
    function clampSpeed(b) {
      let sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp < 1e-6) { b.vx = P.minSpeed; b.vy = 0; return; }
      let target = sp;
      if (sp > P.maxSpeed) target = P.maxSpeed;
      else if (sp < P.minSpeed) target = P.minSpeed;
      if (target !== sp) { const k = target / sp; b.vx *= k; b.vy *= k; }
    }

    // ---- one simulation step --------------------------------------------
    function step(W, H) {
      const boids = st.boids;
      const n = boids.length;
      // Perception scales slightly with canvas so flocks read well at any size.
      const perc = P.perception * (1 + Math.min(1, (W * H) / 30000) * 0.6);
      const perc2 = perc * perc;
      const sep2 = P.sepRadius * P.sepRadius;
      const wrap = P.edge === 'wrap';

      for (let i = 0; i < n; i++) {
        const b = boids[i];
        let sepx = 0, sepy = 0;          // separation accumulator
        let alix = 0, aliy = 0;          // alignment accumulator
        let cohx = 0, cohy = 0;          // cohesion (center of mass)
        let cnt = 0;

        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const o = boids[j];
          let dx = o.x - b.x, dy = o.y - b.y;
          // shortest toroidal distance so the flock stays cohesive across wraps
          if (wrap) {
            if (dx > W * 0.5) dx -= W; else if (dx < -W * 0.5) dx += W;
            if (dy > H * 0.5) dy -= H; else if (dy < -H * 0.5) dy += H;
          }
          const d2 = dx * dx + dy * dy;
          if (d2 > perc2 || d2 < 1e-6) continue;
          cnt++;
          alix += o.vx; aliy += o.vy;
          cohx += dx; cohy += dy;        // relative — center of neighbours
          if (d2 < sep2) {
            // push away, stronger the closer they are
            const inv = 1 / (d2 + 0.4);
            sepx -= dx * inv; sepy -= dy * inv;
          }
        }

        if (cnt > 0) {
          // separation
          b.vx += sepx * P.wSep; b.vy += sepy * P.wSep;
          // alignment — steer toward average neighbour velocity
          b.vx += (alix / cnt - b.vx) * P.wAli;
          b.vy += (aliy / cnt - b.vy) * P.wAli;
          // cohesion — drift toward the local center of mass
          b.vx += cohx * P.wCoh; b.vy += cohy * P.wCoh;
        }

        // attractor / cursor pull (toroidal-aware so it never tugs across)
        if (st.attract) {
          let dx = st.ax - b.x, dy = st.ay - b.y;
          if (wrap) {
            if (dx > W * 0.5) dx -= W; else if (dx < -W * 0.5) dx += W;
            if (dy > H * 0.5) dy -= H; else if (dy < -H * 0.5) dy += H;
          }
          b.vx += dx * P.wAttract; b.vy += dy * P.wAttract;
        }

        // predator flee — strong inverse-square shove away when near
        if (st.predator) {
          let dx = b.x - st.px, dy = b.y - st.py;
          if (wrap) {
            if (dx > W * 0.5) dx -= W; else if (dx < -W * 0.5) dx += W;
            if (dy > H * 0.5) dy -= H; else if (dy < -H * 0.5) dy += H;
          }
          const d2 = dx * dx + dy * dy;
          if (d2 < P.fleeRadius * P.fleeRadius && d2 > 1e-4) {
            const f = P.wFlee / (d2 + 1);
            b.vx += dx * f; b.vy += dy * f;
          }
        }

        // startle scatter — a brief outward burst from the flock's mid-screen
        if (st.scatter > 0) {
          let dx = b.x - st.ax, dy = b.y - st.ay;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
          b.vx += (dx / d) * 0.55 * (st.scatter / 18);
          b.vy += (dy / d) * 0.55 * (st.scatter / 18);
        }

        // organic wander — a slow per-boid heading drift (no flicker: phase is
        // derived from the boid's stable seed + the global frame counter).
        const wp = st.t * 0.05 + b.seed * 1.7;
        b.vx += Math.cos(wp) * P.wander;
        b.vy += Math.sin(wp * 1.3) * P.wander;

        clampSpeed(b);
      }

      // integrate positions + handle world edges
      for (let i = 0; i < n; i++) {
        const b = boids[i];
        b.x += b.vx; b.y += b.vy;
        if (wrap) {
          if (b.x < 0) b.x += W; else if (b.x >= W) b.x -= W;
          if (b.y < 0) b.y += H; else if (b.y >= H) b.y -= H;
        } else {
          if (b.x < 0) { b.x = 0; b.vx = Math.abs(b.vx); }
          else if (b.x >= W) { b.x = W - 1; b.vx = -Math.abs(b.vx); }
          if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy); }
          else if (b.y >= H) { b.y = H - 1; b.vy = -Math.abs(b.vy); }
        }
      }

      if (st.scatter > 0) st.scatter--;
    }

    // ---- rendering -------------------------------------------------------

    // Fade the whole buffer toward black for glowing motion trails.
    function fade(buf, k) {
      const col = buf.col;
      for (let i = 0, nn = col.length; i < nn; i++) col[i] *= k;
    }

    // Add a soft additive glow blob (plus-shape with a brighter core).
    function glow(buf, x, y, c, core1) {
      buf.add(x, y, c, core1);
      buf.add(x + 1, y, c, 0.28);
      buf.add(x - 1, y, c, 0.28);
      buf.add(x, y + 1, c, 0.28);
      buf.add(x, y - 1, c, 0.28);
    }

    function render(buf, W, H) {
      const mood = MOODS[st.mood];
      const pal = mood.pal;
      const npal = pal.length;
      const flowing = st.t * 0.01;     // slow global hue drift so colors breathe

      for (let i = 0; i < st.boids.length; i++) {
        const b = st.boids[i];
        // hue from heading: map the velocity angle to a palette ring position so
        // birds going the same way share a color → vivid, banded, NOT a wash.
        const ang = Math.atan2(b.vy, b.vx);     // -PI..PI
        const ringPos = ((ang / TAU) + 0.5) * npal + flowing;
        const c = Vis.cyc(pal, ringPos);
        // speed → brightness so fast streaks pop
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        const bright = 0.7 + Math.min(1, sp / P.maxSpeed) * 0.6;
        const bc = [c[0] * bright, c[1] * bright, c[2] * bright];

        // a short trailing tail in the direction of travel sells the motion
        const tx = b.x - b.vx * 1.4, ty = b.y - b.vy * 1.4;
        buf.add(tx, ty, [bc[0] * 0.35, bc[1] * 0.35, bc[2] * 0.35], 0.5);

        // the bird itself — bright additive core + halo
        glow(buf, b.x, b.y, bc, 1.0);
      }

      // attractor cursor — a calm white-gold pulsing marker the flock follows
      if (st.attract) {
        const pulse = 0.5 + 0.5 * Math.sin(st.t * 0.18);
        const ac = [255 * (0.5 + pulse * 0.5), 230 * (0.4 + pulse * 0.4), 150];
        glow(buf, st.ax, st.ay, ac, 0.7 + pulse * 0.5);
      }

      // predator — a menacing red eye the boids flee
      if (st.predator) {
        const pulse = 0.6 + 0.4 * Math.sin(st.t * 0.3);
        const pc = [255 * pulse, 40 * pulse, 50 * pulse];
        buf.add(st.px, st.py, pc, 1.6);
        buf.add(st.px + 1, st.py, pc, 0.7);
        buf.add(st.px - 1, st.py, pc, 0.7);
        buf.add(st.px, st.py + 1, pc, 0.7);
        buf.add(st.px, st.py - 1, pc, 0.7);
        buf.add(st.px + 1, st.py + 1, pc, 0.35);
        buf.add(st.px - 1, st.py - 1, pc, 0.35);
        buf.add(st.px + 1, st.py - 1, pc, 0.35);
        buf.add(st.px - 1, st.py + 1, pc, 0.35);
      }
    }

    // ---- the public instance --------------------------------------------
    return {
      enter() {
        // host has cleared the screen; settle timing + a welcome HUD flash.
        st.t = 0;
        st.flash = 28;
        st.msg = 'flock awake';
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
          if (W < 2 || H < 4) return;   // too tiny to draw anything meaningful

          st.t++;
          if (st.flash > 0) st.flash--;

          step(W, H);

          // fade the buffer toward the mood's background for glowing trails.
          // We fade ~0.8 then re-tint the cleared floor so it never goes pure
          // black (keeps a subtle mood wash behind the flock).
          fade(buf, 0.8);
          const mbg = MOOD_BG[st.mood] || [3, 3, 8];
          const col = buf.col;
          for (let i = 0, nn = W * H; i < nn; i++) {
            const o = i * 3;
            if (col[o] < mbg[0]) col[o] = mbg[0];
            if (col[o + 1] < mbg[1]) col[o + 1] = mbg[1];
            if (col[o + 2] < mbg[2]) col[o + 2] = mbg[2];
          }

          render(buf, W, H);
          core.out.write(buf.emit());

          // ---- HUD (bottom terminal row) ----
          const rows = Math.max(2, core.rows() | 0);
          const status =
            (st.predator ? ' P!' : '') +
            (st.scatter > 0 ? ' scatter' : '');
          const label = ' BOIDS · ' + MOODS[st.mood].name +
            ' · ' + st.boids.length + ' birds' + status + '  ';
          const title = core.theme.gradient(label, st.t,
            { palette: MOODS[st.mood].pal, speed: 0.12, spread: 0.5 });
          const hint = '←→↑↓ cursor  p predator  space scatter  +/- birds  c color  esc menu';
          const room = Math.max(0, (core.cols() | 0) - label.length - 1);
          const hud = title + core.theme.fg([150, 150, 175]) +
            hint.slice(0, room) + core.RESET;
          core.out.write(core.at(rows, 1) + hud);
        } catch (e) {
          // never throw out of a frame — swallow and keep the playground alive
        }
      },

      key(s) {
        try {
          const W = st.bw || (core.cols() | 0);
          const H = st.bh || ((core.rows() | 0 - 1) * 2);
          const stepX = Math.max(2, W * 0.06);
          const stepY = Math.max(2, H * 0.06);
          switch (s) {
            case 'q':
            case '\x1b':                              // lone escape → menu
              return 'menu';

            // arrows steer the attractor/cursor (the predator rides with it so
            // dropping `p` lets you "chase" the flock around).
            case '\x1b[D': case '\x1bOD':             // left
              st.ax -= stepX; break;
            case '\x1b[C': case '\x1bOC':             // right
              st.ax += stepX; break;
            case '\x1b[A': case '\x1bOA':             // up
              st.ay -= stepY; break;
            case '\x1b[B': case '\x1bOB':             // down
              st.ay += stepY; break;

            case 'p': case 'P':                       // toggle predator
              st.predator = !st.predator;
              st.flash = 30;
              st.msg = st.predator ? 'predator!' : 'predator gone';
              break;

            case ' ':                                 // startle scatter burst
              st.scatter = 18;
              st.flash = 24;
              st.msg = 'scatter!';
              break;

            case '+': case '=': case ']':             // add boids
              st.want = (st.want | 0) + 4;
              if (st.bw) stock(st.bw, st.bh);
              st.flash = 18;
              break;
            case '-': case '_': case '[':             // remove boids
              st.want = Math.max(2, (st.want | 0) - 4);
              if (st.bw) stock(st.bw, st.bh);
              st.flash = 18;
              break;

            case 'c': case 'C':                       // cycle color mood
              st.mood = (st.mood + 1) % MOODS.length;
              st.flash = 30;
              st.msg = MOODS[st.mood].name;
              break;
          }

          // keep the steered cursor/predator inside the world (wrap-friendly)
          if (W > 0 && H > 0) {
            if (st.ax < 0) st.ax += W; else if (st.ax >= W) st.ax -= W;
            if (st.ay < 0) st.ay += H; else if (st.ay >= H) st.ay -= H;
            // predator follows the cursor so it's always where you're aiming
            st.px = st.ax; st.py = st.ay;
          }
        } catch (e) { /* keys must never throw */ }
        return undefined;
      },
    };
  },
};
