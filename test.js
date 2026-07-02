// Smoke test + timing for the binary runtime resolver.
const { resolveState, loadGeom, loadIndex, DATA_DIR } = require('./src/binary-resolver');

const cases = [
  [39.0997, -94.5786, 'Downtown KC        (expect US-MO)'],
  [38.9822, -94.6708, 'Overland Park KS   (expect US-KS)'],
  [39.11,   -94.61,   'KC near MO/KS line (expect US-KS)'],
  [40.7128, -74.0060, 'NYC               (expect US-NY)'],
  [34.0522, -118.2437,'Los Angeles       (expect US-CA)'],
  [31.7619, -106.4850,'El Paso TX        (near TX/NM/MX, big state)'],
  [38.756445, -82.89604, 'ON the OH/KY line (expect both states named)'],
  [40.03281758831511, -83.07472294770703, 'Columbus OH       (long-dist drift check: ~142.75 km)'],
  [36.998976, -109.045172, 'Four Corners      (expect 3 in bordersWith)'],
  [48.95,   -104.06,  'MT/ND border      (high-latitude anisotropy)'],
  [51.9,    -179.95,  'Aleutian pass     (antimeridian; expect null, dist < 60)'],
  [21.3069, -157.858, 'Honolulu          (expect US-HI, multipolygon)'],
  [25.0,    -80.0,    'Ocean off FL      (expect code:null)'],
  // districts & territories
  [38.9047, -77.0363, 'Washington DC     (expect US-DC)'],
  [18.4655, -66.1057, 'San Juan PR       (expect US-PR)'],
  [13.4443, 144.7937, 'Hagatna Guam      (expect US-GU, positive lng)'],
  // tri-point (corner between exactly three states)
  [40.0029, -102.0519,'CO/NE/KS tripoint (expect 2 in bordersWith)'],
  // continental oddities
  [36.503,  -89.541,  'Kentucky Bend     (KY exclave, expect US-KY / US-MO)'],
  [49.3517, -95.0603, 'Northwest Angle MN(pene-exclave, Canada -> null)'],
  [48.985,  -123.07,  'Point Roberts WA  (pene-exclave, Canada -> null)'],
  [41.2905, -95.9180, 'Carter Lake IA    (IA west of Missouri R., in Omaha)'],
  [37.9214, -89.9165, 'Kaskaskia IL      (IL exclave west of Mississippi R.)'],
  [39.5850, -75.5520, 'Delaware R nr NJ  (DE owns river to NJ bank -> US-DE)'],
  [40.6892, -74.0445, 'Liberty Island    (NY enclave in NJ waters)'],
  [41.7360, -83.4430, 'Lost Peninsula MI (pene-exclave via Toledo OH)'],
  [43.5,    -87.2,    'Mid Lake Michigan (state line in the lake, WI/MI)'],
  // Upper Peninsula Michigan & related
  [46.5436, -87.3954, 'Marquette MI      (central UP; MI multipolygon mainland)'],
  [45.1070, -87.6140, 'Menominee MI      (UP/WI land border)'],
  [46.4950, -84.3450, 'Sault Ste Marie MI(Canada across St. Marys R. -> null)'],
  [45.8174, -84.7278, 'Straits of Mackinac (between the two MI peninsulas)'],
  [48.0000, -88.8300, 'Isle Royale MI    (island in Lake Superior)'],
];

console.log('data dir:', DATA_DIR);
loadGeom(); loadIndex(); // warm (already eager-loaded at require)
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
console.log('interior            ', timeit(39.7, -98.5, 3000).toFixed(4));
console.log('near-border (small) ', timeit(39.11, -94.61, 3000).toFixed(4));
console.log('near-border (big TX)', timeit(31.7619, -106.485, 3000).toFixed(4));
console.log('high-latitude (MT)  ', timeit(48.95, -104.06, 3000).toFixed(4));
console.log('antimeridian (AK)   ', timeit(51.9, -179.95, 3000).toFixed(4));
