#!/usr/bin/env node
/*
 * build-boundaries.js  — one-off / CI preprocessing step (NOT runtime).
 *
 * Turns a US Census TIGER state shapefile into two pre-bboxed GeoJSON tiers
 * consumed by src/state-resolver.js (shipped in the Lambda layer):
 *    layer/geo/states-full.geojson    full-res (authoritative, ~21 MB)
 *    layer/geo/states-coarse.geojson  DP-simplified (~180 KB at 1%)
 *
 * Usage:
 *    node build-boundaries.js --shp ./tl_2023_us_state.shp --out ./layer/geo --coarse 1
 *
 * Requires `npx mapshaper` at build time only (never at runtime).
 *
 * Source data (authoritative, public domain):
 *    US states: https://www2.census.gov/geo/tiger/TIGER2023/STATE/tl_2023_us_state.zip
 *    Canada (optional, for the CA-> residential_data_CAN path): Statistics Canada
 *      provincial boundaries — merge in as a second input with country:"CA" (see TODO below).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; };
const SHP = arg('shp', './tl_2023_us_state.shp');
const OUT = arg('out', './layer/geo');
const COARSE_PCT = arg('coarse', '1');   // Douglas-Peucker retention % for the coarse tier

fs.mkdirSync(OUT, { recursive: true });

function mapshaper(args) {
  const r = spawnSync('npx', ['-y', 'mapshaper@0.6', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) { process.stderr.write((r.stderr || '').toString()); throw new Error('mapshaper failed'); }
}

function bboxOfCoords(coords) {
  let a = 180, b = 90, c = -180, d = -90;
  const w = x => { if (typeof x[0] === 'number') { if (x[0] < a) a = x[0]; if (x[0] > c) c = x[0]; if (x[1] < b) b = x[1]; if (x[1] > d) d = x[1]; return; } for (const y of x) w(y); };
  w(coords); return [a, b, c, d];
}
function closeRings(geom) {
  const fix = ring => { const f = ring[0], l = ring[ring.length - 1]; if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]); return ring; };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) poly[i] = fix(poly[i]);
}
function postProcess(rawPath, outPath) {
  const fc = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  for (const ft of fc.features) {
    closeRings(ft.geometry);
    ft.bbox = bboxOfCoords(ft.geometry.coordinates); // standard GeoJSON feature bbox member
  }
  fs.writeFileSync(outPath, JSON.stringify(fc));
  fs.unlinkSync(rawPath);
  return { features: fc.features.length, mb: +(fs.statSync(outPath).size / 1048576).toFixed(3) };
}

// map TIGER dbf fields (STUSPS, NAME) -> our canonical properties
const STAMP = 'this.properties={code:"US-"+STUSPS,name:NAME,country:"US"}';

const rawFull = path.join(OUT, '_raw_full.geojson');
mapshaper([SHP, '-each', STAMP, '-o', 'format=geojson', rawFull]);

const rawCoarse = path.join(OUT, '_raw_coarse.geojson');
mapshaper([SHP, '-each', STAMP, '-simplify', 'dp', COARSE_PCT + '%', 'keep-shapes', '-o', 'format=geojson', rawCoarse]);

// TODO(Canada): to cover the CA-> residential_data_CAN path, run mapshaper on the StatCan
// provincial shapefile with `this.properties={code:"CA-"+PREABBR,name:PRENAME,country:"CA"}`,
// then mapshaper -merge-layers (or concatenate FeatureCollections) before postProcess.

const full = postProcess(rawFull, path.join(OUT, 'states-full.geojson'));
const coarse = postProcess(rawCoarse, path.join(OUT, 'states-coarse.geojson'));
console.log('built states-full.geojson   ', full);
console.log('built states-coarse.geojson ', coarse, `(dp ${COARSE_PCT}%)`);
