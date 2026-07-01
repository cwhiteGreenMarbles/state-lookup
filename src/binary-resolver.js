/*
 * binary-resolver.js — runtime resolver backed by PRECREATED binary artifacts
 * (built by build-binary.js). Cold start reads buffers only; there is NO GeoJSON
 * parse and NO index build.
 *
 *   - containment: the SAME even-odd ray-cast as the GeoJSON path, run over the
 *     geom.f64 typed array (proven algorithm, just binary-fed).
 *   - distance:    precreated Flatbush over border segments -> nearest-segment km.
 *
 * Drop-in shape-compatible with state-resolver.resolveState().
 */
const fs = require('fs');
const path = require('path');
const _fb = require('flatbush');
const Flatbush = _fb.default || _fb; // v4 is ESM -> constructor under .default when required from CJS

const DATA_DIR = process.env.GEO_DATA_DIR || path.join(__dirname, '..', 'layer', 'geo');
const TRUST_KM = Number(process.env.GEO_TRUST_KM || 3);
const KNN = Number(process.env.GEO_KNN || 16);

let GEO = null, EI = null;

function readTyped(file, Ctor) {
  const b = fs.readFileSync(path.join(DATA_DIR, file));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // copy -> aligned, own ArrayBuffer
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
  const index = Flatbush.from(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  EI = { index, start: readTyped('edges-start.u32', Uint32Array), cid: readTyped('edges-cid.u16', Uint16Array) };
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

// point-to-segment distance in km via equirectangular projection around the point
function segDistKm(lat, lng, ax, ay, bx, by) {
  const kx = 111.320 * Math.cos(lat * Math.PI / 180), ky = 110.574;
  const axr = (ax - lng) * kx, ayr = (ay - lat) * ky, bxr = (bx - lng) * kx, byr = (by - lat) * ky;
  const dx = bxr - axr, dy = byr - ayr, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(axr * dx + ayr * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = axr + t * dx, cy = ayr + t * dy;
  return Math.hypot(cx, cy);
}
function borderKm(lat, lng) {
  const ei = loadIndex(), geo = loadGeom();
  const ids = ei.index.neighbors(lng, lat, KNN);
  let min = Infinity;
  for (const id of ids) {
    const sp = ei.start[id];
    const ax = geo.coords[2 * sp], ay = geo.coords[2 * sp + 1], bx = geo.coords[2 * (sp + 1)], by = geo.coords[2 * (sp + 1) + 1];
    const d = segDistKm(lat, lng, ax, ay, bx, by);
    if (d < min) min = d;
  }
  return min === Infinity ? null : Math.round(min * 100) / 100;
}

function resolveState(lat, lng) {
  const geo = loadGeom();
  const fi = resolveFeatureIdx(geo, lat, lng);
  const distanceKm = borderKm(lat, lng);
  const nearBorder = distanceKm != null && distanceKm <= TRUST_KM;
  if (fi < 0) return { code: null, country: null, distanceKm, tier: 'binary', nearBorder, escalated: false };
  const code = geo.codes[geo.features[fi].c];
  return { code, country: code.slice(0, 2), distanceKm, tier: 'binary', nearBorder, escalated: false };
}

module.exports = { resolveState, loadGeom, loadIndex, DATA_DIR };
