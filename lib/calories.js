'use strict';

// ---------------------------------------------------------------------------
// lib/calories.js — a daily calorie & workout check-in, tuned for a cut.
// Arrow keys move between fields; type numbers; type a food and Flo (the claude
// CLI) estimates its calories. Tracks weight toward a goal, factors in calories
// burned, and stores one JSON per day in ~/.flaude/calories/ so it knows whether
// you logged — it expects a check-in every ~12h (overdue past 24h).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Vis = require('./visuals');
const { fg, bg, gradient, RESET } = Vis;
const CSI = Vis.CSI;
const goto = (r, c) => CSI + r + ';' + c + 'H';
const KCAL_PER_LB = 3500;

const z2 = (n) => String(n).padStart(2, '0');
function dstr(d) { return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()); }
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return dstr(d); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }

module.exports = {
  name: 'CALORIES',
  blurb: 'daily calorie & workout check-in',
  color: 'aqua',
  audio: false,

  create(core, opts) {
    const DIR = path.join(core.paths.dir, 'calories');
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
    const file = (date) => path.join(DIR, date + '.json');

    // persisted goal settings (editable in-app)
    const goal = Object.assign(
      { startWeight: 180, goalWeight: 140, startDate: dstr(new Date()), goalDays: 182, target: 1900, base: 2300 },
      core.config.get('calories') || {}
    );
    core.config.set('calories', goal);
    const saveGoal = () => core.config.set('calories', goal);

    function loadDay(date) {
      try { return JSON.parse(fs.readFileSync(file(date), 'utf8')); }
      catch (e) { return { date, weight: goal.startWeight, foods: [], burned: 0, loggedAt: null }; }
    }
    function saveDay(d) {
      d.loggedAt = new Date().toISOString();
      try { fs.writeFileSync(file(d.date), JSON.stringify(d, null, 2)); } catch (e) {}
    }
    const dayLogged = (date) => { try { const j = JSON.parse(fs.readFileSync(file(date), 'utf8')); return (j.foods && j.foods.length) || j.burned > 0; } catch (e) { return false; } };

    const today = dstr(new Date());
    const day = loadDay(today);
    if (day.weight == null) day.weight = goal.startWeight;

    // ---- state ----
    const FIELDS = ['weight', 'target', 'base', 'food', 'burned'];
    const S = { frame: 0, focus: 3, fresh: false, foodInput: '', flash: '' };
    if (opts && opts.focus === 'burned') S.focus = FIELDS.indexOf('burned');

    function streak() {
      let n = 0, d = today;
      if (!dayLogged(today)) d = addDays(today, -1);
      while (dayLogged(d)) { n++; d = addDays(d, -1); }
      return n;
    }
    function checkin() {
      // last log time across recent days
      let last = day.loggedAt;
      if (!last) { for (let i = 1; i <= 7; i++) { try { const j = JSON.parse(fs.readFileSync(file(addDays(today, -i)), 'utf8')); if (j.loggedAt) { last = j.loggedAt; break; } } catch (e) {} } }
      if (!last) return { txt: 'first check-in — log your day!', col: [255, 200, 90] };
      const hrs = (Date.now() - new Date(last).getTime()) / 3600000;
      if (dayLogged(today) && hrs < 12) return { txt: 'logged ✓ — next check-in in ' + Math.max(0, Math.ceil(12 - hrs)) + 'h', col: [120, 230, 170] };
      if (hrs > 24) return { txt: 'overdue — log now to keep your streak', col: [255, 110, 130] };
      return { txt: 'check-in due (' + Math.floor(hrs) + 'h since last)', col: [255, 200, 90] };
    }

    // ---- food calorie lookup via the claude CLI ----
    function lookupFood(name) {
      const row = { name, kcal: null, pending: true };
      day.foods.push(row); saveDay(day);
      const prompt = 'Estimate the total calories (kcal) in this food at a typical single serving unless a quantity is given: "' + name + '". Reply with ONLY a whole number — no words, no units.';
      const child = core.claude(prompt, {
        onDone: (buf) => { const m = (buf || '').match(/\d{1,5}/); row.kcal = m ? parseInt(m[0], 10) : 0; row.pending = false; saveDay(day); },
        onErr: () => { row.kcal = 0; row.pending = false; saveDay(day); },
      });
      if (!child) { row.kcal = 0; row.pending = false; row.name += ' (no estimate — claude CLI missing)'; saveDay(day); }
    }

    // ---- math ----
    function calc() {
      const eaten = day.foods.reduce((s, f) => s + (f.kcal || 0), 0);
      const expend = goal.base + day.burned;
      const deficit = expend - eaten;
      const lbToGo = day.weight - goal.goalWeight;
      const elapsed = Math.max(0, daysBetween(goal.startDate, today));
      const daysLeft = Math.max(1, goal.goalDays - elapsed);
      const reqDeficit = (lbToGo * KCAL_PER_LB) / daysLeft;
      const projWk = deficit * 7 / KCAL_PER_LB;
      const etaDays = deficit > 0 ? Math.ceil(lbToGo / (deficit / KCAL_PER_LB)) : Infinity;
      return { eaten, expend, deficit, lbToGo, daysLeft, reqDeficit, projWk, etaDays };
    }

    const numFields = { weight: () => day.weight, target: () => goal.target, base: () => goal.base, burned: () => day.burned };
    function setNum(field, v) {
      if (field === 'weight') { day.weight = v; saveDay(day); }
      else if (field === 'burned') { day.burned = v; saveDay(day); }
      else if (field === 'target') { goal.target = v; saveGoal(); }
      else if (field === 'base') { goal.base = v; saveGoal(); }
    }

    // ================= input =================
    function key(s) {
      try {
        const f = FIELDS[S.focus];
        if (s === '\x1b') return 'menu';
        if (s === '\x1b[A' || s === '\x1bOA') { S.focus = (S.focus + FIELDS.length - 1) % FIELDS.length; S.fresh = true; return; }
        if (s === '\x1b[B' || s === '\x1bOB' || s === '\t') { S.focus = (S.focus + 1) % FIELDS.length; S.fresh = true; return; }

        if (f === 'food') {
          if (s === '\r' || s === '\n') { const n = S.foodInput.trim(); if (n) { lookupFood(n); S.foodInput = ''; } return; }
          if (s === '\x7f' || s === '\b') { if (S.foodInput) S.foodInput = S.foodInput.slice(0, -1); else if (day.foods.length) { day.foods.pop(); saveDay(day); } return; }
          if (s.length === 1 && s >= ' ') { S.foodInput += s; return; }
          return;
        }

        // numeric fields
        if (f === 'burned') {
          if (s === 'w' || s === 'W') { day.burned += 250; saveDay(day); S.flash = '+250 walk (1h)'; return; }
          if (s === 'r' || s === 'R') { day.burned += 300; saveDay(day); S.flash = '+300 run (30m)'; return; }
          if (s === 'l' || s === 'L') { day.burned += 400; saveDay(day); S.flash = '+400 lift (1h)'; return; }
        }
        if (s >= '0' && s <= '9') {
          let v = numFields[f]();
          v = S.fresh ? (s.charCodeAt(0) - 48) : (v * 10 + (s.charCodeAt(0) - 48));
          if (f === 'weight' && v > 700) v = 700; if (v > 99999) v = 99999;
          S.fresh = false; setNum(f, v); return;
        }
        if (s === '\x7f' || s === '\b') { setNum(f, Math.floor(numFields[f]() / 10)); S.fresh = false; return; }
        if (s === '\r' || s === '\n') { S.fresh = true; return; }
      } catch (e) { /* never throw */ }
    }

    // ================= render =================
    function field(label, val, unit, focused, suffix) {
      const lab = fg([150, 150, 175]) + label.padEnd(8);
      const box = focused
        ? gradient('[ ' + val + ' ]', S.frame, { palette: core.theme.palette(), speed: 0.14, spread: 0.6 }) + (S.frame % 30 < 18 ? fg([240, 240, 250]) + '▎' : ' ')
        : fg([235, 235, 245]) + '[ ' + val + ' ]';
      return lab + box + fg([120, 120, 145]) + ' ' + (unit || '') + (suffix ? '   ' + suffix : '') + RESET;
    }
    function barRow(frac, width, palette) {
      frac = Math.max(0, Math.min(1, frac));
      const fillN = Math.round(frac * width);
      let o = '';
      for (let i = 0; i < width; i++) o += (i < fillN ? bg(Vis.cyc(palette, i * 0.12 + S.frame * 0.04)) + ' ' : bg([40, 40, 55]) + ' ');
      return o + RESET;
    }

    function render() {
      S.frame++;
      const cols = core.cols(), rows = core.rows();
      if (cols < 30 || rows < 18) { core.out.write(CSI + 'H' + fg([200, 200, 210]) + 'enlarge the window for /calories'); return; }
      const pal = core.theme.palette();
      const W = Math.min(62, cols - 4);
      const L = Math.max(2, Math.floor((cols - W) / 2) + 1);
      let r = Math.max(2, Math.floor((rows - 22) / 2) + 1);
      let o = CSI + '2J';

      const c = calc();
      const ci = checkin();

      const title = '✦  CALORIES  ✦';
      o += goto(r, L + Math.floor((W - title.length) / 2)) + gradient(title, S.frame, { palette: pal, speed: 0.06, spread: 0.5 }); r += 1;
      o += goto(r, L) + fg([120, 120, 150]) + today + '   ·   streak ' + fg([255, 200, 90]) + streak() + 'd' + fg([120, 120, 150]) + '   ·   ' + fg(ci.col) + ci.txt + RESET; r += 2;

      // weight goal line + progress bar
      const prog = (goal.startWeight - day.weight) / Math.max(1, (goal.startWeight - goal.goalWeight));
      o += goto(r, L) + field('weight', day.weight, 'lb', FIELDS[S.focus] === 'weight', fg([120, 120, 150]) + '→ goal ' + goal.goalWeight + ' lb  (' + c.lbToGo.toFixed(0) + ' to go · ' + c.daysLeft + 'd left)'); r += 1;
      o += goto(r, L) + barRow(prog, W, pal) + RESET; r += 2;

      // intake / expenditure fields
      o += goto(r, L) + field('target', goal.target, 'kcal net/day', FIELDS[S.focus] === 'target'); r += 1;
      o += goto(r, L) + field('base', goal.base, 'kcal maintenance', FIELDS[S.focus] === 'base'); r += 2;

      // food
      o += goto(r, L) + fg(pal[0]) + 'FOOD' + fg([120, 120, 145]) + '  (type a food, enter — Flo estimates kcal)' + RESET; r += 1;
      const foodFocused = FIELDS[S.focus] === 'food';
      const inLine = foodFocused
        ? gradient('› ' + (S.foodInput || ''), S.frame, { palette: pal, speed: 0.12, spread: 0.5 }) + (S.frame % 30 < 18 ? fg([240, 240, 250]) + '▎' : '')
        : fg([110, 110, 140]) + '› ' + (S.foodInput || 'type a food…');
      o += goto(r, L + 1) + inLine + RESET; r += 1;
      const show = day.foods.slice(-6);
      for (const fd of show) {
        const kc = fd.pending ? fg([255, 200, 90]) + '…' : fg([235, 235, 245]) + (fd.kcal || 0);
        o += goto(r, L + 3) + fg([170, 175, 200]) + fd.name.slice(0, W - 12).padEnd(W - 12) + kc + RESET; r += 1;
      }
      if (day.foods.length > 6) { o += goto(r, L + 3) + fg([110, 110, 140]) + '… +' + (day.foods.length - 6) + ' more' + RESET; r += 1; }
      o += goto(r, L + 3) + fg([120, 120, 150]) + 'eaten'.padEnd(W - 12) + fg([255, 230, 150]) + c.eaten + ' kcal' + RESET; r += 2;

      // burned
      const bf = FIELDS[S.focus] === 'burned';
      o += goto(r, L) + field('burned', day.burned, 'kcal', bf, fg([120, 120, 150]) + (bf ? 'w=walk r=run l=lift' : '')); r += 2;

      // summary
      o += goto(r, L) + fg([90, 90, 115]) + '─'.repeat(W) + RESET; r += 1;
      const okDef = c.deficit >= c.reqDeficit * 0.9;
      o += goto(r, L) + fg([150, 150, 175]) + 'NET ' + fg([240, 240, 250]) + (c.eaten - day.burned) + ' kcal' +
        fg([120, 120, 150]) + '   deficit ' + fg(c.deficit >= 0 ? [120, 230, 170] : [255, 110, 130]) + (c.deficit >= 0 ? '−' : '+') + Math.abs(Math.round(c.deficit)) + RESET; r += 1;
      const projTxt = isFinite(c.etaDays)
        ? '~' + c.projWk.toFixed(1) + ' lb/wk → 140 in ~' + c.etaDays + 'd' + (c.etaDays <= c.daysLeft ? '  ✓ on track' : '  ⚠ behind pace')
        : 'no deficit today — eat less or move more';
      o += goto(r, L) + fg(okDef ? [120, 230, 170] : [255, 200, 90]) + projTxt + fg([120, 120, 150]) + '   (need −' + Math.round(c.reqDeficit) + '/day)' + RESET; r += 2;

      o += goto(rows, L) + fg([90, 90, 115]) + '↑↓ field · type numbers · food: type+enter · esc save & back' + (S.flash ? fg(pal[1]) + '   ' + S.flash : '') + RESET;
      if (S.frame % 90 === 0) S.flash = '';
      core.out.write(o);
    }

    return {
      enter() { S.frame = 0; },
      exit() { saveDay(day); },
      frame() { try { render(); } catch (e) {} },
      key,
    };
  },
};
