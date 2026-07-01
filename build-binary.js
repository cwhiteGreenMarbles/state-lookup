#!/usr/bin/env node
/*
 * build-binary.js — precompute the binary runtime artifacts so cold start reads
 * buffers instead of parsing the 21 MB GeoJSON / building an index.
 *
 * Reads:  data/states-full.geojson (build source)
 * Writes (into layer/geo/):
 *   geom.f64          Float64Array of ALL ring coords, interleaved [x0,y0,x1,y1,...]
 *   geom-meta.json    { codes:[...], features:[{ c, bbox, rings:[[startPt,count],...] }] }
 *   edges.flatbush    Flatbush static index over every border segment (Float32 boxes)
 *   edges-start.u32   Uint32Array: global start-point index of each segment
 *   edges-cid.u16     Uint16Array: feature/code index of each segment
 *
 * Containment at runtime uses geom.f64 + the SAME even-odd ray-cast (no parse).
 * Distance uses the precreated Flatbush + geom.f64 (no rebuild).
 */
const fs = require('fs');
const path = require('path');
const _fb = require(require.resolve('flatbush', { paths: [path.join(__dirname, 'src')] }));
const Flatbush = _fb.default || _fb; // v4 is ESM -> constructor under .default when required from CJS

const SRC = path.join(__dirname, 'data');          // GeoJSON build sources (NOT shipped)
const DATA = path.join(__dirname, 'layer', 'geo'); // runtime binary artifacts (the layer)
fs.mkdirSync(DATA, { recursive: true });
const gj = JSON.parse(fs.readFileSync(path.join(SRC, 'states-full.geojson'), 'utf8'));

function bboxOf(coords) {
  let a = 180, b = 90, c = -180, d = -90;
  const w = x => { if (typeof x[0] === 'number') { if (x[0] < a) a = x[0]; if (x[0] > c) c = x[0]; if (x[1] < b) b = x[1]; if (x[1] > d) d = x[1]; return; } for (const y of x) w(y); };
  w(coords); return [a, b, c, d];
}

// ---- geometry buffers ----
const codes = [], codeId = new Map(), featMeta = [], coordList = [];
let pointCount = 0;
for (const ft of gj.features) {
  let cid = codeId.get(ft.properties.code);
  if (cid == null) { cid = codes.length; codes.push(ft.properties.code); codeId.set(ft.properties.code, cid); }
  const g = ft.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const rings = [];
  for (const poly of polys) for (const ring of poly) {
    const start = pointCount;
    for (const [x, y] of ring) { coordList.push(x, y); pointCount++; }
    rings.push([start, ring.length]);
  }
  featMeta.push({ c: cid, bbox: ft.bbox || bboxOf(g.coordinates), rings });
}
const coords = new Float64Array(coordList);
fs.writeFileSync(path.join(DATA, 'geom.f64'), Buffer.from(coords.buffer));
fs.writeFileSync(path.join(DATA, 'geom-meta.json'), JSON.stringify({ codes, features: featMeta }));

// ---- edge index ----
const starts = [], cids = [];
for (const f of featMeta) for (const [start, count] of f.rings) {
  for (let k = 0; k < count - 1; k++) { starts.push(start + k); cids.push(f.c); }
}
const n = starts.length;
const index = new Flatbush(n, 16, Float32Array);
for (let i = 0; i < n; i++) {
  const sp = starts[i];
  const ax = coords[2 * sp], ay = coords[2 * sp + 1], bx = coords[2 * (sp + 1)], by = coords[2 * (sp + 1) + 1];
  index.add(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
}
index.finish();
fs.writeFileSync(path.join(DATA, 'edges.flatbush'), Buffer.from(index.data));
fs.writeFileSync(path.join(DATA, 'edges-start.u32'), Buffer.from(new Uint32Array(starts).buffer));
fs.writeFileSync(path.join(DATA, 'edges-cid.u16'), Buffer.from(new Uint16Array(cids).buffer));

const mb = f => (fs.statSync(path.join(DATA, f)).size / 1048576).toFixed(2) + ' MB';
console.log('geom.f64        ', mb('geom.f64'), '| points', pointCount);
console.log('geom-meta.json  ', mb('geom-meta.json'), '| features', featMeta.length);
console.log('edges.flatbush  ', mb('edges.flatbush'), '| segments', n);
console.log('edges-start.u32 ', mb('edges-start.u32'));
console.log('edges-cid.u16   ', mb('edges-cid.u16'));
