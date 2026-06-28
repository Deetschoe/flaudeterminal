'use strict';

// ---------------------------------------------------------------------------
// lib/custom.js — CUSTOM: describe a shader in words (or by voice) and let
// Claude forge it. Flaude extracts the code, validates + saves it forever to
// ~/.flaude/shaders/, gives it its own color, and immediately hands it to the
// live field renderer. The shader also joins PORTAL's cycle from then on.
//
// Flow: TYPE → (enter) → FORGING (Claude) → on success runField() the new
// shader; on a broken result, do ONE automatic repair round with the error and
// the previous code before giving up. Voice (Wispr-style) toggles with backtick.
//
// Pure render-from-the-top each frame (no clear → no flicker). Never throws
// from frame()/key().
// ---------------------------------------------------------------------------

const Vis = require('/Users/dieterschoening/Developer/Flaude/lib/visuals');

// A few inviting example ideas, shown under the prompt to spark imagination.
const EXAMPLES = ['lava lamp', 'matrix rain', 'neon plasma', 'aurora storm', 'liquid chrome'];

// CUSTOM's own signature color — a warm white, distinct from the four modes.
const CUSTOM_COLOR = [240, 240, 255];

// ---------------------------------------------------------------------------
// Code extraction — pull the shader source out of Claude's reply.
//   1. first ```js ... ``` (or ``` ... ```) fenced block, if any;
//   2. otherwise the trimmed whole output.
// Then ensure it is a CommonJS module: if there's no "module.exports", but the
// text looks like a bare object literal, prepend "module.exports = ".
// ---------------------------------------------------------------------------
function extractCode(raw) {
  let code = '';
  const text = String(raw || '');
  // Prefer a ```js / ```javascript fence; fall back to any fenced block.
  const fenced = text.match(/```(?:js|javascript)?[ \t]*\r?\n([\s\S]*?)```/i);
  if (fenced) code = fenced[1];
  else code = text;
  code = code.trim();
  // If Claude returned a bare object literal, wrap it into a module.
  if (!/module\.exports/.test(code)) {
    const obj = code.match(/\{[\s\S]*\}/);
    if (obj) code = 'module.exports = ' + obj[0].trim() + ';';
  }
  return code;
}

// Derive a filesystem-safe slug from the user's description.
function slugify(desc) {
  return String(desc).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'shader';
}

// ---------------------------------------------------------------------------
// Generation prompt — PRECISE instructions so Claude returns ONE valid shader
// module that satisfies the contract. Kept tight; reused (with extras) on repair.
// ---------------------------------------------------------------------------
function buildPrompt(desc) {
  return [
    'You are generating ONE animated shader for a terminal visualizer called Flaude.',
    'The user wants a shader that looks like: "' + desc + '".',
    '',
    'Output ONLY a single CommonJS module in a ```js fenced code block. No prose,',
    'no explanation before or after — just the fenced code block.',
    '',
    'The module MUST follow this exact contract:',
    '',
    '```js',
    'module.exports = {',
    "  name: 'a-kebab-case-name',",
    '  palette: [[r,g,b], [r,g,b], ...], // 4-7 [0..255] color stops, ordered dark -> bright',
    '  field(x, y, t) {                  // x,y are WORLD coords (~ -3..6), t is seconds-ish time',
    '    // Return a single number in 0..1 (it will be clamped). Higher = brighter palette color.',
    '    // Use ONLY Math.* operations. No require, no globals, no I/O, no Math.random.',
    '    // Must be PURE and DETERMINISTIC, smooth, and animated continuously via t.',
    '    return /* a number in 0..1 */;',
    '  },',
    '  glow(f) { return 0.6 + 0.6 * f * f; }, // optional brightness curve for the field value',
    '};',
    '```',
    '',
    'Requirements:',
    '- field(x,y,t) must ALWAYS return a finite number for any inputs (no NaN/Infinity).',
    '- Animate via t so it visibly flows; do not depend on any external state.',
    '- Make it beautiful and clearly evoke: "' + desc + '".',
    'Return the code block now.',
  ].join('\n');
}

// Repair prompt — includes the previous (broken) code and the specific error.
function buildRepairPrompt(desc, prevCode, errMsg) {
  return [
    'The following shader module for Flaude is broken and was rejected.',
    'Description it should match: "' + desc + '".',
    'Error / reason it failed: ' + errMsg,
    '',
    'Here is the previous code:',
    '```js',
    prevCode,
    '```',
    '',
    'Fix it. Output ONLY the corrected single CommonJS module in a ```js fenced',
    'code block — no prose. It MUST export { name, palette:[[r,g,b]...],',
    'field(x,y,t)->finite number in 0..1, glow?(f) }, use ONLY Math.*, be pure,',
    'deterministic (no Math.random), and animate via t.',
  ].join('\n');
}

module.exports = {
  name: 'CUSTOM',
  blurb: 'describe a shader; Claude forges it & saves it forever',
  color: 'white',
  audio: false,

  create(core) {
    const RESET = core.RESET;

    // --- mutable experience state ----------------------------------------
    const st = {
      phase: 'type',     // 'type' | 'forging' | 'flourish' | 'error'
      input: '',         // the user's description being typed
      frame: 0,          // animation counter (gradients, backdrop)
      status: '',        // sub-status line under the forging spinner
      error: '',         // friendly error message in the 'error' phase
      forged: null,      // the shader object handed off on success
      forgedName: '',    // its name (for the flourish)
      flourishUntil: 0,  // frame at which the flourish hands off to runField
      // generation bookkeeping
      attempt: 0,        // 0 = first try, 1 = repair round
      lastCode: '',      // last extracted code (for the repair prompt)
      desc: '',          // description used for this generation
      child: null,       // current claude child (so we can ignore stale ones)
      gen: 0,            // generation token — guards against stale callbacks
      busy: false,       // a claude call is in flight
      // voice
      recording: false,
      dict: null,
    };

    // -----------------------------------------------------------------
    // Generation — call Claude, extract, save, validate, and on failure
    // run exactly ONE repair round, then hand off or surface an error.
    // -----------------------------------------------------------------
    function generate(desc, isRepair, prevCode, errMsg) {
      st.busy = true;
      st.phase = 'forging';
      const myGen = ++st.gen;
      st.status = isRepair ? 'repairing…' : 'consulting claude…';

      const prompt = isRepair
        ? buildRepairPrompt(desc, prevCode, errMsg)
        : buildPrompt(desc);

      // core.claude may be null (claude CLI missing) — handle gracefully.
      const finishErr = (msg) => {
        if (myGen !== st.gen) return; // a newer request superseded this one
        st.busy = false;
        st.phase = 'error';
        st.error = msg;
      };

      let child;
      try {
        child = core.claude(prompt, {
          onChunk: () => { if (myGen === st.gen) st.status = 'forging…'; },
          onDone: (buf) => {
            if (myGen !== st.gen) return;
            handleResult(desc, buf, isRepair);
          },
          onErr: () => finishErr('claude is unavailable — is the `claude` CLI installed?'),
        });
      } catch (e) {
        finishErr('claude failed to start.');
        return;
      }
      if (!child) {
        finishErr('claude is unavailable — is the `claude` CLI installed?');
        return;
      }
      st.child = child;
    }

    // Validate + save + reload, then decide success / repair / fail.
    function handleResult(desc, rawBuf, isRepair) {
      const code = extractCode(rawBuf);
      st.lastCode = code;

      let saveErr = null;
      let shader = null;
      try {
        const slug = slugify(desc);
        core.saveShader(slug, code);
        core.loadCustomShaders();
        shader = findShader(slug, desc);
        if (!shader) saveErr = 'the shader did not validate (field() must return finite 0..1 numbers).';
      } catch (e) {
        saveErr = (e && e.message) ? e.message : String(e);
      }

      if (shader) { succeed(shader); return; }

      // Failure: one automatic repair round, then give up.
      if (!isRepair) {
        st.attempt = 1;
        generate(desc, true, code, saveErr || 'unknown validation error');
        return;
      }
      st.busy = false;
      st.phase = 'error';
      st.error = 'could not forge a working shader. ' + (saveErr || '') +
        ' Edit your description and try again.';
    }

    // Find the freshly-saved shader in core.SHADERS: by name, by slug, else the
    // last custom entry (the contract says it lands as a custom entry on reload).
    function findShader(slug, desc) {
      const list = core.SHADERS || [];
      const names = [slug, slugify(desc)];
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (s && names.indexOf(s.name) !== -1) return s;
      }
      // fall back to the last custom-flagged entry
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].custom) return list[i];
      }
      // last resort: any entry that looks like a valid shader
      const last = list[list.length - 1];
      if (last && typeof last.field === 'function') return last;
      return null;
    }

    function succeed(shader) {
      st.busy = false;
      st.forged = shader;
      st.forgedName = shader.name || 'shader';
      st.phase = 'flourish';
      st.flourishUntil = st.frame + 36; // ~0.6s of flourish, then hand off
    }

    // -----------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------
    // A dim, slow animated plasma backdrop (its own field), shown behind the
    // type / forging UI so the screen always feels alive.
    function backdropSample(u, v, t, intensity) {
      const x = u * 4 - 2, y = v * 4 - 2;
      let s = 0;
      s += Math.sin(x * 1.6 + t * 0.6);
      s += Math.sin(y * 1.9 - t * 0.5);
      s += Math.sin((x + y) * 1.2 + t * 0.4);
      let f = s / 3 * 0.5 + 0.5;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      const c = Vis.ramp(Vis.P4, f);
      const k = intensity * (0.18 + 0.22 * f);
      return [c[0] * k, c[1] * k, c[2] * k];
    }

    function frame() {
      try { draw(); } catch (e) { /* never throw from frame() */ }
    }

    function draw() {
      st.frame++;

      // The flourish phase counts down, then hands control to the renderer.
      if (st.phase === 'flourish' && st.frame >= st.flourishUntil && st.forged) {
        const sh = st.forged;
        st.forged = null; // guard against double hand-off
        core.runField(sh, { audio: false });
        return;
      }

      const cols = core.cols(), rows = core.rows();
      const W = cols, H = (rows - 1) * 2;
      if (W < 2 || H < 2) return;

      const t = st.frame * 0.03;
      // Backdrop brightens a touch while forging for a "warming up" feel.
      const intensity = st.phase === 'forging' ? 1.0 : 0.6;
      const buf = [Vis.fullFrame(W, H, (u, v) => backdropSample(u, v, t, intensity))];

      const mid = Math.floor(rows / 2);
      if (st.phase === 'type') drawType(buf, cols, rows, mid);
      else if (st.phase === 'forging') drawForging(buf, cols, rows, mid);
      else if (st.phase === 'flourish') drawFlourish(buf, cols, rows, mid);
      else if (st.phase === 'error') drawError(buf, cols, rows, mid);

      buf.push(footer(rows, cols));
      core.out.write(buf.join(''));
    }

    function drawType(buf, cols, rows, mid) {
      const title = 'C U S T O M';
      buf.push(Vis.at(mid - 5, Vis.center(cols, title.length)));
      buf.push(Vis.gradient(title, st.frame, { speed: 0.05, spread: 0.4 }));

      const sub = 'describe a shader — Claude will forge it';
      buf.push(Vis.at(mid - 3, Vis.center(cols, sub.length)));
      buf.push(Vis.fg([150, 150, 175]) + sub + RESET);

      // The input field, with a blinking caret.
      const caret = (st.frame >> 4) & 1 ? '▏' : ' ';
      const shown = st.input.length ? st.input : '';
      const placeholder = shown ? '' : 'type here…';
      const line = '› ' + (shown || Vis.fg([90, 90, 115]) + placeholder + Vis.fg(CUSTOM_COLOR));
      const visLen = 2 + (shown ? shown.length : placeholder.length) + 1;
      buf.push(Vis.at(mid - 1, Vis.center(cols, Math.min(cols - 2, visLen))));
      buf.push(Vis.fg(CUSTOM_COLOR) + line + caret + RESET);

      // Example ideas to spark imagination.
      const ideas = 'try: ' + EXAMPLES.join('  ·  ');
      buf.push(Vis.at(mid + 2, Vis.center(cols, ideas.length)));
      buf.push(Vis.fg([120, 120, 150]) + ideas + RESET);

      if (st.recording) {
        const rec = '● REC  (release backtick to transcribe)';
        buf.push(Vis.at(mid + 4, Vis.center(cols, rec.length)));
        buf.push(Vis.fg(Vis.EXP_COLORS.magenta) + rec + RESET);
      }
    }

    function drawForging(buf, cols, rows, mid) {
      // Animated "forging…" gradient with an orbiting set of sparkles.
      const spin = '✦✧✦✧';
      const i = (st.frame >> 2) % spin.length;
      const word = spin[i] + ' forging ' + spin[(i + 2) % spin.length];
      buf.push(Vis.at(mid - 1, Vis.center(cols, word.length)));
      buf.push(Vis.gradient(word, st.frame, { speed: 0.16, spread: 0.6 }));

      const status = st.status || '…';
      buf.push(Vis.at(mid + 1, Vis.center(cols, status.length)));
      buf.push(Vis.fg([150, 150, 175]) + status + RESET);

      if (st.attempt > 0) {
        const r = 'first attempt needed a fix — trying again';
        buf.push(Vis.at(mid + 3, Vis.center(cols, r.length)));
        buf.push(Vis.fg([130, 130, 160]) + r + RESET);
      }
    }

    function drawFlourish(buf, cols, rows, mid) {
      const msg = '✦ forged: ' + st.forgedName;
      buf.push(Vis.at(mid, Vis.center(cols, msg.length)));
      buf.push(Vis.gradient(msg, st.frame, { speed: 0.18, spread: 0.5 }));
    }

    function drawError(buf, cols, rows, mid) {
      const head = '✗ could not forge';
      buf.push(Vis.at(mid - 1, Vis.center(cols, head.length)));
      buf.push(Vis.fg(Vis.EXP_COLORS.magenta) + head + RESET);

      // Wrap the error to fit the width.
      const max = Math.max(20, Math.min(cols - 4, 72));
      const lines = wrap(st.error, max);
      lines.slice(0, 3).forEach((ln, k) => {
        buf.push(Vis.at(mid + 1 + k, Vis.center(cols, ln.length)));
        buf.push(Vis.fg([170, 170, 190]) + ln + RESET);
      });

      const hint = 'enter to retry · edit your description first';
      buf.push(Vis.at(mid + 5, Vis.center(cols, hint.length)));
      buf.push(Vis.fg([120, 120, 150]) + hint + RESET);
    }

    function footer(rows, cols) {
      let hints = 'enter forge · esc menu';
      if (core.voiceAvailable) hints += ' · ` voice';
      return Vis.at(rows, 1) + Vis.fg(Vis.EXP_COLORS.violet) + ' flaude ✦  ' +
        Vis.fg([150, 150, 175]) + hints + RESET;
    }

    // Simple greedy word-wrap.
    function wrap(text, max) {
      const words = String(text).split(/\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);
      return lines;
    }

    // -----------------------------------------------------------------
    // Voice (Wispr-style) — backtick toggles dictation.
    // -----------------------------------------------------------------
    function toggleVoice() {
      if (!core.voiceAvailable) return;
      if (!st.recording) {
        const d = core.dictate({
          onText: (txt) => {
            if (txt) {
              // Append the transcript to whatever's typed so far.
              st.input += (st.input && !/\s$/.test(st.input) ? ' ' : '') + txt;
            }
          },
          onErr: () => {},
        });
        if (d) { st.dict = d; st.recording = true; }
      } else {
        st.recording = false;
        if (st.dict) { try { st.dict.stop(); } catch (e) {} st.dict = null; }
      }
    }

    // -----------------------------------------------------------------
    // Input handling
    // -----------------------------------------------------------------
    function key(s) {
      try { return handleKey(s); } catch (e) { return undefined; }
    }

    function handleKey(s) {
      // Lone Escape always returns to the menu (q is a typeable char here).
      if (s === '\x1b') return 'menu';

      // Backtick toggles voice dictation (when available).
      if (s === '`') { toggleVoice(); return; }

      if (st.phase === 'forging' || st.phase === 'flourish') {
        // Ignore typing while Claude works / during the hand-off flourish.
        return;
      }

      if (st.phase === 'error') {
        // Any edit returns to the type screen; enter re-submits as-is.
        if (s === '\r' || s === '\n') {
          if (st.input.trim()) { startForge(); }
          return;
        }
        // Fall through to text editing (which also flips back to 'type').
        st.phase = 'type';
      }

      // --- 'type' phase text editing ---
      if (s === '\r' || s === '\n') {
        if (st.input.trim()) startForge();
        return;
      }
      if (s === '\x7f' || s === '\b') { st.input = st.input.slice(0, -1); return; }
      // Printable single character.
      if (s.length === 1 && s >= ' ') { st.input += s; return; }
      return;
    }

    function startForge() {
      st.desc = st.input.trim();
      st.attempt = 0;
      st.error = '';
      generate(st.desc, false, '', '');
    }

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------
    return {
      enter() {
        st.phase = 'type';
        st.frame = 0;
      },
      exit() {
        st.gen++; // invalidate any in-flight claude callback
        if (st.dict) { try { st.dict.stop(); } catch (e) {} st.dict = null; }
        st.recording = false;
      },
      frame,
      key,
    };
  },
};
