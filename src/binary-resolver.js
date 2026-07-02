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
 *   { code, country, distanceKm, nearBorder, borderPoint, borderWith, bordersWith }
 *   - code/country are null offshore (point in no state/province).
 *   - distanceKm is ALWAYS the distance to the nearest state border segment —
 *     for offshore points that is the distance to the nearest coast.
 *   - nearBorder = distanceKm <= GEO_TRUST_KM.
 *   - borderPoint = the nearest {lat,lng} ON the border; borderWith = the
 *     state/province across it (null = water / non-US neighbor).
 *   - bordersWith = ALL states meeting at borderPoint minus the containing one
 *     (one entry on a normal border, three at Four Corners; borderWith first).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Flatbush from 'flatbush'; // v4 is ESM — native default import, no interop shim needed

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// great-circle distance (km) — used for the final REPORTED distance so long
// distances match standard geodesic measurements; the equirectangular segDistKm
// stays for candidate selection where only relative order matters.
function havKm(la1, lo1, la2, lo2) {
  const R = 6371, dla = (la2 - la1) * Math.PI / 180;
  let dlo = lo2 - lo1; if (dlo > 180) dlo -= 360; else if (dlo < -180) dlo += 360;
  dlo *= Math.PI / 180;
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

// nearest-border search from one query position. Expands k until the planar
// lower bound (kmin * degrees) of any unseen candidate exceeds the best km
// found — provably cannot miss the geodesically nearest segment. Returns the
// winning segment's start-point index alongside the distance.
function nearestSeg(lng, lat) {
  const ei = loadIndex(), geo = loadGeom();
  const kx = 111.320 * Math.abs(Math.cos(lat * Math.PI / 180));
  const kmin = Math.max(Math.min(kx, KY), 1e-9);
  let k = KNN, best = Infinity, bestSp = -1;
  for (;;) {
    const ids = ei.index.neighbors(lng, lat, k);
    for (const id of ids) {
      const sp = ei.start[id];
      const d = segDistKm(lat, lng, geo.coords[2 * sp], geo.coords[2 * sp + 1], geo.coords[2 * (sp + 1)], geo.coords[2 * (sp + 1) + 1]);
      if (d < best) { best = d; bestSp = sp; }
    }
    if (ids.length < k) break; // index exhausted
    const bound = kmin * boxDistDeg(geo.coords, ei.start[ids[ids.length - 1]], lng, lat);
    if (bound >= best) break;  // no unseen segment can beat the current best
    k *= 2;
    if (k > 65536) break;      // safety valve
  }
  return { km: best, sp: bestSp };
}

// all states touching a point: probe 8 compass directions a small step out and
// resolve containment for each. At a normal border this finds both sides; at a
// tri-/quadripoint (e.g. Four Corners) it finds every state meeting there.
function statesAtPoint(geo, lat0, lng0, kx) {
  const found = new Set();
  const stepKm = 0.03;
  for (let i = 0; i < 8; i++) {
    const ang = i * Math.PI / 4;
    const sLat = lat0 + (Math.sin(ang) * stepKm) / KY;
    let sLng = lng0 + (Math.cos(ang) * stepKm) / (kx || 1e-9);
    if (sLng > 180) sLng -= 360; else if (sLng < -180) sLng += 360;
    const fi = resolveFeatureIdx(geo, sLat, sLng);
    if (fi >= 0) found.add(geo.codes[geo.features[fi].c]);
  }
  return found;
}

// distance + nearest point on the border + the state across that border.
// `ownCode` is the containing state's code (null offshore), used to tell
// "across the line" apart from "back into the same state".
function borderInfo(lat, lng, ownCode) {
  let r = nearestSeg(lng, lat);
  // near the antimeridian, also search from the wrapped position so segments on
  // the other side of the dateline are retrievable from the index
  if (lng > 170) { const r2 = nearestSeg(lng - 360, lat); if (r2.km < r.km) r = r2; }
  else if (lng < -170) { const r2 = nearestSeg(lng + 360, lat); if (r2.km < r.km) r = r2; }
  if (r.sp < 0) return { distanceKm: null, borderPoint: null, borderWith: null, bordersWith: [] };

  const geo = loadGeom(), sp = r.sp;
  const ax = geo.coords[2 * sp], ay = geo.coords[2 * sp + 1], bx = geo.coords[2 * (sp + 1)], by = geo.coords[2 * (sp + 1) + 1];
  // re-project once to get the parameter t of the nearest point on the segment
  const kx = 111.320 * Math.cos(lat * Math.PI / 180);
  let dax = ax - lng; if (dax > 180) dax -= 360; else if (dax < -180) dax += 360;
  let dbx = bx - lng; if (dbx > 180) dbx -= 360; else if (dbx < -180) dbx += 360;
  const axr = dax * kx, ayr = (ay - lat) * KY, bxr = dbx * kx, byr = (by - lat) * KY;
  const dx = bxr - axr, dy = byr - ayr, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(axr * dx + ayr * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let bpLng = ax + t * (bx - ax); if (bpLng > 180) bpLng -= 360; else if (bpLng < -180) bpLng += 360;
  const bpLat = ay + t * (by - ay);
  const borderPoint = { lat: Math.round(bpLat * 1e6) / 1e6, lng: Math.round(bpLng * 1e6) / 1e6 };

  // borderWith: step past the border point, directly away from the query, and
  // resolve what contains the stepped point. Escalating step sizes cover border
  // jitter/concavities; null = water or a non-US neighbor (Canada/Mexico until
  // those boundaries are added to the dataset).
  let borderWith = null;
  const qdxKm = (axr + t * dx), qdyKm = (ayr + t * dy);        // query -> border point, km-space
  const qLen = Math.hypot(qdxKm, qdyKm);
  if (qLen > 1e-6) {
    const ux = qdxKm / qLen, uy = qdyKm / qLen;
    for (const stepKm of [0.03, 0.1, 0.3]) {
      const sLat = bpLat + (uy * stepKm) / KY;
      let sLng = bpLng + (ux * stepKm) / (kx || 1e-9);
      if (sLng > 180) sLng -= 360; else if (sLng < -180) sLng += 360;
      const fi = resolveFeatureIdx(geo, sLat, sLng);
      const c = fi >= 0 ? geo.codes[geo.features[fi].c] : null;
      if (c && c !== ownCode) { borderWith = c; break; }
      if (!c && ownCode == null) continue;      // offshore query, still in water — step further
      if (!c) break;                             // stepped into water/foreign territory
    }
  } else if (l2 > 0) {
    // query is ON the border: query->borderPoint has no direction, so probe
    // perpendicular to the winning segment on both sides and return whichever
    // state isn't the containing one (e.g. on the OH/KY line with code US-KY
    // -> borderWith US-OH).
    const segLen = Math.sqrt(l2);
    const px = -dy / segLen, py = dx / segLen;
    outer: for (const sign of [1, -1]) {
      for (const stepKm of [0.03, 0.1, 0.3]) {
        const sLat = bpLat + (sign * py * stepKm) / KY;
        let sLng = bpLng + (sign * px * stepKm) / (kx || 1e-9);
        if (sLng > 180) sLng -= 360; else if (sLng < -180) sLng += 360;
        const fi = resolveFeatureIdx(geo, sLat, sLng);
        const c = fi >= 0 ? geo.codes[geo.features[fi].c] : null;
        if (c && c !== ownCode) { borderWith = c; break outer; }
      }
    }
  }
  // bordersWith: every state meeting at the nearest border point (minus the
  // containing state) — one entry on a normal border, three at Four Corners.
  // borderWith (the directional single answer) is kept first for compatibility.
  const around = statesAtPoint(geo, bpLat, bpLng, kx);
  around.delete(ownCode);
  let bordersWith = [...around].filter(c => c !== borderWith);
  if (borderWith) bordersWith.unshift(borderWith);

  // report the great-circle distance to the chosen border point (the flat r.km
  // is fine for picking the segment, but drifts ~0.5% over 100+ km)
  const distanceKm = Math.round(havKm(lat, lng, bpLat, bpLng) * 100) / 100;
  return { distanceKm, borderPoint, borderWith, bordersWith };
}

/**
 * resolveState(lat, lng) ->
 *   { code, country, distanceKm, nearBorder, borderPoint, borderWith, bordersWith }
 * `code` is the authoritative containing state/province (e.g. "US-MO"), or null
 * offshore. `distanceKm` is always the distance to the nearest border segment
 * (offshore: nearest coast). `borderPoint` is the nearest point ON that border;
 * `borderWith` is the state/province across it (null = water or a non-US
 * neighbor such as Canada/Mexico until those boundaries are added).
 */
function resolveState(lat, lng) {
  const geo = loadGeom();
  const fi = resolveFeatureIdx(geo, lat, lng);
  const code = fi >= 0 ? geo.codes[geo.features[fi].c] : null;
  const { distanceKm, borderPoint, borderWith, bordersWith } = borderInfo(lat, lng, code);
  const nearBorder = distanceKm != null && distanceKm <= TRUST_KM;
  return { code, country: code ? code.slice(0, 2) : null, distanceKm, nearBorder, borderPoint, borderWith, bordersWith };
}

// Eager-load at module scope: in Lambda this runs during the init phase. The buffer
// reads dominate cold start (~360ms of ~480ms Init Duration) and are I/O-throughput-
// bound — reading them concurrently did NOT help, so this stays a simple sequential
// load. Set GEO_LAZY=1 to defer to the first request (sync, memoized) instead.
// The timing log below is diagnostic (measuring the load's share of Init Duration).
const _initT0 = performance.now();
if (process.env.GEO_LAZY !== '1') { loadGeom(); loadIndex(); }
console.log('[state-lookup] init buffer load:', (performance.now() - _initT0).toFixed(1), 'ms');

export { resolveState, loadGeom, loadIndex, DATA_DIR };
