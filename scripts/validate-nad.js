// Sweep a sample of the National Address Database (NAD) through the resolver.
// Ground truth: NAD's State column (authoritative addresses from state/local
// address authorities — independent of TIGER boundary processing).
//
// Get the data (public domain, ~7.8 GB zip / ~38 GB txt):
//   https://www.transportation.gov/gis/national-address-database
// Sample it first (full file is too big to parse whole):
//   awk 'NR==1 || NR%5000==2' TXT/NAD_r21.txt > nad-sample.csv
// Run:
//   node scripts/validate-nad.js ./nad-sample.csv
const fs = require('fs');
const path = require('path');
const { resolveState } = require(path.join(__dirname, '..', 'src'));

const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) { console.error('usage: node scripts/validate-nad.js <nad sample csv>'); process.exit(1); }

// quote-aware CSV split (NAD text fields can contain commas)
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const header = splitCsv(lines[0].replace(/^﻿/, ''));
const iState = header.indexOf('State');
const iLat = header.indexOf('Latitude');
const iLng = header.indexOf('Longitude');
if (iState < 0 || iLat < 0 || iLng < 0) { console.error('State/Latitude/Longitude columns not found'); process.exit(1); }

const per = {};
let total = 0, interior = 0, interiorOk = 0, nearB = 0, nearOk = 0, junk = 0;
const failures = [];
for (let li = 1; li < lines.length; li++) {
  if (!lines[li]) continue;
  const cols = splitCsv(lines[li]);
  const st = (cols[iState] || '').trim().toUpperCase();
  const lat = Number(cols[iLat]), lng = Number(cols[iLng]);
  if (!/^[A-Z]{2}$/.test(st) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  if (lat === 0 && lng === 0) { junk++; continue; }
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
console.log(states.map(s => `${s}: n=${per[s].n} ok=${per[s].ok} nearBorder=${per[s].nb} bad=${per[s].bad}`).join('\n'));
console.log(`\nstates covered: ${states.length}`);
console.log(`total points: ${total} (junk skipped: ${junk})`);
console.log(`interior (>2km): ${interiorOk}/${interior} correct (${(100 * interiorOk / (interior || 1)).toFixed(4)}%)`);
console.log(`near-border (<=2km): ${nearOk}/${nearB} state-or-neighbor (${(100 * nearOk / (nearB || 1)).toFixed(4)}%)`);
console.log(`states with failures: ${badStates.length}${badStates.length ? ' -> ' + badStates.map(s => `${s}(${per[s].bad})`).join(' ') : ''}`);
if (failures.length) { console.log('\nsample failures:'); for (const f of failures.slice(0, 25)) console.log(JSON.stringify(f)); }
