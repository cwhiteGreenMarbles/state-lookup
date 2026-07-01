// Smoke test + timing across interior, near-border, and offshore points.
const { resolveState, loadCoarse, loadFull, DATA_DIR } = require('./src/state-resolver');

const cases = [
  [39.0997, -94.5786, 'Downtown KC        (expect US-MO)'],
  [38.9822, -94.6708, 'Overland Park KS   (expect US-KS)'],
  [39.11,   -94.61,   'KC near MO/KS line (expect fine tier)'],
  [40.7128, -74.0060, 'NYC               (expect US-NY)'],
  [34.0522, -118.2437,'Los Angeles       (expect US-CA)'],
  [40.639,  -87.526,  'IN/IL state line  (near border)'],
  [21.3069, -157.858, 'Honolulu          (expect US-HI, multipolygon)'],
  [25.0,    -80.0,    'Ocean off FL      (expect code:null)'],
];

console.log('data dir:', DATA_DIR);
loadCoarse(); loadFull(); // warm
console.log('== results ==');
for (const [lat, lng, label] of cases) {
  console.log(label.padEnd(38), JSON.stringify(resolveState(lat, lng)));
}

function timeit(lat, lng, n) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) resolveState(lat, lng);
  return Number(process.hrtime.bigint() - t0) / 1e6 / n;
}
console.log('\n== timing (ms/call) ==');
console.log('interior (coarse tier) ', timeit(39.7, -98.5, 500).toFixed(3));
console.log('near-border (fine tier)', timeit(39.11, -94.61, 200).toFixed(3));
