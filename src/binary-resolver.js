/*
 * binary-resolver.js — runtime resolver backed by PRECREATED binary artifacts
 * (built by build-binary.js). Cold start reads buffers only; there is NO GeoJSON
 * parse and NO index build.
 *
 *   - containment: even-odd ray-cast over the geom.f64 typed array (the same
 *     proven algorithm as the GeoJSON reference path, just binary-fed).
 *   - distance:    precreated Flatbush over border segments. Candidates are
 *     retrieved in planar-degree order and re-scored in km; the search expands
 *     (k-doubling) until the planar lower bound of any unseen segment exceeds
 *     the best km found, so the geodesically nearest segment is never missed
 *     at high latitude. Queries near the antimeridian are re-run wrapped by
 *     360 degrees so Aleutian-area points see segments across the dateline.
 *
 * Response contract (documented in README):
 *   { code, country, distanceKm, nearBorder }
 *   - code/country are null offshore (point in no state/province).
 *   - distanceKm is ALWAYS the distance to the nearest state border segment —
 *     for offshore points that is the distance to the nearest coast.
 *   - nearBorder = distanceKm <= GEO_TRUST_KM.
 */
const fs = require('fs');
const path = require('path');
const _fb = require('flatbush');
const Flatbush = _fb.default || _fb; // v4 is ESM -> constructor under .default when required from CJS

const CANDIDATE_DIRS = [
  process.env.GEO_DATA_DIR,
  path.join(__dirname, '..', 'layer', 'geo'),
  path.join(__dirname, 'data'),
].filter(Boolean);
const DATA_DIR = CANDIDATE_DIRS.find(d => { try { return fs.existsSync(path.join(d, 'geom.f64')); } catch (_) { return false; } }) || CANDIDATE_DIRS[0];

const TRUST_KM = Number(process.env.GEO_TRUST_KM || 3);
const KNN = Number(process.env.GEO_KNN || 16);       // initial k; search expands as needed
const KY = 110.574;                                   // km per degree latitude

let GEO = null, EI = null;

// Read a file into a typed array WITHOUT copying when the Buffer already owns an
// exclusive, aligned ArrayBuffer (true for large readFileSync buffers, which are
// non-pooled). Copy only in the pooled/misaligned case.
function readTyped(file, Ctor) {
  const b = fs.readFileSync(path.join(DATA_DIR, file));
  if (b.byteOffset % Ctor.BYTES_PER_ELEMENT === 0) {
    return new Ctor(b.buffer, b.byteOffset, b.byteLength / Ctor.BYTES_PER_ELEMENT);
  }
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Ctor(ab);
}
function loadGeom() {
  if (GEO) return GEO;
  const coords = readTyped('geom.f64', Float64Array);
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'geom-meta.json'), 'utf8'));
  GEO = { coords, codes: meta.codes, features: meta.features };
  return GEO;
}
function loadIndex() {
  if (EI) return EI;
  const b = fs.readFileSync(path.join(DATA_DIR, 'edges.flatbush'));
  const ab = (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength)
    ? b.buffer
    : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  EI = { index: Flatbush.from(ab), start: readTyped('edges-start.u32', Uint32Array), cid: readTyped('edges-cid.u16', Uint16Array) };
  return EI;
}

// even-odd ray-cast over one feature's rings, reading coords from the typed array
function inFeature(coords, feature, lng, lat) {
  const [a, b, c, d] = feature.bbox;
  if (lng < a || lng > c || lat < b || lat > d) return false;
  let inside = false;
  for (const [start, count] of feature.rings) {
    for (let k = 0; k < count - 1; k++) {
      const i = start + k, j = start + k + 1;
      const xi = coords[2 * i], yi = coords[2 * i + 1], xj = coords[2 * j], yj = coords[2 * j + 1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}
function resolveFeatureIdx(geo, lat, lng) {
  for (let fi = 0; fi < geo.features.length; fi++) {
    if (inFeature(geo.coords, geo.features[fi], lng, lat)) return fi;
  }
  return -1;
}

// point-to-segment distance in km via equirectangular projection around the point.
// Longitude deltas are wrapped to (-180, 180] so segments across the antimeridian
// score correctly.
function segDistKm(lat, lng, ax, ay, bx, by) {
  const kx = 111.320 * Math.cos(lat * Math.PI / 180);
  let dax = ax - lng; if (dax > 180) dax -= 360; else if (dax < -180) dax += 360;
  let dbx = bx - lng; if (dbx > 180) dbx -= 360; else if (dbx < -180) dbx += 360;
  const axr = dax * kx, ayr = (ay - lat) * KY, bxr = dbx * kx, byr = (by - lat) * KY;
  const dx = bxr - axr, dy = byr - ayr, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(axr * dx + ayr * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(axr + t * dx, ayr + t * dy);
}
// planar-degree distance from the query point to a segment's bbox — the exact
// metric Flatbush orders neighbors() by, recomputed for the furthest returned
// candidate to lower-bound every unseen segment.
function boxDistDeg(coords, sp, lng, lat) {
  const ax = coords[2 * sp], ay = coords[2 * sp + 1], bx = coords[2 * (sp + 1)], by = coords[2 * (sp + 1) + 1];
  const dx = Math.max(Math.min(ax, bx) - lng, 0, lng - Math.max(ax, bx));
  const dy = Math.max(Math.min(ay, by) - lat, 0, lat - Math.max(ay, by));
  return Math.hypot(dx, dy);
}

// nearest-border distance (km) from one query position. Expands k until the
// planar lower bound (kmin * degrees) of any unseen candidate exceeds the best
// km found — provably cannot miss the geodesically nearest segment.
function nearestKm(lng, lat) {
  const ei = loadIndex(), geo = loadGeom();
  const kx = 111.320 * Math.abs(Math.cos(lat * Math.PI / 180));
  const kmin = Math.max(Math.min(kx, KY), 1e-9);
  let k = KNN, best = Infinity;
  for (;;) {
    const ids = ei.index.neighbors(lng, lat, k);
    for (const id of ids) {
      const sp = ei.start[id];
      const d = segDistKm(lat, lng, geo.coords[2 * sp], geo.coords[2 * sp + 1], geo.coords[2 * (sp + 1)], geo.coords[2 * (sp + 1) + 1]);
      if (d < best) best = d;
    }
    if (ids.length < k) break; // index exhausted
    const bound = kmin * boxDistDeg(geo.coords, ei.start[ids[ids.length - 1]], lng, lat);
    if (bound >= best) break;  // no unseen segment can beat the current best
    k *= 2;
    if (k > 65536) break;      // safety valve
  }
  return best;
}
function borderKm(lat, lng) {
  let best = nearestKm(lng, lat);
  // near the antimeridian, also search from the wrapped position so segments on
  // the other side of the dateline are retrievable from the index
  if (lng > 170) best = Math.min(best, nearestKm(lng - 360, lat));
  else if (lng < -170) best = Math.min(best, nearestKm(lng + 360, lat));
  return best === Infinity ? null : Math.round(best * 100) / 100;
}

/**
 * resolveState(lat, lng) -> { code, country, distanceKm, nearBorder }
 * `code` is the authoritative containing state/province (e.g. "US-MO"), or null
 * offshore. `distanceKm` is always the distance to the nearest border segment
 * (offshore: nearest coast).
 */
function resolveState(lat, lng) {
  const geo = loadGeom();
  const fi = resolveFeatureIdx(geo, lat, lng);
  const distanceKm = borderKm(lat, lng);
  const nearBorder = distanceKm != null && distanceKm <= TRUST_KM;
  if (fi < 0) return { code: null, country: null, distanceKm, nearBorder };
  const code = geo.codes[geo.features[fi].c];
  return { code, country: code.slice(0, 2), distanceKm, nearBorder };
}

// Eager-load at module scope: in Lambda this runs during the init phase (boosted
// CPU, not billed against the first request). Set GEO_LAZY=1 to defer.
if (process.env.GEO_LAZY !== '1') { loadGeom(); loadIndex(); }

module.exports = { resolveState, loadGeom, loadIndex, DATA_DIR };
