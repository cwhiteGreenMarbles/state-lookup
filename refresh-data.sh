#!/usr/bin/env bash
# refresh-data.sh — pull the newest US Census TIGER state boundaries, rebuild the
# GeoJSON tiers and binary runtime artifacts, and run the full validation suite.
#
# TIGER releases annually (~September). Run this yearly (or whenever), review the
# diff, commit, and republish the layer.
#
# Usage:
#   ./refresh-data.sh            # auto-detect newest vintage on the Census server
#   ./refresh-data.sh 2025       # force a specific vintage
set -euo pipefail
cd "$(dirname "$0")"

# --- 1. pick the vintage ---
YEAR="${1:-}"
if [ -z "$YEAR" ]; then
  THIS_YEAR=$(date +%Y)
  for y in $(seq "$THIS_YEAR" -1 2020); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -I \
      "https://www2.census.gov/geo/tiger/TIGER${y}/STATE/tl_${y}_us_state.zip" || echo 000)
    if [ "$code" = "200" ]; then YEAR="$y"; break; fi
  done
  [ -n "$YEAR" ] || { echo "ERROR: could not find any TIGER vintage on the Census server" >&2; exit 1; }
fi
echo "==> using TIGER${YEAR}"

# --- 2. download + unzip (skip if already present) ---
ZIP="tl_${YEAR}_us_state.zip"
if [ ! -f "$ZIP" ]; then
  echo "==> downloading $ZIP"
  curl -sS --fail --max-time 300 -o "$ZIP" \
    "https://www2.census.gov/geo/tiger/TIGER${YEAR}/STATE/tl_${YEAR}_us_state.zip"
fi
unzip -o "$ZIP" >/dev/null

# --- 3. rebuild GeoJSON tiers + binary runtime artifacts ---
echo "==> building GeoJSON tiers (data/)"
node build-boundaries.js --shp "./tl_${YEAR}_us_state.shp" --out ./data --coarse 1

echo "==> building binary runtime artifacts (layer/geo/)"
node build-binary.js

# --- 4. validate ---
echo "==> smoke test"
node test.js

echo "==> full validation (multi-region equivalence + regression assertions)"
node validate-binary.js

# --- 5. external sweep: Census Gazetteer places (~32k labeled points, every state + DC + PR) ---
# Prefer the gazetteer vintage matching the TIGER year; walk back if not published yet.
GAZ_YEAR=""
for gy in "$YEAR" $(seq $((YEAR - 1)) -1 $((YEAR - 3))); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -I \
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${gy}_Gazetteer/${gy}_Gaz_place_national.zip" || echo 000)
  if [ "$code" = "200" ]; then GAZ_YEAR="$gy"; break; fi
done
if [ -n "$GAZ_YEAR" ]; then
  GAZ_ZIP="${GAZ_YEAR}_Gaz_place_national.zip"
  if [ ! -f "$GAZ_ZIP" ]; then
    echo "==> downloading Gazetteer ${GAZ_YEAR}"
    curl -sS --fail --max-time 120 -o "$GAZ_ZIP" \
      "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${GAZ_YEAR}_Gazetteer/${GAZ_ZIP}"
  fi
  unzip -o "$GAZ_ZIP" >/dev/null
  echo "==> gazetteer sweep (${GAZ_YEAR}, all states + DC + PR)"
  node scripts/validate-gazetteer.js "./${GAZ_YEAR}_Gaz_place_national.txt"
else
  echo "WARNING: no Census Gazetteer vintage found — skipping external sweep" >&2
fi

# --- 6. remove superseded vintages ---
for f in tl_*_us_state.*; do
  case "$f" in tl_${YEAR}_us_state.*) ;; *) rm -f "$f" ;; esac
done
if [ -n "$GAZ_YEAR" ]; then
  for f in *_Gaz_place_national.*; do
    case "$f" in ${GAZ_YEAR}_Gaz_place_national.*) ;; *) rm -f "$f" ;; esac
  done
fi

echo ""
echo "==> DONE. TIGER${YEAR} data built and validated."
echo "    Review 'git status' (data/states-coarse.geojson content changes),"
echo "    update vintage references if the year changed (package.json, README.md,"
echo "    build-boundaries.js), commit, and republish the layer."
