# keen123 — Commander Keen 1·2·3 in the browser

Play the **Commander Keen "Invasion of the Vorticons"** trilogy (episodes 1, 2, 3)
directly in a web browser. 100% client-side — no server, nothing uploaded.

**▶ Live:** https://awkto.github.io/keen123/

## How it works

This is the **js-dos baseline** ("Path 1"): the real DOS game binaries run under
[js-dos](https://js-dos.com) (DOSBox compiled to WebAssembly), entirely in your browser tab.

- **Keen 1** — the freely-redistributable **shareware v1.31** ships with the site, so it plays
  instantly with no setup. See [`games/`](games/) for the redistribution notice.
- **Keen 2 & 3** — commercial. Buy them on
  [GOG](https://www.gog.com/game/commander_keen_complete_pack) /
  [Steam](https://store.steampowered.com/app/9180/Commander_Keen_Pack/), then **drag-and-drop
  your own data files** onto the page. They are assembled into a `.jsdos` bundle in-browser and
  never leave your machine. *(The same picker also accepts your full retail Keen 1 files.)*

### Supplying your own data (Keen 2/3, or full Keen 1)

The Vorticons games are a *folder of files*, not three combined files like the later Galaxy
games. **Select (or drop) every file in the episode's folder** — at minimum:

| File | Example (Keen 2) |
|------|------------------|
| `EGAHEAD.CK?`  | `EGAHEAD.CK2`  |
| `EGALATCH.CK?` | `EGALATCH.CK2` |
| `EGASPRIT.CK?` | `EGASPRIT.CK2` |
| `LEVEL*.CK?`   | `LEVEL01.CK2` … |
| the game `.EXE` | `KEEN2.EXE`   |

…plus the rest (`SOUNDS`, `FINALE`, `CTLPANEL`, `STORYTXT`, …). When in doubt, just select
*all* files in the folder — everything you pick is bundled.

## Controls & settings

- **Keyboard** (Keen defaults): arrows move · **Ctrl** = jump · **Alt** = pogo · **Space** = fire.
- **Touch** (phones/tablets, or force it in Settings): the screen splits — game on top, an
  on-screen joystick + Jump/Pogo/Shoot buttons on the bottom.
- **Settings** (on the launcher): aspect ratio (As-is, 1:1, 5:4, 4:3, 16:10, 16:9, Fit-to-window),
  crisp vs. smooth pixels, and the touch-controls mode (auto/on/off).
- **Saves persist** automatically in your browser (IndexedDB, per episode) and survive reloads.

### Server sync (container only)

When the site is served by the container (not a static host like GitHub Pages), an optional
**☁ Server sync** card appears. Turn it on to keep your saved games on the server too, so they
outlive the browser and can be shared across devices. Each browser gets a short 4-character **sync
key** (legacy longer keys still work); copy it to another device (or paste one in via *Link another
device*) to share the same server-side saves. Saves are tracked per episode with a 3-way state, so
nothing is silently overwritten: when both sides have saves, linking asks which set to keep, and
starting an episode whose cloud save diverges prompts which to play. **Stop syncing** disconnects
while keeping both copies. The feature is opt-in (off by default) and hidden entirely on static hosts.

Saves are stored in `SAVE_DIR` (default `/saves`) scoped by sync key — **mount a volume there**
so they survive container updates: `-v keen123-saves:/saves`.

## Project layout

```
index.html        launcher UI
css/app.css        styling
js/app.js          launch logic + in-browser .jsdos bundle builder
js/fflate.min.js   vendored zip library (assembles bundles client-side)
games/keen1.jsdos  prebuilt Keen 1 shareware bundle (redistributable)
ROADMAP.md         Path 2: Omnispeak/Commander Genius → WebAssembly (native engine port)
```

## Self-hosting with Docker

A container image is published to Docker Hub as **`awkto/keen123`** by GitHub Actions on every
`v*.*.*` tag (`:latest` tracks the newest release).

```bash
docker run -d --name keen123 --restart unless-stopped \
  -p 127.0.0.1:5024:80 \
  -v /path/to/keen-data:/data:ro \
  -v keen123-saves:/saves \
  awkto/keen123:latest
```

The `-v keen123-saves:/saves` volume keeps server-side saves (see *Server sync*) across updates.

**Server / kiosk mode:** mount a directory of your own Keen files at `/data`. On startup the
container detects each episode, builds its `.jsdos` bundle, and writes `games/manifest.json` — the
launcher then shows **only the available games** as one-click buttons and hides the upload UI.
Layout under `/data` can be flat or one subdir per episode:

```
/data/EGAHEAD.CK2 EGALATCH.CK2 EGASPRIT.CK2 LEVEL01.CK2 … KEEN2.EXE   # flat, or…
/data/keen2/EGAHEAD.CK2 EGALATCH.CK2 EGASPRIT.CK2 LEVEL01.CK2 … KEEN2.EXE
```

Keen 1 falls back to the bundled shareware if `/data` has no Keen 1. Commercial Keen 2/3 data is
never baked into the image — it only ever lives in your mounted `/data`. With no `/data`, the
container runs in normal bring-your-own-data mode.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). Short version: this js-dos build is **Path 1** (fast, authentic,
emulated). **Path 2** is a native-web engine port (e.g. [Commander Genius](https://github.com/gerstrong/Commander-Genius),
which reimplements the Vorticons engine) compiled to WebAssembly for crisp scaling, modern
controls, and no DOS-emulation layer. Path 2 will be developed on a separate branch.

## Local development

```
python3 -m http.server 8087   # then open http://127.0.0.1:8087
```
(js-dos requires `http://`, not `file://`.)

## Licensing

- **This launcher code** (everything except `games/` and `js/fflate.min.js`) is MIT — see
  [`LICENSE`](LICENSE).
- **`js/fflate.min.js`** is [fflate](https://github.com/101arrowz/fflate), MIT.
- **js-dos** is loaded from its CDN under its own (GPL) license; it is not redistributed here.
- **Commander Keen** is © id Software. Only the freely-redistributable Keen 1 shareware data is
  included. **Do not commit Keen 2/3 data to this repository.**
