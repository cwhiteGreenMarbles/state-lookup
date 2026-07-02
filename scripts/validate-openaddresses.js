// Sweep OpenAddresses points through the state-lookup resolver.
// Ground truth: the us/<state>/ directory each county CSV lives in.
//
// Get the data (ODbL — attribution required; validation use only, do not
// redistribute derived databases without reviewing share-alike terms):
//   https://batch.openaddresses.io/data  ->  us_west / us_midwest / us_northeast / us_south
//   collection zips; unzip them under one root directory.
// Run:
//   node scripts/validate-openaddresses.js /path/to/openaddresses-root
// The root should contain us_midwest/us/<st>/<county>.csv etc.
const fs = require('fs');
const path = require('path');
const { resolveState } = require(path.join(__dirname, '..', 'src'));

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(ROOT)) { console.error('usage: node scripts/validate-openaddresses.js <openaddresses root dir>'); process.exit(1); }
const REGIONS = fs.readdirSync(ROOT).filter(d => d.startsWith('us_') && fs.statSync(path.join(ROOT, d)).isDirectory());
const FILES_PER_STATE = Number(process.env.OA_FILES || 6);
const ROWS_PER_FILE = Number(process.env.OA_ROWS || 120);

const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

const perState = {};
for (const region of REGIONS) {
  const usDir = path.join(ROOT, region, 'us');
  if (!fs.existsSync(usDir)) continue;
  for (const st of fs.readdirSync(usDir)) {
    const stDir = path.join(usDir, st);
    if (!fs.statSync(stDir).isDirectory()) continue;
    const csvs = fs.readdirSync(stDir).filter(f => f.endsWith('.csv'));
    if (!csvs.length) continue;
    const pts = (perState[st.toUpperCase()] ??= []);
    for (const f of pick(csvs, FILES_PER_STATE)) {
      let txt;
      try { txt = fs.readFileSync(path.join(stDir, f), 'utf8'); } catch { continue; }
      const lines = txt.split('\n');
      if (lines.length < 2) continue;
      const header = lines[0].split(',');
      const iLon = header.indexOf('LON'), iLat = header.indexOf('LAT');
      if (iLon < 0 || iLat < 0) continue;
      for (const li of pick([...Array(lines.length - 1).keys()].map(i => i + 1), ROWS_PER_FILE)) {
        const cols = lines[li].split(',');
        const lng = Number(cols[iLon]), lat = Number(cols[iLat]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        pts.push([lat, lng, f]);
      }
    }
  }
}

let total = 0, interior = 0, interiorOk = 0, nearB = 0, nearOk = 0, junk = 0;
const failures = [];
const rows = [];
for (const [st, pts] of Object.entries(perState).sort()) {
  let ok = 0, bad = 0, nb = 0;
  for (const [lat, lng, file] of pts) {
    if (lat < 17 || lat > 72 || lng < -180 || lng > -60) { junk++; continue; }
    total++;
    const r = resolveState(lat, lng);
    const got = r.code ? r.code.slice(-2) : null;
    const nearBorder = r.distanceKm != null && r.distanceKm <= 2;
    if (!nearBorder) {
      interior++;
      if (got === st) { interiorOk++; ok++; }
      else { bad++; if (failures.length < 30) failures.push({ st, file, lat, lng, got: r.code, distanceKm: r.distanceKm }); }
    } else {
      nearB++; nb++;
      const acceptable = got === st || (r.bordersWith || []).some(c => c.slice(-2) === st);
      if (acceptable) { nearOk++; ok++; }
      else { bad++; if (failures.length < 30) failures.push({ st, file, lat, lng, got: r.code, distanceKm: r.distanceKm, near: true }); }
    }
  }
  rows.push(`${st}: n=${pts.length} ok=${ok} nearBorder=${nb} bad=${bad}`);
}
console.log(rows.join('\n'));
console.log(`\nregions: ${REGIONS.join(',')} | states covered: ${Object.keys(perState).length}`);
console.log(`total points: ${total} (junk skipped: ${junk})`);
console.log(`interior (>2km): ${interiorOk}/${interior} correct (${(100 * interiorOk / (interior || 1)).toFixed(4)}%)`);
console.log(`near-border (<=2km): ${nearOk}/${nearB} state-or-neighbor (${(100 * nearOk / (nearB || 1)).toFixed(4)}%)`);
if (failures.length) {
  console.log('\nfailures (check whether the SOURCE FILE is misfiled before blaming the resolver):');
  for (const f of failures) console.log(JSON.stringify(f));
}
