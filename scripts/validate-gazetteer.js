// Sweep the US Census Gazetteer national places file (every state + DC + PR)
// through the state-lookup resolver. Ground truth: the USPS state column.
//
// Get the data (public domain, ~3 MB):
//   curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip
//   unzip 2025_Gaz_place_national.zip
// Run:
//   node scripts/validate-gazetteer.js ./2025_Gaz_place_national.txt
//
// Note: the 2025 vintage is pipe-delimited; earlier vintages were tab-delimited
// (auto-detected below).
const fs = require('fs');
const path = require('path');
const { resolveState } = require(path.join(__dirname, '..', 'src'));

const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) { console.error('usage: node scripts/validate-gazetteer.js <path to *_Gaz_place_national.txt>'); process.exit(1); }

const txt = fs.readFileSync(FILE, 'latin1');
const lines = txt.split('\n');
const delim = lines[0].includes('|') ? '|' : '\t';
const header = lines[0].replace(/^﻿/, '').split(delim).map(s => s.trim());
const iState = header.indexOf('USPS');
const iLat = header.indexOf('INTPTLAT');
const iLng = header.findIndex(h => h.startsWith('INTPTLON'));

const per = {};
let total = 0, interior = 0, interiorOk = 0, nearB = 0, nearOk = 0;
const failures = [];
for (let li = 1; li < lines.length; li++) {
  const cols = lines[li].split(delim);
  if (cols.length < 5) continue;
  const st = cols[iState].trim();
  const lat = Number(cols[iLat]), lng = Number(cols[iLng]);
  if (!st || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const p = (per[st] ??= { n: 0, ok: 0, nb: 0, bad: 0 });
  total++; p.n++;
  const r = resolveState(lat, lng);
  const got = r.code ? r.code.slice(-2) : null;
  const nearBorder = r.distanceKm != null && r.distanceKm <= 2;
  if (!nearBorder) {
    interior++;
    if (got === st) { interiorOk++; p.ok++; }
    else { p.bad++; if (failures.length < 40) failures.push({ st, lat, lng, got: r.code, distanceKm: r.distanceKm, borderWith: r.borderWith }); }
  } else {
    nearB++; p.nb++;
    const acceptable = got === st || (r.bordersWith || []).some(c => c.slice(-2) === st);
    if (acceptable) { nearOk++; p.ok++; }
    else { p.bad++; if (failures.length < 40) failures.push({ st, lat, lng, got: r.code, distanceKm: r.distanceKm, near: true }); }
  }
}
const states = Object.keys(per).sort();
const badStates = states.filter(s => per[s].bad > 0);
console.log(`states covered: ${states.length} (${states.join(',')})`);
console.log(`total places: ${total}`);
console.log(`interior (>2km): ${interiorOk}/${interior} correct (${(100 * interiorOk / (interior || 1)).toFixed(4)}%)`);
console.log(`near-border (<=2km): ${nearOk}/${nearB} state-or-neighbor (${(100 * nearOk / (nearB || 1)).toFixed(4)}%)`);
console.log(`states with failures: ${badStates.length}${badStates.length ? ' -> ' + badStates.map(s => `${s}(${per[s].bad})`).join(' ') : ''}`);
if (failures.length) { console.log('\nsample failures:'); for (const f of failures.slice(0, 20)) console.log(JSON.stringify(f)); }
process.exitCode = badStates.length ? 1 : 0;
