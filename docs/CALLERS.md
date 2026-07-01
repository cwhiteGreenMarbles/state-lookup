# Callers — where state resolution happens today

This inventories the client call sites that resolve `lat/lng → US state code`
today (via the Google reverse-geocode), i.e. the callers `state-lookup` is meant
to replace. Line numbers are from tracing the workspace; treat them as anchors,
not guarantees. iOS (`nomo-prospect-ios`) is excluded — it is being retired.

Two mechanisms feed the state code:
- **REST:** `apiService.getAddressByCoords(lat,lng)` → `globalService.extractLocation()` → `US:XX` / `US-XX`
- **SDK:** `google.maps.Geocoder` (web) / `maps/api/geocode/json` fetch (android)

The resolved code lands in the `location` field of `POST /users/getNearestLocations`
and other state-scoped calls; the backend uses only `location.slice(-2)`.

---

## 1. Primary target — the high-volume hot path

These fire on essentially every qualifying map-idle / region-change, are uncached,
and dominate call volume. **State code only → fully replaceable by `state-lookup`.**

| Client | File:line | Trigger | Consumes → |
|--------|-----------|---------|------------|
| prospect-5 v2 | `mainmap-v2/components/address-layer/address-layer.component.ts:308` (`resolveLocation`) | map `idle` → `fetchMarkers` | `getNearestLocations` `location`; fallback `US:MO` |
| android v2 | `screens/MapScreenV2/MapView/index.tsx:384 / :399 / :414` (`getGeocodeData`) | `handleRegionChangeComplete` | `fetchMarkers` → `getNearestLocations` |
| android v2 | `screens/MapScreenV2/MapView/hooks/useMapInitialization.ts:106` | initial zoom to user | first `fetchMarkers` |
| android v2 | helper `screens/MapScreenV2/MapView/utils.ts:65` (`getGeocodeData`, reverse) | — | used by the above |

Android assembles the payload in `MapView/hooks/useMarkers.ts:101/104`
(`state` + `location = "US-<ST>"`).

---

## 2. Other state-resolution callers (cold paths) — also replaceable

State code only; lower volume (user actions, not panning). Same drop-in swap.

### prospect-5 mainmap-v2
| File:line | Purpose |
|-----------|---------|
| `map-engine-v2/map-engine-v2.component.ts:777` (`resolveLocation`, cached `currentLocation`) | feeds the five below |
| `map-engine-v2.component.ts:329` | `autoFixColeLocation(addressHash, location, …)` |
| `map-engine-v2.component.ts:367` | `getLocationDetails({AddressHashes, location})` |
| `map-engine-v2.component.ts:417` | `correctColeLocation(…, location)` (marker dragend) |
| `map-engine-v2.component.ts:589` | `location` field of the add-address drawer payload |
| `map-engine-v2.component.ts:730` | `bulkAutoFixColeLocation(markersPayload, location)` |
| `v2-save-area-drawer/v2-save-area-drawer.component.ts:88` | `saveAreaCoordinates` `location` (create area) |
| `area-layer/area-layer.component.ts:311` | `saveAreaCoordinates` `location` (edit area) |

### prospect-5 mainmap-v1 (legacy; same mechanism)
| File:line | Purpose |
|-----------|---------|
| `mainmap/mainmap.component.ts:1867` (`getNearsetLocation`) | sets `this.location` → `getNearestLocations` (`:1870/2618`). Hot path (bounds-change, 1.2 km + 1500 ms gated). No fallback (skips fetch on error). |
| `mainmap.component.ts:1005` (`getRoofDetail`) | sets `this.location` for `getRoofByLoc` |
| `mainmap.component.ts:3973` (`onMapClick` add-pin) | sets `this.location` |
| reads of `this.location` → | `getRoofByLoc` (`:1013`, `:1650`), `analyzeAreaProperties` (`:1966/2046/2092`), `getLocationDetail` (`:2368/2372/3722/3732`), `getLocationDetailsMultiple` (`:3684/3690`), `getLocationDetailOld` (`:3739`), `saveAreaCoordinates` (`:4182`), `autoFixColeLocation` (`:4756`), `bulkAutoFixColeLocation` (`:4896`) |

---

## 3. NOT replaceable by `state-lookup` (need full address / neighborhood)

These geocodes extract street/city/zip or neighborhood+viewport — more than a
state code — and must remain real geocodes. Listed so the migration doesn't touch
them by mistake.

| Client | File:line | Needs |
|--------|-----------|-------|
| prospect-5 v2 | `map-engine-v2.component.ts:601` (`reverseGeocode`, `google.maps.Geocoder`) | street/city/state/zip for add-address drawer |
| prospect-5 v2 | `v2-search-drawer/v2-search-drawer.component.ts:49` (Places Autocomplete) | forward address search |
| prospect-5 v1 | `mainmap.component.ts:3905` → `formatAddress:3917-3942` (`addNewHome`) | street/zip/city/state |
| android v2 | `screens/MapScreenV2/.../ObservationDetailSheet.tsx:98` + `MapView/utils.ts:98` (`getNeighborhoodAndViewport`) | neighborhood name + viewport for "Create Area" |

---

## 4. The geocode wrappers (where the Google call actually lives)

| Client | File:line |
|--------|-----------|
| prospect-5 | `services/api.service.ts:1549` `getAddressByCoords` (reverse), `:1540` `getAddress` (forward) — hardcoded key |
| android | `app/utils/geocode.ts:5` `getCountryCity` (reverse), `:37` `getCoordinatesFromAddress` (forward) |

Centralizing the swap here (or in `globalService.extractLocation`) converts all of
§1–§2 at once while leaving §3 on Google.

---

## 5. The backend consumer (the callee)

`POST /users/getNearestLocations` — `nomo-prospect-lambdas/nomo-prospect-api`:
- route `routes/users.js:383`, handler `controllers/userController.js:1867`
- `location.slice(-2)` selects the per-state shard:
  - `Homes.<STATE>` `$geoNear` — `userController.js:24309` (called `:1939`)
  - `residential_data_<state>` dispositions — `userController.js:24360`
    (special case: `CA…` country prefix → `residential_data_CAN`)

`state-lookup` produces the exact `location` value this contract expects, so the
callee is unchanged.
