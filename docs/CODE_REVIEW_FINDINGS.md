# Code Review Findings — 2026-07-01

High-effort multi-agent review of the repo (22 agents; every finding below was
independently adversarially verified — all 10 are CONFIRMED). Ranked most-severe
first. Scope: runtime = `src/binary-resolver.js` + `src/index.js`; build scripts,
reference resolver, and test harnesses reviewed for build/runtime consistency.

---

## Real correctness bugs (runtime path)

### 1. kNN ranks in planar degrees but scores in km → distance overestimated at high latitude
**`src/binary-resolver.js:76`**

`Flatbush.neighbors()` orders candidates by raw degree distance, but `segDistKm`
applies `cos(lat)`. At higher latitudes (MT, ND, AK) the geodesically nearest
segment can fall outside the `GEO_KNN=16` candidate set entirely, so `distanceKm`
comes back too large and **`nearBorder` flips to `false` for points genuinely
within `GEO_TRUST_KM` of a state line** — the exact signal consumers would use to
decide trust. Same mechanism fires when 16+ long diagonal segments' bounding boxes
contain the point (box distance 0) and outrank the truly nearest short segment.

**Fix direction:** scale x by `cos(lat)` when querying (requires building the
index in scaled space, or over-fetch + expanding-radius search that terminates
when the next candidate's box distance in km exceeds the best true distance).

### 2. No antimeridian wrap
**`src/binary-resolver.js:74`** (also `:67`, `:80`)

Points near ±180° (western Aleutians) see segments across the dateline as ~360°
away; both the kNN query and `segDistKm` exclude them → wildly wrong distances in
that region (e.g. (51.9, −179.95) between Amchitka and Semisopochnoi). Only
matters if far-west Alaska is ever in scope; cheap to guard (query both
`lng` and `lng ± 360`, wrap Δlng in `segDistKm`).

### 3. Offshore contract drift vs the reference resolver
**`src/binary-resolver.js:92`** (also `:94`)

Reference returns `{distanceKm:null, nearBorder:true, escalated:true}` offshore;
binary returns a **numeric** distance-to-nearest-coast with
`nearBorder:false, escalated:false`, and `tier:'binary'` instead of
`'coarse'/'fine'`. Any consumer written to the documented reference contract
(`escalated === true || distanceKm === null` ⇒ "don't trust this") will treat
offshore as confidently-resolved-with-null-code.

**Decision needed:** either match the reference contract, or (better) keep the
numeric distance — it is more useful — and update the documented contract +
README example to match.

### 4. `Number(null)` / `Number('')` coerce to (0,0)
**`src/index.js:18`** (same coercion in `local-server.js:10`)

Missing/empty coords pass `Number.isFinite` validation as `(0,0)` and resolve a
point in the Gulf of Guinea, returning `200 {code:null, distanceKm:<thousands>}`
instead of `400`. Callers cannot distinguish bad input from genuinely offshore.

**Fix direction:** reject `null`/`''`/whitespace before coercion (e.g.
`typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')`).

### 5. No lat/lng range validation
**`src/index.js:19`**

`lat=200` or `lng=999` passes `Number.isFinite` and returns 200 with meaningless
output. Bounding `|lat| ≤ 90` and `|lng| ≤ 180` would also catch **every swapped
lat/lng row for the continental US** (|lng| > 90 there) — a recurring upstream
data problem in this workspace (see the hail-notify polygon history).

---

## Test / reference infrastructure (these hid #1–2)

### 6. Ground-truth resolver's ring prune is itself buggy
**`reference/state-resolver.js:78`**

The prune uses a fixed 50 km cap with a longitude overestimate (111 km/deg, no
`cos(lat)`) and skips any ring beyond the cap once *any* min exists — even when
that ring could still beat the current min. Coarse-tier reference distances can
be badly wrong for interior points of large states (e.g. reports 200 km when the
true answer is 37 km). Fine-tier comparisons in `validate-binary.js` are
unaffected (the prune cannot misfire under 50 km with min unset).

### 7. Validation harness samples CONUS only
**`validate-binary.js:26`**

Sampling is lat 25–49, lng −125..−67, so Alaska and Hawaii — exactly where
findings #1 and #2 bite — are never exercised, while the harness certifies
"sub-km p99 equivalence." The reported equivalence numbers are true **for CONUS
only**. Add AK (incl. Aleutians/antimeridian) and HI sample regions plus a few
fixed regression points.

---

## Cleanups

### 8. `local-server.js` duplicates the handler instead of delegating
**`local-server.js:10`**

Reimplements parse/validate/respond and has already drifted (different error
message, missing the CORS header). Dev testing exercises different code than the
deployed Lambda; any handler fix (e.g. #4/#5) silently won't apply locally.
Simpler: `const { handler } = require('./src'); const r = await handler({ queryStringParameters: q }); res.writeHead(r.statusCode, r.headers); res.end(r.body);`

### 9. `readTyped` copies every buffer unnecessarily
**`src/binary-resolver.js:25`** (also the Flatbush load at `:38`)

Large `readFileSync` buffers are non-pooled (byteOffset 0, exclusive
ArrayBuffer) and usable as-is; the unconditional `ArrayBuffer.slice` copy means
cold start transiently holds ~2× the ~15 MB geometry. Use the buffer directly
when aligned/exclusive; copy only for pooled small buffers.

### 10. Buffers lazy-load in the first invocation, not at module scope
**`src/binary-resolver.js:21`**

Lambda's init phase gets boosted CPU and different billing; deferring
`loadGeom()/loadIndex()` to the first `resolveState` call moves the data load
into the first user-facing request. Call both at module scope (as `test.js`
already does to warm).

---

## Suggested priority for Nomo's actual usage (CONUS canvassing)

Fix before wiring consumers to this service:
- **#1** — corrupts `nearBorder` in northern states, not just Alaska
- **#3** — contract decision (recommend: keep numeric offshore distance, update docs)
- **#4 + #5** — trivial input validation; catches the workspace's known swapped-coords problem
- **#7** — so validation would actually catch #1's regression class

Then: **#8–#10** quick hygiene; **#2** only if Alaska enters scope; **#6** when the
reference's coarse tier is next used as a baseline.

---

## Fix status (2026-07-01, same day)

All 10 findings addressed:

| # | Fix |
|---|-----|
| 1 | `borderKm` now uses an expanding kNN search (k-doubling): candidates re-scored in km, terminating only when the planar-degree lower bound (`min(kx,ky) × boxDistDeg` of the furthest returned candidate) exceeds the best km found — provably cannot miss the nearest segment at any latitude. |
| 2 | `segDistKm` wraps longitude deltas to (−180, 180]; queries with `|lng| > 170` re-run from the ±360°-wrapped position so cross-dateline segments are retrievable from the index. Aleutian pass point now returns ~14 km (was ~hundreds). |
| 3 | Contract simplified and documented in README: `{ code, country, distanceKm, nearBorder }`; `tier`/`escalated` dropped; offshore keeps the (useful) numeric distance-to-coast, explicitly documented. |
| 4 | `parseCoord` in `src/index.js` rejects `null`/`''`/whitespace before coercion. |
| 5 | `parseCoord` enforces `lat ∈ [−90,90]`, `lng ∈ [−180,180]` → 400 on out-of-range (catches swapped lat/lng for CONUS). |
| 6 | Reference `borderKm` prune replaced: km-scaled lower bound (`cos(lat)`, 0.99 slack) compared against the current min — pruning can no longer change the result; fixed 50 km cap removed. |
| 7 | `validate-binary.js` samples CONUS + Alaska + Hawaii + a dateline strip, and adds fixed regression assertions for #1, #2, #4, #5 and Hawaii containment. |
| 8 | `local-server.js` delegates to the exported Lambda handler (identical validation/headers/shape). |
| 9 | `readTyped` uses the Buffer's own ArrayBuffer when aligned (large `readFileSync` buffers are non-pooled); copies only pooled/misaligned buffers. Same for the Flatbush load. |
| 10 | Geometry + index eager-load at module scope (Lambda init phase); `GEO_LAZY=1` opts out. |
