/*
 * validate-binary.js — prove the precreated binary resolver is equivalent to the
 * GeoJSON resolver, and measure the cold-start win.
 *   - containment: must match the GeoJSON resolver's state code (target: 0 mismatch)
 *   - distance:    compare on near-border points (where the GeoJSON path also uses
 *                  full-res distance) — expect sub-km agreement
 *   - load time:   binary buffer read vs 21 MB GeoJSON parse
 */
const geo = require('./reference/state-resolver'); // GeoJSON + turf (tiered) — test-only ground truth
const bin = require('./src/binary-resolver');       // precreated binary — the runtime path

function tms(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

// --- cold-start-style load timing (fresh process => first call pays the load) ---
console.log('== load time (cold) ==');
console.log('GeoJSON full parse   :', tms(() => geo.loadFull()).toFixed(1), 'ms');
console.log('binary geom+index    :', tms(() => { bin.loadGeom(); bin.loadIndex(); }).toFixed(1), 'ms');

geo.loadCoarse(); // warm the tiered path fully

// --- equivalence over random CONUS points ---
const N = 200000;
let land = 0, codeMismatch = 0, maxDistErr = 0, distCompared = 0;
const errs = [];
for (let i = 0; i < N; i++) {
  const lat = 25 + Math.random() * 24, lng = -125 + Math.random() * 58;
  const g = geo.resolveState(lat, lng);
  const b = bin.resolveState(lat, lng);
  if (g.code) land++;
  if ((g.code || null) !== (b.code || null)) codeMismatch++;
  if (g.tier === 'fine' && g.code && b.code && g.distanceKm != null && b.distanceKm != null) {
    const e = Math.abs(g.distanceKm - b.distanceKm);
    errs.push(e); distCompared++;
    if (e > maxDistErr) maxDistErr = e;
  }
}
errs.sort((a, b) => a - b);
const p = q => errs.length ? errs[Math.floor(q * (errs.length - 1))] : 0;
console.log('\n== equivalence over', N, 'random points (', land, 'landed) ==');
console.log('containment code mismatches:', codeMismatch, `(${(100 * codeMismatch / (land || 1)).toFixed(4)}% of land pts)`);
console.log('near-border distance compared:', distCompared, 'pts');
console.log(`distance |binary - geojson| : p50 ${p(0.5).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${maxDistErr.toFixed(3)} km`);

// --- per-call timing ---
function timeit(fn, lat, lng, n) { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(lat, lng); return Number(process.hrtime.bigint() - t) / 1e6 / n; }
console.log('\n== binary per-call timing (ms) ==');
console.log('interior   :', timeit(bin.resolveState, 39.7, -98.5, 2000).toFixed(4));
console.log('near-border:', timeit(bin.resolveState, 39.11, -94.61, 2000).toFixed(4));
