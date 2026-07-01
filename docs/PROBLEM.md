# Problem Statement — Offline State Resolution (`state-lookup`)

## Background
The Nomo canvassing map (prospect-5 mainmap v1/v2 and the android MapScreen
equivalents) fetches nearby homeowner records as the user pans and zooms. The
backend that serves those records, `POST /users/getNearestLocations`, is
**partitioned by US state**: it uses the caller-supplied `location` value
(`location.slice(-2)`) to select which physical collection to query —
`Homes.<STATE>` for the address points and `residential_data_<state>` for dealer
dispositions. So before the map can fetch anything, it must know **which state the
current map center is in**.

Today the clients derive that state by calling the **Google Geocoding API** — a
reverse geocode of the map-center lat/lng — and parsing
`administrative_area_level_1` into a `US-XX` code.

## Problem
Using a full geocoding API to obtain a two-letter state code is the wrong tool,
and it's on the hottest path in the app:

1. **High call volume, uncached.** The reverse geocode fires on essentially every
   qualifying map-idle/region-change (`address-layer.component.ts:308`, android
   `MapView/index.tsx:384/399/414`). The result is never cached — panning back and
   forth over the same city re-hits Google every time. State rarely changes, yet
   it's the least-cached value on the path.
2. **Cost and latency.** Every lookup is a billable Google request plus a network
   round-trip (tens of ms) in front of the marker fetch, scaling with active
   canvassers and map interactions.
3. **Legally un-cacheable.** Google's Terms prohibit storing/persisting geocoding
   results, so the obvious fix — cache the state code — isn't available against
   Google-derived data.
4. **Silent wrong-data failure mode.** On geocode error, v2 falls back to a
   hardcoded `US:MO`, which makes the backend query **Missouri's** collections
   regardless of where the user actually is — returning wrong or empty markers with
   no error surfaced.
5. **Massive overkill.** A geocode returns full street/city/zip; the consumer needs
   only the state. We pay for a precise address lookup to extract one field.

## Why it matters
This is a per-interaction cost multiplied across every user and every pan. It adds
latency to the core map experience, creates an unbounded and un-cacheable external
dependency and bill, and has a failure mode that silently serves the wrong region's
data.

## Constraints
- The backend contract is fixed: it needs a correct `US-XX`/`CA-XX` state (or
  province) code in the `location` field, including the existing `CA…` → Canada
  (`residential_data_CAN`) path.
- **Border accuracy is required.** Homes near a state line must resolve to the
  correct state, or the map opens the wrong shard. Generalized/approximate
  boundaries that are "miles off" are not acceptable near borders.
- Should reduce — ideally eliminate — the external geocoding dependency and its
  cost, and be legally cacheable.

## Goal
Replace the high-volume Google reverse-geocode with an **offline, authoritative
lat/lng → state-code resolver** that:
- returns the exact `US-XX`/`CA-XX` code the backend already expects (drop-in for
  `location`);
- is accurate to the legal boundary, including near state lines;
- runs locally (no external API, no per-call cost, freely cacheable);
- is fast enough for the map's per-idle call rate;
- removes the silent wrong-state fallback in favor of an explicit
  "unknown/offshore" result.

The `state-lookup` service implements this via point-in-polygon against US Census
TIGER boundaries, with a coarse/fine layered lookup for speed and an optional
distance-to-border signal for near-line handling.
