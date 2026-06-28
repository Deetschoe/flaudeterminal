#!/usr/bin/env node
'use strict';

// Flaude ✦ — a flamboyant, fully-interactive shader playground for your terminal.
//
//   flaude            open the menu and pick an experience
//   flaude --audio    jump straight into the music-reactive mode
//   flaude --help     show keys
//
// Pure ANSI truecolor. The only optional external tools are `ffmpeg` (audio +
// voice) and the `claude` CLI (the ORACLE and CUSTOM experiences). Everything
// visual is hand-rolled — see lib/visuals.js for the shared rendering helpers.
//
// Experiences (see lib/*.js for the pluggable ones):
//   PORTAL  drifting fluorescent field shaders
//   PULSE   the field, reacting to your music
//   ORBIT   a keyboard-driven 3D simulation
//   ORACLE  ask Claude; answers bloom as living typography
//   CUSTOM  describe a shader and Claude forges + saves it

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const V = require('./lib/visuals');

const out = process.stdout;
const inp = process.stdin;
const CSI = V.CSI;
const RESET = V.RESET;

// ---------------------------------------------------------------------------
// Paths & optional capabilities
// ---------------------------------------------------------------------------
const FLAUDE_DIR = path.join(os.homedir(), '.flaude');
const SHADER_DIR = path.join(FLAUDE_DIR, 'shaders');
const MODEL_DIR = path.join(FLAUDE_DIR, 'models');
try { fs.mkdirSync(SHADER_DIR, { recursive: true }); } catch (e) {}

// Locate a whisper.cpp model for voice dictation (optional). Override with
// FLAUDE_WHISPER_MODEL. We detect at startup; absence just disables voice.
const WHISPER_MODEL = (() => {
  const cands = [process.env.FLAUDE_WHISPER_MODEL, path.join(MODEL_DIR, 'ggml-base.en.bin')];
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return null;
})();

// Persisted preferences (~/.flaude/config.json): which color palette, Flo's name.
const CONFIG_FILE = path.join(FLAUDE_DIR, 'config.json');
const config = { theme: 'flow', floName: 'Flo' };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) {}
if (!V.PALETTES[config.theme]) config.theme = 'flow';
// toggleable features (see /settings)
config.settings = Object.assign({ caffeinate: true, finishFlash: true, greet: true }, config.settings || {});
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {} }

// Keep the Mac awake while Flaude is open, so it can run on the go (caffeinate).
let caffeinateProc = null;
function startCaffeinate() {
  if (caffeinateProc) return;
  try {
    // -w <pid> ties caffeinate to Flaude's lifetime: it auto-exits when Flaude
    // does, even on a hard kill, so it can never orphan and keep the Mac awake.
    caffeinateProc = spawn('caffeinate', ['-i', '-m', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinateProc.on('error', () => { caffeinateProc = null; });
    caffeinateProc.on('exit', () => { caffeinateProc = null; });
  } catch (e) { caffeinateProc = null; }
}
function stopCaffeinate() { if (caffeinateProc) { try { caffeinateProc.kill(); } catch (e) {} caffeinateProc = null; } }

// Warm the Mac screen for easier reading (cuts blue light) via a tiny bundled
// CoreGraphics gamma script. Unlike caffeinate, the tint is *meant* to outlive
// Flaude — flip it on, then go read anywhere; it stays until you clear it. The
// last level is persisted so a tinted screen is re-applied next time you open.
const WARMTH_SCRIPT = path.join(__dirname, 'lib', 'warmth.swift');
function applyTint(level) {
  const l = Math.max(0, Math.min(1, Number(level) || 0));
  try {
    const p = spawn('swift', [WARMTH_SCRIPT, l === 0 ? 'reset' : l.toFixed(2)], { stdio: 'ignore' });
    p.on('error', () => {});
  } catch (e) { return false; }
  config.tintLevel = l; saveConfig();
  return true;
}

// ===========================================================================
// Audio reactivity — ffmpeg taps an input device; a tiny FFT extracts loudness
// and bass/mid/treble energy that the visuals can react to.
// ===========================================================================
const SR = 22050;
const FFT_N = 1024;

const audio = {
  on: false,
  device: 0,
  proc: null,
  level: 0, bass: 0, mid: 0, treble: 0,
  beat: 0,
  _bassEnv: 0,
  buf: new Float32Array(FFT_N),
  fill: 0,
};

const _re = new Float32Array(FFT_N);
const _im = new Float32Array(FFT_N);
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function pushBand(key, val) {
  const mk = '_mx' + key;
  audio[mk] = Math.max(val, (audio[mk] || 1e-6) * 0.9985);
  const norm = audio[mk] > 0 ? val / audio[mk] : 0;
  const prev = audio[key];
  audio[key] = prev + (norm - prev) * (norm > prev ? 0.4 : 0.12);
}

function onWindow() {
  for (let i = 0; i < FFT_N; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));
    _re[i] = audio.buf[i] * w; _im[i] = 0;
  }
  fft(_re, _im);
  const binHz = SR / FFT_N;
  let bass = 0, mid = 0, treble = 0, nb = 0, nm = 0, nt = 0, rms = 0;
  for (let k = 1; k < FFT_N >> 1; k++) {
    const f = k * binHz;
    const mag = Math.hypot(_re[k], _im[k]);
    if (f < 200) { bass += mag; nb++; }
    else if (f < 2000) { mid += mag; nm++; }
    else if (f < 6000) { treble += mag; nt++; }
  }
  for (let i = 0; i < FFT_N; i++) rms += audio.buf[i] * audio.buf[i];
  pushBand('level', Math.sqrt(rms / FFT_N));
  pushBand('bass', nb ? bass / nb : 0);
  pushBand('mid', nm ? mid / nm : 0);
  pushBand('treble', nt ? treble / nt : 0);
  audio._bassEnv = audio._bassEnv * 0.93 + audio.bass * 0.07;
  if (audio.bass > audio._bassEnv * 1.4 && audio.bass > 0.3) audio.beat = 1;
}

function startAudio() {
  if (audio.on) return true;
  audio.device = resolveAudioIndex(); // honor the chosen source (mic, or a loopback for Spotify)
  const args = ['-f', 'avfoundation', '-i', ':' + audio.device, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-loglevel', 'quiet', '-'];
  let proc;
  try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return false; }
  audio.proc = proc; audio.on = true; audio.fill = 0;
  let carry = null;
  proc.stdout.on('data', (chunk) => {
    if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
    const n = chunk.length >> 1;
    for (let i = 0; i < n; i++) {
      audio.buf[audio.fill++] = chunk.readInt16LE(i << 1) / 32768;
      if (audio.fill >= FFT_N) { onWindow(); audio.fill = 0; }
    }
    if (chunk.length & 1) carry = chunk.subarray(chunk.length - 1);
  });
  proc.on('error', () => { audio.on = false; });
  proc.on('exit', () => { audio.on = false; });
  return true;
}

function stopAudio() {
  audio.on = false; audio.beat = 0;
  audio.level = audio.bass = audio.mid = audio.treble = 0;
  if (audio.proc) { try { audio.proc.kill('SIGKILL'); } catch (e) {} audio.proc = null; }
}

// ---------------------------------------------------------------------------
// Audio device discovery — so you can capture Spotify through headphones by
// pointing Flaude at a system-audio loopback device instead of the mic.
// Indices shift between runs, so we resolve by NAME (stored in config).
// ---------------------------------------------------------------------------
let forcedAudioIndex = null; // set by --device N
const isLoopback = (name) => /blackhole|loopback|aggregate|multi-?output|virtual.*speaker|soundflower/i.test(name);

function listAudioDevices() {
  try {
    const r = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
    const out = r.stderr || '';
    const devs = []; let inAudio = false;
    for (const l of out.split('\n')) {
      if (/AVFoundation audio devices/.test(l)) { inAudio = true; continue; }
      if (/AVFoundation video devices/.test(l)) inAudio = false;
      if (inAudio) { const m = l.match(/\[(\d+)\]\s+(.+?)\s*$/); if (m) devs.push({ index: +m[1], name: m[2], loopback: isLoopback(m[2]) }); }
    }
    return devs;
  } catch (e) { return []; }
}
// the source for MUSIC reactivity (honors the user's chosen device / a loopback)
function resolveAudioIndex() {
  if (forcedAudioIndex != null) return forcedAudioIndex;
  const devs = listAudioDevices();
  if (!devs.length) return 0;
  if (config.audioDevice) { const d = devs.find((x) => x.name === config.audioDevice); if (d) return d.index; }
  const mic = devs.find((x) => /macbook.*microphone|built-in/i.test(x.name)) || devs.find((x) => /microphone/i.test(x.name));
  return mic ? mic.index : devs[0].index;
}
// the source for VOICE dictation — always a real microphone, never a loopback
function resolveMicIndex() {
  const devs = listAudioDevices();
  if (!devs.length) return 0;
  const mic = devs.find((x) => /macbook.*microphone/i.test(x.name)) || devs.find((x) => /microphone/i.test(x.name) && !x.loopback);
  return mic ? mic.index : devs[0].index;
}
function setAudioDevice(sel) {
  const devs = listAudioDevices();
  if (!devs.length) return null;
  let d = null;
  if (/^\d+$/.test(String(sel))) d = devs.find((x) => x.index === +sel);
  if (!d) d = devs.find((x) => x.name.toLowerCase() === String(sel).toLowerCase());
  if (!d) d = devs.find((x) => x.name.toLowerCase().includes(String(sel).toLowerCase()));
  if (!d) return null;
  config.audioDevice = d.name; saveConfig();
  return d;
}

// ---------------------------------------------------------------------------
// Finish flash — a Claude Code Stop hook writes a signal file; whenever it
// changes, any running Flaude flashes. (The hook is installed on first launch.)
// ---------------------------------------------------------------------------
const SIGNAL_FILE = path.join(FLAUDE_DIR, 'finish.signal');
let flashFrames = 0;
function triggerFlash() { if (config.settings.finishFlash !== false) flashFrames = 50; }
function watchFinishSignal() {
  try { if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, '0'); } catch (e) {}
  try { fs.watchFile(SIGNAL_FILE, { interval: 150 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) triggerFlash(); }); } catch (e) {}
}
function drawFlash() {
  const cols = out.columns || 80, rows = out.rows || 24;
  if (cols < 4 || rows < 4) return;
  const pal = V.PALETTES[config.theme] || V.P4;
  const f = 50 - flashFrames;                 // 0 → 49
  const inten = Math.max(0, 1 - f / 50);      // fade out
  const dim = (c) => [c[0] * inten, c[1] * inten, c[2] * inten];
  let o = '';
  for (let x = 0; x < cols; x++) {
    const c = V.bg(dim(V.cyc(pal, x * 0.08 + f * 0.2)));
    o += CSI + '1;' + (x + 1) + 'H' + c + ' ' + CSI + rows + ';' + (x + 1) + 'H' + c + ' ';
  }
  for (let r = 2; r < rows; r++) {
    const c = V.bg(dim(V.cyc(pal, r * 0.1 + f * 0.2)));
    o += CSI + r + ';1H' + c + ' ' + CSI + r + ';' + cols + 'H' + c + ' ';
  }
  const msg = ' ✦ a Claude finished ✦ ';
  const bc = V.cyc(pal, f * 0.15);
  o += CSI + Math.floor(rows / 2) + ';' + Math.max(1, Math.floor((cols - msg.length) / 2) + 1) + 'H';
  o += V.bg(dim(bc)) + V.fg([18, 8, 26]) + msg + RESET;
  out.write(o);
}

// ---------------------------------------------------------------------------
// Finish SOUND — reuse the user's existing ~/.claude/play-sound.sh system,
// just swap which file plays on "stop", and make sure the flash hook is set.
// ---------------------------------------------------------------------------
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SOUND_CONFIG = path.join(CLAUDE_DIR, 'sound-config.json');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

function getFinishSound() {
  try {
    const c = JSON.parse(fs.readFileSync(SOUND_CONFIG, 'utf8'));
    const name = c.sounds && c.sounds.stop;
    if (!name) return null;
    const custom = path.join(CLAUDE_DIR, name);
    const sys = '/System/Library/Sounds/' + name + '.aiff';
    return { name, path: fs.existsSync(custom) ? custom : (fs.existsSync(sys) ? sys : custom) };
  } catch (e) { return null; }
}
function setFinishSound(src) {
  let p = String(src).trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  if (!fs.existsSync(p)) return { ok: false, msg: 'no file found at: ' + p };
  const destName = 'flaude-finish' + (path.extname(p) || '.mp3');
  try { fs.copyFileSync(p, path.join(CLAUDE_DIR, destName)); } catch (e) { return { ok: false, msg: 'copy failed: ' + e.message }; }
  let cfg = { volume: 1, sounds: {} };
  try { cfg = JSON.parse(fs.readFileSync(SOUND_CONFIG, 'utf8')); } catch (e) {}
  cfg.sounds = cfg.sounds || {};
  cfg.sounds.stop = destName;
  try { fs.writeFileSync(SOUND_CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { return { ok: false, msg: 'could not write sound-config.json' }; }
  ensureStopSoundHook();
  ensureFlashHook();
  return { ok: true, msg: path.basename(p) };
}
function previewFinishSound() {
  const sh = path.join(CLAUDE_DIR, 'play-sound.sh');
  if (fs.existsSync(sh)) { try { spawn('bash', [sh, 'stop', 'preview'], { stdio: 'ignore' }); return true; } catch (e) {} }
  const f = getFinishSound();
  if (f) { try { spawn('afplay', [f.path], { stdio: 'ignore' }); return true; } catch (e) {} }
  return false;
}
// make sure the user's settings.json fires play-sound.sh + our flash signal on Stop
function ensureStopSoundHook() {
  const sh = path.join(CLAUDE_DIR, 'play-sound.sh');
  if (!fs.existsSync(sh)) return;
  patchSettings((s) => {
    s.hooks.Stop = s.hooks.Stop || [];
    if (!JSON.stringify(s.hooks.Stop).includes('play-sound.sh')) {
      s.hooks.Stop.push({ hooks: [{ type: 'command', command: sh + " stop 'Task complete'" }] });
      return true;
    }
    return false;
  });
}
function ensureFlashHook() {
  return patchSettings((s) => {
    s.hooks.Stop = s.hooks.Stop || [];
    if (!JSON.stringify(s.hooks.Stop).includes('finish.signal')) {
      s.hooks.Stop.push({ hooks: [{ type: 'command', command: "date +%s > '" + SIGNAL_FILE + "'" }] });
      return true;
    }
    return false;
  });
}
function patchSettings(mutate) {
  let s;
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return false; }
  s.hooks = s.hooks || {};
  const changed = mutate(s);
  if (changed) { try { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); } catch (e) { return false; } }
  return true;
}

// ===========================================================================
// Shaders — each is { name, palette, field(x,y,t)->0..1, glow?(f)->mult }.
// field() works in WORLD coordinates so the same contract works for both
// built-in and Claude-generated custom shaders (no shared globals).
// ===========================================================================
const SHADERS = [
  {
    name: 'fluoro', color: [196, 68, 210],
    palette: [[8, 0, 28], [46, 6, 96], [120, 20, 210], [196, 48, 236], [255, 92, 220], [180, 140, 255], [236, 224, 255]],
    field(x, y, t) {
      let s = 0;
      s += Math.sin(x * 1.7 + t * 0.9);
      s += Math.sin(y * 2.3 - t * 0.7);
      s += Math.sin((x + y) * 1.3 + t * 0.5);
      s += Math.sin(Math.hypot(x - 1.5, y - 1.5) * 2.6 - t * 1.1);
      s += Math.sin((x + Math.sin(y * 1.1 + t * 0.6)) * 1.9 + t * 0.4);
      return s / 5 * 0.5 + 0.5;
    },
    glow(f) { return 0.65 + 0.6 * f * f; },
  },
  {
    name: 'aurora', color: [40, 210, 140],
    palette: [[2, 6, 16], [6, 40, 60], [18, 120, 110], [40, 210, 140], [150, 245, 170], [220, 255, 220]],
    field(x, y, t) {
      let s = 0;
      s += Math.sin(x * 2.2 + Math.sin(y * 0.7 + t * 0.5) * 1.6 + t * 0.6);
      s += Math.sin(x * 4.0 - t * 0.4) * 0.5;
      s += Math.sin((y - t * 0.3) * 1.1);
      return s / 2 * 0.5 + 0.5;
    },
    glow(f) { return 0.5 + 0.8 * f * f; },
  },
  {
    name: 'ember', color: [240, 90, 10],
    palette: [[4, 2, 0], [60, 8, 0], [160, 30, 0], [240, 90, 10], [255, 180, 40], [255, 240, 180]],
    field(x, y, t) {
      const v = y / 3.0;
      let s = 0;
      s += Math.sin(x * 3.1 + Math.sin(y * 2.0 - t * 1.4) * 1.2);
      s += Math.sin((x + y) * 2.0 - t * 1.8) * 0.6;
      s = s / 1.6 * 0.5 + 0.5;
      return s * (0.35 + 0.65 * v);
    },
    glow(f) { return 0.5 + 0.9 * f * f; },
  },
  {
    name: 'ocean', color: [30, 160, 200],
    palette: [[2, 8, 30], [6, 30, 80], [10, 90, 150], [30, 160, 200], [120, 220, 230], [230, 250, 255]],
    field(x, y, t) {
      let s = 0;
      s += Math.sin(x * 1.2 - t * 0.5);
      s += Math.sin((x * 0.6 + y * 1.4) - t * 0.35);
      s += Math.sin(Math.hypot(x - 1.5, y - 1.5) * 1.8 - t * 0.6) * 0.7;
      return s / 2.7 * 0.5 + 0.5;
    },
    glow(f) { return 0.55 + 0.7 * f * f; },
  },
];
const BUILTIN_COUNT = SHADERS.length;

// Load Claude-generated custom shaders from ~/.flaude/shaders/*.js. Each is
// validated before being trusted: it must expose field()/palette and produce
// finite output for sample inputs.
function loadCustomShaders() {
  SHADERS.length = BUILTIN_COUNT; // drop previously-loaded customs, keep built-ins
  let files = [];
  try { files = fs.readdirSync(SHADER_DIR).filter((f) => f.endsWith('.js')); } catch (e) { return; }
  for (const f of files) {
    const full = path.join(SHADER_DIR, f);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      if (!mod || typeof mod.field !== 'function' || !Array.isArray(mod.palette)) continue;
      // sanity: must return finite numbers
      let ok = true;
      for (const [x, y, t] of [[0, 0, 0], [1.5, 2.5, 3.0], [-2, 3, 9]]) {
        const r = mod.field(x, y, t);
        if (typeof r !== 'number' || !isFinite(r)) { ok = false; break; }
      }
      if (!ok) continue;
      if (!mod.color) mod.color = V.ramp(mod.palette, 0.6);
      mod.custom = true;
      if (!mod.name) mod.name = f.replace(/\.js$/, '');
      SHADERS.push(mod);
    } catch (e) { /* skip broken shader */ }
  }
}

// Persist a generated shader to disk and return its filename.
function saveCustomShader(slug, code) {
  loadCustomShaders.lastSlug = slug;
  const safe = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'shader';
  const file = path.join(SHADER_DIR, safe + '.js');
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// ===========================================================================
// Field experience (powers PORTAL and PULSE)
// ===========================================================================
const fstate = { frame: 0, speed: 1.0, bright: 1.0, paused: false, shader: 0, flowX: 0, flowY: 0, panX: 0, panY: 0 };
let fieldZoom = 3.0;
let fieldAudio = false;

const clampSpeed = (v) => Math.max(0, Math.min(4, v));
const clampBright = (v) => Math.max(0.2, Math.min(2.0, v));
const clampFlow = (v) => Math.max(-0.6, Math.min(0.6, v));
const FLOW_KICK = 0.04;

function fieldShade(sh, u, v, t) {
  const x = u * fieldZoom + fstate.panX;
  const y = v * fieldZoom + fstate.panY;
  let f = sh.field(x, y, t);
  if (f < 0) f = 0; else if (f > 1) f = 1;
  if (audio.on) { f += audio.treble * 0.12; if (f > 1) f = 1; }
  const col = V.ramp(sh.palette, f);
  let glow = sh.glow ? sh.glow(f) : (0.65 + 0.6 * f * f);
  if (audio.on) glow *= 1 + audio.level * 0.7 + audio.beat * 0.6;
  const b = fstate.bright * glow;
  return [col[0] * b, col[1] * b, col[2] * b];
}

function fieldHud(rows) {
  const sh = SHADERS[fstate.shader];
  const arrows = (fstate.flowX || fstate.flowY)
    ? (fstate.flowY < 0 ? '↑' : fstate.flowY > 0 ? '↓' : '') + (fstate.flowX < 0 ? '←' : fstate.flowX > 0 ? '→' : '')
    : '·';
  let aud;
  if (audio.on) {
    const bars = ' ▁▂▃▄▅▆▇█';
    const lv = (x) => bars[Math.max(0, Math.min(8, Math.round(x * 8)))];
    aud = V.fg(V.EXP_COLORS.aqua) + 'a ♪ ' + lv(audio.level) + ' b' + lv(audio.bass) + ' m' + lv(audio.mid) + ' t' + lv(audio.treble) + '  ';
  } else {
    aud = V.fg([130, 130, 160]) + 'a audio  ';
  }
  return V.at(rows, 1) +
    V.fg(V.EXP_COLORS.violet) + ' flaude ✦  ' +
    aud +
    V.fg([150, 150, 175]) + 'n ' + sh.name + (sh.custom ? '*' : '') + '  ' +
    '↑↓←→ ' + arrows + '  [ ] glow ' + fstate.bright.toFixed(1) + '  ' +
    'space ' + (fstate.paused ? 'paused' : 'live') + '  esc menu' + RESET;
}

function fieldFrame() {
  let zoomTarget = 3.0;
  if (audio.on) {
    audio.beat *= 0.85;
    zoomTarget = 3.0 * (1 - audio.bass * 0.12 - audio.beat * 0.08);
  }
  fieldZoom += (zoomTarget - fieldZoom) * 0.06;
  if (!fstate.paused) {
    const accel = audio.on ? 1 + audio.treble * 0.6 + audio.level * 0.3 : 1;
    fstate.frame += fstate.speed * accel;
    fstate.panX += fstate.flowX; fstate.panY += fstate.flowY;
    fstate.flowX *= 0.92; fstate.flowY *= 0.92;
    if (Math.abs(fstate.flowX) < 1e-4) fstate.flowX = 0;
    if (Math.abs(fstate.flowY) < 1e-4) fstate.flowY = 0;
  }
  const cols = out.columns || 80, rows = out.rows || 24;
  const W = cols, H = (rows - 1) * 2;
  if (W < 2 || H < 2) return;
  const t = fstate.frame * 0.04;
  const sh = SHADERS[fstate.shader];
  let frameStr;
  try {
    frameStr = V.fullFrame(W, H, (u, v) => fieldShade(sh, u, v, t));
  } catch (e) {
    // a broken custom shader: fall back to fluoro and carry on
    fstate.shader = 0;
    return;
  }
  out.write(frameStr + fieldHud(rows));
}

function fieldKey(s) {
  if (s === 'q' || s === 'Q' || s === '\x1b') return 'menu';
  if (s === '\x1b[A' || s === '\x1bOA') { fstate.flowY = clampFlow(fstate.flowY - FLOW_KICK); return; }
  if (s === '\x1b[B' || s === '\x1bOB') { fstate.flowY = clampFlow(fstate.flowY + FLOW_KICK); return; }
  if (s === '\x1b[C' || s === '\x1bOC') { fstate.flowX = clampFlow(fstate.flowX + FLOW_KICK); return; }
  if (s === '\x1b[D' || s === '\x1bOD') { fstate.flowX = clampFlow(fstate.flowX - FLOW_KICK); return; }
  if (s === ']') { fstate.bright = clampBright(fstate.bright + 0.1); return; }
  if (s === '[') { fstate.bright = clampBright(fstate.bright - 0.1); return; }
  if (s === '=' || s === '+') { fstate.speed = clampSpeed(fstate.speed + 0.1); return; }
  if (s === '-' || s === '_') { fstate.speed = clampSpeed(fstate.speed - 0.1); return; }
  if (s === '0') { fstate.flowX = 0; fstate.flowY = 0; return; }
  if (s === 'n' || s === '\t') { fstate.shader = (fstate.shader + 1) % SHADERS.length; return; }
  if (s === 'p' || s === '\x1b[Z') { fstate.shader = (fstate.shader + SHADERS.length - 1) % SHADERS.length; return; }
  if (s >= '1' && s <= '9') { const i = s.charCodeAt(0) - 49; if (i < SHADERS.length) fstate.shader = i; return; }
  if (s === 'a' || s === 'A') { audio.on ? stopAudio() : startAudio(); return; }
  if (s === ' ') { fstate.paused = !fstate.paused; return; }
}

function makeField(opts) {
  return {
    enter() { if (opts.audio) startAudio(); },
    exit() { stopAudio(); },
    frame: fieldFrame,
    key: fieldKey,
  };
}

// runField — start the field renderer with a given shader (index or object).
function runField(shader, opts) {
  opts = opts || {};
  if (typeof shader === 'object' && shader) {
    let idx = SHADERS.indexOf(shader);
    if (idx === -1) { SHADERS.push(shader); idx = SHADERS.length - 1; }
    fstate.shader = idx;
  } else if (typeof shader === 'number') {
    fstate.shader = Math.max(0, Math.min(SHADERS.length - 1, shader));
  }
  fstate.flowX = fstate.flowY = fstate.panX = fstate.panY = 0;
  fieldAudio = !!opts.audio;
  setActive(makeField({ audio: fieldAudio }));
}

// ===========================================================================
// Voice dictation (Wispr-style) and Claude helper — exposed to experiences
// ===========================================================================
// Flatten a tool_result's content (string | array of parts | {text}) to text.
function flattenToolContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  if (typeof c === 'object' && c.text) return c.text;
  return '';
}

// Run Claude in print mode over the STRUCTURED stream-json protocol instead of
// screen-scraping. We parse the NDJSON event stream: assistant prose accumulates
// into `buf` so the old onChunk(text, buf) / onDone(buf, code) contract still holds
// for every existing caller (Flo chat, away digests). Richer consumers pass
// `onEvent` to receive normalized {kind:'text'|'tool'|'tool_result'|'result'|'system'}
// events (tool visibility, cost/duration metadata, future approval+steering).
// If a line isn't JSON we fall back to treating it as raw text, so it degrades
// gracefully on a CLI that doesn't speak stream-json.
function claudeCall(prompt, opts) {
  opts = opts || {};
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (opts.args) for (const a of opts.args) args.push(a);
  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  let proc;
  try { proc = spawn('claude', args, spawnOpts); }
  catch (e) { if (opts.onErr) opts.onErr(e); return null; }

  let buf = '';          // clean assistant prose (back-compat for onChunk/onDone)
  let lineBuf = '';      // NDJSON line accumulator across data events
  let resultText = null; // final answer from the `result` event, if present
  let resultErr = false; // claude reported is_error even on a 0 exit code
  let tools = 0;         // tool calls seen (metadata for digests)

  const pushText = (text) => {
    if (!text) return;
    buf += text;
    if (opts.onChunk) opts.onChunk(text, buf);
    if (opts.onEvent) opts.onEvent({ kind: 'text', text });
  };

  function handle(evt) {
    const type = evt && evt.type;
    if (type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const b of evt.message.content) {
        if (b.type === 'text') pushText(b.text);
        else if (b.type === 'tool_use') { tools++; if (opts.onEvent) opts.onEvent({ kind: 'tool', id: b.id, tool: b.name, input: b.input }); }
      }
    } else if (type === 'user' && evt.message && Array.isArray(evt.message.content)) {
      for (const b of evt.message.content) {
        if (b.type === 'tool_result' && opts.onEvent) opts.onEvent({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, content: flattenToolContent(b.content) });
      }
    } else if (type === 'result') {
      resultText = (evt.result != null) ? String(evt.result) : null;
      resultErr = !!evt.is_error;
      if (opts.onEvent) opts.onEvent({ kind: 'result', text: resultText, isError: resultErr, costUsd: evt.total_cost_usd, durationMs: evt.duration_ms, numTurns: evt.num_turns, tools });
    } else if (type === 'system') {
      if (opts.onEvent) opts.onEvent({ kind: 'system', subtype: evt.subtype, model: evt.model });
    }
  }

  function consume(line) {
    line = line.trim();
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line); } catch (e) { pushText(line + '\n'); return; }
    handle(evt);
  }

  proc.stdout.on('data', (d) => {
    lineBuf += d.toString('utf8');
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1); consume(line); }
  });
  proc.stderr.on('data', () => {}); // swallow the connectors warning
  proc.on('error', (e) => { if (opts.onErr) opts.onErr(e); });
  proc.on('close', (code) => {
    if (lineBuf.trim()) consume(lineBuf); // flush a trailing partial line
    if (opts.onDone) opts.onDone(buf, code || (resultErr ? 1 : 0), { resultText, tools, isError: resultErr });
  });
  return proc;
}

// Record from the mic via ffmpeg; on stop() finalize and transcribe with
// whisper-cli. Returns a controller, or null if voice is unavailable.
function dictate(opts) {
  opts = opts || {};
  if (!WHISPER_MODEL) { if (opts.onErr) opts.onErr(new Error('no whisper model')); return null; }
  const wav = path.join(os.tmpdir(), 'flaude-dictate-' + process.pid + '.wav');
  let rec;
  try {
    rec = spawn('ffmpeg', ['-y', '-f', 'avfoundation', '-i', ':' + resolveMicIndex(), '-ac', '1', '-ar', '16000', '-loglevel', 'quiet', wav], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) { if (opts.onErr) opts.onErr(e); return null; }
  let stopped = false;
  return {
    stop() {
      if (stopped) return; stopped = true;
      try { rec.kill('SIGINT'); } catch (e) {}
      rec.on('close', () => {
        let w;
        try { w = spawn('whisper-cli', ['-m', WHISPER_MODEL, '-f', wav, '-nt'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch (e) { if (opts.onErr) opts.onErr(e); return; }
        let o = '';
        w.stdout.on('data', (d) => { o += d.toString('utf8'); });
        w.on('error', (e) => { if (opts.onErr) opts.onErr(e); });
        w.on('close', () => {
          try { fs.unlinkSync(wav); } catch (e) {}
          if (opts.onText) opts.onText(o.replace(/\s+/g, ' ').trim());
        });
      });
    },
  };
}

// ===========================================================================
// The core object handed to every pluggable experience (lib/*.js)
// ===========================================================================
const core = {
  out, inp, CSI, RESET, V,
  cols: () => out.columns || 80,
  rows: () => out.rows || 24,
  theme: {
    P4: V.P4,
    gradient: V.gradient,
    color: (n) => (Array.isArray(n) ? n : (V.EXP_COLORS[n] || [255, 255, 255])),
    fg: V.fg, bg: V.bg,
    palette: () => V.PALETTES[config.theme] || V.P4, // the active, user-chosen palette
    palettes: V.PALETTE_NAMES,
  },
  ramp: V.ramp,
  fullFrame: V.fullFrame,
  PixelBuffer: V.PixelBuffer,
  center: V.center,
  at: V.at,
  audio, startAudio, stopAudio,
  spawn,
  claude: claudeCall,
  dictate,
  voiceAvailable: !!WHISPER_MODEL,
  paths: { home: os.homedir(), dir: FLAUDE_DIR, shaders: SHADER_DIR },
  SHADERS,
  loadCustomShaders,
  saveShader: saveCustomShader,
  toMenu: () => toMenu(),
  quit: () => leave(0),
  runField,
  config: {
    get: (k) => config[k],
    set: (k, v) => { config[k] = v; saveConfig(); },
    all: () => config,
  },
  settings: {
    get: (k) => config.settings[k],
    set: (k, v) => {
      config.settings[k] = v; saveConfig();
      if (k === 'caffeinate') (v ? startCaffeinate() : stopCaffeinate());
    },
    all: () => config.settings,
    caffeinateActive: () => !!caffeinateProc,
  },
  tint: {
    level: () => config.tintLevel || 0,
    set: (l) => applyTint(l),
  },
  listAudioDevices,
  setAudioDevice,
  flash: triggerFlash,
  getFinishSound,
  setFinishSound,
  previewFinishSound,
};

// ===========================================================================
// Experience registry + the home CONSOLE (the creative terminal you land in)
// ===========================================================================
const EXPERIENCES = [
  { name: 'PORTAL',    color: 'violet',  blurb: 'drifting fluorescent shaders — n for more, a for music', kind: 'field', audio: false },
  { name: 'ORBIT',     color: 'gold',    blurb: 'a hand-spun 3D simulation — rotate it with the keys', kind: 'ext', mod: './lib/orbit' },
  { name: 'FIREWORKS', color: 'magenta', blurb: 'launch a celebratory fireworks show', kind: 'ext', mod: './lib/fireworks' },
  { name: 'BOIDS',     color: 'aqua',    blurb: 'a living flock that swirls and flees', kind: 'ext', mod: './lib/boids' },
  { name: 'SAND',      color: 'gold',    blurb: 'paint falling sand, water & sparks', kind: 'ext', mod: './lib/sand' },
  { name: 'CUSTOM',    color: 'white',   blurb: 'describe a shader; Claude forges it & saves it forever', kind: 'ext', mod: './lib/custom' },
  { name: 'CALORIES',  color: 'aqua',    blurb: 'daily calorie & workout check-in', kind: 'ext', mod: './lib/calories' },
  { name: 'AWAY',      color: 'magenta', blurb: 'queue tasks; Flaude works them while you step away', kind: 'ext', mod: './lib/away' },
  { name: 'SETTINGS',  color: 'violet',  blurb: 'toggle features on & off', kind: 'ext', mod: './lib/settings' },
];

// the console (home) is created once and reused, so the conversation and the
// little character persist as you dip in and out of the experiences.
const consoleMod = require('./lib/console');
let consoleInst = null;

function startModule(mod, opts, inst) {
  const instance = inst || mod.create(core, opts);
  if (mod.audio) startAudio();
  setActive({
    enter() { if (instance.enter) instance.enter(); },
    exit() { if (instance.exit) instance.exit(); if (mod.audio) stopAudio(); },
    frame() { if (instance.frame) instance.frame(); },
    key(s) { return instance.key ? instance.key(s) : undefined; },
  });
  return instance;
}

// launch an experience by name — used by the console's slash-commands
function launchExperience(name, opts) {
  const exp = EXPERIENCES.find((e) => e.name === String(name).toUpperCase());
  if (!exp) return false;
  if (exp.kind === 'field') { runField(0, { audio: exp.audio }); return true; }
  loadCustomShaders();
  let mod;
  try { mod = require(exp.mod); } catch (e) { return false; }
  try { startModule(mod, opts); } catch (e) { return false; }
  return true;
}

// the home screen — Flaude's creative console (also where 'esc'/'menu' returns)
function toMenu() {
  loadCustomShaders();
  if (!consoleInst) consoleInst = consoleMod.create(core);
  startModule(consoleMod, null, consoleInst);
}

// extra core methods the console needs (added now that the helpers exist)
core.launchExperience = (name, opts) => launchExperience(name, opts);
core.experiences = EXPERIENCES.map((e) => ({ name: e.name, blurb: e.blurb, color: e.color }));

// ===========================================================================
// Runtime — one timer, one key router, a swappable "active" experience
// ===========================================================================
let timer = null;
let active = null;

function setActive(a) {
  if (active && active.exit) { try { active.exit(); } catch (e) {} }
  active = a;
  out.write(CSI + '2J');
  if (a && a.enter) { try { a.enter(); } catch (e) {} }
}

function loop() {
  if (active && active.frame) { try { active.frame(); } catch (e) {} }
  if (flashFrames > 0) { try { drawFlash(); } catch (e) {} flashFrames--; }
}

function onData(chunk) {
  const s = chunk.toString('utf8');
  if (s === '\x03') return leave(0); // ctrl-c always quits
  if (active && active.key) {
    let r;
    try { r = active.key(s); } catch (e) { r = undefined; }
    if (r === 'menu') toMenu();
    else if (r === 'quit') leave(0);
  }
}

function setupTerminal() {
  out.write(CSI + '?1049h' + CSI + '?25l');
  out.write(CSI + '2J');
  if (inp.isTTY) inp.setRawMode(true);
  inp.resume();
  inp.on('data', onData);
  out.on('resize', () => out.write(CSI + '2J'));
  timer = setInterval(loop, 1000 / 60);
}

function leave(code) {
  if (timer) clearInterval(timer);
  if (active && active.exit) { try { active.exit(); } catch (e) {} }
  stopAudio();
  stopCaffeinate();
  inp.off('data', onData);
  if (inp.isTTY) inp.setRawMode(false);
  out.write(RESET + CSI + '?25h' + CSI + '?1049l');
  process.exit(code || 0);
}

function help() {
  console.log(`
flaude ✦ — a flamboyant creative terminal you type into

  flaude            open the console (Flo + a shader vibe; type or use commands)
  flaude --audio    skip the console, jump into the music-reactive field
  flaude --device N audio input device N for sound/voice (default 0 = mic)
  flaude --help     this help

console: just type to chat with Flo, your little spark companion. Type '/' to
         pull up commands — each experience is a slash-command:
  /portal     fluorescent shaders (n=more, a=music)   /boids   a living flock
  /orbit      a 3D simulation you spin                 /sand    paint falling sand
  /fireworks  a fireworks show                         /custom  forge a shader (Claude)
  /calories   daily calorie + workout check-in (food→kcal via Flo, goal tracking)
  /workout    jump into the check-in to log calories burned
  /away       queue tasks; Flaude works them via Claude while you step away
  /settings   toggle features (Mac-awake/caffeinate, finish-flash, greeting)
  /tint       warm the Mac screen for easy reading (/tint 0.8 · /tint off)
  /theme  recolor everything   /name  rename Flo   /voice · /clear · /help · /quit
  /audio  pick the sound source (mic, or a loopback to react to Spotify)
  /sound  set the sound that plays when a Claude Code instance finishes
         enter to send · ↑↓ scroll · \` to speak (voice) · esc to quit

flash:  Flaude installs a Stop hook so it flashes whenever any Claude Code
        instance finishes. Customize the finish sound with /sound (drag an mp3
        into the prompt). To react to Spotify on headphones, use /audio to pick
        a loopback device (install BlackHole if you don't have one).

portal: a react to sound · ↑↓←→ steer the flow · [ ] glow · -/= speed
        n / p / tab cycle shaders · 1-9 jump · 0 stop flow · space pause
        esc / q back to the console

needs:  ffmpeg for sound & voice (brew install ffmpeg); the \`claude\` CLI for
        the ORACLE and CUSTOM experiences. Voice dictation also needs a
        whisper.cpp model (set FLAUDE_WHISPER_MODEL or drop one at
        ~/.flaude/models/ggml-base.en.bin).
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { help(); return; }
  const di = argv.indexOf('--device');
  if (di !== -1 && argv[di + 1] != null) forcedAudioIndex = parseInt(argv[di + 1], 10) || 0;
  const wantAudio = argv.includes('--audio') || argv.includes('-a');

  if (!out.isTTY) {
    console.error('flaude needs an interactive terminal. Run it directly:\n  flaude');
    process.exit(1);
  }

  process.on('SIGINT', () => leave(0));
  process.on('SIGTERM', () => leave(0));
  process.on('uncaughtException', (err) => {
    stopAudio();
    stopCaffeinate();
    out.write(RESET + CSI + '?25h' + CSI + '?1049l');
    console.error('flaude crashed:', err);
    process.exit(1);
  });

  loadCustomShaders();
  ensureFlashHook();      // so any Claude Code instance finishing makes Flaude flash
  watchFinishSignal();
  if (config.settings.caffeinate !== false) startCaffeinate(); // keep the Mac awake while open
  if (config.tintLevel > 0) applyTint(config.tintLevel); // restore the reading tint from last time
  setupTerminal();
  if (wantAudio) runField(0, { audio: true });
  else toMenu();
}

main();
