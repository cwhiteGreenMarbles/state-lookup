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
  // Four Corners quadripoint: bordersWith must contain the three other states
  const fc = bin.resolveState(36.998976, -109.045172);
  const four = ['US-AZ', 'US-CO', 'US-NM', 'US-UT'];
  const expected = four.filter(c => c !== fc.code).sort().join(',');
  assert('Four Corners bordersWith lists the other three states',
    four.includes(fc.code) && [...fc.bordersWith].sort().join(',') === expected,
    `code=${fc.code} bordersWith=${JSON.stringify(fc.bordersWith)}`);
  // normal border: bordersWith is exactly [borderWith]
  assert('KC bordersWith is exactly [US-KS]', kc.bordersWith.length === 1 && kc.bordersWith[0] === 'US-KS',
    `bordersWith=${JSON.stringify(kc.bordersWith)}`);
  // long-distance geodesic drift check: Columbus OH -> OH/KY border, independently
  // verified against Google Maps (142.76 km). The flat-projection bug this guards
  // against reported 141.95 here; fail if the value drifts > 200 m.
  const cb = bin.resolveState(40.03281758831511, -83.07472294770703);
  assert('Columbus OH long-distance geodesic accuracy (142.75 ±0.2 km)',
    cb.code === 'US-OH' && cb.borderWith === 'US-KY' && Math.abs(cb.distanceKm - 142.75) < 0.2,
    `code=${cb.code} borderWith=${cb.borderWith} distanceKm=${cb.distanceKm}`);
  // on-the-line: distance must be ~0 and both sides named (drift here would mean
  // borderPoint/selection regressions)
  assert('OH/KY on-line distance is 0', on.distanceKm === 0 && on.bordersWith.length === 1,
    `distanceKm=${on.distanceKm} bordersWith=${JSON.stringify(on.bordersWith)}`);
  // districts & territories (US-DC confirmed to exist as a downstream shard)
  const dc = bin.resolveState(38.9047, -77.0363);
  assert('Washington DC resolves US-DC (borderWith US-VA)', dc.code === 'US-DC' && dc.borderWith === 'US-VA',
    `code=${dc.code} borderWith=${dc.borderWith}`);
  assert('San Juan resolves US-PR', bin.resolveState(18.4655, -66.1057).code === 'US-PR', '');
  assert('Guam resolves US-GU (positive longitude)', bin.resolveState(13.4443, 144.7937).code === 'US-GU', '');
  // tri-point: exactly two states across (between normal border=1 and Four Corners=3)
  const tp = bin.resolveState(40.0029, -102.0519);
  assert('CO/NE/KS tripoint has 2 in bordersWith',
    tp.bordersWith.length === 2 && ['US-CO', 'US-KS', 'US-NE'].includes(tp.code)
      && tp.bordersWith.every(c => ['US-CO', 'US-KS', 'US-NE'].includes(c)) && !tp.bordersWith.includes(tp.code),
    `code=${tp.code} bordersWith=${JSON.stringify(tp.bordersWith)}`);
  // continental oddities
  const kb = bin.resolveState(36.503, -89.541);
  assert('Kentucky Bend exclave resolves US-KY / US-MO', kb.code === 'US-KY' && kb.borderWith === 'US-MO',
    `code=${kb.code} borderWith=${kb.borderWith}`);
  const de = bin.resolveState(39.585, -75.552);
  assert('Delaware River near NJ shore resolves US-DE (low-water-mark boundary)', de.code === 'US-DE' && de.borderWith === 'US-NJ',
    `code=${de.code} borderWith=${de.borderWith}`);
  const li = bin.resolveState(40.6892, -74.0445);
  assert('Liberty Island resolves US-NY (enclave in NJ waters)', li.code === 'US-NY' && li.borderWith === 'US-NJ',
    `code=${li.code} borderWith=${li.borderWith}`);
  const cl = bin.resolveState(41.2905, -95.918);
  assert('Carter Lake IA resolves US-IA west of the Missouri R.', cl.code === 'US-IA' && cl.borderWith === 'US-NE',
    `code=${cl.code} borderWith=${cl.borderWith}`);
  const nwa = bin.resolveState(49.3517, -95.0603);
  assert('Northwest Angle resolves US-MN with Canada null', nwa.code === 'US-MN' && nwa.borderWith === null,
    `code=${nwa.code} borderWith=${nwa.borderWith}`);
  // Upper Peninsula Michigan & related
  const up = bin.resolveState(46.5436, -87.3954);
  assert('Marquette (central UP) resolves US-MI, nearest border US-WI', up.code === 'US-MI' && up.borderWith === 'US-WI',
    `code=${up.code} borderWith=${up.borderWith}`);
  const ssm = bin.resolveState(46.495, -84.345);
  assert('Sault Ste Marie resolves US-MI with Canada null', ssm.code === 'US-MI' && ssm.borderWith === null,
    `code=${ssm.code} borderWith=${ssm.borderWith}`);
  const lake = bin.resolveState(43.5, -87.2);
  assert('Mid Lake Michigan resolves a state (WI/MI water line)',
    (lake.code === 'US-WI' && lake.borderWith === 'US-MI') || (lake.code === 'US-MI' && lake.borderWith === 'US-WI'),
    `code=${lake.code} borderWith=${lake.borderWith}`);
  // antimeridian input edge: lng=+180 and lng=-180 are the same meridian
  const p180 = bin.resolveState(52.0, 180.0), m180 = bin.resolveState(52.0, -180.0);
  assert('lng=+180 and lng=-180 agree', p180.distanceKm === m180.distanceKm && p180.borderWith === m180.borderWith,
    `+180=${JSON.stringify(p180)} -180=${JSON.stringify(m180)}`);
  // borderPoint idempotence: feeding any near-border result's borderPoint back in
  // must land ON the border (distance 0) in one of the two adjacent states
  let idemFail = 0, idemN = 0;
  for (let i = 0; i < 4000 && idemN < 30; i++) {
    const lat = 25 + Math.random() * 24, lng = -125 + Math.random() * 58;
    const r = bin.resolveState(lat, lng);
    if (!r.code || r.distanceKm == null || r.distanceKm < 0.05 || r.distanceKm > 3 || !r.borderWith) continue;
    idemN++;
    const r2 = bin.resolveState(r.borderPoint.lat, r.borderPoint.lng);
    const allowed = new Set([r.code, r.borderWith]);
    if (r2.distanceKm > 0.01 || !allowed.has(r2.code)) idemFail++;
  }
  assert(`borderPoint idempotence (${idemN} near-border samples)`, idemN >= 20 && idemFail === 0,
    `sampled=${idemN} failures=${idemFail}`);
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
