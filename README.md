# Flaude ✦

An interactive creative terminal. Pure ANSI truecolor, no npm dependencies. You
land in a console with a drifting shader and **Flo**, a little spark companion,
then use slash-commands to jump into experiences. Inspired by the animation when
you hover *ultra* effort in Claude Code.

## Run it

Needs Node 18+ and a truecolor terminal (ghostty, iTerm2, kitty, Windows Terminal).

```bash
node flaude.js      # or: npm link, then `flaude` anywhere
```

## What's inside

- `flaude.js`, `bin/flaude` — the runtime, audio engine, and field renderer.
- `lib/` — the console plus experiences: PORTAL shaders, orbit, fireworks,
  boids, sand, and a Claude-written custom-shader mode.
- `lib/visuals.js` — shared rendering: palettes, gradient text, half-block + 3D.
- `lib/warmth.swift` — optional Swift display-warming helper.

Type `/` in the console for the command palette. `esc` exits any experience.

## License

MIT
