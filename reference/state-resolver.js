/*
 * state-resolver.js — runtime core. Resolves lat/lng -> { code, distanceKm }
 * using a layered point-in-polygon:
 *   - a coarse tier (DP-simplified TIGER, ~0.19 MB) answers ~97% of points cheaply
 *   - the full-res tier is consulted only near a border
 *
 * TRUST_KM = 3 is provably safe: the measured max coarse-vs-full disagreement
 * over 61k random points was 1.28 km, so any point the coarse tier reports as
 * >3 km from a border is guaranteed to be in the same state at full resolution.
 *
 * No external geocoder / no network. Data files are produced by build-boundaries.js
 * These GeoJSONs are BUILD SOURCES in data/ (not shipped in the layer).
 */
const fs = require('fs');
const path = require('path');
const bpip = require('@turf/boolean-point-in-polygon').default;
const p2l = require('@turf/point-to-line-distance').default;
const { point, lineString } = require('@turf/helpers');

// Resolve the boundary-data directory across environments:
//   - Lambda:   GEO_DATA_DIR=/opt/geo (layer mount)
//   - local dev: ../data (repo layout; GeoJSON build sources)
//   - fallback:  ./data (legacy bundled-in-function)
const CANDIDATES = [
  process.env.GEO_DATA_DIR,
  path.join(__dirname, '..', 'data'),
  path.join(__dirname, 'data'),
].filter(Boolean);
const DATA_DIR = CANDIDATES.find(d => { try { return fs.existsSync(path.join(d, 'states-coarse.geojson')); } catch (_) { return false; } }) || CANDIDATES[0];

const TRUST_KM = Number(process.env.GEO_TRUST_KM || 3);   // > 1.28 km measured max miss

let COARSE = null, FULL = null; // module-scope caches; survive warm invocations

function bboxOfCoords(coords) {
  let a = 180, b = 90, c = -180, d = -90;
  const w = x => { if (typeof x[0] === 'number') { if (x[0] < a) a = x[0]; if (x[0] > c) c = x[0]; if (x[1] < b) b = x[1]; if (x[1] > d) d = x[1]; return; } for (const y of x) w(y); };
  w(coords); return [a, b, c, d];
}
// index a FeatureCollection into { code, country, bbox, feature, rings:[{ring,bbox}] }
function prep(fc) {
  return fc.features.map(ft => {
    const g = ft.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const rings = [];
    for (const poly of polys) for (const ring of poly) rings.push({ ring, bbox: bboxOfCoords(ring) });
    return {
      code: ft.properties.code,
      country: ft.properties.country || (ft.properties.code || '').slice(0, 2),
      bbox: ft.bbox || bboxOfCoords(g.coordinates),
      feature: ft,
      rings,
    };
  });
}
const readFC = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
const loadCoarse = () => (COARSE ??= prep(readFC('states-coarse.geojson')));
const loadFull = () => (FULL ??= prep(readFC('states-full.geojson')));

// containment: cheap bbox reject, then ray-cast. Returns the entry or null.
function resolveIn(feats, lat, lng) {
  const p = point([lng, lat]);
  for (const e of feats) {
    const [a, b, c, d] = e.bbox;
    if (lng < a || lng > c || lat < b || lat > d) continue;
    if (bpip(p, e.feature)) return e;
  }
  return null;
}
// nearest border distance (km) for one state, with per-ring bbox pruning.
// A ring is skipped only when a km-scaled LOWER BOUND on its bbox distance
// (equirectangular with cos(lat), small slack for approximation error) cannot
// beat the current minimum — so pruning can never change the result.
function borderKm(entry, lat, lng) {
  const p = point([lng, lat]);
  const kx = 111.320 * Math.abs(Math.cos(lat * Math.PI / 180)), ky = 110.574;
  let min = Infinity;
  for (const { ring, bbox } of entry.rings) {
    const [a, b, c, d] = bbox;
    const dx = Math.max(a - lng, 0, lng - c), dy = Math.max(b - lat, 0, lat - d);
    if (Math.hypot(dx * kx, dy * ky) * 0.99 >= min) continue; // cannot beat current best
    const dd = p2l(p, lineString(ring), { units: 'kilometers' });
    if (dd < min) min = dd;
  }
  return min === Infinity ? null : Math.round(min * 100) / 100;
}

/**
 * resolveState(lat, lng) -> { code, country, distanceKm, tier, nearBorder, escalated }
 * `code` is the authoritative containing state/province (e.g. "US-MO"), or null offshore.
 */
function resolveState(lat, lng) {
  // TIER 1 — coarse
  const ce = resolveIn(loadCoarse(), lat, lng);
  const cDist = ce ? borderKm(ce, lat, lng) : 0; // coarse "ocean" => sitting on/over the coarse edge

  if (ce && cDist != null && cDist > TRUST_KM) {
    return { code: ce.code, country: ce.country, distanceKm: cDist, tier: 'coarse', nearBorder: false, escalated: false };
  }

  // TIER 2 — full-res: authoritative code + precise distance (near-border band only)
  const fe = resolveIn(loadFull(), lat, lng);
  if (!fe) return { code: null, country: null, distanceKm: null, tier: 'fine', nearBorder: true, escalated: true };
  return { code: fe.code, country: fe.country, distanceKm: borderKm(fe, lat, lng), tier: 'fine', nearBorder: true, escalated: true };
}

module.exports = { resolveState, loadCoarse, loadFull, DATA_DIR };
