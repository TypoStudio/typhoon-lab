# Data sources

This file covers third-party data, which keeps its own terms. The project's own work is licensed under CC BY-NC-SA 4.0 (see [LICENSE](LICENSE)); open-source libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Generated files in `src/data/generated/` that only reformat a source are covered by that source's terms; our selection, processing and additions are covered by `LICENSE`.

Coastline geometry, city coordinates and city populations are real, from Natural Earth. New current-date worlds load NOAA GFS pressure, surface wind, ocean surface temperature and 2 m air temperature as their starting analysis. Humidity, shear, the fallback weather background, rural population and damage estimates remain game approximations, except where the historic datasets described below apply.

## NOAA GFS (current starting weather)

- Source: [NOAA/NCEP GFS](https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gfs.php), distributed through NOAA's public `global-forecast-system` Google Cloud Storage mirror. GFS runs at 00/06/12/18 UTC; these are model analyses, not continuously updated observations.
- Product: `gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.1p00.f000`. Seven analysis records are downloaded by HTTP byte range: `PRMSL:mean sea level`, `UGRD/VGRD:10 m above ground`, `TMP:surface`, `TMP:2 m above ground`, and `LAND/ICEC:surface`. Pressure is converted from Pa to hPa and temperatures from K to °C; winds remain eastward/northward m/s. GFS 1° grid points coincide with the game's odd-degree 2° cell centres, so they are sampled directly with latitude/storage order handled by the GRIB decoder. Ocean temperature uses the GFS ocean surface/skin temperature, not a standalone satellite SST product; source land cells are null and source sea-ice cells are represented at −1.8 °C. At coasts where the source mask and game land geometry disagree, missing ocean temperatures retain the game fallback.
- Decoder: `@azohra/meteo.grib` 0.1.4 (MIT). Fixtures under `tests/fixtures/gfs/` are the seven original NOAA 2026-10-27 00 UTC records and their index, downloaded on 2026-10-27, for offline decoder/browser tests.
- The browser worker tries up to four recent cycles with a shared ten-second network deadline. One validated analysis is kept in the browser Cache API. Analyses less than six hours old are reused; on network failure a saved analysis less than 48 hours old may be used and is labelled as saved. Otherwise the game uses its base climate and labels that fallback.
- The analysis is copied once into a mutable game atmosphere and preserved separately for replays. Pressure, wind and air temperature advect; air exchanges heat with the ocean and an approximate seasonal radiative equilibrium. Pressure anomalies relax over a 72-hour game timescale toward heat-driven Hadley/Ferrel/polar pressure belts and local thermal anomalies, rather than a uniform 1010 hPa. Wind adjusts over 12 hours to pressure gradients and heat-driven trade winds/westerlies/polar circulation, with hemisphere-dependent Coriolis response. Solar season and the current simulated air/ocean temperatures drive this reduced circulation model. Ocean temperatures retain the imported field plus subsequent game season/climate/tool effects, rather than being advected by atmospheric wind. When pressure tools fade, their lost contribution transfers into the evolving atmosphere, so expiring a high never restores the initial downloaded low. The circulation follows the qualitative [NOAA explanation](https://www.noaa.gov/jetstream/global/global-atmospheric-circulations); its coefficients are game approximations, not forecast skill claims. No recurring real-world data overwrites the player's world.
- No API key, geolocation or server is needed. The full global field is requested, so the request does not include a player's coordinates or game results. NOAA US-government data is public domain; NOAA GFS attribution and the cycle time are shown in the world panel.

## Natural Earth (real geometry, public domain)

| Item | Value |
| --- | --- |
| Release tag | `v5.1.2` of `nvkelso/natural-earth-vector` (the official Natural Earth vector repository) |
| Land file | `geojson/ne_50m_land.geojson`, SHA-256 `e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b` |
| Lakes file | `geojson/ne_50m_lakes.geojson`, SHA-256 `d350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52`. Rendering only: lakes are drawn as water over the land (and labelled) but the simulation, `isLand` and the grid still treat lake cells as land. |
| Rivers file | `geojson/ne_50m_rivers_lake_centerlines_scale_rank.geojson`, SHA-256 `b0b2ec37ff3057d25fc3d6324e79f5b9a076a956ef9aee6e20b2349f7ce36796` (the `_scale_rank` variant, because the plain 50m file has no `name_ko`, `name_ja`, `name_zh`, `name_zht` or `wikidataid`). Rendering only. `src/data/generated/world-rivers.json` keeps `River` features with `scalerank` 6 or lower, joined into rivers by Wikidata id (a few source streams and delta branches folded into their main river), simplified at 0.03°, pieces under 0.3° dropped. Natural Earth ranks the Yellow River, Ganges, Amur, Indus, Niger, Volga, Murray and Yenisey 3 or 4; the script ranks them 2 so the country view shows them. Names that read badly (Chang Jiang, Huang, Amazonas, ...) are overridden in `src/data/rivers.ts`. There are no rivers in Korea in this file. |
| Minor islands file | `geojson/ne_10m_minor_islands.geojson`, SHA-256 `8c933ca7a4760256bdc46408355706e39764b0fa01c160c28888b90b4faec29f`. Only its Dokdo polygon is used (lon 130.5 to 132.2, lat 37.0 to 37.7); it is added to `world-land.json` unsimplified with `"source": "ne10m"` and `"pinned": true`. Ulleungdo is already in the 50m land file; the script keeps its ring unsimplified and pinned. |
| City location file | `geojson/ne_50m_populated_places_simple.geojson`, SHA-256 `8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978` |
| Places file | `geojson/ne_10m_populated_places.geojson` (the full file, not `_simple`, because it carries `NAME_KO`), SHA-256 `9b8e3de09048ef00dfc70357dbb9fa324493f214b5e0ae4daf1aa79a8d10116b`. Source of the impact cities (coordinates of new cities, `POP_MAX` populations, Korean names) and of the display-only places layer. |
| License | Public domain, per the [Natural Earth terms of use](https://www.naturalearthdata.com/about/terms-of-use/) |
| Used for | Land polygons in `src/data/generated/world-land.json`, lake polygons and names in `src/data/generated/world-lakes.json` (lakes with `scalerank` 5 or lower or an area of 0.1 deg² or more, Caspian Sea excluded because it is already a hole in the land data; same simplification as land; Korean, Japanese and Chinese names from `name_ko`, `name_ja`, `name_zh`, `name_zht`), the impact cities in `src/data/generated/cities.json` (the 71 original coordinates come from the 50m file), and the display-only places layer in `src/data/generated/places.json`. |

Manual addition: Dongdo, the eastern island of Dokdo, is missing from the Natural Earth 10m minor islands file too. `src/data/islands.ts` adds it as a hexagon about 0.002° across at 131.8695°E 37.241°N. The Dokdo polygon in the 10m file sits a few hundred metres west of the real western island; both are drawn as published or placed by hand and only mark the islands, they are not survey data.

The GeoJSON files come from the repository's tagged copy on GitHub. They were not converted from the Natural Earth shapefile archive, and the bytes were not compared with that archive. Natural Earth's population field `pop_max` (metropolitan-area estimates, rounded to the thousand) is now the population of every impact city, including the original 71 (Tokyo is 35.7 M, not the old invented 20 M). Natural Earth v5.1.2 has no `POP_YEAR` column, so `populationYear` is 2025, as before.

Natural Earth 50m is generalized. Coastal points can fall a few kilometres from the drawn coastline. The tests allow up to 0.05° (about 5 km) for city points; New York is the furthest at about 0.035°.

## JMA best track (loading a past typhoon, attribution required)

| Item | Value |
| --- | --- |
| Source | Japan Meteorological Agency, RSMC Tokyo best track data: `https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/Besttracks/bst_all.zip` |
| Archive SHA-256 | `76b65a4210e0a9f69c6ce56b401ac572d4203c11edf1f30691a20a891353cef6` (pinned in `scripts/prepare-typhoons.mjs`) |
| Licence | JMA Public Data License 1.0, compatible with CC BY 4.0; attribution required ([JMA copyright](https://www.jma.go.jp/jma/en/copyright.html)) |
| Required statement | Source: Japan Meteorological Agency (JMA), RSMC Tokyo best track data. The data was edited and processed by TypoStudio (converted to the game's format and units, with wind estimated from pressure where missing); the Japan Meteorological Agency did not create the edited data. Shown in the game's Help > Data tab and this repository's README. |
| Used | 14 storms, written to `src/data/generated/typhoons.json` by `node scripts/prepare-typhoons.mjs` (set `TYPHOON_BST_ZIP` to use a local copy). Wind (10-min mean, kt) is converted to m/s; it is blank before 1977 and for many weak rows, and the game estimates it from central pressure there. |

KMA's machine-readable best track (data.go.kr dataset 15139453, 공공누리 제1유형) requires an API key, and the KMA yearly PDFs carry no licence mark, which is why this build ships the JMA file. Sarah (1959) has no wind records, so its wind is estimated from pressure.

## NOAA best tracks outside East Asia (past typhoons from other basins)

| Item | Value |
| --- | --- |
| Source | NOAA NHC HURDAT2: `hurdat2-1851-2025-092326.txt` (North Atlantic) and `hurdat2-nepac-1949-2025-092926.txt` (Northeast and Central Pacific) from `https://www.nhc.noaa.gov/data/hurdat/`. NOAA NCEI IBTrACS v04r01 basin files `ibtracs.{NI,SI,SP,SA}.list.v04r01.csv` from `https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/` |
| Licence | Public domain (US Government work). IBTrACS asks for a citation: Knapp et al. 2010, doi:10.1175/2009BAMS2755.1 |
| Used | 26 storms, merged into `src/data/generated/typhoons.json` by `node scripts/prepare-world-storms.mjs` (downloads once into `.cache/world-storms/`; each file's SHA-256 and fetch date go into `sources`). Run it after `prepare-typhoons.mjs`, which rewrites the file from the JMA archive alone. |
| Conversions | 6-hourly rows only. 1-minute wind (HURDAT2, IBTrACS `USA_WIND`) x 0.514444 x 0.93 = 10-minute m/s (0.93 is the WMO factor); IBTrACS `WMO_WIND` is used as is where present. Missing pressure: rows before the first known value are dropped, later gaps carry the previous value. Extratropical, disturbance, low and wave rows are grade `L`. Longitudes are -180..180. |
| Not bundled | Galveston 1900 (HURDAT2 AL031900) and Bhola 1970 (IBTrACS 1970312N12086) have no central pressure in their records. |
| Environment | None of these storms has a reanalysis environment file (the environment window covers the western Pacific only), so they run on the base climate. |

## Historical environment (loading a past typhoon, NOAA PSL)

| Item | Value |
| --- | --- |
| Atmosphere | NCEP/NCAR Reanalysis 1 daily averages, 2.5° grid, via NOAA PSL OPeNDAP. Dataset page: [data.ncep.reanalysis.html](https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html). Files under `https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface/`: `air.sig995.<year>.nc`, `rhum.sig995.<year>.nc`, `uwnd.sig995.<year>.nc`, `vwnd.sig995.<year>.nc` (sigma 0.995, about 40 m above the surface) and `slp.<year>.nc` |
| Sea surface temperature | NOAA ERSST v5 monthly means, 2° grid, `https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.ersst.v5/sst.mnmean.nc`. Dataset page: [data.noaa.ersst.v5.html](https://psl.noaa.gov/data/gridded/data.noaa.ersst.v5.html) |
| Licence | US government works published by NOAA PSL, no copyright claimed, no key needed. PSL asks users to acknowledge it: "NCEP Reanalysis data provided by the NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov". |
| Citations | Kalnay, E. et al., 1996: The NCEP/NCAR 40-Year Reanalysis Project. *Bull. Amer. Meteor. Soc.*, 77, 437–471. Huang, B. et al., 2017: Extended Reconstructed Sea Surface Temperature, Version 5 (ERSSTv5): Upgrades, Validations, and Intercomparisons. *J. Climate*, 30, 8179–8205, https://doi.org/10.1175/JCLI-D-16-0836.1 |
| Used | 14 storms, one file each in `src/data/generated/environment/<typhoonId>.json`, written by `node scripts/prepare-environment.mjs` (`npm run prepare:environment`). Sea surface temperature, near-surface (sigma 0.995) air temperature, relative humidity and wind (u, v), plus sea-level pressure for every UTC day from the day before the first track point to the day after the last. |

Units after decoding: sst and air in °C (air converted from K), rhum in %, slp in hPa (from Pa), u and v in m/s. Values are stored as integers with the `scale` object in each file (sst, air, u, v 0.01; rhum, slp 0.1). `null` means missing, which only happens for SST on land.

Grid: cell centres of the game lattice, 2° steps, odd degrees. 52 longitudes (97°E to 199°E, stored wrapped as 97 … 179, −179 … −161) by 36 latitudes (−5° to 65°), row 0 = southernmost, 1,872 cells per field per day. The window covers all 14 tracks with margin.

Resampling and caveats:

1. The reanalysis 2.5° grid is resampled to the 2° lattice by bilinear interpolation (longitude is wrapped modulo 360). The game centres do not line up with either source grid, so every value is interpolated.
2. ERSST is monthly. For each day, SST is the linear blend of the two nearest monthly fields, with each month placed at its midpoint and the day taken at 12:00 UTC. A real day's SST can differ from this by the sub-monthly variability, and ERSST is a reconstruction on a 2° grid, so cold wakes left by earlier typhoons and small eddies are not present. Where a bilinear stencil touches ERSST land, only the ocean neighbours are used (re-weighted); the cell is `null` when ocean neighbours carry less than half the weight.
3. Reanalysis 1 at 2.5° and daily mean smooths tropical cyclones heavily. Typhoon Maemi was 955 hPa near 34.9°N 128.3°E at 12 UTC on 12 September 2003; the daily mean field has about 1000 hPa as its lowest value nearby. Treat the pressure field as the environment around the storm, not as the storm itself. Wind is the 0.995 sigma level (about 40 m), not 10 m, and is likewise a daily mean.
4. Air temperature is the 0.995 sigma level value, and humidity is relative humidity at that level.
5. NOAA OISST v2.1 daily 0.25° (`.../Datasets/noaa.oisst.v2.highres/sst.day.mean.<year>.nc`, from late 1981) is reachable the same way, but is not used: ERSST is used for all storms so that Sarah (1959) and Tip (1979) are handled identically.

The script fetches the OPeNDAP ASCII responses with a concurrency of 4 and 4 retries, caches them under `.cache/environment/` (git-ignored), checks each file's time axis and grid origin against what it expects, and writes deterministic output (re-running from the cache gives byte-identical files; the `fetchedAt` date comes from the cache, not from the clock).

Total size: 14 files, 10,676,956 bytes (about 10.7 MB), 530 KB to 1.12 MB each.

## Impact cities

`scripts/prepare-map.mjs` writes `src/data/generated/cities.json`, an array of `{ id, name, nameKo, lon, lat, population, populationYear }` objects, largest first. Impact cities are the places that take part in the simulation: the population grid, damage, the World tab list and the rankings. They are every 10m populated place with `POP_MAX >= 500,000` merged with the 71 original demo cities. An original is matched to its 10m feature by name within 0.3°; it keeps its id, English name and coordinates, and its population becomes the 10m `POP_MAX`. A few originals are below 500,000 under that figure (Darwin 93 k, Suva 175 k, Laoag 207 k, Colombo 217 k, Port Moresby 284 k, Wonsan 329 k, Iloilo 388 k, Baguio 448 k) and stay as impact cities. Twin features of one metro area within 0.05° (Kansas City MO and KS) collapse into the larger one.

Ids are the ASCII name as a slug. When two cities share a slug (two San Joses, two Santiagos) both get the ISO country code appended (`santiago-chl`, `santiago-dom`), and if that still collides, rounded coordinates. Result: 1,013 impact cities, about 198 KB (57 KB gzipped). `nameKo` is Natural Earth's `NAME_KO` with the administrative suffix removed, as for places below. `names` holds `ja`, `zh-CN` and `zh-TW` from Natural Earth's `NAME_JA`, `NAME_ZH` and `NAME_ZHT`, cleaned the same way (市 and 特別市/広域市/廣域市 removed in Korea, Japan, China and Taiwan; 東京都 becomes 東京); a language is left out when the source has no name. The UI shows a `ko.ts` entry first (the original 71), then `nameKo`.

Thresholds:

| Threshold | Value | Effect |
| --- | --- | --- |
| Impact city | `POP_MAX >= 500,000` (plus the 71 originals) | Population grid, damage, ranking, World tab list |
| Place (label only) | `POP_MAX >= 250,000` or a national capital, and not an impact city | Muted label on the map; no damage, news or clicks |
| City news | population `>= 1,000,000` | `city` bulletins (gales reach, flooding levels). Smaller cities are still damaged and counted. Landfall news may name any impact city. |

Each city is spread over nearby land with a Gaussian of 80 km, on top of the fictional rural background, and its people are counted once per cell. Replays are deterministic but depend on this city data: a replay recorded before the 500,000-city expansion replays the same storms and placements, and produces different city damage totals, rankings and news.

## Places layer (display labels only)

`scripts/prepare-map.mjs` also writes `src/data/generated/places.json`, a compact array of `[name, nameKo|null, lon, lat, popMax, scalerank, minZoom, names?]` rows sorted by `popMax`. It comes from the 10m populated places file, not the 50m one: the 50m file has only 5 South Korean places (no Daegu, Ulsan, Jeonju or Pohang). Rows are kept when `POP_MAX` is at least 250,000 or the feature is a country capital, then places that an impact city already draws (same name within 0.3°, or anything within 0.05°) are dropped; every place at or above 500,000 is an impact city, so what remains is smaller towns and small capitals. Result: 756 rows, about 90 KB (38 KB gzipped). Coordinates are rounded to 3 decimals. `nameKo` is `NAME_KO` with the administrative suffix removed (서울특별시 becomes 서울, 창원시 becomes 창원 for Korea, Japan, China and Taiwan); it is null when the source has none. The optional eighth element is `{ ja?, 'zh-CN'?, 'zh-TW'? }` from `NAME_JA`, `NAME_ZH` and `NAME_ZHT` (same cleaning), present when the source has at least one. Sea and typhoon names are not Natural Earth data: they come from the locale tables in `src/locales/`.

The map draws a place as a small dot plus a muted label. A place is eligible when `minZoom <= z + 0.5 + 0.5 * max(0, z - 2.7)`, where `z = log2(scale * 360 / 256)` is the web-map zoom of the view (`scale` is px per degree), or when `popMax` is at least 5,000,000 (no place is now). Only places inside the viewport (and on the visible side of the globe) are drawn, at most 600 per frame, largest first. Labels that collide with an earlier label are dropped; dots stay. Places never take damage, appear in news or can be clicked.

Impact cities are drawn by the city renderer. Their dots always show; their labels thin out by population the same way (cities of 2 M or more always, smaller ones when `4.1 + 1.2 * log2(2 M / population) <= z + 0.5`), and unlabelled dots are drawn smaller.

## Derived geometry

`scripts/prepare-map.mjs` produces `src/data/generated/world-land.json`. It does the following.

1. Downloads the three input files (land, simple places, full places) and checks each SHA-256 against the pinned value. A mismatch stops the script.
2. Checks that no raw source edge jumps across ±180°. Stops if one does.
3. Keeps the whole world (−180..180°, −90..90°). Natural Earth already splits polygons at the antimeridian, so no clipping or unwrapping is applied.
4. Simplifies rings with Douglas–Peucker at 0.03° (about 3 km), rounds to 4 decimals, and drops rings under 0.0001 deg² (about 1 km²).
5. Writes outer rings and holes as open `[lon, lat]` rings, in compact JSON.

Result: 1,373 polygons, 1,374 rings, 1 hole, 27,236 vertices, 529,256 bytes (about 529 KB; the city locations that used to share this file moved to `cities.json`, and the land geometry is identical). The only hole in the 50m source is the Caspian Sea. Holes are kept if they are present in the source.

Simplification can add one chord along the Antarctic pole edge at about −89.9989° (the ring closes from −180° to 180° at the pole). That chord is part of the polar boundary, and the tests allow it only at |lat| > 89.

To regenerate, run `node scripts/prepare-map.mjs`. Network access is required. The script writes only the generated JSON (`world-land.json`, `cities.json`, `places.json`); `CITY_SOURCES` lists the 71 original cities it must keep. Re-running with the same pinned inputs produces byte-identical output (checked).

## Fictional data

| Item | Where | Status |
| --- | --- | --- |
| Rural background population | `src/simulation/engine.ts` (`ruralDensity`) | Invented: about 1.2 M people per fully-land 2° cell, thinning toward the poles. City populations are real Natural Earth `POP_MAX` values, but how they spread over the grid (an 80 km Gaussian) is a game choice. |
| Weather evolution, humidity, shear and fallback climate | Simulation (`src/simulation/`) | Designed for gameplay. Current-date initial pressure, wind and temperatures use NOAA GFS as documented above; subsequent circulation is simulated. Loading a past typhoon can replace the background with the reanalysis described under "Historical environment". |
| Natural formation waves / weakening tools | Fictional game scenario | Seeded western-Pacific typhoons, cool water, dry air, cold air and downdrafts are game mechanics. They do not model a real weather-modification method. Loss totals are the current city estimates, not a sum of news reports. |
| Warm air / updraft | Fictional scalar conditions | Air heating and upward velocity use capped, ramped game effects; they support model genesis/growth. No observed atmospheric profile or resolved convection dataset is used. |
| Thunderstorms and simulated clouds | Fictional game model | Convective cells and gusts derive from game conditions. Clouds on the combined map are limited to active cyclone footprints: intensity controls core/bands/eye structure, with local temperature, humidity, lift and pressure modulating density. Background weather and standalone thunderstorms produce no cloud imagery. Structure and hemisphere rotation follow the qualitative [NOAA description](https://www.noaa.gov/jetstream/tropical/tropical-cyclone-introduction/tropical-cyclone-structure); textures and numerical parameters are game approximations. No satellite imagery, cloud observation or observed thunderstorm dataset is used. |
| Damage news | Fictional game narrative | Cumulative city damage drives displaced/missing people, flooded-home counts and USD loss estimates. Residential area names are generic story locations, not mapped flood zones or real incident reports. No rainfall, flood-depth, census, property-value or casualty dataset is used. The per-damage rates are calibrated to order-of-magnitude agreement with public Maemi 2003 and Rusa 2002 records (loss, displaced, dead/missing, damaged homes) and remain fictional. |
| Impact score | Simulation | A game measure: wind exposure times a game damage curve. It is not a casualty count or a monetary loss estimate. |

City names are English display labels. Ids and coordinates follow Natural Earth.

## The original 71 cities

The game started with 71 hand-picked cities (24 originals, then 47 added in the 24→71 expansion, which bumped `SCENARIO.version` to `0.7.0`). They are all still impact cities with the same ids. `scripts/prepare-map.mjs` selects each by `nameascii` and `adm0name` in the 50m file, and fails if the pair does not match exactly one feature. Sydney, Los Angeles, and San Juan each have two features with the same `nameascii` there, so the country name is required for them. Two display names differ from Natural Earth: Baguio ("Baguio City") and Yangon ("Rangoon"). `tests/fixtures/original-cities.ts` lists the ids, and `tests/data.test.ts` checks that every one is still present.

## Planned data not used in this build

The design in `GAME_PLAN.md` also names NOAA OISST, GEBCO, GHS-POP, and GHS-UCDB. This build does not download, ingest, or derive from those datasets. NOAA GFS is now used for current starting pressure and wind as described above. Adding the other datasets would need its own preparation step, license entry, and version pin.

## Limitations

- The coastline is 50m generalized and simplified at 0.03°. It suits a worldwide overview and continent-scale zoom, not coastal flooding or road-level analysis.
- `isLand` in `src/data/world.ts` ray-casts over one-degree latitude bands. On the development machine, 1 million queries took about 1.7 s (about 1.7 µs each). Southern bands hold more edges. This was measured once, not benchmarked on target devices. The simulation engine keeps its own index and does not use this function in its loops.
- Only one tagged release is pinned. Newer Natural Earth releases are not checked.
- The city set is a population cut (500,000+ plus the 71 originals), not a list of cyclone-exposed cities. It covers the whole world, so most cities are never touched by a storm. Natural Earth `POP_MAX` is a metropolitan-area figure from the 2010s to 2020s and some entries are odd (Colombo is 217 k).
