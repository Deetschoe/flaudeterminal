'use strict';

// ---------------------------------------------------------------------------
// lib/fireworks.js — FIREWORKS: a celebratory terminal fireworks show.
//
// Rockets streak up trailing sparks, then BURST into showers of colored stars
// that arc under gravity, twinkle, and fade with glowing trails. Built on
// core.PixelBuffer with ADDITIVE blending so every spark glows, and the whole
// buffer is faded a little each frame so trails linger like real smoke-lit
// embers. Bursts come in varied shapes (round, ring, willow, palm, crackle)
// and each one picks a distinct curated multi-color palette for real color
// diversity — never a flat uniform rainbow. Renders from the top each frame
// (no clear → no flicker). Joyful, alive, and robust on tiny terminals.
// ---------------------------------------------------------------------------

const Vis = require('/Users/dieterschoening/Developer/Flaude/lib/visuals');

const TAU = Math.PI * 2;
const clamp255 = Vis.clamp255;

// --- Color moods ----------------------------------------------------------
// Each mood is a bag of curated multi-color PALETTES. When a shell bursts we
// pick ONE palette from the current mood, so every burst is internally
// coherent (a few harmonious colors) while the sky overall stays diverse.
// 'c' cycles the mood. Colors are kept punchy — these get scaled by additive
// glow so we leave headroom below full white.
const MOODS = [
  {
    name: 'festive',
    palettes: [
      [[255, 90, 90], [255, 200, 80]],            // ember red→gold
      [[80, 160, 255], [120, 255, 230]],          // sky→aqua
      [[255, 80, 200], [180, 100, 255]],          // pink→violet
      [[120, 255, 120], [255, 255, 140]],         // lime→lemon
      [[255, 140, 60], [255, 60, 120]],           // orange→rose
      [[120, 200, 255], [255, 255, 255]],         // ice→white
    ],
  },
  {
    name: 'gold rush',
    palettes: [
      [[255, 210, 90], [255, 150, 40]],           // gold→amber
      [[255, 240, 160], [255, 110, 30]],          // cream→copper
      [[255, 180, 60], [255, 60, 30]],            // sun→fire
      [[255, 230, 120], [255, 255, 255]],         // honey→white
    ],
  },
  {
    name: 'ocean',
    palettes: [
      [[60, 120, 255], [120, 255, 230]],          // deep blue→aqua
      [[40, 220, 200], [180, 255, 255]],          // teal→pale
      [[90, 80, 255], [60, 200, 255]],            // indigo→cyan
      [[33, 230, 193], [200, 255, 240]],          // flaude aqua→mint
    ],
  },
  {
    name: 'candy',
    palettes: [
      [[255, 90, 200], [255, 220, 120]],          // pink→gold
      [[180, 120, 255], [120, 255, 220]],         // lilac→aqua
      [[255, 110, 140], [255, 230, 160]],         // rose→cream
      [[255, 80, 160], [120, 200, 255]],          // magenta→sky
    ],
  },
  {
    name: 'flaude',
    palettes: [
      [[255, 196, 75], [255, 46, 166]],           // gold→magenta
      [[255, 46, 166], [138, 91, 255]],           // magenta→violet
      [[138, 91, 255], [33, 230, 193]],           // violet→aqua
      [[33, 230, 193], [255, 196, 75]],           // aqua→gold
    ],
  },
];

// Burst shapes — each carries its own personality. 'round' classic sphere,
// 'ring' a flat expanding circle, 'willow' droopy long-lived strands, 'palm'
// fewer, thicker, upward-then-falling fronds, 'crackle' a strobing fizz.
const SHAPES = ['round', 'ring', 'willow', 'palm', 'crackle'];

module.exports = {
  name: 'FIREWORKS',
  blurb: 'launch a celebratory fireworks show',
  color: 'magenta',
  audio: false,
  create(core) {
    // --- mutable show state ----------------------------------------------
    const st = {
      buf: null,
      bw: 0, bh: 0,
      t: 0,                  // frame counter (drives sparkle + HUD gradient)
      rockets: [],           // ascending shells
      sparks: [],            // exploded stars
      launchX: 0.5,          // launch position, normalized 0..1
      burstH: 0.32,          // apex height, normalized 0..1 from TOP (smaller = higher)
      mood: 0,
      auto: true,            // idle auto-launch on by default — it's a show
      idle: 0,               // frames since last user launch
      finale: 0,             // remaining finale frames (rapid barrage)
      flash: 0,              // brief HUD flash on actions
    };

    // ---- framebuffer sizing ---------------------------------------------
    function ensureBuf() {
      const W = Math.max(2, core.cols() | 0);
      const H = Math.max(2, (Math.max(2, core.rows() | 0) - 1) * 2);
      if (!st.buf) { st.buf = new core.PixelBuffer(W, H); st.bw = W; st.bh = H; }
      else if (W !== st.bw || H !== st.bh) { st.buf.resize(W, H); st.bw = W; st.bh = H; }
      return st.buf;
    }

    // ---- helpers ---------------------------------------------------------
    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];

    // Launch a rocket that will explode near (nx, ny) in normalized coords.
    function launch(nx, ny, shape) {
      const buf = st.buf;
      if (!buf) return;
      const W = buf.W, H = buf.H;
      // start at the bottom, just below the screen, aim for the target apex.
      const x = clampN(nx) * W;
      const targetY = clampN(ny) * H;
      const startY = H - 1;
      // pick a coherent palette from the current mood for this whole shell.
      const palette = pick(MOODS[st.mood].palettes);
      st.rockets.push({
        x, y: startY,
        vx: rand(-0.15, 0.15),
        // upward velocity sized so the shell coasts to ~targetY then bursts.
        vy: -Math.max(0.7, Math.sqrt(Math.max(1, startY - targetY)) * 0.55),
        targetY,
        palette,
        shape: shape || pick(SHAPES),
        // small chance of an extra-fat shell with more sparks.
        big: Math.random() < 0.25,
        life: 0,
      });
    }

    function clampN(v) { return v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v; }

    // Burst a shell at (x,y) into many sparks of the given shape + palette.
    function burst(x, y, palette, shape, big) {
      const buf = st.buf;
      if (!buf) return;
      const scale = Math.min(buf.W, buf.H);
      // spark count scales with terminal size, capped so huge terms stay smooth.
      let n = Math.round((shape === 'palm' ? 26 : 60) * (big ? 1.6 : 1));
      n = Math.max(10, Math.min(160, Math.round(n * (scale / 60))));
      const sparks = st.sparks;
      const baseSpeed = (shape === 'ring' ? 0.9 : 0.7) * (1 + scale / 220);
      for (let i = 0; i < n; i++) {
        let ang, spd, life, grav, drag, twk;
        if (shape === 'ring') {
          // flat-ish ring: angles spread evenly, speeds nearly uniform.
          ang = (i / n) * TAU + rand(-0.04, 0.04);
          spd = baseSpeed * rand(0.92, 1.05);
          life = rand(36, 56);
          grav = 0.018; drag = 0.97; twk = 0.5;
        } else if (shape === 'willow') {
          // drooping long strands: slower, very long life, heavier fall.
          ang = Math.random() * TAU;
          spd = baseSpeed * rand(0.25, 0.8);
          life = rand(70, 110);
          grav = 0.03; drag = 0.985; twk = 0.25;
        } else if (shape === 'palm') {
          // fronds: biased upward, thick, then arc down.
          ang = -Math.PI / 2 + rand(-0.9, 0.9);
          spd = baseSpeed * rand(0.8, 1.25);
          life = rand(55, 85);
          grav = 0.028; drag = 0.98; twk = 0.35;
        } else if (shape === 'crackle') {
          // strobing fizz: short life, frantic twinkle.
          ang = Math.random() * TAU;
          spd = baseSpeed * rand(0.3, 1.1) * Math.sqrt(Math.random());
          life = rand(22, 40);
          grav = 0.02; drag = 0.95; twk = 1.0;
        } else {
          // round: classic sphere, sqrt for even disc fill.
          ang = Math.random() * TAU;
          spd = baseSpeed * rand(0.35, 1.0) * Math.sqrt(Math.random() + 0.05);
          life = rand(45, 70);
          grav = 0.022; drag = 0.975; twk = 0.45;
        }
        const colT = Math.random();              // where this spark sits in palette
        sparks.push({
          x, y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          grav, drag,
          life, maxLife: life,
          col: Vis.ramp(palette, colT),
          twk,                                   // twinkle amount
          ph: Math.random() * TAU,               // twinkle phase offset
        });
      }
      // a bright central flash so the burst reads as a real detonation.
      sparks.push({
        x, y, vx: 0, vy: 0, grav: 0, drag: 1,
        life: 6, maxLife: 6, col: [255, 255, 255], twk: 0, ph: 0, flash: true,
      });
      st.flash = 8;
    }

    // Unleash a finale — many rockets over the next ~1.5s.
    function finale() {
      st.finale = 90;
      st.flash = 30;
    }

    // ---- the public instance --------------------------------------------
    return {
      enter() {
        st.t = 0;
        st.rockets.length = 0;
        st.sparks.length = 0;
        st.idle = 0;
        st.finale = 0;
        st.flash = 20;
      },

      exit() {
        // release the framebuffer + particles; host handles timers.
        st.buf = null;
        st.bw = st.bh = 0;
        st.rockets.length = 0;
        st.sparks.length = 0;
      },

      frame() {
        try {
          const buf = ensureBuf();
          const W = buf.W, H = buf.H;
          if (W < 2 || H < 4) { return; }
          st.t++;
          if (st.flash > 0) st.flash--;

          // ---- fade the buffer for glowing trails ----
          // Scale every channel down a touch each frame; recent sparks stay
          // bright, old paths decay into embers. Faster fade keeps it crisp.
          const col = buf.col;
          const decay = 0.80;
          for (let i = 0, nn = col.length; i < nn; i++) col[i] *= decay;
          // never let z interfere — we only ever additively blend here.

          // ---- auto-show / finale launching ----
          st.idle++;
          if (st.finale > 0) {
            st.finale--;
            // rapid barrage: a couple of shells most frames, scattered widely.
            if (st.t % 3 === 0) {
              const k = 1 + ((Math.random() * 2) | 0);
              for (let j = 0; j < k; j++) {
                launch(rand(0.1, 0.9), rand(0.18, 0.45));
              }
            }
            st.idle = 0;
          } else if (st.auto && st.idle > 36 && Math.random() < 0.06) {
            // occasional ambient launch when the user is idle.
            launch(rand(0.15, 0.85), rand(0.2, 0.45));
            st.idle = 0;
          }

          // ---- update + draw rockets ----
          const rk = st.rockets;
          for (let i = rk.length - 1; i >= 0; i--) {
            const r = rk[i];
            r.life++;
            r.vy += 0.022;            // gravity slows the ascent
            r.x += r.vx;
            r.y += r.vy;
            // sparkly ascending trail
            buf.add(r.x, r.y, [255, 230, 180], 1.0);
            buf.add(r.x, r.y - 1, [120, 90, 50], 0.6);
            // jittery ember just behind it
            buf.add(r.x + rand(-0.4, 0.4), r.y + 1, [180, 120, 60], 0.5);
            // explode at apex (velocity turns downward) or once it reaches target
            if (r.vy >= -0.05 || r.y <= r.targetY) {
              burst(r.x, r.y, r.palette, r.shape, r.big);
              rk.splice(i, 1);
            } else if (r.y < -2 || r.x < -2 || r.x > W + 2) {
              rk.splice(i, 1);       // safety: stray rocket
            }
          }

          // ---- update + draw sparks ----
          const sp = st.sparks;
          for (let i = sp.length - 1; i >= 0; i--) {
            const p = sp[i];
            p.life--;
            if (p.life <= 0) { sp.splice(i, 1); continue; }
            if (!p.flash) {
              p.vy += p.grav;
              p.vx *= p.drag;
              p.vy *= p.drag;
              p.x += p.vx;
              p.y += p.vy;
            }
            // cull off-screen sparks (keep a margin so trails fade gracefully)
            if (p.y > H + 2 || p.x < -2 || p.x > W + 2) { sp.splice(i, 1); continue; }
            // alpha fades over life; twinkle jitters brightness for sparkle.
            const lf = p.life / p.maxLife;
            let a = lf;
            if (p.twk > 0) {
              // crackle/strobe sparks blink hard; others shimmer gently.
              const tw = 0.5 + 0.5 * Math.sin(st.t * 0.9 + p.ph * 5);
              a *= (1 - p.twk) + p.twk * tw;
            }
            if (p.flash) a = 1;
            const c = p.col;
            const k = a * (p.flash ? 2.2 : 1.0);
            // core dot
            buf.add(p.x, p.y, c, k);
            // soft halo to make it bloom (additive — overlaps glow brighter)
            buf.add(p.x, p.y, [c[0] * 0.45, c[1] * 0.45, c[2] * 0.45], k * 0.6);
          }

          core.out.write(buf.emit());

          // ---- HUD (bottom terminal row) ----
          const rows = Math.max(2, core.rows() | 0);
          const moodName = MOODS[st.mood].name;
          const autoTxt = st.auto ? 'auto' : 'manual';
          const fin = st.finale > 0 ? ' FINALE!' : '';
          const label = ' FIREWORKS · ' + moodName + ' · ' + autoTxt + fin + '  ';
          const title = core.theme.gradient(label, st.t,
            { palette: MOODS[st.mood].palettes[0].concat(MOODS[st.mood].palettes[1] || []),
              speed: 0.13, spread: 0.5 });
          const hint = 'space launch  ←→ move  ↑↓ height  f finale  a auto  c color  esc menu';
          const room = Math.max(0, (core.cols() | 0) - label.length - 1);
          const hud = title + core.theme.fg([150, 150, 175]) + hint.slice(0, room) + core.RESET;
          core.out.write(core.at(rows, 1) + hud);
        } catch (e) {
          // never throw out of a frame — keep the show alive.
        }
      },

      key(s) {
        try {
          switch (s) {
            case 'q':
            case '\x1b':                          // lone escape → menu
              return 'menu';

            case ' ':                             // launch a rocket
              launch(st.launchX, st.burstH);
              st.idle = 0;
              break;

            case '\x1b[D': case '\x1bOD':         // left  → move launch X
              st.launchX = clampN(st.launchX - 0.05); break;
            case '\x1b[C': case '\x1bOC':         // right → move launch X
              st.launchX = clampN(st.launchX + 0.05); break;
            case '\x1b[A': case '\x1bOA':         // up    → higher burst (smaller H)
              st.burstH = Math.max(0.12, st.burstH - 0.04); break;
            case '\x1b[B': case '\x1bOB':         // down  → lower burst
              st.burstH = Math.min(0.6, st.burstH + 0.04); break;

            case 'f': case 'F':                   // FINALE barrage
              finale(); break;
            case 'a': case 'A':                   // toggle auto-show
              st.auto = !st.auto; st.flash = 20; break;
            case 'c': case 'C':                   // cycle color mood
              st.mood = (st.mood + 1) % MOODS.length; st.flash = 20; break;
          }
        } catch (e) { /* keys must never throw */ }
        return undefined;
      },
    };
  },
};
