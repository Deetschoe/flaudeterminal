'use strict';

// ---------------------------------------------------------------------------
// lib/console.js — the CONSOLE: Flaude's home. A creative terminal you type
// into. A dim flowing shader (in whichever palette you've picked) drifts behind
// everything; "Flo", a little spark companion with personality, idles in the
// corner. Type to chat with Flo (via the claude CLI); type "/" for commands —
// every experience is a slash-command (/portal, /orbit, /fireworks, /boids,
// /sand, /custom), plus customization (/theme, /name) and voice (backtick).
// ---------------------------------------------------------------------------

const Vis = require('./visuals');
const { cyc, fg, bg, gradient, RESET } = Vis;
const CSI = Vis.CSI;
const goto = (r, c) => CSI + r + ';' + c + 'H'; // move WITHOUT clearing (overlay)

const PANEL = [12, 10, 22];   // dark pad behind text so it stays readable
const YOU = [150, 156, 190];  // your messages
const SYS = [120, 200, 180];  // system notices

// Flo has things to say.
const QUIPS = [
  'type anything — i\'ll riff',
  'hit / and watch the commands bloom',
  'try /fireworks, it\'s a vibe',
  '/sand is weirdly therapeutic',
  '/boids — i could watch them all day',
  '/orbit makes me a little dizzy (good dizzy)',
  '/custom forges a brand-new shader from words',
  '/theme repaints my whole world',
  'you can /name me something cooler',
  'i live in here, between the pixels ✦',
];
const LAUNCH = {
  PORTAL: 'portals open ✦ go get lost in there',
  ORBIT: 'spinning up a little universe for you…',
  FIREWORKS: 'lighting the fuses — stand back!',
  BOIDS: 'releasing the flock… shoo, birds, shoo!',
  SAND: 'here, go play in the sand',
  CUSTOM: 'ooh, let\'s forge something new',
};

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if ((line + ' ' + word).length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

module.exports = {
  name: 'CONSOLE',
  blurb: 'your creative terminal — type, chat, and run commands',
  color: 'magenta',
  audio: false,

  create(core) {
    const PAL = () => core.theme.palette(); // the active, user-chosen palette

    const S = {
      frame: 0,
      input: '',
      history: [],      // {role:'you'|'flo'|'sys', text}
      scroll: 0,
      view: 'chat',     // 'chat' | 'cmd'
      cmdSel: 0,
      mood: 'idle',     // idle | listening | thinking | talking | rec
      child: null,
      pending: null,
      rec: null,
      quit: false,
      name: core.config ? (core.config.get('floName') || 'Flo') : 'Flo',
    };

    function say(role, text) { S.history.push({ role, text }); S.scroll = 0; }
    const flo = (t) => say('flo', t);

    // ---- commands ----
    const launch = (name) => () => {
      if (core.launchExperience(name)) flo(LAUNCH[name] || ('opening ' + name.toLowerCase() + '…'));
      else say('sys', name + ' couldn\'t start (is it installed?).');
    };

    function cycleTheme(arg) {
      const names = core.theme.palettes;
      let next;
      if (arg && names.includes(arg.trim())) next = arg.trim();
      else { const i = names.indexOf(core.config.get('theme')); next = names[(i + 1) % names.length]; }
      core.config.set('theme', next);
      flo('repainted everything in “' + next + '” ✦');
    }
    function setName(arg) {
      const n = (arg || '').trim().slice(0, 16);
      if (!n) { say('sys', 'tell me a name, e.g.  /name Spark'); return; }
      core.config.set('floName', n); S.name = n;
      flo('nice — call me ' + n + ' from now on ✦');
    }
    function showHelp() {
      say('sys', 'Type to chat with me. Type "/" for commands:');
      for (const c of COMMANDS) say('sys', '  ' + c.cmd + '  —  ' + c.desc);
      say('sys', core.voiceAvailable ? 'Press ` to speak instead of type.' : 'Voice is off (no whisper model found).');
    }

    // pick which device the music reactivity listens to (a loopback for Spotify)
    function audioCmd(arg) {
      const devs = core.listAudioDevices ? core.listAudioDevices() : [];
      if (!devs.length) { say('sys', 'no audio devices found (is ffmpeg installed?)'); return; }
      if (!arg) {
        const cur = core.config.get('audioDevice');
        say('sys', 'sound sources — use  /audio <number>  to choose:');
        for (const d of devs) say('sys', '  [' + d.index + '] ' + d.name + (d.loopback ? '  ← system audio' : '') + (d.name === cur ? '  (current)' : ''));
        say('sys', 'To react to Spotify on headphones, pick a "system audio" device.');
        if (!devs.some((d) => d.loopback)) say('sys', 'None found — install one:  brew install blackhole-2ch  then make a Multi-Output Device.');
        return;
      }
      const d = core.setAudioDevice(arg);
      if (!d) { say('sys', 'no device matched "' + arg + '" — try /audio to list them'); return; }
      flo('listening on ' + d.name + (d.loopback ? ' — play something! ✦' : ' ✦'));
      core.launchExperience('PORTAL'); // jump in with the new source so you see it react
      core.audio && core.startAudio && core.startAudio();
    }

    // set the sound that plays when a Claude Code instance finishes
    function soundCmd(arg) {
      if (!arg) {
        const cur = core.getFinishSound && core.getFinishSound();
        say('sys', cur ? ('finish sound: ' + cur.name + '  (' + cur.path + ')') : 'no finish sound set yet.');
        say('sys', 'set one by dragging an mp3 into the prompt:  /sound <path>');
        say('sys', 'or  /sound test  to hear + see it now.');
        return;
      }
      if (arg.trim() === 'test') {
        const ok = core.previewFinishSound && core.previewFinishSound();
        if (core.flash) core.flash();
        say('sys', ok ? 'playing your finish sound ✦' : 'no finish sound to play yet — set one with /sound <path>');
        return;
      }
      const r = core.setFinishSound ? core.setFinishSound(arg) : { ok: false, msg: 'unavailable' };
      if (r.ok) flo('saved “' + r.msg + '” — i\'ll play it (and flash) when a Claude finishes ✦');
      else say('sys', r.msg);
    }

    // warm the Mac screen for comfortable reading (less blue light). Toggles,
    // or set a level:  /tint 0.8  ·  /tint off. The tint stays on after you
    // leave Flaude so you can read anywhere — come back and /tint off to clear.
    function tintCmd(arg) {
      if (!core.tint) { say('sys', 'screen tint isn\'t available here (needs a Mac).'); return; }
      const a = (arg || '').trim().toLowerCase();
      const cur = core.tint.level();
      let next;
      if (a === 'off' || a === '0' || a === 'reset') next = 0;
      else if (a === 'on') next = 0.6;
      else if (a && !isNaN(parseFloat(a))) next = Math.max(0, Math.min(1, parseFloat(a)));
      else next = cur > 0 ? 0 : 0.6; // bare /tint toggles
      core.tint.set(next);
      if (next > 0) flo('warmed your screen to ' + Math.round(next * 100) + '% for easy reading ✦ (stays on even after you leave — /tint off to clear)');
      else flo('cleared the tint — back to normal colors ✦');
    }

    const COMMANDS = [
      { cmd: '/portal',    desc: 'fluorescent shaders (n = more, a = music)', run: launch('PORTAL') },
      { cmd: '/orbit',     desc: 'a 3D simulation you spin', run: launch('ORBIT') },
      { cmd: '/fireworks', desc: 'a celebratory fireworks show', run: launch('FIREWORKS') },
      { cmd: '/boids',     desc: 'a living, swirling flock', run: launch('BOIDS') },
      { cmd: '/sand',      desc: 'paint falling sand, water & sparks', run: launch('SAND') },
      { cmd: '/custom',    desc: 'forge a shader from words (Claude)', run: launch('CUSTOM') },
      { cmd: '/calories',  desc: 'daily calorie & workout check-in', run: launch('CALORIES') },
      { cmd: '/workout',   desc: 'log calories burned (check-in)', special: 'workout' },
      { cmd: '/away',      desc: 'queue tasks; Flaude works them while you step away', run: launch('AWAY') },
      { cmd: '/settings',  desc: 'toggle features on & off', run: launch('SETTINGS') },
      { cmd: '/tint',      desc: 'warm the screen for reading (/tint 0.8 · /tint off)', special: 'tint' },
      { cmd: '/theme',     desc: 'change the color palette', special: 'theme' },
      { cmd: '/name',      desc: 'rename me — /name Spark', special: 'name' },
      { cmd: '/audio',     desc: 'pick the sound source (mic / loopback for Spotify)', special: 'audio' },
      { cmd: '/sound',     desc: 'set the Claude-finish sound (drag an mp3)', special: 'sound' },
      { cmd: '/voice',     desc: 'dictate with your voice', run: toggleVoice, voice: true },
      { cmd: '/clear',     desc: 'clear the conversation', run: () => { S.history = []; S.scroll = 0; } },
      { cmd: '/help',      desc: 'what can I do?', run: showHelp },
      { cmd: '/quit',      desc: 'exit flaude', run: () => { S.quit = true; } },
    ].filter((c) => !c.voice || core.voiceAvailable);

    function runCommand(c, arg) {
      S.input = ''; S.view = 'chat'; S.cmdSel = 0;
      if (!c) return;
      if (c.special === 'theme') return cycleTheme(arg);
      if (c.special === 'name') return setName(arg);
      if (c.special === 'audio') return audioCmd(arg);
      if (c.special === 'sound') return soundCmd(arg);
      if (c.special === 'tint') return tintCmd(arg);
      if (c.special === 'workout') { if (core.launchExperience('CALORIES', { focus: 'burned' })) flo('let\'s log that workout 💪'); return; }
      if (c.run) c.run();
    }

    // ---- chat with Claude ----
    function sendChat(msg) {
      say('you', msg);
      S.pending = { role: 'flo', text: '' };
      S.history.push(S.pending);
      S.scroll = 0;
      S.mood = 'thinking';
      const persona = 'You are ' + S.name + ', a tiny, witty, warm spark-character who lives ' +
        'inside Flaude — a flamboyant creative terminal full of shaders and toys. Reply in 1-4 ' +
        'short, playful sentences. Plain text only, no markdown, no lists.';
      const convo = S.history.slice(-9, -1)
        .filter((h) => h.role === 'you' || h.role === 'flo')
        .map((h) => (h.role === 'you' ? 'User: ' : S.name + ': ') + h.text).join('\n');
      const prompt = persona + '\n\n' + (convo ? convo + '\n' : '') + 'User: ' + msg + '\n' + S.name + ':';
      const p = S.pending;
      S.child = core.claude(prompt, {
        onChunk: (t, buf) => { p.text = buf.trim(); S.mood = 'talking'; },
        onDone: (buf, code) => {
          p.text = buf.trim() || (code ? '(no answer — is the `claude` CLI set up?)' : '…');
          S.child = null; S.pending = null; S.mood = 'idle';
        },
        onErr: (e) => {
          p.text = '(couldn\'t reach claude: ' + (e && e.message ? e.message : e) + ')';
          S.child = null; S.pending = null; S.mood = 'idle';
        },
      });
      if (!S.child) { p.text = '(the `claude` CLI isn\'t available)'; S.pending = null; S.mood = 'idle'; }
    }

    // ---- voice ----
    function toggleVoice() {
      if (!core.voiceAvailable) { say('sys', 'Voice needs a whisper model — see /help.'); return; }
      if (S.rec) { S.rec.stop(); S.rec = null; S.mood = 'idle'; return; }
      S.mood = 'rec';
      S.rec = core.dictate({
        onText: (t) => { if (t) S.input += (S.input && !S.input.endsWith(' ') ? ' ' : '') + t; S.mood = 'idle'; },
        onErr: () => { say('sys', 'voice hiccup — try again'); S.mood = 'idle'; },
      });
      if (!S.rec) { say('sys', 'couldn\'t start the mic'); S.mood = 'idle'; }
    }

    // ---- command palette ----
    function filtered() {
      const q = S.input.slice(1).split(/\s+/)[0].toLowerCase();
      if (!q) return COMMANDS.slice();
      // prefix matches first (so "/a" puts /audio on top), then substring matches
      const starts = [], has = [];
      for (const c of COMMANDS) {
        const name = c.cmd.slice(1);
        if (name.startsWith(q)) starts.push(c);
        else if (name.includes(q)) has.push(c);
      }
      return starts.concat(has);
    }

    // =======================================================================
    function key(s) {
      if (s === '`') { toggleVoice(); return; }

      if (S.view === 'cmd') {
        const list = filtered();
        if (s === '\x1b[A' || s === '\x1bOA') { S.cmdSel = (S.cmdSel + Math.max(1, list.length) - 1) % Math.max(1, list.length); return; }
        if (s === '\x1b[B' || s === '\x1bOB') { S.cmdSel = (S.cmdSel + 1) % Math.max(1, list.length); return; }
        if (s === '\t') { if (list[S.cmdSel]) S.input = list[S.cmdSel].cmd + ' '; return; }
        if (s === '\r' || s === '\n') {
          const parts = S.input.trim().split(/\s+/);
          const arg = parts.slice(1).join(' ');
          const exact = COMMANDS.find((c) => c.cmd === parts[0]);
          runCommand(exact || list[S.cmdSel], arg);
          return;
        }
        // else fall through to text editing (typing filters the palette)
      }

      if (s === '\x1b') { if (S.input) { S.input = ''; S.view = 'chat'; return; } return 'quit'; }
      if (s === '\x7f' || s === '\b') {
        S.input = S.input.slice(0, -1);
        if (!S.input.startsWith('/')) S.view = 'chat';
        S.cmdSel = 0;
        return;
      }
      if (S.view === 'chat' && (s === '\x1b[A' || s === '\x1bOA')) { S.scroll++; return; }
      if (S.view === 'chat' && (s === '\x1b[B' || s === '\x1bOB')) { S.scroll = Math.max(0, S.scroll - 1); return; }
      if (s === '\r' || s === '\n') {
        const text = S.input.trim();
        S.input = '';
        if (!text) return;
        if (text.startsWith('/')) {
          const parts = text.split(/\s+/);
          const c = COMMANDS.find((x) => x.cmd === parts[0]);
          S.view = 'chat';
          if (c) runCommand(c, parts.slice(1).join(' '));
          else say('sys', 'unknown command: ' + parts[0] + '  — type / for the list');
        } else { S.view = 'chat'; sendChat(text); }
        return;
      }
      if (s.length === 1 && s >= ' ') {
        S.input += s;
        S.view = S.input.startsWith('/') ? 'cmd' : 'chat';
        if (S.view === 'cmd') S.cmdSel = 0;
        return;
      }
    }

    // =======================================================================
    function backdrop(u, v, t) {
      const x = u * 4, y = v * 4;
      let s = Math.sin(x * 1.3 + t * 0.5) + Math.sin(y * 1.7 - t * 0.4) + Math.sin((x + y) * 1.0 + t * 0.3);
      s = s / 3 * 0.5 + 0.5;
      const c = cyc(PAL(), s * 1.6 + t * 0.06);
      const k = 0.14 + 0.12 * s;
      return [c[0] * k, c[1] * k, c[2] * k];
    }

    function mascot() {
      const f = S.frame;
      const tw = ['✦', '✧', '⋆', '✧'][Math.floor(f / 14) % 4];
      const blink = (f % 210) < 8;
      const eye = S.mood === 'rec' ? '◉' : blink ? '-' : '•';
      let mouth = '‿';
      if (S.mood === 'thinking') mouth = '~';
      else if (S.mood === 'talking') mouth = (f >> 2) % 2 ? '▽' : 'o';
      else if (S.mood === 'rec') mouth = 'o';
      let bubble;
      if (S.mood === 'rec') bubble = '● listening to you…';
      else if (S.mood === 'thinking') bubble = 'hmm' + '.'.repeat(1 + (f >> 3) % 3);
      else if (S.mood === 'talking') bubble = '…';
      else if (S.input) bubble = 'go on…';
      else bubble = QUIPS[Math.floor(f / 380) % QUIPS.length];
      const face = '( ' + eye + ' ' + mouth + ' ' + eye + ' )';
      let o = goto(2, 3) + gradient('  ' + tw, f, { palette: PAL(), speed: 0.1, spread: 0.6 });
      o += goto(3, 3) + gradient(face, f, { palette: PAL(), speed: 0.06, spread: 0.4 }) +
        '  ' + fg([190, 160, 255]) + S.name + ' ' + fg([130, 130, 160]) + '‹ ' + bubble + ' ›' + RESET;
      return o;
    }

    function render() {
      S.frame++;
      const cols = core.cols(), rows = core.rows();
      if (cols < 8 || rows < 8) { core.out.write(CSI + 'H'); return; }
      const t = S.frame * 0.03;
      let o = core.fullFrame(cols, (rows - 1) * 2, (u, v) => backdrop(u, v, t));

      const title = 'flaude ✦';
      o += goto(1, core.center(cols, title.length)) + gradient(title, S.frame, { palette: PAL(), speed: 0.06, spread: 0.5 });
      o += mascot();

      const inputRow = rows;
      const margin = 3;
      const width = cols - margin * 2;

      // scrollback
      const top = 5;
      const bottom = rows - 3;
      const avail = Math.max(1, bottom - top + 1);
      const lines = [];
      for (const h of S.history) {
        const tag = h.role === 'you' ? 'you ' : h.role === 'flo' ? (S.name.slice(0, 3).toLowerCase() + ' ') : '  • ';
        const col = h.role === 'you' ? YOU : h.role === 'sys' ? SYS : null;
        const wrapped = wrap(h.text || '', width - 5);
        wrapped.forEach((ln, i) => lines.push({ tag: i === 0 ? tag : '    ', text: ln, col, flo: h.role === 'flo' }));
        lines.push({ spacer: true });
      }
      const end = Math.max(0, lines.length - avail - S.scroll);
      const slice = lines.slice(end, end + avail);
      slice.forEach((ln, i) => {
        const r = top + i;
        if (ln.spacer) return;
        o += goto(r, margin) + bg(PANEL);
        if (ln.flo) o += fg([120, 120, 150]) + ln.tag + gradient(ln.text, S.frame + i * 6, { palette: PAL(), speed: 0.05, spread: 0.22 }) + bg(PANEL);
        else o += fg([110, 110, 140]) + ln.tag + fg(ln.col || [200, 200, 215]) + ln.text;
        o += RESET;
      });
      if (S.scroll > 0) o += goto(bottom + 1, cols - margin - 7) + fg(SYS) + '▾ more' + RESET;

      // command palette overlay
      if (S.view === 'cmd') {
        const list = filtered();
        const ph = Math.min(list.length, 8);
        const base = inputRow - 1 - ph;
        o += goto(base - 1, margin) + bg(PANEL) + fg([200, 200, 230]) + ' commands ' + RESET;
        for (let i = 0; i < ph; i++) {
          const c = list[i];
          const sel = i === S.cmdSel % Math.max(1, list.length);
          o += goto(base + i, margin) + bg(PANEL);
          const label = (sel ? '▸ ' : '  ') + c.cmd;
          o += (sel ? gradient(label, S.frame, { palette: PAL(), speed: 0.12, spread: 0.5 }) : fg([170, 175, 200]) + label) +
            bg(PANEL) + fg([110, 110, 140]) + '  ' + c.desc + RESET;
        }
        if (!list.length) o += goto(base, margin) + bg(PANEL) + fg([200, 120, 150]) + '  no matching command' + RESET;
      }

      // input line
      const caret = (S.frame % 30) < 18 ? '▎' : ' ';
      const promptCol = S.input.startsWith('/') ? PAL()[0] : [190, 160, 255];
      let shown = S.input;
      const maxIn = cols - 6;
      if (shown.length > maxIn) shown = shown.slice(shown.length - maxIn);
      o += core.at(inputRow, 1) + fg(promptCol) + ' › ' + fg([235, 235, 245]) + shown + fg([150, 150, 180]) + caret + RESET;

      core.out.write(o);
      if (S.quit) return 'quit';
    }

    // =======================================================================
    return {
      enter() {
        S.view = 'chat';
        S.name = core.config ? (core.config.get('floName') || 'Flo') : 'Flo';
        const greet = !core.settings || core.settings.get('greet') !== false;
        if (S.history.length === 0 && greet) {
          flo('hey — i\'m ' + S.name + ' ✦ your spark in the machine. type to chat, or hit / for commands.');
        }
      },
      exit() {
        if (S.child) { try { S.child.kill(); } catch (e) {} S.child = null; S.pending = null; }
        if (S.rec) { try { S.rec.stop(); } catch (e) {} S.rec = null; }
        S.mood = 'idle';
      },
      frame() { if (render() === 'quit') core.quit(); },
      key,
    };
  },
};
