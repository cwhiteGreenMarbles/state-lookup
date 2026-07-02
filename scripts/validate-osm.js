// Fetch OSM place nodes per state from Overpass and sweep them through the
// resolver. Ground truth: OSM's own ISO3166-2 state boundary relation each node
// was queried from — a lineage fully independent of TIGER.
//
// CAVEAT: public Overpass endpoints rate-limit aggressively; a full 51-state
// fetch can take a long time or fail with 429s. Points are cached to the output
// file, so re-running resumes where it left off. For bulk validation prefer
// scripts/validate-gazetteer.js (complete, one download) and use this as an
// independent spot-check.
//
// Run:
//   node scripts/validate-osm.js /tmp/osm-points.json           # fetch (resumable) + validate
//   node scripts/validate-osm.js /tmp/osm-points.json --no-fetch # validate cached points only
const fs = require('fs');
const path = require('path');
const { resolveState } = require(path.join(__dirname, '..', 'src'));

const OUT = process.argv[2];
const NO_FETCH = process.argv.includes('--no-fetch');
if (!OUT) { console.error('usage: node scripts/validate-osm.js <points cache file> [--no-fetch]'); process.exit(1); }

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
];
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchState(code, epIdx = 0, attempt = 0) {
  const q = `[out:json][timeout:90];
area["ISO3166-2"="US-${code}"][admin_level=4]->.a;
node(area.a)["place"~"^(town|village|hamlet)$"];
out skel 120;`;
  try {
    const res = await fetch(ENDPOINTS[epIdx % ENDPOINTS.length], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    return (j.elements || []).map(e => [e.lat, e.lon]);
  } catch (e) {
    if (attempt < 4) { await sleep(15000 * (attempt + 1)); return fetchState(code, epIdx + 1, attempt + 1); }
    console.error(`${code}: FAILED (${e.message})`);
    return [];
  }
}

(async () => {
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  if (!NO_FETCH) {
    for (const code of STATES) {
      if (data[code] && data[code].length) continue;
      data[code] = await fetchState(code);
      fs.writeFileSync(OUT, JSON.stringify(data));
      console.log(`${code}: ${data[code].length} points`);
      await sleep(10000); // be polite to the public endpoints
    }
  }

  let total = 0, interior = 0, interiorOk = 0, nearB = 0, nearOk = 0;
  const failures = [];
  let covered = 0;
  for (const [st, pts] of Object.entries(data)) {
    if (pts.length) covered++;
    for (const [lat, lng] of pts) {
      total++;
      const r = resolveState(lat, lng);
      const got = r.code ? r.code.slice(-2) : null;
      const nearBorder = r.distanceKm != null && r.distanceKm <= 2;
      if (!nearBorder) {
        interior++;
        if (got === st) interiorOk++;
        else if (failures.length < 20) failures.push({ st, lat, lng, got: r.code, distanceKm: r.distanceKm });
      } else {
        nearB++;
        if (got === st || (r.bordersWith || []).some(c => c.slice(-2) === st)) nearOk++;
        else if (failures.length < 20) failures.push({ st, lat, lng, got: r.code, near: true });
      }
    }
  }
  console.log(`\nstates with points: ${covered}/51, total: ${total}`);
  console.log(`interior (>2km): ${interiorOk}/${interior} correct (${(100 * interiorOk / (interior || 1)).toFixed(3)}%)`);
  console.log(`near-border (<=2km): ${nearOk}/${nearB} state-or-neighbor (${(100 * nearOk / (nearB || 1)).toFixed(3)}%)`);
  if (failures.length) { console.log('failures:'); for (const f of failures) console.log(JSON.stringify(f)); }
})();
