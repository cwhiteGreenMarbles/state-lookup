# Frontend Changes to Ease State-Resolution Call Volume

Companion to [`PROBLEM.md`](./PROBLEM.md) and [`CALLERS.md`](./CALLERS.md). This
document is the **course of action** for the client side: what to change in
`nomo-prospect-5` and `nomo-android-4` so the map stops resolving `lat/lng → state
code` more often than it needs to.

`state-lookup` removes the *per-call cost and TOS restriction* of resolution.
These frontend changes remove the *redundant calls themselves* — and, unlike the
service swap, most of them are worth doing **even before** `state-lookup` ships,
because they also cut Google quota today.

> **Scope decision:** state resolution is **always a `state-lookup` web service
> call** — there is no client-side point-in-polygon in the frontends. The clients
> do not bundle boundary data or resolve locally; every change below is about
> calling the service **less often** (caching, gating, debouncing), not moving
> resolution into the client.

## The core observation

The state code is the **least-cached value on the hottest path**, yet it is the
value that **changes least** as the user interacts. A canvasser pans and zooms
around one neighborhood for an entire session; the containing state effectively
never changes. Today every gated map-idle / region-change re-resolves it from
scratch. The fix is to resolve once and reuse until the map center has plausibly
moved far enough to cross a state line.

## Current state of each call site (what already exists)

| Call site | File:line | Gate on *fetch* | Cache on *resolve* | Fallback |
|-----------|-----------|-----------------|--------------------|----------|
| prospect-5 v2 address-layer (**hot path**) | `mainmap-v2/.../address-layer.component.ts:308` | distance (miles, `userData.distance`) + `isFetching`, **no debounce** | **none** — re-resolves every gated fetch | silent `US:MO` |
| prospect-5 v2 map-engine (cold paths) | `mainmap-v2/.../map-engine-v2.component.ts:777` | n/a (user actions) | caches `currentLocation` but **never invalidates** → stale across state lines | `US-NJ` |
| prospect-5 v1 mainmap (legacy) | `mainmap/mainmap.component.ts:1860` | **1.2 km move + 1500 ms debounce** (`:3306`, `:897`) | none | skips fetch |
| android v2 | `MapScreenV2/MapView/index.tsx:384/399/414` | distance (miles) + zoom≥14, **no debounce** | **none** — re-geocodes every gated pan, 3 duplicated branches | none → markers silently fail |

**Nobody caches the resolve correctly.** v1 has the best gating (distance +
debounce) but no cache; v2 address-layer and android have distance gates on the
*marker fetch* but re-resolve the state on every one; map-engine caches but never
lets go. Android additionally calls **Google's geocoder directly**
(`utils.ts:65`), so its redundant calls burn Google quota, not just backend load.

## Course of action (prioritized)

### 1. Cache the state code in the v2 hot path — biggest win
**File:** `nomo-prospect-5/.../address-layer/address-layer.component.ts:308`
(`resolveLocation`).

Before resolving, if a previously resolved code exists and the new center is
within a "still plausibly the same state" radius (~30–50 km) of the point where
it was resolved, **return the cached code without resolving**. Reuse the existing
`calcDistanceKm` helper (`:170`). Store `{ code, lat, lng }` at resolve time, not
just the bare `this.location` written post-fetch (`:273`).

Rationale: the marker distance gate typically passes on 1–10 mile pans that never
cross a state line, so this eliminates the large majority of hot-path
resolutions. Legal to cache once off Google.

### 2. Fix the map-engine-v2 cache to invalidate on distance
**File:** `nomo-prospect-5/.../map-engine-v2/map-engine-v2.component.ts:777`.

Same `{ code, lat, lng }` pattern as #1 — but the bug here is the opposite: it
caches once and **never invalidates**, so a canvasser who drives to a new state
keeps the stale code all session. Re-resolve when the center has moved beyond the
same radius.

**Consolidate:** hoist a single shared resolver service (wrapping `state-lookup`)
used by both address-layer and map-engine so the two stop maintaining divergent
caches *and* divergent fallbacks (`US:MO` vs `US-NJ`).

### 3. Add a debounce to the v2 idle path (port v1's pattern)
**File:** `address-layer.component.ts:128` (`onMapIdle`).

v1 already absorbs rapid pan/zoom bursts with `debounceTime(1500)`
(`mainmap.component.ts:897`) on top of its 1.2 km gate. v2's address-layer relies
only on the `idle` event + the `isFetching` re-entrancy flag. Add a 500–1000 ms
debounce so a flurry of idle events during a drag collapses to one resolve+fetch.

### 4. Android: cache `{country, state}` against last-resolved center
**File:** `nomo-android-4/.../MapScreenV2/MapView/index.tsx:384/399/414`.

First collapse the three copy-pasted geocode+fetch branches into one helper.
Then skip `getGeocodeData` when the last-resolved point is within the same ~30 km
radius. Android already has the *fetch* distance gate; it just re-geocodes every
time that gate opens. Because `utils.ts:65` hits Google directly, this cache cuts
**Google quota** immediately. Once on `state-lookup` the network `fetch` becomes a
local synchronous call — caching is then nearly free but still worth it to avoid
recompute.

### 5. Remove the silent wrong-state fallbacks and reconcile format drift
**Files:** `address-layer.component.ts:313–315` (`US:MO`), and the android catch
blocks (`index.tsx` ~388/403/418).

On resolve failure, prefer **last-known-good** state, else surface an error / skip
the fetch — never fabricate Missouri (web) or silently drop all markers
(android). While here, reconcile the delimiter/format drift observed across sites:
`US:MO` (colon) vs `US-NJ` (dash) vs android's `` `${country}-${city}` ``. The
backend shard key is the `US-XX` dash form; `state-lookup` already emits that.
Confirm against `globalService.extractLocation` before the drop-in swap (see the
Format-parity TODO in the README).

## Sequencing

- **Independent of `state-lookup`, do now:** #1, #3, #4 (caching + debounce) and
  the fallback cleanup in #5 all reduce Google call volume today.
- **With the `state-lookup` swap:** #2's shared resolver service is the natural
  seam to introduce the offline resolver behind, and #5's format-parity check is
  a prerequisite for the swap.

## Expected effect

Resolution calls drop from *once per gated map-idle* to *once per state-boundary
crossing per session* — effectively a handful per canvasser per day instead of
per pan. Combined with the `state-lookup` swap, per-call cost also goes to zero
and the result becomes freely cacheable, closing the loop the problem statement
opened.
