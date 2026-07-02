# Validation Results

Validation of the `state-lookup` binary resolver against five independent data
sources, run **2026-07-01** against TIGER2025-built artifacts. Every sweep uses
the same methodology (see "Bucketing" below).

## Summary ledger

| # | Dataset | Ground truth | Points | States | Result |
|---|---------|--------------|--------|--------|--------|
| 1 | GeoJSON+turf reference resolver | same TIGER data, independent code path | ~29,000 random (CONUS/AK/HI/dateline) | — | **0 containment mismatches**, distance ≤0.01 km max |
| 2 | US Census Gazetteer places (2025) | Census USPS state per place | 32,350 | all 50 + DC + PR | **100.0000% interior, 100.0000% near-border** |
| 3 | OpenStreetMap place nodes | OSM ISO3166-2 boundary relations (fully independent lineage) | 480 | 4 (Overpass rate-limited) | **100%** |
| 4 | OpenAddresses (all 4 US regions) | source state directory | 33,164 | 51 | **100%** excluding one provably-misfiled source file (see findings) |
| 5 | Production `Homes.<STATE>` MongoDB | the state collection each doc lives in | 81 (populated collections: OH/FL/WI/MO) | 4 | **100% of valid coordinates** (62/62) |

Combined: **~95,000 labeled points, zero resolver errors.** Every apparent
failure traced to an error in the *source data*, which the resolver exposed
(see "Data errors found").

## Bucketing (used by every sweep)

- **Interior** — resolver's `distanceKm > 2`: the resolved state must equal the
  label exactly.
- **Near-border** — `distanceKm <= 2`: the label must be the resolved state OR
  one of its `bordersWith` neighbors. Rationale: labeled points can legitimately
  sit on the line, and boundary datasets differ by meters there; a stricter rule
  would count dataset disagreement as resolver error.
- Junk coordinates (null-island ~(0,0), out-of-range) are counted separately,
  never as passes.

## Data errors found (resolver as auditor)

The sweeps surfaced upstream data problems — in each case the resolver's answer
was verified correct and the source was wrong:

1. **`Homes.MO`** (production Mongo) contains exactly one document — and its
   coordinates are in **Columbus, Ohio** (145.5 km inside OH). Misfiled shard row.
2. **`Homes.OH` / `Homes.WI`** contain **null-island rows** (~lat 0.00004,
   lng 0.00008): 3/30 sampled in OH, **15/25 in WI**. Looks like a persisted
   failed-geocode default.
3. **OpenAddresses `us_west/us/nm/sandoval.csv`** contains **San Diego, CA**
   data (lng ≈ −117), not Sandoval County NM (lng ≈ −106.5). All 120 sampled
   rows resolved `US-CA` with Mexico (`borderWith: null`) to the south —
   consistent and correct.
4. **`Homes` collection list** includes garbage shards (`-`, `AY`, `ED`, `LL`,
   `RA`, `TE`, a literal `Homes.TX` name) — likely created over time by
   `location.slice(-2)` on malformed `location` values.

## How to run each sweep

All scripts live in `scripts/` and require the built binary artifacts
(`npm run build && npm run build:binary` first, or a repo where `layer/geo/` is
already populated). Tier-0 (reference equivalence + 38 fixed assertions) is
`npm run validate:binary`.

### 1. Census Gazetteer — every state, one download (recommended regression gate)

```bash
curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip
unzip 2025_Gaz_place_national.zip
node scripts/validate-gazetteer.js ./2025_Gaz_place_national.txt
```
Public domain, ~3 MB, ~32k places, all 50 states + DC + PR. Runs in ~40 s.
Exit code 1 on any state with failures — suitable for CI / `refresh-data.sh`.
(2025 vintage is pipe-delimited; the script auto-detects older tab-delimited vintages.)

### 2. OpenAddresses — real address points (~33k sampled)

```bash
# download region collections from https://batch.openaddresses.io/data
# unzip us_midwest / us_northeast / us_south / us_west under one root
node scripts/validate-openaddresses.js /path/to/openaddresses-root
```
Samples 6 random county files × 120 random rows per state (tune with
`OA_FILES` / `OA_ROWS` env vars). License: ODbL — validation use with
attribution; review share-alike before redistributing derived data.
**When a failure appears, check the source file first** — inspect its longitude
range; misfiled county files are a known OpenAddresses issue.

### 3. OpenStreetMap — independent-lineage spot check

```bash
node scripts/validate-osm.js /tmp/osm-points.json            # fetch (resumable) + validate
node scripts/validate-osm.js /tmp/osm-points.json --no-fetch # re-validate cached points
```
Queries Overpass for `place` nodes inside each state's ISO3166-2 boundary
relation. **Public Overpass endpoints rate-limit hard** (429s); the cache file
makes re-runs resume. Treat as a spot check, not the bulk gate — for full
coverage at scale use Geofabrik per-state extracts instead.

### 4. Production Homes audit (MongoDB)

Sample coordinates from the per-state collections and compare to the resolver
(read-only; skip `PII_*` collections):

```js
// per populated Homes.<ST> collection:
//   db.getSiblingDB('Homes').getCollection(ST).aggregate([
//     { $sample: { size: N } },
//     { $project: { _id: 0, latitude: 1, longitude: 1 } },
//   ])
// then for each doc (coords are STRINGS in Homes — Number() them):
//   const r = resolveState(Number(latitude), Number(longitude));
//   flag if r.code?.slice(-2) !== ST  (or coords are null-island)
```
At ~65 µs/containment this can sweep a full 127k-doc collection in seconds —
usable as a standing data-quality audit, not just validation.

## Caveats / honest notes

- Sweeps #1 and #2 share ancestry with TIGER at the *organization* level
  (Census), but the labels are administrative attributions, not derived from our
  boundary-file processing — they validate the whole build+runtime pipeline.
  #3 (OSM) and #4 (OpenAddresses) are independent lineages.
- The Homes check has mild circularity: rows were originally placed in state
  collections by the old Google-derived resolution, so agreement there partly
  reads "we agree with Google's assignments" — still exactly the compatibility
  that matters for the migration.
- The Mongo cluster sampled appears to be a dev/partial dataset (most state
  collections empty); production rates may differ.
- Near-border tolerance (2 km) is deliberately generous to absorb
  labeled-point-on-the-line and dataset-vs-dataset boundary differences; the
  fixed assertions in `validate-binary.js` cover exact on-the-line behavior.
