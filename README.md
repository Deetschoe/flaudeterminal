# Flaude ✦

A **flamboyant, fully-interactive creative terminal**. Pure ANSI truecolor, no
npm dependencies. You land in a console with a drifting shader behind it and
**Flo**, a little spark companion you can chat with — then type slash-commands to
dive into experiences: music-reactive fluorescent shaders, a hand-spun 3D
simulation, a fireworks show, a living flock, a falling-sand sandbox, and a
"describe it and Claude forges it" custom-shader mode. Recolor the whole thing
with switchable palettes.

Inspired by the little animation that plays when you hover *ultra* effort in
Claude Code.

This repo is the open-source Flaude terminal — the CLI and everything around it. What's inside:

- **The terminal CLI** (`flaude.js`, `bin/flaude`) — the runtime, the built-in audio engine, and the field renderer.
- **The shaders and experiences** (`lib/`) — the console, PORTAL, orbit, fireworks, boids, sand, and a Claude-written custom mode.
- **Shared rendering helpers** (`lib/visuals.js`) — the palettes, gradient text, and half-block + 3D drawing.
- **A small Swift display-warming helper** (`lib/warmth.swift`).

## Run it

You need a terminal with truecolor support (ghostty, cmux, iTerm2, kitty, modern
xterm, Windows Terminal) and Node 18+.

```bash
node flaude.js
```

Or install it as a global command and just type `flaude` anywhere:

```bash
npm link   # then, in any terminal:
flaude
```

## The console

Running `flaude` drops you into the **console** — a creative terminal you type
into, with a dim shader drifting behind everything and **Flo**, a little spark
companion with personality (she blinks, bobs, quips, and reacts), idling in the
corner.

- **Just type** to chat with Flo (powered by the `claude` CLI). Her replies bloom
  in as flowing gradient text.
- **Type `/`** to pull up the command palette — every experience is a
  slash-command. Filter as you type, `↑` / `↓` to pick, `enter` to run.
- `↑` / `↓` scroll the conversation, `` ` `` to dictate by voice, `esc` to quit.

| command | what it does |
|---------|------------|
| `/portal` | drifting fluorescent shaders — cycle with `n`, toggle music with `a` |
| `/orbit`  | a keyboard-driven 3D simulation — wireframes, point-clouds & a starfield |
| `/fireworks` | launch a celebratory fireworks show (`space`, `f` for finale) |
| `/boids`  | a living flock that swirls, flees a predator, and scatters |
| `/sand`   | paint falling sand, water, embers & growing plants |
| `/custom` | describe a shader; Claude writes it, Flaude saves it forever and runs it |
| `/calories` · `/workout` | daily calorie + workout check-in with goal tracking |
| `/away` | queue tasks; Flaude works them through Claude while you step away |
| `/settings` | toggle features (keep-Mac-awake, finish-flash, greeting) |
| `/theme` | recolor everything — cycle the palettes (or `/theme vapor`) |
| `/name` | rename Flo (`/name Spark`) |
| `/audio` | pick the sound source — mic, or a loopback to react to Spotify |
| `/sound` | set the sound that plays when a Claude Code instance finishes |
| `/voice` `/clear` `/help` `/quit` | dictate · wipe the chat · help · exit |

Skip the console and jump straight into the music-reactive field with
`flaude --audio`. Press `esc` (or `q`) inside any experience to return to the
console — your conversation with Flo is still there.

## Make it yours

`/theme` cycles through a wardrobe of curated palettes — **flaude, sunset, vapor,
ember, forest, ice, candy, neon** — and the whole UI (and Flo) recolors to match.
`/name` renames your companion. Both persist to `~/.flaude/config.json`, so
Flaude looks the way you left it next time.

## PORTAL — the field

| key | action |
|-----|--------|
| `a` | toggle audio reactivity (mic) |
| `↑` `↓` `←` `→` | steer the flow — stream the pattern across the terminal |
| `n` / `p` / `tab` | cycle to the next / previous shader (incl. your custom ones) |
| `1`–`9` | jump straight to a shader |
| `[` / `]` | dim / brighten the glow |
| `-` / `=` | slow down / speed up the drift |
| `0` | stop the flow |
| `space` | pause / resume |
| `esc` / `q` | back to the console |

**Reacting to music** (press `a`, or launch with `flaude --audio`): bass gently
pumps the zoom so the pattern breathes with the low end (heavily smoothed, so it
stays musical instead of strobing on loud tracks); kick drums punch the zoom and
flash the glow; treble sparkles the highlights; overall loudness drives
brightness and speed.

Out of the box Flaude listens on the **microphone** — just play your song out
loud. But on **headphones or AirPods** the mic can't hear the music, so to react
to Spotify you need to capture *system audio* via a loopback device:

1. Install one: `brew install blackhole-2ch`
2. In **Audio MIDI Setup**, make a **Multi-Output Device** (your AirPods +
   BlackHole) and select it as your Mac's output — now you hear the music *and*
   it's available to capture.
3. In Flaude, run **`/audio`** and pick the BlackHole / loopback device (marked
   "← system audio"). Flaude jumps into PORTAL and reacts to whatever's playing.

`/audio` picks the source by **name** (so it survives the device order shuffling
macOS does), and remembers it. Voice dictation always uses your real mic, so the
two never collide.

## The other experiences

- **ORBIT** — a keyboard-driven, depth-shaded 3D toy. Cycle scenes with `n` / `p`
  (rotating wireframe cube, torus point-cloud, Fibonacci-sphere globe, fly-through
  starfield). Arrows add yaw/pitch spin, `+` / `-` zoom, `c` cycles color moods,
  `space` pauses, `r` resets.
- **FIREWORKS** — `space` launches rockets that burst (round, ring, willow, palm,
  crackle); `←` / `→` aim, `↑` / `↓` set burst height, `f` finale, `a` auto-show,
  `c` color mood.
- **BOIDS** — a flock with real separation/alignment/cohesion. Arrows move an
  attractor, `p` drops a predator they flee, `space` scatters them, `+` / `-`
  change the flock size, `c` color mood.
- **SAND** — a falling-sand sandbox. Arrows move the cursor, `space` paints, `tab`
  cycles material (sand · water · stone · ember · plant · fire), `[` / `]` brush
  size, `g` flips gravity, `c` clears.

Press `esc` (or `q`) in any of them to return to the console.

## CUSTOM — forge a shader with Claude

Describe a shader ("lava lamp", "matrix rain", "neon plasma") and press `enter`.
Claude writes a real shader module, Flaude validates it in a sandbox (auto-
repairing once if needed), **saves it to `~/.flaude/shaders/` forever**, gives it
its own color, and runs it immediately. Saved shaders also join the PORTAL `n`
cycle (their names show with a `*`). Requires the `claude` CLI.

## Away mode — `/away` 🚶

Brain-dump a list of tasks (type them, or hit `` ` `` to speak), press **Tab**,
and walk away. Flaude works each task through Claude Code (`claude -p`, in a
scratch dir so it doesn't touch your repos), streams progress, and — because
your Mac stays awake — keeps going while you're gone. When the queue finishes it
**flashes** and saves a dated digest of every answer to `~/.flaude/away/`.

It's the core bet of Flow: Claude Code is a coding tool; this is a *personal,
walk-away life runner* layered on top of it. Queue the errands of your mind,
come back to a plated digest.

## Settings & staying awake — `/settings` ☕

`/settings` is an arrow-key toggle screen (Enter flips a switch; changes persist):

- **Keep Mac awake** *(on by default)* — Flaude runs `caffeinate` the whole time
  it's open, so it keeps running on the go. It's tied to Flaude's process, so it
  can never orphan and leave your Mac awake after you quit.
- **Flash on Claude finish** — the finish flash described below.
- **Flo greets you** — Flo's hello when the console opens.

## Daily check-in — `/calories` 🏋️

A calorie + workout tracker tuned for a cut. `↑` / `↓` move between fields, type
numbers to edit them, and **type a food + enter** to have Flo estimate its
calories (via the `claude` CLI). It factors in calories burned, tracks your
weight toward a goal, and shows your projected rate and whether you're on pace.

- **Fields:** weight, daily net-calorie target, maintenance (base burn), a food
  log, and calories burned. In the **burned** field, `w`/`r`/`l` quick-add a
  walk/run/lift.
- **Goal math:** defaults to 180 → 140 lb over ~6 months; it computes the daily
  deficit you need and projects an ETA from today's numbers.
- **Logs:** one JSON per day in `~/.flaude/calories/`. It tracks your streak and
  expects a check-in every ~12 hours (overdue past 24h). `/workout` jumps
  straight to the burned field.

## When a Claude Code instance finishes ✦

Flaude reacts whenever **any** of your Claude Code sessions finishes a turn:

- **It flashes.** On first launch Flaude adds a tiny `Stop` hook to
  `~/.claude/settings.json` that writes a signal file; any running Flaude watches
  it and flashes a colored border + "✦ a Claude finished ✦" banner. (The hook is
  added once, idempotently, and leaves your existing hooks untouched.)
- **It plays a sound.** Your finish sound is whatever `~/.claude/play-sound.sh`
  plays on `stop` (a cymbal, by default). Customize it from inside Flaude:

  ```
  /sound                       show the current finish sound
  /sound /path/to/effect.mp3   set it (drag an mp3 into the prompt — the path
                               pastes in — then hit enter; Flaude copies it and
                               wires it up)
  /sound test                  hear it + see the flash right now
  ```

  Flaude copies your file into `~/.claude/` and points the existing sound hook at
  it, so it survives across sessions. `afplay` handles mp3/wav/aiff/m4a.

## Voice 🎙️ (Wispr-style)

In the console and CUSTOM you can **type or speak**. Press `` ` `` (backtick) to
start dictating, press it again to stop — Flaude records the mic, transcribes it
locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp), and drops
the text into the input.

Voice is auto-detected and entirely optional. It needs `ffmpeg`, the
`whisper-cli` binary (`brew install whisper-cpp`), and a model file. Flaude looks
for one at `~/.flaude/models/ggml-base.en.bin` or wherever `FLAUDE_WHISPER_MODEL`
points:

```bash
# grab a model once:
curl -L -o ~/.flaude/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

When no model is found the backtick is simply inert and no voice hint is shown.

## What you need

- **Node 18+** and a truecolor terminal — required.
- **ffmpeg** (`brew install ffmpeg`) — for PORTAL's music reactivity and voice.
- **`claude` CLI** — for chatting with Flo and for CUSTOM.
- **whisper-cli + a model** — for voice (optional).

No npm dependencies — every pixel is hand-rolled.

## How it works

Flaude is a small pluggable runtime:

- **`flaude.js`** — the entry point: argument parsing, terminal lifecycle, the
  audio engine (with a tiny built-in FFT), the field renderer that powers PORTAL,
  config/palettes, and the `core` object handed to each experience.
- **`lib/visuals.js`** — pure, stateless rendering helpers shared by everything:
  the palette wardrobe, animated gradient text, a per-pixel **half-block**
  renderer, and a z-buffered `PixelBuffer` for 3D.
- **`lib/console.js`** — the home console: Flo, the shader backdrop, the chat,
  and the slash-command palette.
- **`lib/orbit.js`, `lib/fireworks.js`, `lib/boids.js`, `lib/sand.js`,
  `lib/custom.js`** — the pluggable experiences. Each exports
  `{ name, blurb, color, audio, create(core) }`; the runtime gives them a frame
  loop and routes keys.

Core techniques: **half-block rendering** (each cell prints `▀` with the top
pixel as foreground and the bottom as background, doubling vertical resolution),
**diffed output** (color escapes emitted only when they change; the frame
overwrites in place, so no flicker), and **frame-counter time** so motion never
jitters.

### Writing your own shader

A shader is a `{ name, palette, field, glow }` object — either a built-in in
`flaude.js` or a file in `~/.flaude/shaders/`:

```js
module.exports = {
  name: 'my-shader',
  palette: [[8, 0, 28], [120, 20, 210], [255, 92, 220], [236, 224, 255]],
  field(x, y, t) {            // world coords x,y (~ -3..6), time t; return 0..1
    return Math.sin(x + t) * Math.cos(y - t) * 0.5 + 0.5;
  },
  glow(f) { return 0.65 + 0.6 * f * f; },
};
```

Drop it in `~/.flaude/shaders/` and it joins the PORTAL cycle — or just let
CUSTOM write one for you.

## License

MIT
