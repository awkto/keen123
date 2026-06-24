/*
 * Commander Keen 1/2/3 launcher (js-dos baseline) — "Console" UI.
 *
 * Keen 1/2/3 use the original "Invasion of the Vorticons" engine, whose data
 * layout differs from the Galaxy games (4/5/6): instead of three combined files
 * (AUDIO/EGAGRAPH/GAMEMAPS) each episode ships many files — EGAHEAD.CKx,
 * EGALATCH.CKx, EGASPRIT.CKx, LEVELxx.CKx, SOUNDS.CKx, … plus KEENx.EXE.
 *
 * - Keen 1 shareware ships as a prebuilt bundle (games/keen1.jsdos), playable
 *   instantly. Keen 2/3 (and full Keen 1): the user supplies their own data
 *   files, assembled into a .jsdos bundle entirely in the browser (no upload).
 * - Saves are per-episode (keen1/keen2/keen3), in our own IndexedDB. An optional
 *   server backend keeps a per-episode copy (sync v2: 3-way state per episode).
 *
 * Wrapped in an IIFE: js-dos.js declares globals (including `var $`), so we keep
 * our own top-level names ($ , launch, DOSBOX_CONF, …) out of global scope.
 */

(function () {
"use strict";

// dosbox.conf used for user-supplied bundles. __RUNCMD__ is replaced with the
// detected game executable. Kept in sync with games/keen1.jsdos's config.
const DOSBOX_CONF = `[sdl]
autolock=false
fullscreen=false
output=surface
mapperfile=mapper-jsdos.map
usescancodes=true
[dosbox]
machine=svga_s3
memsize=16
[cpu]
core=auto
cputype=auto
cycles=auto
cycleup=10
cycledown=20
[mixer]
nosound=false
rate=44100
blocksize=1024
prebuffer=20
[render]
frameskip=0
aspect=false
scaler=none
[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
sbmixer=true
oplmode=auto
oplemu=default
oplrate=44100
[speaker]
pcspeaker=true
pcrate=44100
[dos]
xms=true
ems=true
umb=true
keyboardlayout=auto
[autoexec]
echo off
mount c .
c:
__RUNCMD__
`;

let dosCi = null;           // running js-dos instance
let gameCi = null;          // emulator command interface (for sending key events)
let pendingBlobUrl = null;  // object URL for a built bundle, awaiting Play
let pendingFiles = null;    // [{name, data:Uint8Array}]
let pendingRunCmd = null;
let pendingKey = null;      // persistence key for the BYO episode
const launchable = {};      // key -> bundle url (server games + bundled demo) for deep-links
let currentKey = null;      // episode key of the running game (for autosave)
let savedBlobUrl = null;    // object URL of a snapshot we booted from
let saveTimer = null;       // periodic autosave interval

const $ = (id) => document.getElementById(id);

const VALID_EPISODES = [1, 2, 3];
// Each game (keen1/keen2/keen3) is one episode AND one independent sync unit.
const GAMES = ["keen1", "keen2", "keen3"];
const EPISODE_TITLES = { 1: "Marooned on Mars", 2: "The Earth Explodes", 3: "Keen Must Die!" };
const epOfKey = (k) => (String(k).match(/^keen([1-9])$/) || [])[1];
const isEpKey = (k) => /^keen[1-9]$/.test(k);

// Per-game identity used by the console UI (poster gradient, accent, hero copy).
const HERO_SUB = "INVASION OF THE VORTICONS";
const GAME_META = {
  keen1: { n: 1, title: "Marooned on Mars",  accent: "#57b6e8", free: true,
           poster: "radial-gradient(ellipse at 50% 40%, #20407a, #0c0a22 74%)",
           blurb: "Commander Keen 1 — the free shareware episode — running 100% in your browser." },
  keen2: { n: 2, title: "The Earth Explodes", accent: "#f07a7a", free: false,
           poster: "radial-gradient(ellipse at 50% 40%, #6a223a, #0c0a22 74%)",
           blurb: "Commander Keen 2 — running from your supplied game files, 100% in your browser." },
  keen3: { n: 3, title: "Keen Must Die!",     accent: "#6ee0a0", free: false,
           poster: "radial-gradient(ellipse at 50% 40%, #226a4a, #0c0a22 74%)",
           blurb: "Commander Keen 3 — supply your own game files to play, 100% in your browser." },
};

// ---- persistent saves (self-managed) ---------------------------------------
// js-dos autoSave is unreliable here, so we snapshot the emulator filesystem
// (ci.persist(false) → a standalone .jsdos bundle holding the game's saves +
// config) into our own IndexedDB, keyed per episode. We boot from that snapshot
// next time so progress is restored, and the launcher can Download/Upload/Delete
// it (portable across browsers/devices). Same approach as the zeliard build.
const SAVE_DB = "keen-saves";
const SAVE_STORE = "blobs";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SAVE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(SAVE_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveGet(key) {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).get(key);
      t.onsuccess = () => res(t.result || null); t.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
async function savePut(key, blob) {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readwrite").objectStore(SAVE_STORE).put(blob, key);
      t.onsuccess = () => res(true); t.onerror = () => res(false);
    });
  } catch (_) { return false; }
}
async function saveDelete(key) {
  try { const db = await idbOpen();
    await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readwrite").objectStore(SAVE_STORE).delete(key);
      t.onsuccess = () => res(); t.onerror = () => res();
    });
  } catch (_) {}
}
async function saveListKeys() {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).getAllKeys();
      t.onsuccess = () => res(t.result || []); t.onerror = () => res([]);
    });
  } catch (_) { return []; }
}

// Per-episode change-detector baseline (filesystem signature of the booted save).
const lastFsSig = {};

let capturing = false;
// Snapshot the running emulator's filesystem into our IndexedDB under `key`.
// Returns {changed}: true only when the game actually wrote something since the
// last snapshot (so callers can upload on real changes only). Uploading is left
// to the caller.
async function captureSave(key) {
  if (!gameCi || typeof gameCi.persist !== "function" || capturing || !key) return { changed: false };
  capturing = true;
  try {
    const u = await gameCi.persist(false);   // full standalone .jsdos bundle (cumulative-safe)
    if (!u || !u.length) return { changed: false };
    const sig = fsSignature(u);
    if (sig === lastFsSig[key]) return { changed: false };   // nothing new written to disk
    await savePut(key, new Blob([u], { type: "application/octet-stream" }));
    setLocalModified(key, Date.now());
    lastFsSig[key] = sig;
    return { changed: true };
  } catch (e) { console.warn("captureSave failed for", key, e); return { changed: false }; }
  finally { capturing = false; }
}

// ---- server-side save sync (container deployments) -------------------------
// Optional: when the site is served by the container (not a static host such as
// GitHub Pages), a tiny API (docker/saves-api.py) keeps the save bundles on the
// server, scoped by a user-held "sync key". Saves then outlive this browser and
// can be shared across devices that use the same key. Each episode (keen1/2/3) is
// its own server slot. Presence is detected by probing /api/health; the whole
// feature stays hidden when that 404s.
let serverMode = false;
// Sync target. Same-origin by default (web container). A build can point it at a
// remote server by setting window.ZELIARD_SYNC_BASE (the APK does this via
// js/sync-config.js, so the packaged app can still reach a real server).
const SYNC_RAW = (window.ZELIARD_SYNC_BASE || "").trim();
const SYNC_BASE = SYNC_RAW ? SYNC_RAW.replace(/\/+$/, "") + "/" : "";
const apiUrl = (p) => new URL("api/" + p, SYNC_BASE || document.baseURI).href;

// PER-GAME sync model. Each game (keen1/keen2/keen3) carries its OWN 4-char sync
// key, its OWN on/off flag (default off — opt-in), and its OWN server slot. The
// server is reused unchanged: X-Client-Id = that game's key, slot = "auto". The
// IndexedDB save blob is stored under the game id (keen1/2/3) as before.
const SERVER_SLOT = "auto";

// A short, easy-to-type key (4 chars). Copy it to another device — or type one
// in here — to share that ONE game's saves. (Legacy longer keys still validate.)
function makeSyncId() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // no I/O/0/1 — avoid confusion
  const r = new Uint8Array(4);
  (window.crypto || crypto).getRandomValues(r);
  let s = "";
  for (let i = 0; i < 4; i++) s += A[r[i] % A.length];
  return s;   // e.g. K7QF
}
// This game's own key (generated on first read so each game has a stable key).
function getSyncId(g) {
  const slot = "keen.syncId." + g;
  let id = localStorage.getItem(slot);
  if (!id) { id = makeSyncId(); localStorage.setItem(slot, id); }
  return id;
}
function normalizeSyncId(v) {
  const clean = (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 4 || clean.length > 32) return null;     // also accepts legacy 16-char keys
  return clean.length > 4 ? clean.replace(/(.{4})(?=.)/g, "$1-") : clean;
}
function setSyncId(g, v) {
  const id = normalizeSyncId(v);
  if (id) localStorage.setItem("keen.syncId." + g, id);
  return id;
}

// Opt-in PER GAME: sync is OFF for a game until the user enables it for that game,
// so installing/launching never auto-touches a save and other games are untouched.
const syncEnabled = (g) => localStorage.getItem("keen.sync." + g) === "on";
const setSyncEnabled = (g, on) => localStorage.setItem("keen.sync." + g, on ? "on" : "off");

// Two client-clock (epoch-ms) stamps per game give a real 3-way state so we
// never silently clobber: `modified.<g>` bumps whenever that game's local save
// actually changes; `synced.<g>` records the value at the last successful
// push/pull. Versus the server's stamp:
//   local dirty  = modified > synced       server ahead = server.modified > synced
//   both true    = diverged (must ask)     neither      = in sync
const localModified = (key) => parseInt(localStorage.getItem("keen.save.modified." + key) || "0", 10) || 0;
const setLocalModified = (key, ms) => localStorage.setItem("keen.save.modified." + key, String(ms || Date.now()));
const lastSynced = (key) => parseInt(localStorage.getItem("keen.save.synced." + key) || "0", 10) || 0;
function markSynced(key, ms) {   // local now equals server: clean
  localStorage.setItem("keen.save.modified." + key, String(ms));
  localStorage.setItem("keen.save.synced." + key, String(ms));
}

// A stable signature of the emulator filesystem CONTENTS (not the zip wrapper,
// which isn't byte-stable across re-saves). Unzips the persist bundle and samples
// each file's bytes, so it changes only when the game actually writes a save.
function fsSignature(zipU8) {
  try {
    const files = fflate.unzipSync(zipU8);
    let h = 2166136261 >>> 0;
    for (const name of Object.keys(files).sort()) {
      for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
      const b = files[name]; h = Math.imul(h ^ b.length, 16777619);
      const step = Math.max(1, (b.length / 1024) | 0);
      for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 16777619);
    }
    return (h >>> 0).toString(36);
  } catch (_) { return "z" + zipU8.length; }
}

async function detectServerMode() {
  try { const r = await fetch(apiUrl("health"), { cache: "no-store" }); serverMode = r.ok; }
  catch (_) { serverMode = false; }
  return serverMode;
}

const fmtKB = (n) => Math.round(n / 1024) + " KB";

// One game's server save meta {modified,size} (slot "auto" under that game's key),
// or null if none / unreachable.
async function fetchServerSlot(g) {
  try {
    const r = await fetch(apiUrl("saves"), { headers: { "X-Client-Id": getSyncId(g) }, cache: "no-store" });
    if (!r.ok) return null;
    const list = await r.json();
    const meta = (list || []).find((s) => s.slot === SERVER_SLOT);
    return meta || null;
  } catch (_) { return null; }
}

// Classify one game: off / empty / local-only / server-only / in-sync /
// local-dirty / server-new / diverged. `remoteMeta` is the game's server meta.
async function syncStateForGame(g, remoteMeta) {
  if (!serverMode) return { state: "no-server" };
  if (!syncEnabled(g)) return { state: "off" };
  const remote = remoteMeta || null;
  const blob = await saveGet(g);
  const haveLocal = !!(blob && blob.size);
  const base = lastSynced(g);
  const localDirty = haveLocal && localModified(g) > base;
  const serverNew = !!remote && remote.modified > base;
  let state;
  if (!remote && !haveLocal) state = "empty";
  else if (!remote) state = "local-only";
  else if (!haveLocal) state = "server-only";
  else if (localDirty && serverNew) state = "diverged";
  else if (serverNew) state = "server-new";
  else if (localDirty) state = "local-dirty";
  else state = "in-sync";
  return { state, remote, haveLocal, blob };
}

// Upload one game's local save to that game's key (slot "auto"); marks it synced.
async function pushSave(g) {
  if (!serverMode || !syncEnabled(g) || !g) return false;
  const blob = await saveGet(g);
  if (!blob || !blob.size) return false;
  const modified = localModified(g) || Date.now();
  try {
    const r = await fetch(apiUrl("saves/" + SERVER_SLOT), {
      method: "PUT",
      headers: { "X-Client-Id": getSyncId(g), "X-Save-Modified": String(modified) },
      body: blob,
    });
    if (r.ok) { markSynced(g, modified); return true; }
  } catch (_) {}
  return false;
}

// Download one game's server save (slot "auto" under that game's key) into this
// browser; marks it synced. Returns bytes.
async function pullFromServer(g, modified) {
  try {
    const r = await fetch(apiUrl("saves/" + SERVER_SLOT), { headers: { "X-Client-Id": getSyncId(g) }, cache: "no-store" });
    if (!r.ok) return 0;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) return 0;
    await savePut(g, new Blob([buf], { type: "application/octet-stream" }));
    markSynced(g, modified || Date.now());
    lastFsSig[g] = fsSignature(buf);   // baseline = the just-pulled content
    return buf.length;
  } catch (_) { return 0; }
}

// On launch, for each game with sync ON, auto-download a newer server save — but
// ONLY when safe (this device has no unsynced changes of its own for that game).
// Divergence is left for the Play prompt so nothing is silently overwritten.
async function autoSyncOnStart() {
  if (!serverMode) { return; }
  for (const g of GAMES) {
    if (!syncEnabled(g)) continue;
    const meta = await fetchServerSlot(g);
    const s = await syncStateForGame(g, meta);
    if ((s.state === "server-new" || s.state === "server-only") && s.remote) {
      await pullFromServer(g, s.remote.modified);
    }
  }
  await refreshSavesUI();
  refreshCloudUI();
}

function flashBtn(btn, text) {
  if (!btn) return;
  const orig = btn.textContent; btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

function setSyncStatus(msg) {
  const s = $("cloud-status"); if (s) s.textContent = msg;
}

// Status text for ONE game's sync state.
function gameStatusText(s) {
  switch (s.state) {
    case "diverged":    return { label: "Needs a choice", warn: true, text: "⚠ This device and the server have both changed — you'll choose on Play." };
    case "server-new":
    case "server-only": return { label: "Cloud is newer", warn: true, text: "⬇ The server has a newer save — it downloads when you start (or on Play)." };
    case "local-dirty":
    case "local-only":  return { label: "Unsynced",       warn: true, text: "⬆ This device has changes not yet uploaded — they upload as you play and on exit." };
    case "in-sync":     return { label: "Synced",          warn: false, text: "✓ In sync with the server." };
    case "empty":       return { label: "Sync on",         warn: false, text: "Sync on — no save yet; it uploads after you play." };
    case "off":         return { label: "Local only",      warn: false, text: "Server sync is off for this game — its save stays in this browser only." };
    default:            return { label: "",                warn: false, text: "" };
  }
}

// Top-bar pill reflects the CURRENTLY SELECTED game.
function syncPill(s) {
  const pill = $("sync-pill"), txt = $("sync-pill-text");
  if (!pill || !txt) return;
  if (!serverMode || !s || s.state === "off" || s.state === "no-server") { pill.hidden = true; return; }
  const st = gameStatusText(s);
  txt.textContent = st.label || "Synced";
  pill.classList.toggle("warn", !!st.warn);
  pill.hidden = false;
}

// Repaint the Sync card + game-tab chips + top pill for the SELECTED game.
async function refreshCloudUI() {
  paintGameTabChips();   // each tab's Synced/Local-only chip (cheap, no fetch)
  if (!serverMode) { syncPill(null); return; }
  const g = currentGame();
  const meta = syncEnabled(g) ? await fetchServerSlot(g) : null;
  const s = await syncStateForGame(g, meta);
  paintSyncCard(g, s, meta);
  syncPill(s);
}

// ----- "Link" another device for ONE game. If BOTH that game's cloud key and
// this browser have a save, the per-game conflict modal opens; else syncs silently. -----
let pendingLink = null;        // { g, id, remote } awaiting the conflict choice
let conflictChoice = "cloud";

function closeConflict() { const m = $("conflict-modal"); if (m) m.hidden = true; pendingLink = null; }

function paintConflict() {
  const tc = $("tile-cloud"), tl = $("tile-local"), btn = $("conflict-confirm");
  if (tc) tc.classList.toggle("sel", conflictChoice === "cloud");
  if (tl) tl.classList.toggle("sel", conflictChoice === "local");
  if (btn) btn.textContent = conflictChoice === "cloud" ? "Keep cloud save" : "Keep this browser";
}

async function linkToKey(g, rawKey) {
  const id = setSyncId(g, rawKey);
  if (!id) { alert("Enter a sync key (4+ characters, e.g. K7QF)."); return; }
  if ($("sync-id-input")) $("sync-id-input").value = "";
  if ($("link-row")) $("link-row").hidden = true;
  setSyncEnabled(g, true);
  const t = $("set-sync"); if (t && g === currentGame()) t.checked = true;
  // A new key starts a fresh comparison for THIS game only.
  localStorage.removeItem("keen.save.synced." + g);

  const remote = await fetchServerSlot(g);
  const blob = await saveGet(g);
  const haveLocal = !!(blob && blob.size);
  const meta = GAME_META[g];

  if (remote && haveLocal) {
    // Both sides have a save for THIS game — ask which to keep.
    pendingLink = { g, id, remote };
    conflictChoice = "cloud";
    if ($("conflict-key")) $("conflict-key").textContent = id;
    if ($("conflict-game-name")) $("conflict-game-name").textContent = "Keen " + meta.n;
    if ($("conflict-game-text")) $("conflict-game-text").textContent = `Keen ${meta.n} — ${meta.title}`;
    const badge = $("conflict-game-badge"); if (badge) badge.style.setProperty("--game-accent", meta.accent);
    if ($("tile-cloud-size")) $("tile-cloud-size").textContent = fmtKB(remote.size || 0);
    if ($("tile-local-size")) $("tile-local-size").textContent = fmtKB(blob.size || 0);
    if ($("tile-cloud-desc")) $("tile-cloud-desc").textContent = `From the server. Downloads & replaces this browser's Keen ${meta.n} save.`;
    if ($("tile-local-desc")) $("tile-local-desc").textContent = `Your local save. Uploads & replaces Keen ${meta.n}'s cloud copy.`;
    paintConflict();
    $("conflict-modal").hidden = false;
    return;
  }
  // Only one side has a save → sync silently in the obvious direction.
  if (remote) {
    await pullFromServer(g, remote.modified);
    await refreshSavesUI(); await refreshCloudUI();
    setSyncStatus(`✓ Linked Keen ${meta.n} to ${id} — downloaded the cloud save. Press ▶ Play.`);
  } else if (haveLocal) {
    setLocalModified(g, Date.now()); await pushSave(g);
    await refreshSavesUI(); await refreshCloudUI();
    setSyncStatus(`✓ Linked Keen ${meta.n} to ${id} — uploaded this device's save.`);
  } else {
    await refreshCloudUI();
    setSyncStatus(`Linked Keen ${meta.n} to key ${id}. No save here or on the server yet — play to create one.`);
  }
}

async function confirmConflict() {
  const link = pendingLink;
  closeConflict();
  if (!link) return;
  const { g, remote } = link;
  if (conflictChoice === "cloud") {
    if (remote) await pullFromServer(g, remote.modified);
    await refreshSavesUI(); await refreshCloudUI();
    setSyncStatus(`✓ Cloud save downloaded for Keen ${GAME_META[g].n} — press ▶ Play to load.`);
  } else {
    setLocalModified(g, Date.now()); await pushSave(g);
    await refreshSavesUI(); await refreshCloudUI();
    setSyncStatus(`✓ This browser's Keen ${GAME_META[g].n} save was uploaded — in sync from now on.`);
  }
}

// Wire the Sync card controls (the card always reflects the SELECTED game; the
// handlers read currentGame() at click time). On a static host (no backend) the
// card stays hidden and a short explainer shows instead.
function setupCloudSync() {
  if (!serverMode) { const a = $("cloud-absent-note"); if (a) a.hidden = false; return; }
  const card = $("cloud-card");
  if (!card) return;
  card.hidden = false;

  const toggle = $("set-sync");
  if (toggle) {
    toggle.addEventListener("change", () => {
      const g = currentGame();
      setSyncEnabled(g, toggle.checked);
      if (toggle.checked) autoSyncOnStart();
      else refreshCloudUI();
    });
  }
  const copy = $("sync-copy");
  if (copy) copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(getSyncId(currentGame())); flashBtn(copy, "Copied!"); } catch (_) {}
  });
  const open = $("sync-link-open"), row = $("link-row");
  if (open && row) open.addEventListener("click", () => {
    row.hidden = !row.hidden;
    if (!row.hidden) { const i = $("sync-id-input"); if (i) i.focus(); }
  });
  const apply = $("sync-apply"), input = $("sync-id-input");
  if (apply && input) {
    apply.addEventListener("click", () => linkToKey(currentGame(), input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") linkToKey(currentGame(), input.value); });
  }
  // Per-game conflict modal: select a tile, confirm, or cancel / click the backdrop.
  const tc = $("tile-cloud"), tl = $("tile-local");
  if (tc) tc.addEventListener("click", () => { conflictChoice = "cloud"; paintConflict(); });
  if (tl) tl.addEventListener("click", () => { conflictChoice = "local"; paintConflict(); });
  const cf = $("conflict-confirm"), cx = $("conflict-cancel"), cm = $("conflict-modal");
  if (cf) cf.addEventListener("click", confirmConflict);
  if (cx) cx.addEventListener("click", closeConflict);
  if (cm) cm.addEventListener("click", (e) => { if (e.target === cm) closeConflict(); });
  const disc = $("sync-disconnect");
  if (disc) disc.addEventListener("click", () => disconnectSync(currentGame()));
  // Play-guard modal buttons + backdrop dismiss.
  const pc = $("sync-play-cloud"), pl = $("sync-play-local"), px = $("sync-play-cancel"), pm = $("sync-play-modal");
  if (pc) pc.addEventListener("click", () => playWith("cloud"));
  if (pl) pl.addEventListener("click", () => playWith("local"));
  if (px) px.addEventListener("click", hidePlayModal);
  if (pm) pm.addEventListener("click", (e) => { if (e.target === pm) hidePlayModal(); });
  // Debug hook (only with ?debug): lets a harness inspect/drive per-game sync state.
  try {
    if (/[?&#]debug/.test(location.href)) {
      window.__zsync = { syncStateForGame, fetchServerSlot, getSyncId, setSyncId, syncEnabled, setSyncEnabled,
        localModified, lastSynced, autoSyncOnStart, pushSave, pullFromServer, refreshCloudUI, disconnectSync,
        linkToKey, currentGame, selectGame };
    }
  } catch (_) {}
  refreshCloudUI();
}

// Disconnect ONE game on this device WITHOUT deleting anything: keep its local
// save, keep the cloud copy, just stop syncing it and forget that game's key.
function disconnectSync(g) {
  const id = getSyncId(g);
  const n = GAME_META[g].n;
  if (!confirm(`Stop syncing Keen ${n} on this device?\n\nIts saved game here is KEPT, and the cloud copy (key ${id}) is also KEPT — write that key down if you might reconnect. This game just disconnects and forgets the key. Your other Keen games are unaffected.`)) return;
  setSyncEnabled(g, false);
  localStorage.removeItem("keen.syncId." + g);
  localStorage.removeItem("keen.save.synced." + g);   // a future re-link starts fresh
  refreshSavesUI();
  refreshCloudUI();
}

// ---- settings (persisted in localStorage) ----------------------------------

const SETTING_DEFAULTS = { aspect: "4/3", rendering: "pixelated", touch: "auto", engine: "dosbox", filter: "off",
                           pogoRetract: "180", pogoAlt: "off" };
const getSetting = (k) => localStorage.getItem("keen." + k) || SETTING_DEFAULTS[k];
const setSetting = (k, v) => localStorage.setItem("keen." + k, v);

function touchEnabled() {
  const mode = getSetting("touch");
  if (mode === "on") return true;
  if (mode === "off") return false;
  return window.matchMedia("(pointer: coarse)").matches; // auto
}

// ---- launching -------------------------------------------------------------

// `key` scopes the IndexedDB save storage so saves persist across reloads
// (stable per episode, even when BYO bundles get fresh blob: URLs each time).
async function launch(url, key) {
  $("launcher").hidden = true;
  $("game-stage").hidden = false;
  currentKey = key;

  // Emulator engine: DOSBox (default, lighter) or DOSBox-X (adds real-time
  // save/load states). The xstate class reveals the SAVE/LOAD buttons.
  const engine = getSetting("engine") === "dosboxX" ? "dosboxX" : "dosbox";
  $("game-stage").classList.toggle("xstate", engine === "dosboxX");

  const touch = touchEnabled();
  if (touch) {
    $("game-stage").classList.add("touch");
    $("touch-controls").hidden = false;
    // Size the game pane to the chosen display aspect so the canvas fills it
    // with no black letterbox below (the freed height goes to the controls).
    const AR = { "4/3": "4 / 3", "5/4": "5 / 4", "16/10": "16 / 10", "16/9": "16 / 9",
                 "1/1": "1 / 1", "AsIs": "16 / 10", "Fit": "16 / 10" };
    $("dos").style.aspectRatio = AR[getSetting("aspect")] || "4 / 3";
  }

  // Boot from our saved snapshot for this episode if we have one (restores
  // progress); otherwise boot the supplied bundle. Baseline the change-detector
  // to the booted state so the first capture isn't a false "changed".
  let bootUrl = url;
  const saved = await saveGet(key);
  if (saved) {
    savedBlobUrl = URL.createObjectURL(saved); bootUrl = savedBlobUrl;
    try { lastFsSig[key] = fsSignature(new Uint8Array(await saved.arrayBuffer())); } catch (_) { lastFsSig[key] = null; }
  } else { lastFsSig[key] = null; }

  // Dos() boots DOSBox-WASM into #dos and loads the .jsdos bundle.
  dosCi = Dos($("dos"), {
    url: bootUrl,
    key,
    // Load the emulator engine from our vendored copy (js/jsdos/emulators/) rather
    // than the js-dos CDN, so the app works fully offline (incl. inside the APK).
    pathPrefix: new URL("js/jsdos/emulators/", document.baseURI).href,
    autoStart: true,
    autoSave: false,           // we persist explicitly via captureSave()
    backend: engine,           // "dosbox" (default) or "dosboxX" (save states)
    noCloud: true,             // self-contained: no cloud account prompts
    thinSidebar: touch,        // slim the js-dos sidebar on touch (CSS hides it)
    renderAspect: getSetting("aspect"),
    imageRendering: getSetting("rendering"),
    onEvent: (event, arg) => {
      if (event === "ci-ready") {
        gameCi = arg;          // command interface for touch input + persist()
        try { if (/[?&#]debug/.test(location.href)) window.__keenCi = arg; } catch (_) {}
      }
      if (event === "error") {
        alert("js-dos error:\n\n" + arg +
          "\n\nIf you supplied your own files, double-check you selected ALL of the episode's " +
          "files — the game .EXE plus every .CK? file (EGAHEAD, EGALATCH, EGASPRIT, LEVEL*, …).");
      }
    },
  });

  // Apply the chosen visual filter and keep its overlay glued to the canvas.
  startCrtSync();
  renderCrt();
  startPogoAlt();   // desktop Alt → pogo auto-retract, if enabled in Settings

  // Light background net (60s): persist + upload ONLY when the game actually wrote
  // a save — covers the game's own in-menu saves without churning the cloud or
  // hitching gameplay. Realtime quicksaves and exit push immediately (below).
  clearInterval(saveTimer);
  saveTimer = setInterval(async () => { const r = await captureSave(key); if (r.changed) pushSave(key); }, 60000);
  // First snapshot a few seconds in, so even a very short BYO session persists
  // the uploaded game data (the timer / quit handlers might not fire in time,
  // e.g. swiping the Android app away doesn't always emit visibilitychange).
  setTimeout(async () => { const r = await captureSave(key); if (r.changed) pushSave(key); }, 5000);

  // Give the running game its own URL (#keen<ep>) so the browser Back button /
  // system back gesture quits it — this replaces the old on-screen Quit button.
  if (location.hash !== "#" + key) history.pushState({ playing: key }, "", "#" + key);
}

// Back leaves the game's #hash and fires popstate — snapshot progress (and push
// it up), then reload to tear the emulator down cleanly and return to the launcher.
window.addEventListener("popstate", async () => {
  if (!dosCi) return;
  clearInterval(saveTimer);
  const cap = await captureSave(currentKey);
  if (cap.changed || localModified(currentKey) > lastSynced(currentKey)) await pushSave(currentKey);
  location.reload();
});
// Extra safety: snapshot when the tab is hidden/backgrounded (covers closing it).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && dosCi) {
    captureSave(currentKey).then((r) => { if (r.changed || localModified(currentKey) > lastSynced(currentKey)) pushSave(currentKey); });
  }
});

// Deep-link: opening the page at #keen<ep> auto-launches that game (server games
// + the bundled demo). We normalize to the base URL first so a launcher entry
// sits behind the game and Back returns to it.
function deepLink() {
  const key = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  history.replaceState(null, "", location.pathname + location.search);
  if (key && launchable[key]) launch(launchable[key], key);
}

// ----- Play guard: never start an episode on a stale/diverged save without asking --
let pendingPlay = null;   // { key, url, state, remote }

function hidePlayModal() { const m = $("sync-play-modal"); if (m) m.hidden = true; pendingPlay = null; }

// Start a game, honouring ITS OWN sync state: silent pull when the browser is
// empty and the cloud has it, ask when behind/diverged, otherwise just play.
async function playEpisode(key, url) {
  if (serverMode && syncEnabled(key)) {
    const meta = await fetchServerSlot(key);
    const s = await syncStateForGame(key, meta);
    if (s.state === "server-only" && s.remote) {
      await pullFromServer(key, s.remote.modified);   // browser empty, cloud has it — just take it
    } else if (s.state === "server-new" || s.state === "diverged") {
      showPlayModal(key, url, s);                      // behind/diverged — ask which to play
      return;
    }
  }
  launch(url, key);
}

function showPlayModal(key, url, s) {
  const m = $("sync-play-modal"), text = $("sync-play-text");
  if (!m || !text) { launch(url, key); return; }
  pendingPlay = { key, url, state: s.state, remote: s.remote };
  const ep = epOfKey(key);
  text.textContent = s.state === "diverged"
    ? `This device and the server have each changed the Keen ${ep} save since they last matched. Pick which to play — the other is overwritten permanently. (Or Cancel and use “Stop syncing this game” to keep both.)`
    : `The server has a newer Keen ${ep} save than this device${s.remote ? " (" + fmtKB(s.remote.size) + ")" : ""}. Pick which to play — the other is overwritten permanently. (Or Cancel and use “Stop syncing this game” to keep both.)`;
  m.hidden = false;
}

async function playWith(which) {
  const p = pendingPlay;
  hidePlayModal();
  if (!p) return;
  if (which === "cloud" && p.remote) await pullFromServer(p.key, p.remote.modified);
  else if (which === "local") { setLocalModified(p.key, Date.now()); await pushSave(p.key); }
  launch(p.url, p.key);
}

// ---- user-supplied data -> .jsdos bundle -----------------------------------

// Vorticons episodes need the whole file set, so we bundle every file the user
// drops. These three are the signature files we require to consider a drop valid.
const REQUIRED = {
  egahead: /^EGAHEAD\.CK[123]$/,
  egalatch: /^EGALATCH\.CK[123]$/,
  egasprit: /^EGASPRIT\.CK[123]$/,
};

async function handleFiles(fileList) {
  const status = $("file-status");
  status.hidden = false;
  $("play-byo").disabled = true;
  pendingFiles = null;

  const files = [];
  for (const f of fileList) {
    const name = f.name.toUpperCase();
    files.push({ name, data: new Uint8Array(await f.arrayBuffer()) });
  }

  const names = files.map((f) => f.name);
  const has = (re) => names.some((n) => re.test(n));
  const exe = files.find((f) => /\.EXE$/.test(f.name) && /KEEN/.test(f.name))
           || files.find((f) => /\.EXE$/.test(f.name));

  // Which episode? Derive from any CKx extension present.
  const epMatch = names.map((n) => n.match(/\.CK([123])$/)).find(Boolean);
  const episode = epMatch ? epMatch[1] : null;

  const checks = [
    [has(REQUIRED.egahead), "EGAHEAD.CK" + (episode || "?")],
    [has(REQUIRED.egalatch), "EGALATCH.CK" + (episode || "?")],
    [has(REQUIRED.egasprit), "EGASPRIT.CK" + (episode || "?")],
    [!!exe, "game .EXE"],
  ];

  const levelCount = names.filter((n) => /^LEVEL\d+\.CK[123]$/.test(n)).length;

  const rows = checks
    .map(([ok, label]) => `<div class="${ok ? "ok" : "miss"}">${ok ? "✓" : "✗"} ${label}</div>`)
    .join("");

  const allOk = checks.every(([ok]) => ok);
  let extra = "";
  if (allOk && levelCount === 0) {
    extra = `<div class="miss" style="margin-top:.5rem">⚠ No LEVEL*.CK${episode} files found — the game won't have any levels. Make sure you selected every file in the episode's folder.</div>`;
  }
  status.innerHTML = `<div><strong>Selected ${files.length} file(s)` +
    (episode ? ` — detected Keen ${episode}` : "") +
    (levelCount ? `, ${levelCount} level(s)` : "") + `:</strong></div>` + rows + extra;

  if (allOk) {
    pendingFiles = files;
    pendingRunCmd = exe.name;
    pendingKey = "keen" + (episode || "x");
    $("play-byo").disabled = false;
  }
}

function buildBundleBlob(files, runCmd) {
  const conf = DOSBOX_CONF.replace("__RUNCMD__", runCmd);
  const tree = {
    ".jsdos/dosbox.conf": fflate.strToU8(conf),
    "dosbox.conf": fflate.strToU8("[cpu]\ncycles=auto\n"),
  };
  // Bundle every file the user provided (Vorticons needs the full set).
  for (const f of files) tree[f.name] = f.data;
  const zipped = fflate.zipSync(tree, { level: 6 });
  return new Blob([zipped], { type: "application/octet-stream" });
}

function playByo() {
  if (!pendingFiles) return;
  const blob = buildBundleBlob(pendingFiles, pendingRunCmd);
  pendingBlobUrl = URL.createObjectURL(blob);
  // Persist the uploaded game data right away (keyed per episode) so it survives
  // even if the in-game snapshot never gets a chance to capture — e.g. on Android
  // the WebView can be frozen/killed before the autosave or quit handler runs.
  // Later captureSave() calls overwrite this with a full snapshot incl. saves.
  if (pendingKey) { savePut(pendingKey, blob); setLocalModified(pendingKey, Date.now()); }
  if ($("byo-modal")) $("byo-modal").hidden = true;
  launch(pendingBlobUrl, pendingKey);
}

// ---- touch controls --------------------------------------------------------

const activeByPointer = new Map(); // pointerId -> [keyCodes]

function sendKey(code, down) {
  if (gameCi && typeof gameCi.sendKeyEvent === "function") {
    try { gameCi.sendKeyEvent(code, down); } catch (_) {}
  }
}

function bindTouchButton(btn) {
  const keys = (btn.dataset.keys || "").split(",").map(Number).filter(Boolean);
  if (!keys.length) return;
  // Optional stagger (ms) between successive key-downs. data-keys order sets the
  // sequence. (Vorticons SHOOT = Jump+Pogo combo is left un-staggered.)
  const stagger = parseInt(btn.dataset.stagger || "0", 10) || 0;
  let timers = [];

  // Pogo auto-retract: on the POGO button, auto-release the held key(s) after the
  // configured ms (Off = hold normally). A short retract makes a held press behave
  // like a tap — the Vorticons super-bounce wants a tap, hard to time on touch.
  const isPogo = btn.classList.contains("pogo");

  const press = (e) => {
    e.preventDefault();
    // Capture the pointer so this button keeps every move/up event for the
    // whole hold — the OS can't reroute it into a long-press gesture.
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    btn.classList.add("active");
    if (e.pointerId != null) activeByPointer.set(e.pointerId, keys);
    timers.forEach(clearTimeout); timers = [];
    keys.forEach((k, i) => {
      if (stagger && i > 0) timers.push(setTimeout(() => sendKey(k, true), stagger * i));
      else sendKey(k, true);
    });
    if (isPogo) {
      const ms = parseInt(getSetting("pogoRetract"), 10);
      if (ms > 0) timers.push(setTimeout(() => keys.forEach((k) => sendKey(k, false)), ms));
    }
  };
  const release = (e) => {
    timers.forEach(clearTimeout); timers = [];
    btn.classList.remove("active");
    keys.forEach((k) => sendKey(k, false));
    if (e && e.pointerId != null) activeByPointer.delete(e.pointerId);
  };

  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
  // Kill the browser's long-press behaviours (context menu, text selection,
  // iOS callout) that otherwise fire pointercancel mid-hold and drop the keys.
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
}

// Desktop "Pogo on desktop Alt" (opt-in): while a game runs, holding the physical
// Alt key gets the same auto-retract as the touch POGO button, so a held Alt acts
// like a tapped pogo (for the super-bounce). Alt is already pogo in the emulator;
// this just applies the retract timer and stops the browser hijacking Alt.
const ALT_POGO = 342;   // GLFW left-alt (pogo in Vorticons)
let pogoAltDown = false, pogoAltTimer = null, pogoAltKeyHandler = null;
function startPogoAlt() {
  stopPogoAlt();
  if (getSetting("pogoAlt") !== "on") return;
  pogoAltKeyHandler = (e) => {
    if (e.key !== "Alt" && e.code !== "AltLeft" && e.code !== "AltRight") return;
    if (e.type === "keydown") {
      e.preventDefault();
      if (pogoAltDown) return;
      pogoAltDown = true;
      sendKey(ALT_POGO, true);
      const ms = parseInt(getSetting("pogoRetract"), 10);
      if (ms > 0) { clearTimeout(pogoAltTimer); pogoAltTimer = setTimeout(() => sendKey(ALT_POGO, false), ms); }
    } else {
      pogoAltDown = false;
      clearTimeout(pogoAltTimer);
      sendKey(ALT_POGO, false);
    }
  };
  window.addEventListener("keydown", pogoAltKeyHandler, true);
  window.addEventListener("keyup", pogoAltKeyHandler, true);
}
function stopPogoAlt() {
  if (!pogoAltKeyHandler) return;
  window.removeEventListener("keydown", pogoAltKeyHandler, true);
  window.removeEventListener("keyup", pogoAltKeyHandler, true);
  pogoAltKeyHandler = null; pogoAltDown = false; clearTimeout(pogoAltTimer);
}

// Virtual joystick -> arrow keys (8-way). Removes the dead center of a d-pad.
const ARROWS = { up: 265, down: 264, left: 263, right: 262 };
const arrowState = { up: false, down: false, left: false, right: false };

function setArrow(dir, on) {
  if (arrowState[dir] !== on) {
    arrowState[dir] = on;
    sendKey(ARROWS[dir], on);
  }
}
function clearArrows() { Object.keys(ARROWS).forEach((d) => setArrow(d, false)); }

function setupJoystick() {
  const base = $("stick");
  const knob = $("stick-knob");
  if (!base) return;
  let pid = null;

  const update = (cx, cy) => {
    const r = base.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const dx = cx - ox;
    const dy = cy - oy;
    const max = r.width / 2;
    const dist = Math.hypot(dx, dy);
    const k = Math.min(1, dist / max);
    const ang = Math.atan2(dy, dx);
    knob.style.transform = `translate(${Math.cos(ang) * k * max}px, ${Math.sin(ang) * k * max}px)`;

    const want = { up: false, down: false, left: false, right: false };
    if (dist >= max * 0.3) {               // deadzone
      let a = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360; // 0=right, 90=up
      if (a >= 22.5 && a < 67.5) { want.up = want.right = true; }
      else if (a >= 67.5 && a < 112.5) { want.up = true; }
      else if (a >= 112.5 && a < 157.5) { want.up = want.left = true; }
      else if (a >= 157.5 && a < 202.5) { want.left = true; }
      else if (a >= 202.5 && a < 247.5) { want.down = want.left = true; }
      else if (a >= 247.5 && a < 292.5) { want.down = true; }
      else if (a >= 292.5 && a < 337.5) { want.down = want.right = true; }
      else { want.right = true; }
    }
    Object.keys(ARROWS).forEach((d) => setArrow(d, want[d]));
  };
  const reset = () => { pid = null; knob.style.transform = ""; clearArrows(); };

  base.addEventListener("pointerdown", (e) => {
    e.preventDefault(); pid = e.pointerId;
    try { base.setPointerCapture(pid); } catch (_) {}
    update(e.clientX, e.clientY);
  });
  base.addEventListener("pointermove", (e) => { if (e.pointerId === pid) update(e.clientX, e.clientY); });
  base.addEventListener("pointerup", (e) => { if (e.pointerId === pid) reset(); });
  base.addEventListener("pointercancel", (e) => { if (e.pointerId === pid) reset(); });
}

// On-screen keyboard: a hidden <input> whose focus raises the device soft
// keyboard. We forward typed characters/keys to the emulator (held briefly so
// the emulator polls them). Lets you type save-game names on touch devices.
function setupKeyboard() {
  const btn = $("kbd-btn");
  const proxy = $("kbd-proxy");
  if (!btn || !proxy) return;

  const SHIFT = 340;                 // GLFW left shift
  const SPECIAL = {                  // keys that arrive as keydown (even on Android)
    Enter: 257, Backspace: 259, Tab: 258, Escape: 256,
    ArrowUp: 265, ArrowDown: 264, ArrowLeft: 263, ArrowRight: 262,
  };
  const PUNCT = { "-":45,"=":61,"[":91,"]":93,";":59,"'":39,",":44,".":46,"/":47,"\\":92,"`":96 };

  // press a key, then release it a few frames later so the emulator registers it
  const hold = (code, shift) => {
    if (shift) sendKey(SHIFT, true);
    sendKey(code, true);
    setTimeout(() => { sendKey(code, false); if (shift) sendKey(SHIFT, false); }, 50);
  };
  const typeChar = (ch) => {
    if (ch === " ") return hold(32);
    if (ch === "\n") return hold(257);
    const u = ch.toUpperCase().charCodeAt(0);
    if ((u >= 65 && u <= 90) || (u >= 48 && u <= 57)) return hold(u, ch >= "A" && ch <= "Z");
    if (PUNCT[ch] != null) return hold(PUNCT[ch]);
  };

  const toggle = (e) => {
    e.preventDefault();
    if (document.activeElement === proxy) { proxy.blur(); btn.classList.remove("active"); }
    else { proxy.value = ""; proxy.focus(); btn.classList.add("active"); }
  };
  btn.addEventListener("pointerup", toggle);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  proxy.addEventListener("blur", () => btn.classList.remove("active"));

  // Printable characters: soft keyboards fire `beforeinput` (keydown is unreliable
  // on Android — it reports keyCode 229). Keep the field empty after each char.
  proxy.addEventListener("beforeinput", (e) => {
    if (e.inputType === "insertText" && e.data) { for (const ch of e.data) typeChar(ch); }
    e.preventDefault();
    proxy.value = "";
  });
  // Enter / Backspace / arrows / Esc: these do fire keydown. stopPropagation so
  // js-dos's own key handler doesn't also process them (would double the input).
  proxy.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (SPECIAL[e.key] != null) { hold(SPECIAL[e.key]); e.preventDefault(); }
  });
  proxy.addEventListener("keyup", (e) => { e.stopPropagation(); });
  proxy.addEventListener("keypress", (e) => { e.stopPropagation(); });
}

// Emulator save states (DOSBox-X only): js-dos triggers these via a backend event.
function backendTrigger(event) {
  if (gameCi && typeof gameCi.sendBackendEvent === "function") {
    try { gameCi.sendBackendEvent({ type: "wc-trigger-event", event }); } catch (_) {}
  }
}
// Realtime save states behind a 💾 popup (DOSBox-X). Tapping 💾 opens a Save/Load
// popup; tapping either runs the emulator state action (and persists) and closes it.
function setupSaveLoad() {
  const trigger = $("saveload-btn");
  const popup = $("saveload-popup");
  const save = $("savestate-btn");
  const load = $("loadstate-btn");
  if (!trigger || !popup) return;

  const isOpen = () => popup.classList.contains("open");
  const open = () => { popup.hidden = false; popup.classList.add("open"); };
  const close = () => { popup.classList.remove("open"); popup.hidden = true; };

  trigger.addEventListener("pointerup", (e) => { e.preventDefault(); isOpen() ? close() : open(); });
  trigger.addEventListener("contextmenu", (e) => e.preventDefault());
  trigger.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  const act = (btn, fn) => {
    if (!btn) return;
    btn.addEventListener("pointerup", (e) => {
      e.preventDefault(); btn.classList.add("active"); fn();
      setTimeout(() => btn.classList.remove("active"), 200); close();
    });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  };
  // Quicksave: trigger the state, then capture + push immediately (don't wait for
  // the 60s net) so closing right after a quicksave still reaches the cloud.
  act(save, () => { backendTrigger("hand_savestate"); setTimeout(async () => { await captureSave(currentKey); await pushSave(currentKey); }, 700); });
  act(load, () => backendTrigger("hand_loadstate"));

  // Tap outside the popup/trigger to dismiss.
  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !popup.contains(e.target) && !trigger.contains(e.target)) close();
  }, true);
}

// ---- visual filters (CRT / scanlines) --------------------------------------
// Two render paths, both into a WebGL canvas sized to the game canvas:
//  • OVERLAY (default, zero-cost): a static multiplier drawn once and composited
//    via mix-blend-mode:multiply. Can't move pixels, so scanlines/mask/vignette
//    only. Pitch is locked to the EGA 320x200 grid so lines sit on game rows.
//  • SAMPLE (curved): js-dos frames can't be read directly, but captureStream
//    taps the compositor output — we feed that into a <video>, upload it as a
//    texture every frame and re-render it WARPED (real barrel curvature) with
//    scanlines/mask/vignette baked in. Our opaque canvas then covers the flat
//    original. Costs ~1 frame of display latency + 1 upload+draw per frame, only
//    while a sampling filter is selected; the emulator (worker) is unaffected.
const GAME_W = 320, GAME_H = 200;        // EGA resolution (Keen runs 320x200)
const FILTERS = {
  off:       null,
  scanlines: { type: 1, scan: 0.45, mask: 0,    vig: 0,    css: "" },
  crt:       { type: 3, scan: 0.45, mask: 0.18, vig: 0.45, css: "" },
  curved:    { sample: true, scan: 0.42, mask: 0.16, vig: 0.50, curve: 0.12, css: "" },
  rgb:       { type: 2, scan: 0,    mask: 0.22, vig: 0,    css: "" },
  soft:      { type: 1, scan: 0.30, mask: 0,    vig: 0,    css: "blur(0.6px) saturate(1.06)" },
  amber:     { type: 1, scan: 0.42, mask: 0,    vig: 0.25, css: "grayscale(1) sepia(1) hue-rotate(-18deg) saturate(3.2) brightness(1.05)" },
  green:     { type: 1, scan: 0.42, mask: 0,    vig: 0.25, css: "grayscale(1) sepia(1) hue-rotate(72deg) saturate(2.6) brightness(1.04)" },
};
let crtStop = null;     // resize/poll observer teardown
let crtGL = null;       // { gl, buf, overlay, sample, tex }
let crtRAF = 0;         // sampling render-loop handle
let crtVideo = null, crtStream = null;

const CRT_VS = `attribute vec2 aPos; varying vec2 vUv;
  void main(){ vUv = vec2(aPos.x*0.5+0.5, 1.0-(aPos.y*0.5+0.5)); gl_Position = vec4(aPos,0.0,1.0); }`;
// Overlay: outputs a multiplier (composited via mix-blend-mode:multiply).
const CRT_FS_OVERLAY = `precision highp float; varying vec2 vUv;
  uniform vec2 uGame; uniform int uFilter; uniform float uScan; uniform float uMask; uniform float uVig;
  void main(){
    vec3 m = vec3(1.0); vec2 uv = vUv;
    if (uFilter==1 || uFilter==3){ float s=sin(3.14159265*uv.y*uGame.y); m*=mix(1.0-uScan,1.0,s*s); }
    if (uFilter==2 || uFilter==3){ float ph=mod(floor(uv.x*uGame.x),3.0); vec3 t=vec3(1.0-uMask);
      if(ph<0.5)t.r=1.0; else if(ph<1.5)t.g=1.0; else t.b=1.0; m*=t; }
    if (uVig>0.0){ vec2 p=uv*2.0-1.0; m*=1.0-uVig*dot(p,p)*0.5; }
    gl_FragColor = vec4(m, 1.0);
  }`;
// Sample: warps the captured game texture (real curvature) + bakes in the CRT look.
const CRT_FS_SAMPLE = `precision highp float; varying vec2 vUv;
  uniform sampler2D uTex; uniform vec2 uGame; uniform float uScan; uniform float uMask; uniform float uVig; uniform float uCurve;
  void main(){
    vec2 p = vUv*2.0-1.0;
    p *= 1.0 + uCurve*dot(p,p);                       // barrel warp the SAMPLE coords -> pixels bend
    vec2 uv = p*0.5+0.5;
    if (uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }
    vec3 c = texture2D(uTex, uv).rgb;
    float s=sin(3.14159265*uv.y*uGame.y); c*=mix(1.0-uScan,1.0,s*s);
    float ph=mod(floor(uv.x*uGame.x),3.0); vec3 t=vec3(1.0-uMask);
    if(ph<0.5)t.r=1.0; else if(ph<1.5)t.g=1.0; else t.b=1.0; c*=t;
    c*=1.0-uVig*dot(p,p)*0.5;
    gl_FragColor = vec4(c, 1.0);
  }`;

function crtProgram(gl, fs) {
  const mk = (ty, src) => { const sh = gl.createShader(ty); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn("CRT shader:", gl.getShaderInfoLog(sh)); return null; } return sh; };
  const v = mk(gl.VERTEX_SHADER, CRT_VS), f = mk(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("CRT link:", gl.getProgramInfoLog(prog)); return null; }
  return { prog, loc: gl.getAttribLocation(prog, "aPos"), uni: {
    game: gl.getUniformLocation(prog, "uGame"), filter: gl.getUniformLocation(prog, "uFilter"),
    scan: gl.getUniformLocation(prog, "uScan"), mask: gl.getUniformLocation(prog, "uMask"),
    vig: gl.getUniformLocation(prog, "uVig"), curve: gl.getUniformLocation(prog, "uCurve"),
    tex: gl.getUniformLocation(prog, "uTex"),
  } };
}

function crtInit(canvas) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const overlay = crtProgram(gl, CRT_FS_OVERLAY), sample = crtProgram(gl, CRT_FS_SAMPLE);
  if (!overlay || !sample) return null;
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // No UNPACK_FLIP_Y: the vertex shader already flips Y (vUv.y=0 at top), so an
  // unflipped texture upload maps screen-top -> game-top correctly.
  return { gl, buf, overlay, sample, tex };
}

function crtBind(p) {
  const gl = crtGL.gl;
  gl.useProgram(p.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, crtGL.buf);
  gl.enableVertexAttribArray(p.loc);
  gl.vertexAttribPointer(p.loc, 2, gl.FLOAT, false, 0, 0);
}

// Match the overlay canvas to the game canvas (CSS box + backing at full DPR).
function crtSize(cv, game) {
  const r = game.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  cv.style.left = r.left + "px"; cv.style.top = r.top + "px";
  cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }   // resize keeps the GL context/resources
  return { w, h };
}

function crtStopSample() {
  if (crtRAF) { cancelAnimationFrame(crtRAF); crtRAF = 0; }
  if (crtStream) { try { crtStream.getTracks().forEach((t) => t.stop()); } catch (_) {} crtStream = null; }
  if (crtVideo) { try { crtVideo.pause(); crtVideo.srcObject = null; } catch (_) {} crtVideo = null; }
}

function renderCrt() {
  const cv = $("crt-canvas");
  const game = document.querySelector("#dos canvas");
  if (!cv || !game) return;
  const def = FILTERS[getSetting("filter")];
  if (def && def.sample && crtRAF) return;     // sample loop already running & self-sizing
  crtStopSample();
  // Colour-shift / blur ride on the game canvas's own CSS filter.
  game.style.filter = (def && def.css) || "";
  cv.style.mixBlendMode = (def && def.sample) ? "normal" : "multiply";
  if (!def) { cv.classList.remove("on"); return; }
  const size = crtSize(cv, game);
  if (!size) return;
  if (!crtGL) crtGL = crtInit(cv);
  if (!crtGL) { cv.classList.remove("on"); return; }
  const { gl } = crtGL;

  if (def.sample) { cv.classList.add("on"); startCrtSampleLoop(cv, game, def); return; }
  if (!def.type) { cv.classList.remove("on"); return; }   // CSS-only filter, no overlay

  crtBind(crtGL.overlay);
  const u = crtGL.overlay.uni;
  gl.viewport(0, 0, size.w, size.h);
  gl.uniform2f(u.game, GAME_W, GAME_H);
  gl.uniform1i(u.filter, def.type);
  gl.uniform1f(u.scan, def.scan);
  gl.uniform1f(u.mask, def.mask);
  gl.uniform1f(u.vig, def.vig);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  cv.classList.add("on");
}

// Capture the game and re-render it warped, every frame, into our (opaque) canvas
// which covers the flat original. Only used by sampling filters (curved).
function startCrtSampleLoop(cv, game, def) {
  const gl = crtGL.gl;
  try {
    crtStream = game.captureStream();
    crtVideo = document.createElement("video");
    crtVideo.muted = true; crtVideo.playsInline = true; crtVideo.srcObject = crtStream;
    crtVideo.play().catch(() => {});
  } catch (e) {
    console.warn("CRT capture failed:", e);
    cv.classList.remove("on"); cv.style.mixBlendMode = "multiply"; return;
  }
  const u = crtGL.sample.uni;
  const draw = () => {
    crtRAF = requestAnimationFrame(draw);
    if (!crtVideo || crtVideo.readyState < 2) return;
    const s = crtSize(cv, game); if (!s) return;
    crtBind(crtGL.sample);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, crtGL.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crtVideo); } catch (_) { return; }
    gl.viewport(0, 0, s.w, s.h);
    gl.uniform1i(u.tex, 0);
    gl.uniform2f(u.game, GAME_W, GAME_H);
    gl.uniform1f(u.scan, def.scan);
    gl.uniform1f(u.mask, def.mask);
    gl.uniform1f(u.vig, def.vig);
    gl.uniform1f(u.curve, def.curve);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  draw();
}

// Keep the overlay aligned as the canvas mounts (async) / resizes / fullscreens.
function startCrtSync() {
  if (crtStop) return;
  const dos = $("dos");
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(renderCrt) : null;
  if (ro && dos) ro.observe(dos);
  const onResize = () => renderCrt();
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onResize);
  let tries = 0;
  const poll = setInterval(() => {
    const c = document.querySelector("#dos canvas");
    if (c) { if (ro) ro.observe(c); renderCrt(); }
    if (c || ++tries > 25) clearInterval(poll);
  }, 200);
  crtStop = () => {
    if (ro) ro.disconnect();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("fullscreenchange", onResize);
    clearInterval(poll);
  };
}

function setupTouchControls() {
  document.querySelectorAll("#touch-controls [data-keys]").forEach(bindTouchButton);
  setupJoystick();
  setupKeyboard();
  setupSaveLoad();

  // Take over touch for the whole control pad: non-passive preventDefault stops
  // long-press selection/callout, double-tap zoom, and scroll across the pad.
  const pad = $("touch-controls");
  if (pad) {
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
    pad.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    pad.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }
  // Safety net: if a pointer is lost (window blur, etc.), release everything.
  const releaseAll = () => {
    activeByPointer.forEach((keys) => keys.forEach((k) => sendKey(k, false)));
    activeByPointer.clear();
    clearArrows();
    document.querySelectorAll("#touch-controls .active").forEach((b) => b.classList.remove("active"));
  };
  window.addEventListener("blur", releaseAll);
}

// ---- console UI state: view / game / mView ----------------------------------
// view  ∈ {play,howto,settings}  — desktop sections (game bar hidden on global)
// game  ∈ {keen1,keen2,keen3}    — the selected game (drives Play/Saves/Sync)
// mView ∈ {play,saves,sync,howto,settings} — mobile bottom tab
// A game tab is "active" only when view===play. Saves & Sync are per game;
// How-to & Settings are global.

// Games whose data the server built into a bundle (so their hero Play boots that
// bundle directly, no bring-your-own needed). Keen 1 is always playable.
const serverBundled = new Set();

const consoleEl = () => $("console");
function currentGame() {
  const g = consoleEl() ? consoleEl().dataset.game : "keen1";
  return GAMES.includes(g) ? g : "keen1";
}
function currentView()  { return consoleEl() ? consoleEl().dataset.view  || "play" : "play"; }
function currentMView() { return consoleEl() ? consoleEl().dataset.mview || "play" : "play"; }

// Switch the selected game (Play/Saves/Sync follow it). Other games untouched.
function selectGame(g) {
  if (!GAMES.includes(g)) return;
  consoleEl().dataset.game = g;
  paintGameView();
  refreshSavesUI();
  refreshCloudUI();
}
// Desktop view (Play / How to play / Settings). Selecting Play keeps the game.
function setView(view) {
  consoleEl().dataset.view = view;
  document.querySelectorAll(".nav-top").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  // keep mView roughly aligned for the bottom bar
  if (view === "howto" || view === "settings") consoleEl().dataset.mview = view;
  paintGameTabsActive();
  paintBottomTabs();
}
// Mobile bottom tab. play/saves/sync map to the Play view (game-scoped);
// howto/settings are the global views.
function setMView(mv) {
  consoleEl().dataset.mview = mv;
  consoleEl().dataset.view = (mv === "howto" || mv === "settings") ? mv : "play";
  paintGameTabsActive();
  paintBottomTabs();
  document.querySelectorAll(".nav-top").forEach((b) => b.classList.toggle("active", b.dataset.view === currentView()));
  const lbl = $("m-global-text");
  if (lbl) lbl.textContent = mv === "howto" ? "Same controls for all games" : "Global settings — apply to all games";
}
function paintGameTabsActive() {
  const onPlay = currentView() === "play";
  const g = currentGame();
  document.querySelectorAll(".game-tab").forEach((b) =>
    b.classList.toggle("active", onPlay && b.dataset.game === g));
  document.querySelectorAll(".m-game-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.game === g));
}
function paintBottomTabs() {
  const mv = currentMView();
  document.querySelectorAll(".tab-b").forEach((b) => b.classList.toggle("active", b.dataset.mview === mv));
}

// Paint the per-game identity onto the Play hero + badges + accent variable.
function paintGameView() {
  const g = currentGame(), meta = GAME_META[g];
  // accent var on the whole console so tabs/badges/poster pick it up
  if (consoleEl()) consoleEl().style.setProperty("--game-accent", meta.accent);
  const bg = $("poster-bg"); if (bg) bg.style.background = meta.poster;
  const sub = $("hero-sub"); if (sub) sub.textContent = HERO_SUB;
  const blurb = $("hero-blurb"); if (blurb) blurb.textContent = meta.blurb;
  // hero-link visibility/text is managed by refreshSavesUI (it depends on saves).
  paintGameTabsActive();
  // badges
  ["saves-badge", "sync-badge", "sync-badge-absent"].forEach((id) => {
    const el = $(id); if (el) el.textContent = "Keen " + meta.n;
  });
}

// Each game tab's Synced / Local-only chip (no network — just the on/off flag).
function paintGameTabChips() {
  document.querySelectorAll(".game-tab").forEach((b) => {
    const g = b.dataset.game, on = serverMode && syncEnabled(g);
    b.classList.toggle("synced", on);
    const txt = b.querySelector(".gt-status-text");
    if (txt) txt.textContent = on ? "Synced" : "Local only";
  });
}

// Paint the Server-sync card for one game: key, toggle, on/off blocks, device
// list, status line. `s` = its sync state, `meta` = its server slot meta (or null).
function paintSyncCard(g, s, meta) {
  const gm = GAME_META[g];
  const idEl = $("sync-id"); if (idEl) idEl.textContent = getSyncId(g);
  const on = syncEnabled(g);
  const toggle = $("set-sync"); if (toggle) toggle.checked = on;
  const onBlock = $("sync-on-block"), offBlock = $("sync-off-block"), disc = $("disconnect-note");
  if (onBlock) onBlock.hidden = !on;
  if (offBlock) offBlock.hidden = on;
  if (disc) disc.hidden = !on;
  const offNote = $("sync-off-note");
  if (offNote) offNote.textContent = `Sync is off for Keen ${gm.n} — this save stays in this browser only. Turn it on to back up and share across devices.`;
  // device list: "This device" + (when the cloud has a copy from elsewhere) a hint.
  const rows = $("device-rows");
  if (rows) {
    let html = `<div class="device-row"><span class="dot good"></span>This device<span class="dim"> · now</span></div>`;
    if (meta && meta.size) {
      const when = meta.modified ? "synced" : "";
      html += `<div class="device-row"><span class="dot"></span>Cloud key ${getSyncId(g)}<span class="dim"> · ${fmtKB(meta.size)} ${when}</span></div>`;
    }
    rows.innerHTML = html;
  }
  const st = gameStatusText(s);
  setSyncStatus(st.text || "");
}

// (Re)build the Play hero CTA (or server-games list) + the Saves card for the
// SELECTED game. Keen 1 is always playable (shareware); Keen 2/3 surface Play
// when a save/BYO bundle exists, otherwise a "load your files →" affordance.
async function refreshSavesUI() {
  paintGameView();
  paintGameTabChips();
  const g = currentGame(), meta = GAME_META[g];
  const blob = await saveGet(g);
  const size = blob ? blob.size : 0;
  const hasSave = !!(blob && blob.size);

  // --- Play hero CTA (per game) ---
  // Playable directly when: there's a local save, the game is free shareware, or
  // the server built a bundle for it. Otherwise it's bring-your-own files.
  const playBtn = $("hero-play");
  if (playBtn) {
    playBtn.hidden = false;
    playBtn.textContent = `▶ Play Keen ${meta.n} — ${meta.title}`;
    playBtn.onclick = () => {
      if (hasSave) playSave(g);
      else if (launchable[g]) playEpisode(g, launchable[g]);
      else if (meta.free) playEpisode("keen1", launchable.keen1 || "games/keen1.jsdos");
      else openByo();
    };
  }
  // "load your files →" link: shown for BYO games that aren't server-bundled.
  const heroLink = $("hero-link");
  if (heroLink) {
    if (meta.free || serverBundled.has(g)) { heroLink.hidden = true; }
    else { heroLink.hidden = false; heroLink.textContent = hasSave ? "replace your files →" : "load your files →";
           heroLink.onclick = (e) => { e.preventDefault(); openByo(); }; }
  }

  // --- Saves card (per selected game) ---
  const has = $("save-has"), empty = $("save-empty");
  if (has && empty) {
    if (hasSave) {
      has.hidden = false; empty.hidden = true;
      const szEl = $("save-size"); if (szEl) szEl.textContent = fmtKB(size);
    } else {
      has.hidden = true; empty.hidden = false;
      const et = $("save-empty-text");
      if (et) et.innerHTML = meta.free
        ? `No saved game yet for Keen ${meta.n} — play to create one, or upload a <code>.jsdos</code>.`
        : `No saved game yet for Keen ${meta.n} — load your files and play, or upload a <code>.jsdos</code>.`;
    }
  }
}

// Resume a stored episode straight from its IndexedDB snapshot — honour sync
// state first (cloud may be newer / diverged). launch() boots from the snapshot
// for this key, so the passed URL is just a placeholder for empty-browser cases.
async function playSave(key) {
  const blob = await saveGet(key);
  const url = blob ? URL.createObjectURL(blob) : (launchable[key] || "games/keen1.jsdos");
  playEpisode(key, url);
}

async function downloadSave(key) {
  const blob = await saveGet(key);
  if (!blob) return;
  // In the Android (Capacitor) WebView a programmatic <a download> silently does
  // nothing, so write the file and open the share sheet instead ("Save to Files",
  // Drive, etc.). Falls back to the normal anchor download in a real browser.
  if (await nativeSaveFile(blob, key + "-save.jsdos")) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = key + "-save.jsdos";   // a .jsdos is a zip of the save/game files
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// Save a file via Capacitor (Filesystem + Share). Returns false when not running
// natively or the plugins are unavailable, so the caller can fall back.
async function nativeSaveFile(blob, name) {
  const Cap = window.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return false;
  const Filesystem = Cap.Plugins && Cap.Plugins.Filesystem;
  const Share = Cap.Plugins && Cap.Plugins.Share;
  if (!Filesystem) return false;
  try {
    const data = await blobToBase64(blob);
    const w = await Filesystem.writeFile({ path: name, data, directory: "CACHE" });
    if (Share && w && w.uri) {
      await Share.share({ title: name, files: [w.uri], dialogTitle: "Save your Keen game file" });
    } else {
      alert("Saved to app storage as " + name + ".");
    }
    return true;
  } catch (e) { console.warn("native save failed:", e); return false; }
}

// Delete = clear THIS game's local save. Per the spec: Delete clears local +
// keeps the cloud copy intact (so it can be re-pulled). When that game is synced,
// we leave the server copy and re-baseline so it shows as "server-only" after.
async function deleteSaveUI(g) {
  const synced = serverMode && syncEnabled(g);
  const ep = GAME_META[g].n;
  const msg = synced
    ? `Delete the saved game for Keen ${ep} in this browser?\n\nThe cloud copy (key ${getSyncId(g)}) is KEPT on the server, so you can download it again later. This device just clears its local Keen ${ep} save.`
    : `Delete the saved game for Keen ${ep} in this browser? This cannot be undone.`;
  if (!confirm(msg)) return;
  await saveDelete(g);
  localStorage.removeItem("keen.save.modified." + g);
  localStorage.removeItem("keen.save.synced." + g);
  delete lastFsSig[g];
  await refreshSavesUI();
  refreshCloudUI();
}

// Import a downloaded save into a specific game. The Upload button is per game,
// so we import into the SELECTED game; we still sanity-check the file's episode
// (from the name or a .CKx inside the bundle) and warn on a mismatch.
async function importSave(file, g) {
  if (!file) return;
  g = g || currentGame();
  const buf = new Uint8Array(await file.arrayBuffer());
  let ep = (file.name.match(/keen[ _-]?([1-9])/i) || [])[1];
  if (!ep) {
    try {
      for (const n of Object.keys(fflate.unzipSync(buf))) {
        const m = n.match(/\.CK([1-9])$/i); if (m) { ep = m[1]; break; }
      }
    } catch (_) {}
  }
  ep = parseInt(ep, 10);
  const wantEp = GAME_META[g].n;
  if (VALID_EPISODES.includes(ep) && ep !== wantEp) {
    if (!confirm(`This looks like a Keen ${ep} save, but you're uploading it to Keen ${wantEp}. Import it as Keen ${wantEp} anyway?`)) return;
  }
  await savePut(g, new Blob([buf], { type: "application/octet-stream" }));
  setLocalModified(g, Date.now());
  await refreshSavesUI();
  pushSave(g); refreshCloudUI();
  alert(`Save imported for Keen ${wantEp}. It loads next time you play that game.`);
}

// ---- settings UI -----------------------------------------------------------

function setupSettings() {
  // Segmented controls (buttons) — Engine / Pixels(rendering) / Touch.
  document.querySelectorAll(".seg[data-setting]").forEach((seg) => {
    const key = seg.dataset.setting;
    const paint = () => {
      const cur = getSetting(key);
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === cur));
    };
    seg.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => { setSetting(key, b.dataset.value); paint(); });
    });
    paint();
  });
  // Native selects — Aspect / Filter / Pogo auto-retract.
  [["set-aspect", "aspect"], ["set-filter", "filter"], ["set-pogoRetract", "pogoRetract"]].forEach(([id, key]) => {
    const sel = $(id);
    if (!sel) return;
    sel.value = getSetting(key);
    sel.addEventListener("change", () => {
      setSetting(key, sel.value);
      if (key === "filter") renderCrt();   // re-draw immediately if a game is running
    });
  });
  // Toggle — Pogo on desktop Alt.
  const pa = $("set-pogoAlt");
  if (pa) {
    pa.checked = getSetting("pogoAlt") === "on";
    pa.addEventListener("change", () => setSetting("pogoAlt", pa.checked ? "on" : "off"));
  }
}

// Console routing: top-bar nav (How to play/Settings), the game tabs (desktop +
// mobile pill), and the mobile bottom tab bar. All set data-view/data-game/
// data-mview on .console; CSS reveals the matching sections.
function setupTabs() {
  const c = $("console");
  if (!c) return;
  // top-bar global nav
  document.querySelectorAll(".nav-top").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  // desktop game tabs → Play view for that game
  document.querySelectorAll(".game-tab").forEach((b) =>
    b.addEventListener("click", () => { setView("play"); selectGame(b.dataset.game); }));
  // mobile game switcher pill
  document.querySelectorAll(".m-game-tab").forEach((b) =>
    b.addEventListener("click", () => selectGame(b.dataset.game)));
  // mobile bottom tabs
  document.querySelectorAll(".tab-b").forEach((b) =>
    b.addEventListener("click", () => setMView(b.dataset.mview)));

  // initial paint
  c.dataset.view = c.dataset.view || "play";
  c.dataset.game = c.dataset.game || "keen1";
  c.dataset.mview = c.dataset.mview || "play";
  setView(c.dataset.view);
  paintGameView();
}

function openByo(e) { if (e && e.preventDefault) e.preventDefault(); const m = $("byo-modal"); if (m) m.hidden = false; }

// ---- server / kiosk mode ---------------------------------------------------

// When served from the container with a mounted data dir, an entrypoint writes
// games/manifest.json listing the available (server-built) episode bundles. In
// the multi-game console we DON'T take the page over with a separate games list:
// instead each detected game's bundle is registered in `launchable[g]`, so that
// game's normal per-game hero Play button boots the server bundle (and deep-link /
// Back routing works). Games not detected on the server stay bring-your-own.
async function setupServerMode() {
  let manifest;
  try {
    const res = await fetch("games/manifest.json", { cache: "no-store" });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (_) { return; }
  if (!manifest || !manifest.serverMode || !Array.isArray(manifest.games) || !manifest.games.length) return;

  manifest.games.forEach((g) => {
    const key = "keen" + g.episode;
    launchable[key] = g.bundle;   // per-game hero Play uses this; enables deep-link / back routing
    serverBundled.add(key);
  });
  refreshSavesUI();
}

// ---- wiring ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  // Ask the browser/Android WebView to keep our IndexedDB (saved games + uploaded
  // BYO game data) durable so it isn't evicted under storage pressure.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  // On Android (Capacitor) the app being backgrounded is the most reliable moment
  // to snapshot — visibilitychange isn't always delivered before the WebView freezes.
  try {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && App.addListener) {
      App.addListener("pause", () => { if (dosCi) captureSave(currentKey).then((r) => { if (r.changed) pushSave(currentKey); }); });
      // Hardware Back: in-game -> back to launcher; at the launcher -> exit the app.
      App.addListener("backButton", () => {
        if (location.hash && location.hash !== "#") window.history.back();
        else App.exitApp();
      });
    }
  } catch (_) {}

  setupSettings();
  setupTabs();
  setupTouchControls();

  launchable["keen1"] = "games/keen1.jsdos";   // bundled demo (overridden by server manifest if present)
  setupServerMode().then(() => { refreshSavesUI(); deepLink(); });   // deep-link after the manifest (if any)

  // Server-side save sync — only when the container backend is present (probe
  // /api/health). On static hosts (GitHub Pages) the card stays hidden.
  detectServerMode().then(() => {
    setupCloudSync();
    autoSyncOnStart();   // safe newer-server pull on launch (diverged -> asked on Play)
  });

  // Saved-game card buttons (operate on the SELECTED game, read at click time).
  const fileInput = $("save-file-input");
  const pickFile = () => fileInput && fileInput.click();
  if ($("save-upload"))   $("save-upload").addEventListener("click", pickFile);
  if ($("save-upload-2")) $("save-upload-2").addEventListener("click", pickFile);
  if ($("save-download")) $("save-download").addEventListener("click", () => downloadSave(currentGame()));
  if ($("save-delete"))   $("save-delete").addEventListener("click", () => deleteSaveUI(currentGame()));
  if (fileInput) fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = ""; importSave(f, currentGame());
  });

  $("play-byo").addEventListener("click", playByo);

  // BYO files modal open/close.
  const byoModal = $("byo-modal");
  const byoClose = $("byo-close");
  if (byoClose) byoClose.addEventListener("click", () => { byoModal.hidden = true; });
  if (byoModal) byoModal.addEventListener("click", (e) => { if (e.target === byoModal) byoModal.hidden = true; });

  const dz = $("dropzone");
  const input = $("file-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => { if (input.files.length) handleFiles(input.files); });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFiles(dt.files);
  });
});

})();
