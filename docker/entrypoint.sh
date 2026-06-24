#!/bin/sh
# Build .jsdos bundles + a manifest from a mounted /data dir, then serve the site.
#
# Keen 1/2/3 use the "Invasion of the Vorticons" engine: each episode is a whole
# directory of files (EGAHEAD/EGALATCH/EGASPRIT.CKx, LEVELxx.CKx, SOUNDS.CKx, …)
# plus KEENx.EXE. Mount your own Keen files at /data, flat or one subdir per
# episode. Commercial Keen 2/3 data is never baked into the image — only /data.
set -e

WEB=/usr/share/nginx/html
GAMES="$WEB/games"
DATA=/data

# build_episode <ep> <src_dir> -> writes games/keen<ep>.jsdos, returns 0 on success.
# Bundles EVERY file in the source dir (Vorticons needs the full set), not a
# fixed list — we just require the signature files + the EXE to be present.
build_episode() {
  ep="$1"; src="$2"
  head=$( find "$src" -maxdepth 1 -iname "EGAHEAD.CK$ep"  2>/dev/null | head -1)
  latch=$(find "$src" -maxdepth 1 -iname "EGALATCH.CK$ep" 2>/dev/null | head -1)
  sprit=$(find "$src" -maxdepth 1 -iname "EGASPRIT.CK$ep" 2>/dev/null | head -1)
  exe=$(  find "$src" -maxdepth 1 -iname "KEEN$ep*.EXE"   2>/dev/null | head -1)
  [ -z "$exe" ] && exe=$(find "$src" -maxdepth 1 -iname "*.EXE" 2>/dev/null | head -1)
  [ -n "$head" ] && [ -n "$latch" ] && [ -n "$sprit" ] && [ -n "$exe" ] || return 1

  work=$(mktemp -d)
  mkdir -p "$work/.jsdos"

  # Copy every regular file for this episode into the bundle root.
  for f in "$src"/*; do
    [ -f "$f" ] || continue
    cp "$f" "$work/$(basename "$f")"
  done
  exename=$(basename "$exe" | tr '[:lower:]' '[:upper:]')

  cat > "$work/.jsdos/dosbox.conf" <<CONF
[dosbox]
machine=svga_s3
memsize=16
[cpu]
core=auto
cputype=auto
cycles=auto
[mixer]
nosound=false
rate=44100
[sblaster]
sbtype=sb16
oplmode=auto
oplrate=44100
[speaker]
pcspeaker=true
[dos]
xms=true
ems=true
umb=true
[autoexec]
echo off
mount c .
c:
$exename
CONF
  printf '[cpu]\ncycles=auto\n' > "$work/dosbox.conf"

  # rm first: zip appends to an existing archive (the image ships keen1.jsdos),
  # which would corrupt the bundle when rebuilding Keen 1 from /data.
  rm -f "$GAMES/keen$ep.jsdos"
  ( cd "$work" && zip -rq -X "$GAMES/keen$ep.jsdos" . )
  rm -rf "$work"
  return 0
}

games_json=""
add_game() {
  [ -n "$games_json" ] && games_json="$games_json,"
  # Append a content hash to the bundle URL so js-dos (which caches bundles by
  # URL in IndexedDB) re-fetches whenever the data changes — otherwise returning
  # players keep running a stale cached bundle.
  h=$(md5sum "$GAMES/keen$1.jsdos" 2>/dev/null | cut -c1-8)
  games_json="$games_json{\"episode\":$1,\"bundle\":\"games/keen$1.jsdos?v=$h\"}"
}

if [ -d "$DATA" ]; then
  echo "[keen123] scanning $DATA for Keen data..."
  for ep in 1 2 3; do
    for d in "$DATA" "$DATA"/*; do
      [ -d "$d" ] || continue
      if build_episode "$ep" "$d"; then
        echo "[keen123] built Keen $ep from $d"
        add_game "$ep"
        break
      fi
    done
  done
fi

# Fall back to the bundled Keen 1 shareware if /data didn't supply Keen 1.
if [ -f "$GAMES/keen1.jsdos" ] && ! echo "$games_json" | grep -q '"episode":1'; then
  add_game 1
fi

if [ -n "$games_json" ]; then
  printf '{"serverMode":true,"games":[%s]}\n' "$games_json" > "$GAMES/manifest.json"
  echo "[keen123] manifest: $(cat "$GAMES/manifest.json")"
else
  rm -f "$GAMES/manifest.json"
  echo "[keen123] no game data found; running in bring-your-own-data mode"
fi

# Server-side save slots: a tiny API behind nginx's /api/ proxy. Saves live in
# SAVE_DIR (default /saves) — mount a volume there (`-v keen123-saves:/saves`) to
# keep them across container updates (watchtower recreates the container).
export SAVE_DIR="${SAVE_DIR:-/saves}"
mkdir -p "$SAVE_DIR"
echo "[keen123] starting saves-api (SAVE_DIR=$SAVE_DIR)"
python3 /saves-api.py &

exec nginx -g 'daemon off;'
