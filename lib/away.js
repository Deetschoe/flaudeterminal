'use strict';

// ---------------------------------------------------------------------------
// lib/away.js — AWAY MODE. Brain-dump a list of tasks (type or speak), hit run,
// and walk away: Flaude works each one through Claude Code (`claude -p`) in the
// background while your Mac stays awake (caffeinate), streaming progress and
// saving every answer to ~/.flaude/away/ as a dated digest. It flashes when the
// whole queue finishes.
//
// The bet: Anthropic ships a coding tool; this is a *personal, walk-away life
// runner* layered on top of it — queue errands of the mind, come back to a
// plated digest. Different product, same engine.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Vis = require('./visuals');
const { fg, bg, gradient, RESET } = Vis;
const CSI = Vis.CSI;
const goto = (r, c) => CSI + r + ';' + c + 'H';
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function wrap(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if ((line + ' ' + word).length <= w) line += ' ' + word;
      else { out.push(line); line = word; }
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
  }
  return out;
}

module.exports = {
  name: 'AWAY',
  blurb: 'queue tasks; Flaude works them while you step away',
  color: 'magenta',
  audio: false,

  create(core) {
    const DIR = path.join(core.paths.dir, 'away');
    const WORK = path.join(DIR, 'work');     // claude runs here, away from your repos
    try { fs.mkdirSync(WORK, { recursive: true }); } catch (e) {}
    const SESSION = path.join(DIR, 'session.json');

    // mode: 'queue' (live) | 'history' (browse past digests)
    const S = { frame: 0, input: '', tasks: [], running: false, child: null, view: 0, scroll: 0, rec: null, banner: '', mode: 'queue', hist: [], histSel: 0, histText: null };
    try { const j = JSON.parse(fs.readFileSync(SESSION, 'utf8')); if (Array.isArray(j.tasks)) S.tasks = j.tasks.map((t) => ({ ...t, status: t.status === 'running' ? 'pending' : t.status })); } catch (e) {}

    const saveSession = () => { try { fs.writeFileSync(SESSION, JSON.stringify({ tasks: S.tasks }, null, 2)); } catch (e) {} };
    const z2 = (n) => String(n).padStart(2, '0');
    function stamp() { const d = new Date(); return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()); }
    function fmtDur(ms) { return ms ? (ms / 1000).toFixed(1) + 's' : '—'; }

    // Pull `@path` tokens out of a brain-dump line → camera-to-context attachments.
    // The agent is told to Read each before answering; --add-dir is passed at run.
    function parseAttach(text) {
      const attach = [];
      const cleaned = text.replace(/@(\S+)/g, (m, p) => {
        let fp = p.startsWith('~') ? path.join(core.paths.home, p.slice(1)) : p;
        fp = path.resolve(fp);
        try { if (fs.statSync(fp).isFile()) { attach.push(fp); return ''; } } catch (e) {}
        return m; // leave a non-file @token in the prompt untouched
      }).replace(/\s+/g, ' ').trim();
      return { prompt: cleaned, attach };
    }

    function buildPrompt(t) {
      if (Array.isArray(t.attach) && t.attach.length) {
        const list = t.attach.map((p) => '- ' + p).join('\n');
        return 'Attached file(s) — use the Read tool to view each before answering:\n' + list + '\n\n' + (t.prompt || '(describe / act on the attached file)');
      }
      return t.prompt;
    }

    function writeDigest() {
      const done = S.tasks.filter((t) => t.status === 'done' || t.status === 'err');
      if (!done.length) return;
      const ok = done.filter((t) => t.status === 'done').length;
      const totalMs = done.reduce((a, t) => a + (t.ms || 0), 0);
      let md = '# Away digest — ' + new Date().toLocaleString() + '\n\n';
      md += '> ' + ok + '/' + done.length + ' completed · ' + fmtDur(totalMs) + ' total\n\n';
      for (const t of done) {
        const icon = t.status === 'done' ? '✓' : '✗';
        md += '## ' + icon + ' ' + t.prompt + '\n\n';
        const meta = [fmtDur(t.ms)];
        if (t.tools) meta.push(t.tools + ' tool' + (t.tools === 1 ? '' : 's'));
        if (Array.isArray(t.attach) && t.attach.length) meta.push('📎 ' + t.attach.length);
        md += '`' + meta.join(' · ') + '`\n\n';
        md += (t.result || '(no output)') + '\n\n---\n\n';
      }
      try { fs.writeFileSync(path.join(DIR, stamp() + '.md'), md); } catch (e) {}
    }

    function loadHistory() {
      let files = [];
      try { files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().reverse(); } catch (e) {}
      S.hist = files; S.histSel = 0; S.histText = null; S.scroll = 0;
    }

    function runTask(t) {
      t.status = 'running'; t.started = Date.now(); t.result = ''; t.tools = 0;
      const extra = [];
      if (Array.isArray(t.attach) && t.attach.length) {
        const dirs = new Set(t.attach.map((p) => path.dirname(p)));
        for (const d of dirs) extra.push('--add-dir', d);
      }
      S.child = core.claude(buildPrompt(t), {
        cwd: WORK,
        args: extra,
        onChunk: (chunk, buf) => { t.result = buf; },
        onEvent: (e) => { if (e.kind === 'tool') t.tools = (t.tools || 0) + 1; },
        onDone: (buf, code, meta) => { t.result = (buf || '').trim() || '(empty)'; t.status = code ? 'err' : 'done'; t.ms = Date.now() - t.started; if (meta) { t.tools = meta.tools; if (meta.resultText) t.answer = meta.resultText; } S.child = null; saveSession(); },
        onErr: (e) => { t.result = 'error: ' + (e && e.message ? e.message : e); t.status = 'err'; S.child = null; saveSession(); },
      });
      if (!S.child) { t.status = 'err'; t.result = 'the claude CLI is not available'; S.running = false; }
    }

    function pump() {
      if (!S.running || S.child) return;
      const next = S.tasks.find((t) => t.status === 'pending');
      if (next) { S.view = S.tasks.indexOf(next); S.scroll = 0; runTask(next); }
      else { S.running = false; S.banner = 'queue complete ✦'; writeDigest(); if (core.flash) core.flash(); }
    }

    function startRun() {
      if (!S.tasks.some((t) => t.status === 'pending')) { S.banner = 'add a task first'; return; }
      S.running = true; S.banner = '';
      if (core.settings && core.settings.get('caffeinate') === false) S.banner = 'tip: /settings → Keep Mac awake, so it survives the walk away';
    }

    function toggleVoice() {
      if (!core.voiceAvailable) { S.banner = 'voice needs a whisper model'; return; }
      if (S.rec) { S.rec.stop(); S.rec = null; return; }
      S.banner = '● listening…';
      S.rec = core.dictate({ onText: (t) => { if (t) S.input += (S.input && !S.input.endsWith(' ') ? ' ' : '') + t; S.banner = ''; }, onErr: () => { S.banner = 'voice hiccup'; } });
    }

    function keyHistory(s) {
      if (s === '\x1b') { S.mode = 'queue'; S.scroll = 0; return; }                 // esc → back to queue
      if (s === '\x1b[D' || s === '\x1bOD') { if (S.histText) { S.histText = null; S.scroll = 0; } else { S.mode = 'queue'; } return; }
      if (s === '\x1b[A' || s === '\x1bOA') { if (S.histText) S.scroll++; else S.histSel = Math.max(0, S.histSel - 1); return; }
      if (s === '\x1b[B' || s === '\x1bOB') { if (S.histText) S.scroll = Math.max(0, S.scroll - 1); else S.histSel = Math.min(S.hist.length - 1, S.histSel + 1); return; }
      if (s === '\r' || s === '\n' || s === '\x1b[C' || s === '\x1bOC') {
        if (!S.histText && S.hist[S.histSel]) { try { S.histText = fs.readFileSync(path.join(DIR, S.hist[S.histSel]), 'utf8'); } catch (e) { S.histText = '(could not read digest)'; } S.scroll = 0; }
      }
    }

    function key(s) {
      try {
        if (S.mode === 'history') return keyHistory(s);
        if (s === '\x1b') return 'menu';
        if (s === '`') { toggleVoice(); return; }
        if (s === '\t') { S.running ? (S.running = false, S.banner = 'paused') : startRun(); return; }
        if (s === '\x1b[C' || s === '\x1bOC') { S.mode = 'history'; loadHistory(); return; } // → browse past digests
        if (s === '\x1b[A' || s === '\x1bOA') { S.scroll++; return; }
        if (s === '\x1b[B' || s === '\x1bOB') { S.scroll = Math.max(0, S.scroll - 1); return; }
        if (s === '\x7f' || s === '\b') {
          if (S.input) S.input = S.input.slice(0, -1);
          else { const i = S.tasks.map((t) => t.status).lastIndexOf('pending'); if (i >= 0) { S.tasks.splice(i, 1); saveSession(); } }
          return;
        }
        if (s === '\r' || s === '\n') {
          const raw = S.input.trim();
          if (raw) {
            const { prompt, attach } = parseAttach(raw);
            if (prompt || attach.length) {
              S.tasks.push({ prompt: prompt || '(see attached)', status: 'pending', result: '', attach });
              S.input = ''; saveSession();
              if (attach.length) S.banner = '📎 ' + attach.length + ' attached';
            }
          } else if (!S.running) startRun();
          return;
        }
        if (s.length === 1 && s >= ' ') { S.input += s; return; }
      } catch (e) {}
    }

    function renderHistory() {
      const cols = core.cols(), rows = core.rows();
      if (cols < 30 || rows < 16) { core.out.write(CSI + 'H' + fg([200, 200, 210]) + 'enlarge the window'); return; }
      const pal = core.theme.palette();
      const L = 3, W = cols - 6;
      let o = CSI + '2J';
      o += goto(1, L) + gradient('✦  HISTORY  ✦  past digests', S.frame, { palette: pal, speed: 0.06, spread: 0.45 });

      if (S.histText) {
        const date = S.hist[S.histSel] ? S.hist[S.histSel].replace(/\.md$/, '') : '';
        o += goto(2, L) + fg([150, 150, 180]) + date + RESET;
        const lines = [];
        for (const ln of S.histText.split('\n')) for (const w of wrap(ln, W)) lines.push(w);
        const panH = rows - 4;
        const end = Math.max(0, lines.length - panH - S.scroll);
        lines.slice(end, end + panH).forEach((ln, i) => { o += goto(3 + i, L) + fg([200, 200, 215]) + ln + RESET; });
        o += goto(rows, L) + fg([90, 90, 115]) + '↑↓ scroll · ← list · esc back' + RESET;
        core.out.write(o); return;
      }

      if (!S.hist.length) { o += goto(3, L) + fg([120, 120, 150]) + 'no digests yet — run a queue and come back ✦' + RESET; }
      const listMax = rows - 5;
      const startI = Math.max(0, Math.min(S.histSel - Math.floor(listMax / 2), S.hist.length - listMax));
      let r = 3;
      for (let i = Math.max(0, startI); i < S.hist.length && r < 3 + listMax; i++, r++) {
        const sel = i === S.histSel;
        const date = S.hist[i].replace(/\.md$/, '');
        o += goto(r, L) + (sel ? fg(pal[0]) + '› ' : fg([90, 90, 115]) + '  ') + (sel ? fg([235, 235, 245]) : fg([170, 175, 200])) + date + RESET;
      }
      o += goto(rows, L) + fg([90, 90, 115]) + '↑↓ select · enter/→ open · ← back · esc queue' + RESET;
      core.out.write(o);
    }

    function render() {
      S.frame++;
      pump(); // keep the queue draining even while browsing history
      if (S.mode === 'history') { renderHistory(); return; }
      const cols = core.cols(), rows = core.rows();
      if (cols < 30 || rows < 16) { core.out.write(CSI + 'H' + fg([200, 200, 210]) + 'enlarge the window for /away'); return; }
      const pal = core.theme.palette();
      const L = 3, W = cols - 6;
      let o = CSI + '2J';

      const title = '✦  AWAY  ✦  let it cook';
      o += goto(1, L) + gradient(title, S.frame, { palette: pal, speed: 0.06, spread: 0.45 });
      const done = S.tasks.filter((t) => t.status === 'done' || t.status === 'err').length;
      const status = S.running ? fg([255, 200, 90]) + SPIN[S.frame % 10] + ' working ' : fg([120, 120, 150]) + '○ idle ';
      o += goto(2, L) + status + fg([120, 120, 150]) + done + '/' + S.tasks.length + ' done' +
        (S.banner ? fg(pal[1]) + '   ' + S.banner : '') + RESET;

      // task list (top portion)
      const listTop = 4;
      const listMax = Math.max(3, Math.floor((rows - 8) * 0.5));
      const startI = Math.max(0, S.tasks.length - listMax);
      let r = listTop;
      for (let i = startI; i < S.tasks.length && r < listTop + listMax; i++, r++) {
        const t = S.tasks[i];
        const icon = t.status === 'done' ? fg([120, 230, 170]) + '✓' : t.status === 'err' ? fg([255, 110, 130]) + '✗'
          : t.status === 'running' ? fg([255, 200, 90]) + SPIN[S.frame % 10] : fg([120, 120, 150]) + '○';
        const dur = t.ms ? fg([110, 110, 140]) + ' ' + (t.ms / 1000).toFixed(1) + 's' : '';
        const clip = (Array.isArray(t.attach) && t.attach.length) ? fg([150, 150, 180]) + ' 📎' : '';
        const sel = i === S.view ? fg([235, 235, 245]) : fg([170, 175, 200]);
        o += goto(r, L) + icon + ' ' + sel + t.prompt.slice(0, W - 10) + clip + dur + RESET;
      }

      // output panel for the viewed task
      const panTop = listTop + listMax + 1;
      o += goto(panTop - 1, L) + fg([90, 90, 115]) + '─'.repeat(W) + RESET;
      const t = S.tasks[S.view];
      const panH = rows - panTop - 2;
      if (t) {
        const lines = wrap(t.result || (t.status === 'pending' ? '(queued)' : '…'), W);
        const end = Math.max(0, lines.length - panH - S.scroll);
        const slice = lines.slice(end, end + panH);
        slice.forEach((ln, i) => { o += goto(panTop + i, L) + fg([200, 200, 215]) + ln + RESET; });
      }

      // input + hints
      const caret = (S.frame % 30) < 18 ? '▎' : ' ';
      o += goto(rows - 1, L) + fg(pal[0]) + '› ' + fg([235, 235, 245]) + S.input.slice(-(W - 3)) + fg([150, 150, 180]) + caret + RESET;
      o += goto(rows, L) + fg([90, 90, 115]) + 'enter add · @file attach · tab ' + (S.running ? 'pause' : 'run') + ' · ' + (core.voiceAvailable ? '` speak · ' : '') + '↑↓ scroll · → history · esc back' + RESET;
      core.out.write(o);
    }

    return {
      enter() { S.frame = 0; S.banner = S.tasks.length ? '' : 'brain-dump tasks, then tab to run'; },
      exit() { if (S.child) { try { S.child.kill(); } catch (e) {} S.child = null; } if (S.rec) { try { S.rec.stop(); } catch (e) {} S.rec = null; } S.running = false; saveSession(); },
      frame() { try { render(); } catch (e) {} },
      key,
    };
  },
};
