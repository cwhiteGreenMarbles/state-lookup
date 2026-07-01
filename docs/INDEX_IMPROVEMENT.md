# Index improvement — fast distance-to-border via an edge R-tree

## Motivation

Two operations, very different costs:

| Operation | Full-res cost | Why |
|-----------|---------------|-----|
| **Containment** (which state) | ~65 µs/point | ray-cast; a bbox reject skips ~63 of 64 states, and the winning state is tested once |
| **Distance to border** | ~35 ms/point avg, **163 ms worst (TX)** | walks *every* segment of the containing state's full-res border computing a geodesic point-to-segment distance, with no short-circuit |

So containment needs no help. The **distance query is the only slow path**, and it
only runs when `resolveState` escalates to the fine tier near a border. For one
lookup per map-idle that's tolerable; at volume (batch tagging, high request rate,
or if we start returning distance on every call) the ~35 ms dominates.

Measured today (see `test.js`): interior ~0.12 ms, near-border ~35 ms.

## Idea

Index the **border segments** (individual edges), not the polygons, in an R-tree.
A distance query then examines only the handful of segments near the point instead
of all ~970k US edges. This turns the fine distance from O(all edges) into
O(log n + k). This is exactly what an edge index is for — and nomo-weather already
depends on `rbush` (`dependencies/nodejs/package.json`), so it's a known quantity.

## Approach

### Build (once, module-scope, lazy)
Flatten every ring of the full-res tier into segments and bulk-load an rbush tree:

```js
const RBush = require('rbush');
let EDGE_INDEX = null;

function buildEdgeIndex(feats) {
  const items = [];
  for (const e of feats) {
    for (const { ring } of e.rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        items.push({
          minX: Math.min(x1, x2), minY: Math.min(y1, y2),
          maxX: Math.max(x1, x2), maxY: Math.max(y1, y2),
          x1, y1, x2, y2, code: e.code,
        });
      }
    }
  }
  const tree = new RBush();
  tree.load(items);           // bulk load is far faster than repeated insert
  return tree;
}
```

Build cost/memory is the tradeoff: ~970k segment items for the US (more with
Canada). Bulk-load is a few hundred ms once per warm container; hold it alongside
the `FULL` cache. If memory matters, store coordinates in typed arrays and keep
only an integer id in the rbush item.

### Query (nearest segment)
Use `rbush-knn` (or a manual expanding-radius search) to pull candidate segments in
increasing bbox-distance order, computing the true point-to-segment distance and
stopping once the next candidate's bbox distance exceeds the best true distance
found — that guarantees correctness:

```js
const knn = require('rbush-knn');

function borderKmIndexed(lat, lng) {
  let best = Infinity;
  // pull k nearest by bbox; k grows if needed
  const cands = knn(EDGE_INDEX, lng, lat, 8);
  for (const s of cands) {
    const d = segDistKm(lat, lng, s);   // geodesic point-to-segment
    if (d < best) best = d;
  }
  return best === Infinity ? null : Math.round(best * 100) / 100;
}
```

`segDistKm` can reuse turf (`pointToLineDistance` on a 2-point line) or a small
inlined haversine cross-track formula (faster per call, since we now call it only
a handful of times instead of 62k).

Note: `rbush-knn`'s box distance is planar (degrees). Because 1° lng ≠ 1° lat away
from the equator, either (a) pull a slightly larger `k` and rely on the exact
`segDistKm` for the real ordering, or (b) scale x by `cos(lat)` when building/
querying. For CONUS a fixed `k` of ~16 with exact refinement is simple and safe.

## Integration

- Add `buildEdgeIndex` + `borderKmIndexed` to `state-resolver.js`.
- In `borderKm`, prefer the index when built, fall back to the current ring-walk:
  ```js
  function borderKm(entry, lat, lng) {
    if (process.env.GEO_EDGE_INDEX === '1') { EDGE_INDEX ??= buildEdgeIndex(loadFull()); return borderKmIndexed(lat, lng); }
    /* ...existing per-ring walk... */
  }
  ```
- Gate it behind an env flag / lazy build so the containment-only path and
  low-volume callers pay nothing. Only build the index when distance-at-volume is
  actually needed.
- Add `rbush` (and `rbush-knn`) to `src/package.json`.

## Expected result

Near-border distance drops from ~35 ms (163 ms worst) to **tens of microseconds**
per query, at the cost of a one-time index build (~few hundred ms) and extra
resident memory for the segment index. Containment is untouched.

## Alternative: precomputed distance raster

If you want O(1) with no per-request geometry at all: bake a coarse lat/lng grid of
"distance to nearest border" offline and look up the cell. Tiny memory, constant
time, but approximate at cell resolution — exact-compute (via the edge index or
ring walk) only for the cells a border actually crosses. Heavier to build and
maintain; prefer the edge index unless request volume is extreme.

## When to bother

- **Not needed** for the map's one-lookup-per-idle usage — the ring-walk is fine.
- **Do it** if `state-lookup` starts serving distance on every call, runs bulk
  jobs, or fronts a high request rate. Keep it flag-gated so it's opt-in.
