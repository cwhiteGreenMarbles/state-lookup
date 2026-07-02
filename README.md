# state-lookup

Resolve a `lat/lng` to the US state / Canadian province that contains it (and the
distance to that state's border) **entirely offline** — no Google, no external
geocoder. Point-in-polygon against US Census **TIGER** boundaries.

Built to replace the high-volume client-side Google reverse-geocode whose only
purpose was to derive the `US-XX` state code for `getNearestLocations`
(`userController.js` does `location.slice(-2)` to pick the per-state
`Homes.<STATE>` / `residential_data_<state>` collections). See `docs/PROBLEM.md`
and `docs/CALLERS.md`.

## How it answers a point (single binary path)

The runtime uses **precreated binary artifacts** — there is no GeoJSON parse and
no index build at cold start, and no coarse/fine tiering:

1. **Containment** — an exact even-odd ray-cast over the geometry buffer
   (`geom.f64`) gives the authoritative state. ~tens of µs.
2. **Distance to border** — a precreated **Flatbush** R-tree over every border
   *segment* (`edges.flatbush`) finds the nearest segment. Flat ~0.1–0.2 ms
   regardless of state size (it never walks a whole state's border).

```
resolveState(39.0997, -94.5786)
// { code: 'US-MO', country: 'US', distanceKm: 2.47, nearBorder: true,
//   borderPoint: { lat: 39.099701, lng: -94.607136 }, borderWith: 'US-KS' }
```

**Response contract:** `{ code, country, distanceKm, nearBorder, borderPoint, borderWith, bordersWith }`
- `code`/`country` are `null` offshore (point in no state/province).
- `distanceKm` is ALWAYS the distance to the nearest border segment — for
  offshore points that is the distance to the nearest coast. It is `null` only
  if the index is empty.
- `nearBorder` = `distanceKm <= GEO_TRUST_KM` (default 3 km).
- `borderPoint` = the nearest `{lat,lng}` ON that border (offshore: the nearest
  coastline point — usable for snapping stray pins to land).
- `borderWith` = the state/province across that border (e.g. `US-KS` for a
  Kansas City MO point). `null` means water or a non-US neighbor (Canada/Mexico,
  until those boundaries are added to the dataset).
- `bordersWith` = ALL states meeting at `borderPoint`, minus the containing one
  (`borderWith` listed first). One entry on a normal border; three at Four
  Corners (`["US-AZ","US-CO","US-UT"]` for a New Mexico corner point); empty on
  a coast / foreign border.
- The distance search self-expands (k-doubling with a planar lower bound) so the
  geodesically nearest segment is never missed at high latitude, and re-queries
  wrapped by 360° near the antimeridian (Aleutians).
- Data loads eagerly at require time (Lambda init phase); set `GEO_LAZY=1` to defer.

Measured: containment matches the GeoJSON+turf ground truth on multi-region
random sampling — CONUS, Alaska, Hawaii, dateline (**0 mismatches**); cold-start
load **~20 ms** (vs ~300 ms to parse the 21 MB GeoJSON); per call **0.01–0.2 ms**.
See `docs/CODE_REVIEW_FINDINGS.md` for the review that hardened this path.

> The coarse→fine tiering was an earlier design; the binary index makes fine work
> cheap and flat, so the service collapses to one path. `GEO_TRUST_KM` now only
> sets the `nearBorder` label. (Coarse survives solely as an optional *client-side*
> bundle — see `docs/INDEX_IMPROVEMENT.md`.)

## Layout

```
state-lookup/
  src/                     # <-- the deployable function (CodeUri: src/)
    index.js               # Lambda handler + re-exports resolveState for in-process use
    binary-resolver.js     # runtime core: containment ray-cast + Flatbush distance
    package.json           # runtime dep: flatbush ONLY
  layer/geo/               # <-- SAM LayerVersion (ContentUri: layer/), mounts at /opt/geo
    geom.f64               # runtime: all ring coords (Float64)           [git-ignored]
    geom-meta.json         # runtime: codes + per-feature bbox/ring index [git-ignored]
    edges.flatbush         # runtime: precreated Flatbush segment index    [git-ignored]
    edges-start.u32        # runtime: per-segment start point index        [git-ignored]
    edges-cid.u16          # runtime: per-segment state index              [git-ignored]
    # layer contains ONLY runtime artifacts — nothing else ships
  data/                    # <-- GeoJSON build sources; NOT deployed
    states-coarse.geojson  # committed (~0.19 MB); also the client-bundle option
    states-full.geojson    # git-ignored (~21 MB); regenerate via `npm run build`
  build-boundaries.js      # TIGER .shp  -> data/states-{full,coarse}.geojson
  build-binary.js          # data/states-full.geojson -> layer/geo binary artifacts
  reference/
    state-resolver.js      # TEST-ONLY GeoJSON+turf resolver (ground truth); NOT deployed
  validate-binary.js       # proves binary == reference + measures cold start
  local-server.js          # run locally without AWS (`npm start`)
  test.js                  # smoke test + timing (`npm test`)
  template.yaml            # SAM function + boundary layer (API Gateway deferred)
```

## Data storage

The runtime reads **precreated binary buffers** once per warm container
(`fs.readFileSync` → typed-array views; `Flatbush.from` is O(1)), cached at module
scope. Data dir resolves via `GEO_DATA_DIR` → `../layer/geo` (local) → `./data`.

- Binary artifacts (`geom.f64`, `geom-meta.json`, `edges.*`) are **git-ignored**
  and regenerated by `npm run build:binary`. They are the *only* files the runtime
  needs; ship just these in the layer.
- The `*.geojson` are **build-time source** (and the test-only reference resolver /
  optional client bundle), not runtime assets.
- The function zip bundles only `index.js`, `binary-resolver.js`, and `flatbush`.

## Build

```
# 1. authoritative source (public domain)
curl -O https://www2.census.gov/geo/tiger/TIGER2025/STATE/tl_2025_us_state.zip
unzip tl_2025_us_state.zip

# 2. deps
npm run install:fn      # flatbush into src/node_modules (runtime)
npm install             # turf into ./node_modules (test-only reference + validation)

# 3. generate GeoJSON tiers, then the binary runtime artifacts
npm run build           # TIGER .shp -> data/states-{full,coarse}.geojson
npm run build:binary    # states-full.geojson -> layer/geo/{geom.f64,edges.*,...}

# 4. verify
npm test                # binary smoke test + timing
npm run validate:binary # equivalence vs reference + cold-start numbers
```

**Or all of the above in one step** (TIGER releases annually, ~September):

```
npm run refresh-data          # auto-detects the newest vintage on the Census server
./refresh-data.sh 2025        # or force a specific vintage
```

Downloads the newest TIGER states file, rebuilds `data/` + `layer/geo/`, runs the
smoke test and full validation, and removes superseded vintages. Afterwards review
`git status`, bump vintage references if the year changed, commit, republish the layer.

## TODO

- **Canada:** add Statistics Canada provinces (`country:"CA"`), then rebuild the
  binary artifacts. See `docs/ADDING_CANADA.md` (build hook in `build-boundaries.js`).
- **Format parity:** confirm the emitted `US-XX` delimiter matches
  `globalService.extractLocation` before using as a drop-in for `slice(-2)` callers.
- **API Gateway:** add the `Events: Api` block in `template.yaml` when exposing over HTTP.
