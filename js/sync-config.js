// Server-sync target for the launcher.
//
// Web build (this file): no override — the app syncs same-origin, i.e. only when
// it is served by the container itself (and stays hidden on static hosts/Pages).
//
// The Android APK ships a different copy of this file (written by
// android/build-www.sh) that sets window.ZELIARD_SYNC_BASE to a real server, so
// the packaged app — which has no backend of its own — can still sync to it.
//
// window.ZELIARD_SYNC_BASE = "https://keen123.box.dnsif.ca/";
