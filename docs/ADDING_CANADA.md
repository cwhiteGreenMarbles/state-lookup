# Adding Canada (Statistics Canada provinces)

`state-lookup` currently ships US states only (TIGER). To cover the
`CA…` → `residential_data_CAN` path, add Canadian provinces/territories as
`CA-<PR>` features in both tiers. The runtime code needs **no changes** — the
resolver derives `country` from the `code` prefix (`code.slice(0,2)`), so once the
GeoJSON contains `CA-ON`, `CA-BC`, … it "just works". This is a build-step change.

## 1. Source data

**Statistics Canada — Provinces/Territories boundary file (2021 Census).**

- Cartographic (generalized, smaller): `lpr_000b21a_e` —
  `https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpr_000b21a_e.zip`
- Digital (full precision, larger): `lpr_000a21a_e` — same path, `...a21a_e.zip`.
  Prefer this if you want the same "authoritative to the legal line" property the
  US TIGER tier gives near borders.

**License:** Statistics Canada Open Licence — free to use/redistribute **with
attribution**. (This is a small caveat vs. the US TIGER data, which is public
domain. Add a StatCan attribution line to the repo NOTICE/README.)

## 2. Two gotchas

1. **Projection.** StatCan files are in *Statistics Canada Lambert*
   (EPSG:3347), **not** lat/lng. They MUST be reprojected to WGS84 (EPSG:4326)
   or every point-in-polygon test is nonsense. mapshaper reads the `.prj` and
   reprojects with `-proj wgs84`.
2. **Province code.** The field we want (`ON`, `BC`, …) isn't a clean 2-letter in
   the file — `PREABBR` is `"Ont."`, `"B.C."`, etc. Map from the stable numeric
   `PRUID` instead (table below).

### PRUID → postal code
| PRUID | Code | Province/Territory |
|------|------|--------------------|
| 10 | NL | Newfoundland and Labrador |
| 11 | PE | Prince Edward Island |
| 12 | NS | Nova Scotia |
| 13 | NB | New Brunswick |
| 24 | QC | Quebec |
| 35 | ON | Ontario |
| 46 | MB | Manitoba |
| 47 | SK | Saskatchewan |
| 48 | AB | Alberta |
| 59 | BC | British Columbia |
| 60 | YT | Yukon |
| 61 | NT | Northwest Territories |
| 62 | NU | Nunavut |

## 3. Build steps

Get and unzip the file:
```
curl -O https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lpr_000b21a_e.zip
unzip lpr_000b21a_e.zip
```

Convert + reproject + stamp `code`/`country`, producing full and coarse Canadian
GeoJSON (mirrors what `build-boundaries.js` does for the US):
```
PRUID_MAP='var m={"10":"NL","11":"PE","12":"NS","13":"NB","24":"QC","35":"ON","46":"MB","47":"SK","48":"AB","59":"BC","60":"YT","61":"NT","62":"NU"};'
STAMP='this.properties={code:"CA-"+m[String(PRUID)],name:PRENAME,country:"CA"}'

# full-res
npx mapshaper lpr_000b21a_e.shp -proj wgs84 -each "$PRUID_MAP $STAMP" \
  -o format=geojson ca_full.geojson
# coarse (match the US coarse tolerance)
npx mapshaper lpr_000b21a_e.shp -proj wgs84 -simplify dp 1% keep-shapes -each "$PRUID_MAP $STAMP" \
  -o format=geojson ca_coarse.geojson
```

## 4. Merge into the two tiers

The tiers are plain `FeatureCollection`s. Concatenate the Canadian features into
the US ones before the `postProcess` step (close rings + feature bbox). The
cleanest place is inside `build-boundaries.js` — see the `TODO(Canada)` marker.
Sketch:

```js
// after producing the US raw geojson, and the CA raw geojson above:
function mergeInto(usRawPath, caRawPath) {
  const us = JSON.parse(fs.readFileSync(usRawPath, 'utf8'));
  const ca = JSON.parse(fs.readFileSync(caRawPath, 'utf8'));
  us.features.push(...ca.features);
  fs.writeFileSync(usRawPath, JSON.stringify(us));
}
mergeInto(rawFull,   'ca_full.geojson');
mergeInto(rawCoarse, 'ca_coarse.geojson');
// then postProcess(rawFull -> states-full.geojson) etc. as today
```

(Or do it in mapshaper: `npx mapshaper us.shp ca.shp combine-files -proj wgs84
-merge-layers ...` — but two inputs with different CRSs make the JS concat after
per-file reprojection the less error-prone path.)

## 5. Size note

Canada's coastline is enormous — the digital full-res provinces file can dwarf the
US 21 MB. If you use the digital variant, simplify **coastline** aggressively while
keeping the US-facing land border tight (the only Canadian borders that decide a
`US-XX` vs `CA-XX` classification are the 49th parallel and the eastern
provinces). The cartographic (`b`) file is already generalized and is the safer
default unless you specifically need legal-line precision on the US/Canada border.

## 6. Test points

Add to `test.js`:
```
[43.6532, -79.3832, 'Toronto            (expect CA-ON)'],
[49.2827, -123.1207,'Vancouver          (expect CA-BC)'],
[42.3149, -83.0364, 'Windsor ON near Detroit (expect CA-ON, US/CA border)'],
[45.5019, -73.5674, 'Montreal           (expect CA-QC)'],
```
The Windsor/Detroit pair is the important one: it verifies the fine tier
distinguishes `CA-ON` from `US-MI` across the river border.

## 7. Backend note

The consumer routes any `location` whose country prefix is `CA…` to
`residential_data_CAN` (`userController.js:24360`). Emitting `CA-<PR>` satisfies
both that check and any `Homes.<PR>` province-scoped lookup. No resolver change is
required; just confirm `extractLocation`'s expected delimiter if you also swap the
callers (see the format-parity TODO).
