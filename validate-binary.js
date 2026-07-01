/*
 * validate-binary.js — prove the precreated binary resolver is equivalent to the
 * GeoJSON reference resolver, and measure the cold-start win.
 *
 * Sampling covers CONUS *and* the regions where the binary distance path is most
 * at risk (high-latitude anisotropy, the antimeridian, multipolygon islands):
 *   - CONUS, Alaska (incl. Aleutians), Hawaii, plus a dateline strip.
 * Fixed regression assertions cover the specific past defects (planar-degree KNN
 * ranking, antimeridian wrap, input coercion in the handler).
 */
const geo = require('./reference/state-resolver'); // GeoJSON + turf (tiered) — test-only ground truth
const bin = require('./src/binary-resolver');       // precreated binary — the runtime path
const { handler } = require('./src');

function tms(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

// --- cold-start-style load timing ---
// (binary loads eagerly at require time now; re-measure via the cached loaders)
console.log('== load time (cold) ==');
console.log('GeoJSON full parse   :', tms(() => geo.loadFull()).toFixed(1), 'ms');
console.log('binary geom+index    :', '(loaded at require)', tms(() => { bin.loadGeom(); bin.loadIndex(); }).toFixed(1), 'ms cached');
geo.loadCoarse();

// --- equivalence over multi-region random points ---
const REGIONS = [
  { name: 'CONUS',    n: 20000, lat: [25, 49],     lng: [-125, -67] },
  { name: 'Alaska',   n: 6000,  lat: [51, 71.5],   lng: [-179.9, -130] },
  { name: 'Hawaii',   n: 2000,  lat: [18.5, 22.5], lng: [-160.5, -154.5] },
  { name: 'Dateline', n: 1000,  lat: [51, 54],     lng: [-180, -172] },
];
let land = 0, codeMismatch = 0, distCompared = 0, maxDistErr = 0;
const errs = [], mismatches = [];
for (const r of REGIONS) {
  let rLand = 0, rMis = 0, rMaxErr = 0;
  for (let i = 0; i < r.n; i++) {
    const lat = r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]);
    const lng = r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]);
    const g = geo.resolveState(lat, lng);
    const b = bin.resolveState(lat, lng);
    if (g.code) { land++; rLand++; }
    if ((g.code || null) !== (b.code || null)) {
      codeMismatch++; rMis++;
      if (mismatches.length < 5) mismatches.push({ lat, lng, ref: g.code, bin: b.code });
    }
    // distance comparison only where the reference used its authoritative fine tier
    if (g.tier === 'fine' && g.code && b.code && g.distanceKm != null && b.distanceKm != null) {
      const e = Math.abs(g.distanceKm - b.distanceKm);
      errs.push(e); distCompared++;
      if (e > maxDistErr) maxDistErr = e;
      if (e > rMaxErr) rMaxErr = e;
    }
  }
  console.log(`  ${r.name.padEnd(9)} n=${r.n}  land=${rLand}  codeMismatch=${rMis}  maxDistErr=${rMaxErr.toFixed(3)} km`);
}
errs.sort((a, b) => a - b);
const p = q => errs.length ? errs[Math.floor(q * (errs.length - 1))] : 0;
console.log('\n== equivalence (all regions) ==');
console.log('containment code mismatches:', codeMismatch, `(${(100 * codeMismatch / (land || 1)).toFixed(4)}% of ${land} land pts)`);
if (mismatches.length) console.log('  samples:', JSON.stringify(mismatches));
console.log('fine-tier distance compared:', distCompared, 'pts');
console.log(`distance |binary - reference| : p50 ${p(0.5).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${maxDistErr.toFixed(3)} km`);

// --- fixed regression assertions ---
let failed = 0;
function assert(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + detail}`);
  if (!cond) failed++;
}
console.log('\n== regression assertions ==');
// #1 planar-KNN at high latitude: binary fine distance must match reference near a northern border
{
  const pts = [[48.95, -104.06, 'MT/ND border'], [48.9, -111.0, 'MT high-lat interior-ish'], [47.5, -97.1, 'ND near MN']];
  for (const [la, lo, lbl] of pts) {
    const g = geo.resolveState(la, lo), b = bin.resolveState(la, lo);
    const gd = g.distanceKm, bd = b.distanceKm;
    assert(`high-lat distance parity (${lbl})`, g.tier !== 'fine' || Math.abs(gd - bd) < 0.25, `ref=${gd} bin=${bd}`);
    assert(`high-lat code parity (${lbl})`, (g.code || null) === (b.code || null), `ref=${g.code} bin=${b.code}`);
  }
}
// #2 antimeridian: point in the Aleutian pass — nearest land is ~30 km east across the dateline
{
  const b = bin.resolveState(51.9, -179.95);
  assert('antimeridian distance plausible (< 60 km)', b.distanceKm != null && b.distanceKm < 60, `distanceKm=${b.distanceKm}`);
}
// Hawaii multipolygon containment
{
  const b = bin.resolveState(21.3069, -157.858);
  assert('Honolulu resolves US-HI', b.code === 'US-HI', `code=${b.code}`);
}
// borderPoint / borderWith
{
  const hav = (la1, lo1, la2, lo2) => {
    const R = 6371, dla = (la2 - la1) * Math.PI / 180, dlo = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const kc = bin.resolveState(39.0997, -94.5786);
  assert('KC MO borderWith is US-KS', kc.borderWith === 'US-KS', `borderWith=${kc.borderWith}`);
  assert('KC borderPoint self-consistent', Math.abs(hav(39.0997, -94.5786, kc.borderPoint.lat, kc.borderPoint.lng) - kc.distanceKm) < 0.05,
    `hav=${hav(39.0997, -94.5786, kc.borderPoint.lat, kc.borderPoint.lng).toFixed(3)} vs distanceKm=${kc.distanceKm}`);
  const fl = bin.resolveState(25.0, -80.0);
  assert('offshore FL borderWith is US-FL', fl.borderWith === 'US-FL', `borderWith=${fl.borderWith}`);
  const al = bin.resolveState(51.9, -179.95);
  assert('Aleutian borderPoint is across the dateline', al.borderPoint && al.borderPoint.lng > 170, `borderPoint=${JSON.stringify(al.borderPoint)}`);
  // exactly ON the border (a borderPoint fed back in): must name both states
  const on = bin.resolveState(38.756445, -82.89604); // OH/KY line
  assert('on-the-border names both states (OH/KY)',
    (on.code === 'US-KY' && on.borderWith === 'US-OH') || (on.code === 'US-OH' && on.borderWith === 'US-KY'),
    `code=${on.code} borderWith=${on.borderWith}`);
}
// #4/#5 handler input validation
(async () => {
  const cases = [
    [{ lat: null, lng: null }, 'null coords'],
    [{ queryStringParameters: { lat: '', lng: '' } }, 'empty-string coords'],
    [{ lat: 200, lng: -94 }, 'lat out of range'],
    [{ lat: -94.57, lng: 39.09, }, 'swapped lat/lng (lat < -90)'],
    [{}, 'missing coords'],
  ];
  for (const [ev, lbl] of cases) {
    const r = await handler(ev);
    assert(`handler 400 on ${lbl}`, r.statusCode === 400, `got ${r.statusCode} ${r.body}`);
  }
  const ok = await handler({ lat: 39.0997, lng: -94.5786 });
  assert('handler 200 on valid coords', ok.statusCode === 200 && JSON.parse(ok.body).code === 'US-MO', `${ok.statusCode} ${ok.body}`);

  console.log(failed === 0 ? '\nALL ASSERTIONS PASSED' : `\n${failed} ASSERTION(S) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
