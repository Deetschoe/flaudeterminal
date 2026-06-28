'use strict';

// ---------------------------------------------------------------------------
// lib/settings.js — toggle Flaude features on & off. Arrow keys move, Enter (or
// space) flips the highlighted switch; changes apply and persist immediately.
// ---------------------------------------------------------------------------

const Vis = require('./visuals');
const { fg, gradient, RESET } = Vis;
const CSI = Vis.CSI;
const goto = (r, c) => CSI + r + ';' + c + 'H';

module.exports = {
  name: 'SETTINGS',
  blurb: 'toggle features on & off',
  color: 'violet',
  audio: false,

  create(core) {
    // each toggle reads/writes core.settings
    const TOGGLES = [
      { key: 'caffeinate', label: 'Keep Mac awake', hint: 'runs caffeinate so it keeps going on the go' },
      { key: 'finishFlash', label: 'Flash on Claude finish', hint: 'flash when any Claude Code instance finishes' },
      { key: 'greet', label: 'Flo greets you', hint: 'a hello from Flo when the console opens' },
    ];
    const S = { frame: 0, sel: 0 };
    const val = (k) => core.settings.get(k) !== false;

    function key(s) {
      if (s === '\x1b' || s === 'q') return 'menu';
      if (s === '\x1b[A' || s === '\x1bOA' || s === 'k') { S.sel = (S.sel + TOGGLES.length - 1) % TOGGLES.length; return; }
      if (s === '\x1b[B' || s === '\x1bOB' || s === 'j') { S.sel = (S.sel + 1) % TOGGLES.length; return; }
      if (s === '\r' || s === '\n' || s === ' ') { const t = TOGGLES[S.sel]; core.settings.set(t.key, !val(t.key)); return; }
    }

    function render() {
      S.frame++;
      const cols = core.cols(), rows = core.rows();
      const pal = core.theme.palette();
      const W = Math.min(56, cols - 4);
      const L = Math.max(2, Math.floor((cols - W) / 2) + 1);
      let r = Math.max(2, Math.floor((rows - 14) / 2) + 1);
      let o = CSI + '2J';

      const title = '✦  SETTINGS  ✦';
      o += goto(r, L + Math.floor((W - title.length) / 2)) + gradient(title, S.frame, { palette: pal, speed: 0.06, spread: 0.5 }); r += 2;

      TOGGLES.forEach((t, i) => {
        const on = val(t.key);
        const sel = i === S.sel;
        const pill = on ? fg([120, 230, 170]) + '[ ON  ]' : fg([130, 110, 120]) + '[ OFF ]';
        const name = sel ? gradient('▸ ' + t.label, S.frame, { palette: pal, speed: 0.12, spread: 0.5 })
                         : fg([200, 200, 215]) + '  ' + t.label;
        o += goto(r, L) + name + RESET + goto(r, L + W - 7) + pill + RESET; r += 1;
        if (sel) { o += goto(r, L + 2) + fg([120, 120, 145]) + t.hint + RESET; r += 1; }
        else r += 0;
        r += 1;
      });

      r += 1;
      const caf = core.settings.caffeinateActive ? core.settings.caffeinateActive() : false;
      o += goto(r, L) + fg([120, 120, 145]) + 'caffeinate: ' + fg(caf ? [120, 230, 170] : [200, 120, 130]) + (caf ? 'active (Mac staying awake)' : 'off') + RESET; r += 1;
      o += goto(r, L) + fg([120, 120, 145]) + 'voice: ' + fg(core.voiceAvailable ? [120, 230, 170] : [160, 140, 150]) + (core.voiceAvailable ? 'available (`)' : 'no whisper model') + RESET; r += 1;
      o += goto(r, L) + fg([120, 120, 145]) + 'theme: ' + fg(pal[0]) + core.config.get('theme') + fg([120, 120, 145]) + '  (change with /theme)' + RESET;

      o += goto(rows, L) + fg([90, 90, 115]) + '↑↓ move · enter toggle · esc back' + RESET;
      core.out.write(o);
    }

    return { enter() { S.frame = 0; }, frame() { try { render(); } catch (e) {} }, key };
  },
};
