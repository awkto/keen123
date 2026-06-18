# Roadmap

## Path 1 — js-dos baseline ✅ (current, on `main`)

Real DOS binaries under DOSBox-WASM, fully client-side.

- [x] M0 — Keen 1 shareware playable from a prebuilt `.jsdos` bundle
- [x] M0 — Drag-drop / file-picker → in-browser `.jsdos` bundle for Keen 2/3 (and full Keen 1)
- [x] M0 — Static site, deployable to GitHub Pages
- [x] Save-game persistence across reloads (js-dos `autoSave` + IndexedDB, keyed per episode)
- [x] Settings panel: aspect ratio (As-is/1:1/5:4/4:3/16:10/16:9/Fit) + crisp/smooth pixels
- [x] Mobile/touch on-screen controls (joystick + Jump/Pogo/Shoot, vertical split layout)
- [x] Server/kiosk mode: mount a data dir, auto-detect episodes, hide the upload UI
- [ ] Per-game cycles tuning in the settings panel
- [ ] Optional cross-origin isolation (COOP/COEP via service worker) to enable
      SharedArrayBuffer on GitHub Pages for smoother audio/perf

## Path 2 — native engine → WebAssembly (planned, separate branch)

Compile a native reimplementation of the **Vorticons** engine to WebAssembly with Emscripten —
most likely [Commander Genius](https://github.com/gerstrong/Commander-Genius) (CG/Vorticons), an
actively maintained open-source engine that plays Keen 1/2/3 (and Dreams/Galaxy) data. This is a
*native-web* build: no DOS-emulation layer, so we get crisp integer scaling, clean fullscreen,
remappable keyboard/gamepad, and room for modern niceties.

> **License note:** Commander Genius is **GPL-2.0**. A publicly hosted WASM build is a derivative
> work, so its (modified) source must be published. The branch will carry the GPL accordingly.

Planned work (to live on branch `path2-cg-wasm`):

- [ ] M1 — Build Commander Genius natively against Keen 1 shareware data; confirm it runs
- [ ] M2 — Emscripten toolchain (emsdk); compile to WASM (SDL2 → WebGL2)
- [ ] M3 — Runtime asset loading: file picker → MEMFS at the engine's expected paths → start episode
      (reuse the same BYO-data UX as Path 1; preload shareware for a zero-config demo)
- [ ] M4 — Persistence: mount **IDBFS** for saves/config, `FS.syncfs()` after writes
- [ ] M5 — Audio gated behind a user gesture (autoplay policy)
- [ ] M6 — Input polish (keyboard + gamepad), integer scaling, fullscreen, optional touch

### Stretch (Path 2)
- [ ] True "see-more" widescreen — widen the viewport and fix HUD/camera/sprite-activation so the
      wider view isn't full of pop-in. Experimental, per-level gotchas.
