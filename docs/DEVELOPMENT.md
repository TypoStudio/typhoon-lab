# Typhoon Lab

A full-screen, worldwide weather game in one world. Build storms by placing conditions, switch on natural typhoon formation, or load a recorded past typhoon. The October 23 interaction revision supersedes the regional, budget-based round in [GAME_PLAN.md](../GAME_PLAN.md); the current contract is [IMPLEMENTATION.md](../IMPLEMENTATION.md).

## Run locally

Use Node.js 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:5186. To enable the leaderboard, copy `.env.example` to `.env.local` and fill in your Firebase web config; without it the game runs with the leaderboard disabled.

Firebase API restrictions, allowed origins, and key rotation are documented in [FIREBASE_SECURITY.md](FIREBASE_SECURITY.md).

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run preview
```

Browser tests do not capture screenshots by default. Set `TYPHOON_SCREENSHOTS=1` only when screenshot capture is explicitly requested.

The production output in `dist/` is a static site. Serve it over HTTP because module workers do not run through `file://`. Geographic data is bundled locally.

## Ships and planes

The ship and plane icons in **Map overlays** independently show simulated traffic:
up to 10 flights and 16 ships, assigned to visible airport/port hubs. Yellow planes and cyan
ships follow their travel direction on both map views; their icons shrink when
zooming out. Orange indicates a storm detour or diversion. These are illustrative
services, without live flight or vessel feeds.

Wind streaks keep moving over the current wind field when the game is paused; camera gestures and reduced-motion preferences still freeze them.

Traffic advances with model time, pauses with the game, and follows playback
speed, at cruising speeds of 850 km/model-hour for flights and 30 for ships.
The worker owns all movement and accident state; rendering only
interpolates snapshots. Traffic and reports are rebuilt deterministically from
seed and replay actions. Hiding a layer cannot stop movement or prevent accidents.
Snapshots retain 16 model hours of timestamped motion. Above 3600 model seconds
per real second, rendering interpolates those recorded paths over the worker
snapshot interval instead of predicting ahead and snapping back. Lower speeds use
the fractional worker clock between fixed world steps. Repeated clock checkpoints
cannot rewind a visible position; pausing also freezes buffered interpolation.

Aircraft use great-circle routes. Ships use ocean-only routes with sampled
coastline checks. A wrapped A* search replans around current gale radii plus a
safety margin and the near-term storm forecast. Flights with an unsafe destination
select the nearest reachable safe city airport, land, disappear from the air
overlay, and wait on the ground before resuming. If no safe airport is reachable,
they make an emergency approach instead of stopping in midair. Ships may hold
outside a closed port and try to leave the wind area if a storm catches them.
Baseline sea routes are generated ahead of time to keep map
startup responsive. After editing ports, land geometry, or the routing algorithm,
run `npm run prepare:traffic` and `npm test -- tests/traffic.test.ts`.

Wind is sampled from the engine's actual surface-wind field along each traversed
leg. Sustained exposure above 35 m/s (flights) or 28 m/s (ships) accumulates a
severity-weighted dose; short gusts recover. A dose of 0.35 or 0.6 model hours
causes a crash or sinking. These are fictional gameplay thresholds and asset
values: USD 120 million per aircraft and USD 75 million per ship/cargo loss.
Accidents remove the vehicle, add a report to News, and add their loss once to
the world damage total and the responsible storm's loss/ranking. Transport asset
losses are separate from the population damage score, so they do not manufacture
city casualties or flooded homes. Destroyed vehicles remain lost until reset.

## Language

English, Korean (한국어), Japanese (日本語), Simplified Chinese (简体中文) and Traditional Chinese (繁體中文) are available in the right sidebar’s **Language** selector. Changes apply immediately without resetting the world, and the choice is saved locally. A browser set to Korean, Japanese or Chinese starts in that language (`zh-TW`, `zh-HK` and `zh-Hant` get Traditional Chinese, other `zh` gets Simplified); other browsers start in English. You can also open `http://localhost:5186/?lang=ko` (or `en`, `ja`, `zh-CN`, `zh-TW`) directly. Damage is simulated in USD and shown in dollars for English, and at fixed game rates (not live exchange rates) in won (1,350/USD), yen (150/USD), RMB yuan (7.2/USD) or New Taiwan dollars (32/USD) for the other languages. Interface text, help, accessibility labels, map labels, storm news and errors are translated; simulation state and replay JSON keep the same format.

## Play

The world starts running with **no storms**. Drag **Warm water**, **Moisture**, and **Low pressure** from the bottom palette onto the same tropical ocean area. These tools are free. Suitable conditions must persist before a depression forms; wind strength and circulation size then develop gradually. Each low can form its own storm, including nearby lows with overlapping conditions. Their progress is independent; the first storm does not consume the others. **High pressure** changes the surrounding steering flow. Two additional conditions help convection: **Warm air** (450 km, 72 h) raises lower-air temperature by up to 3 °C per placement, capped at +18 °C when stacked; **Updraft** (400 km, 48 h) adds up to 1 m/s of rising air, capped at 9 m/s when stacked. They help favourable disturbances form sooner and strengthen faster, without changing sea temperature or replacing the warm-ocean/moisture/low-pressure requirements. The map readout shows air temperature and updraft separately from sea temperature and horizontal wind. All ten conditions share one bottom palette; keys 1–9 select the first nine and 0 selects the tenth, in palette order. Each button shows its key in the top-left corner.

Formation probes calculate an unrestricted stack from the actual environmental deficits. Ordinary tools have larger stack limits: air-temperature change ±18 °C, vertical flow ±9 m/s, instability ±6, sea cooling 30 °C and shear change ±60 m/s. Recipe placements bypass those stack limits and the ordinary 64-active-tool limit; humidity still stays in 0–100% and shear stays nonnegative. The worker recomputes and places each recipe atomically. Its tool actions carry a `formation` tag through export, validation, replay and ranking signatures. Typhoon recipes require water but have no latitude, season or background-temperature exclusion; blizzard and tornado recipes work on land or water. Blizzard planning checks actual snowy gale cells rather than only the clicked point. Tornado recipes start a rotating thunderstorm deterministically when their real fields have built up, independently of random ambient storms. The world still advances and conditions can be weakened afterwards.

Turn on **Natural typhoon formation / 태풍 자연 발생** in the right sidebar and the world starts storms by itself. Each wave places warm water, moisture, low pressure, warm air and updraft at a seeded open-ocean location in the western Pacific. The conditions ramp up normally; sustained favorable conditions produce a young depression, which can gradually grow into a typhoon. You can weaken the patch before formation. Turning it on brings the first wave at once, and new waves arrive every 48–72 model hours; waves wait in four-hour increments when active storms plus pending lows reach three, or the full five-condition recipe would exceed the active-effect limit. Turning it off stops new waves. Every page load and Reset picks a fresh random seed, so natural formation differs from game to game; open `?seed=<0–4294967295>` (for example `?seed=20261022`) to start, and reset to, a fixed world. The same seed and actions reproduce the same world in a replay.

**Cool water / 차가운 바다**, **Dry air / 건조한 공기**, **Cold air / 차가운 공기** and **Downdraft / 하강 기류** weaken storms; **High pressure / 고기압** steers them. Place weakening conditions on and ahead of the storm, then follow its track as it leaves their range. Cool water lowers SST by up to 3 °C per placement (9 °C cooling cap); dry air subtracts humidity; cold air and downdrafts suppress convection and add decay. Cold/warm air and rising/sinking air offset each other before their ±6 °C / ±3 m/s caps. Tools are free and always available.

**Past typhoon / 과거 태풍**: pick one of 14 recorded typhoons (1959–2022) in the right sidebar and press **Load typhoon / 태풍 불러오기**. The loaded storm follows the recorded 6-hourly JMA RSMC Tokyo best track, pressure and 10-minute wind, and the map HUD shows its real UTC date. Sea temperature, air, humidity, pressure and wind follow NCEP/NCAR Reanalysis 1 and ERSST v5 where an environment record exists. Conditions you place change its strength but not its path, and you can load several typhoons into the same world. **Show recorded paths / 기록 경로 표시** draws each full recorded path as a dashed line (on by default, remembered in the browser). Damage and news still come from the game model. The record ends when the best track does. Source and licence: [DATA_SOURCES.md](../DATA_SOURCES.md).

**Weather phenomena**: the Formation tab also creates Heatwave, Drought, Downpour, Cold wave, Hail, Yellow dust and Wind gust events. Each probe plans uncapped existing condition tools, and its tagged anchor matures into one event after six model hours. Drought and Yellow dust must start over land; dust can then travel over water. Heatwave and Cold wave last 72 hours, Drought 120, Downpour 12, Hail 3, Yellow dust 24 and Wind gust 2. Short-lived events drift with the surface flow; heat, cold and drought stay at their placed location. Their temperature, humidity, precipitation and gusts affect the same grid used for map colours, particles, transport and damage. Geographic footprints, distinct icons and remaining hours work in flat and globe views. Weather damage uses bounded, cumulative game ratios, participates in recovery and has cause-specific news; heat, cold, drought, dust and hail reports do not claim flooded homes. Existing tagged placement actions reproduce events, fields and news on replay. Keys A/S/D retain the three original probes; F/G/H/J/K/L/Z select the seven additions. Small screens scroll the formation palette horizontally.

**Thunderstorms** form over land or sea where Warm air, Moisture and Updraft overlap. They drift with the surface flow, last around 3–6 model hours, and add localized gust damage to cities without needing a tropical cyclone. Lightning symbols mark them on every layer; the storm summary counts them separately. Dry air, Cold air and Downdraft suppress them. Damage remains bounded and cumulative; weaker repeat events do not count the same damage again.

**Map overlays** combine wind, humidity, rainfall, pressure, sea-surface temperature and population in one view. All six icon toggles start enabled. Humidity colours the wind trails from dark blue in dry air to pale white in humid air, using local relative humidity; the droplet toggle restores the original wind colours when switched off. Turning wind off hides its trails, including humidity colours. Rainfall (mm/h) is a display-only estimate from storm winds, humidity and convection, drawn as a blue-to-violet tint with a dry eye in strong storms. Pressure contours are smoothed and spaced every 8 hPa from 1000 hPa up, and every 20 hPa below 1000, reducing crowded rings around deep lows. Sea temperature, near-surface air temperature and population colour the existing sea and land surfaces directly, without transparent overlay meshes. The Temperature toggle colours water by sea-surface temperature and land by air temperature; one shared -40 to 40 °C legend has an upper marker for near-surface air temperature and a lower marker for sea temperature, with both numeric values and their icons on the temperature title line. Both surfaces use the same temperature colour ramp, with population shading blended over the land colour. Temperature is sampled continuously rather than grouped into hexagons, with 55% ramp colour blended into the sea colour. Population blends into the land colour according to density, using display kernels with 2/5 of the original interpolation radius; population totals and damage calculations remain on the original grid; the coastline and lake geometry keep it off water. The toggles restore the base surface colours when disabled; only rain and snow use the separate atmospheric raster. The legend shows the enabled overlays.


Typhoons weaken more slowly over the ocean: natural intensity decay now uses a 96-hour relaxation scale (previously 20 hours), natural shear loss is also slower, land decay is slightly gentler, and weakening tools still reduce their strength. This is a decay scale, not a fixed storm lifespan.

The map HUD shows natural-formation wave timing (while it is on) and estimated city losses. The right panel shows dissipated storms, average time from appearance to dissipation, displaced/missing people, flooded homes and estimated USD losses. These are cumulative fictional city estimates; preventing more damage does not undo damage already sustained. A naturally dissipated storm is included in the count; it is not presented as proof of player-caused elimination. There is no round deadline or compulsory end screen.

The opening camera requests browser geolocation and zooms to the returned area. Southeast Asia (115°E, 10°N) is shown immediately while lookup runs, and remains the fallback if permission is denied, the API is unavailable, the result is invalid, or no result arrives within eight seconds. Location uses the browser API only, with no external IP lookup or saved coordinates. A result arriving after you start interacting does not move the map. **Reset view** returns to the selected opening region; zoom out to see the wider world.

Condition buttons use their original full tool names in both languages, including on narrow screens. Condition ranges appear while dragging, while moving the mouse over the map after selecting a tool, or while hovering over a placed condition icon. Otherwise placed conditions show only their icons and remaining time.

Use the map to pan and zoom. During map movement, simulation time and all map animation (including traffic) pause together; releasing the gesture resumes from the same checkpoint, preserving play/pause and speed settings. Controls float over the map, and the only sidebar opens on the right. Pause, speed, layers, and reset let you explore the simulation. At x1, one real second advances one model second; the x4 and x12 presets advance 600 and 28,800 model seconds per real second. Aircraft and ships follow the same model time, with tuned game speeds of 180 and 10 km per model hour respectively. There is no round deadline or game-over screen: individual storms can fade while the world keeps running.

The illustrative fleet has upper limits of 10 aircraft and 16 ships. While playing, active traffic scales to the number of unique visible airport and port origins, with at most one normal journey per origin and service. A single visible port therefore does not receive a convoy just because it has several outbound routes. Excess safe vehicles enter inactive reserve: they neither simulate nor render, and can rejoin a staggered departure queue when more hubs become visible. Retained visible journeys, diversions, wind-exposed vehicles and accidents are preserved; safety-critical journeys finish before entering reserve. Areas without visible hubs have no normal active traffic. Camera gestures and explicit pause suspend dispatches. Assignments and reserve changes are stored separately from weather actions in the optional replay `trafficDispatches` field, so traffic routes, accident losses and ranking keys reproduce the same session.

**Globe view**: the map opens as a 3D globe by default. Drag to rotate it, scroll or pinch to zoom, and use the **Globe view** switch in the right panel to change to the flat Equal Earth map; the choice is remembered in the browser. `?map=flat` or `?map=globe` overrides it for one visit. The globe needs WebGL, so `?renderer=canvas` and browsers without WebGL show the flat map and the switch is disabled.

The storm list and details show movement speed (km/h), maximum wind (m/s), central pressure (hPa), and gale radius (km). Movement speed is actual centre displacement over the last model step, independent of playback speed. It starts at 0 at birth and excludes the centre adjustment during a merger. The exact-centre/eye wind reading has been removed. Gale radius estimates the extent of winds at least 17.2 m/s. Maximum-wind radius remains available in the details. The right panel shows storm details, weather events, and replay controls. Export a snapshot to reproduce its elapsed time and placements. Replay loads paused; reset starts a new live world. Replay supports up to 60 model days and 5,000 placements, independently of the live clock. Replays use format 4 / simulation 0.8.0. Besides placements they record natural-formation switches and loaded past typhoons. Older formats are rejected.

Map labels show the **storm number, current game grade 0–5, gale radius, and movement speed (km/h)**. Grades are: 0 Depression, 1 Tropical Storm, 2 Severe Tropical Storm, 3 Typhoon/Hurricane/Cyclone, 4 Very Strong, 5 Violent. These use the game’s existing strength stages, not a separate hurricane category system.

**Damage news** reports displaced people, estimated missing people, estimated deaths, flooded homes, and estimated losses in USD when a city's cumulative wind damage crosses a new severity tier. Reports describe fictional residential areas in that city and show cumulative figures at the bulletin time; newer figures replace earlier estimates rather than adding to them. Flood locations and monetary/human-impact estimates are story rules, not a rainfall, flood-depth, census or loss-assessment model; the rates are calibrated to order-of-magnitude agreement with the Maemi 2003 and Rusa 2002 records and remain fictional. Reports regenerate with replay and support Korean and English.

**Storm history** keeps dissipated storms, high-latitude transitions and absorbed storms for the current world. Select a record to fit its entire route on the map and display numbered stage-change markers, including weakening, with times. The details show a stage list and recorded wind history. Selecting a history record on a phone closes the sidebar so the map is visible. Records include birth, hourly observations, all stage changes and the ending; forecasts do not create records. Reset starts a fresh world, so export a replay before resetting or closing the page to keep the history. Import rebuilds the same archive from the seed and placements. Storm records work in both modes, including automatic defense arrivals.

**Ranking** lists the top 10 storms by estimated loss, displaced people, estimated deaths, flooded homes, peak grade or survival time. Storms with a zero value are left out of that metric's list. Ended storms are saved in this browser across resets and reloads; active storms appear until they end. Each record is identified by the world seed, the storm number and a fingerprint of the placements up to the storm's end, so importing the same replay again updates its entry instead of duplicating it, while a new game's storm with the same number is a separate record. Several open tabs share the list: each save re-reads it first. Clear ranking removes the saved list. Figures are the same fictional story estimates as the damage news. Uploading records to a server is planned for a later version.

Impact totals measure fictional wind exposure over demonstration population cells. They are game measures, **not casualty counts or financial-loss estimates**.

## Scope and data

The map includes about 1,000 impact cities: every Natural Earth populated place of 500,000 people or more, plus the original 71 demo cities. They all take wind damage and count in the totals and rankings; the World tab lists the 60 most affected (or largest) cities and shows the total. Only cities of 1 million or more produce news bulletins. Smaller towns (250,000 and up) and small capitals are drawn as labels only. Coastlines, lakes (drawn and labelled only; the simulation still treats them as land), city coordinates and city populations come from Natural Earth; weather, the rural background population, and vulnerability are synthetic. Replays recorded before this change replay the same storms but give different city damage totals. This is not a real forecast or a historical reconstruction. This is not a real forecast or a historical reconstruction. See [DATA_SOURCES.md](../DATA_SOURCES.md) for provenance and map generation.

Major rivers (Natural Earth 50m, public domain) are drawn as thin lines from web zoom 3.3 (the great rivers), 4.5 and 5.5 (smaller ones) and named with the sea names; lakes and tiny islands also appear by zoom, and the coast is drawn thin and faint when zoomed far out.

The world uses a flat map and a 2° weather grid. Storms and tool locations use continuous geographic coordinates. Longitude wraps in the simulation, and storm circulation reverses in the Southern Hemisphere. The model includes a simplified merger rule: two storms in the same hemisphere can merge within 100 km once both are at least 24 model hours old and have winds of at least 17.2 m/s. The stronger storm keeps its ID and wind speed; the merged centre is weighted by wind strength. A merger news entry records both IDs, and selection follows the surviving storm. Young storms and forming lows remain independent. Nearby same-hemisphere storms now induce mutual rotation and close-range convergence, fading to zero by 1,000 km, with the combined steering perturbation capped at 8 m/s. The influence ramps in over the younger storm’s first 24 hours. The 72-hour forecast advances all centres together and ends absorbed paths, while freezing intensity and tool strength. These distances, rates and merger gates are tuned game rules, not universal weather thresholds; overlapping wind areas do not guarantee a merger. This is a simplified Fujiwhara-style model, not a full fluid simulation. Rainfall and storm surge are not simulated.

Rain/snow display uses monotone cubic interpolation of precipitation and air temperature before blending through the freezing front. It never treats a trace of interpolated snow as a binary snow tile. Hexagon colours crossfade with the snow fraction; both particle renderers use the same continuous weather sample, and blizzard respawns use overlapping tent kernels instead of square cell boxes. These are display interpolations; simulation precipitation, damage and inspection values remain on the physical grid.

Wind particles use the original display speed of 2.4 screen pixels per second for each m/s of local wind, adjusted for map zoom and capped at 500 pixels per second. The wind display speed is multiplied by 1, 2, 3 or 4 for the corresponding time-speed setting; simulated wind and damage calculations keep their physical values. Pause and camera gestures suspend particle movement and lifetime/reseeding. Wind tails use midpoint integration with adaptive screen spacing: tight bends in small, zoomed-out cyclones shorten the tracing steps instead of letting a long segment jump across the circulation. Flat and globe rendering share the same eight-segment path, so the correction does not raise the particle or ribbon-segment counts. Wind streaks grow from 27 to 54 screen pixels as wind increases to 35 m/s, and follow the local wind direction along their curves; wind strength does not raise the total budget. The wind budget follows measured frame timing: rates below about 35 fps for two seconds reduce particles by 10% per adjustment, and stable rates above about 45 fps for four seconds restore them in 10% steps up to the original maximum. At least 70% of the initial budget is kept. The first reduction and the latest adjustment record their measured FPS and before/after counts in render stats. Paused or hidden wind, reduced motion and camera gestures hold the current budget, and long tab-suspension gaps do not count toward adjustments.

Particle motion runs on the CPU, with Three.js rendering and a Canvas fallback. Particle counts adapt to performance; no physical-device 60 fps claim is made. A 3D globe and GPU particle simulation remain outside this version; the ranking is stored locally, and server upload comes later.

## Privacy policy and footer

`privacy.html` is a static second Vite page (listed in `build.rollupOptions.input`, so `npm run build` emits `dist/privacy.html`). It embeds the policy in English, Korean, Japanese, Simplified and Traditional Chinese, and a small inline script shows one `<section lang>` chosen by `?lang=` (else `navigator.language`). When you change what the game collects or stores (analytics, Firebase, local storage keys), update all five texts and the effective date there, and the leaderboard paragraph in the help Data tab. The sidebar footer (`footerHtml()` in `src/ui/shell.ts`, also shown under the help Data tab) links to it as `/privacy.html?lang=<current language>`, kept in sync by `syncPrivacyLinks()` in `src/ui/app.ts`.

## Code

- `src/simulation/`: deterministic environment, storm formation, movement, and impact.
- `src/worker.ts`: live fixed-step clock and replay handling.
- `src/data/`: global geography and fictional scenario.
- `src/render/`, `src/ui/`: map rendering, floating controls, and placement.
- `src/types.ts`: shared state and worker protocol.
- `tests/`: geographic, simulation, rendering, replay, and browser checks.

Development uses the configured Claude (three) account through Paseo: Opus for simulation and Haiku for geography, with a Codex sub-agent for interface controls. Codex coordinates interfaces, integration, and browser verification. “Claude 3” refers to the account named in the original plan, rather than the historical Claude 3 model generation.
# Current-date starting weather

Opening the game without a pinned date loads the latest available NOAA GFS sea-level pressure, 10 m wind, ocean surface temperature and 2 m air temperature directly in the worker. `?weather=base` disables the network request. `?start=YYYY-MM-DD` or `?doy=N` keeps the reproducible base-weather scenario; `?weather=live` explicitly enables GFS even with a pinned date. `?seed=N` alone still uses current weather.

The browser uses GCS's JSON download endpoint (CORS-enabled), not the plain bucket URL, and requests seven small GRIB records by byte range (five weather variables plus land/ice masks). It needs no backend or API key and works on the existing static hosting. Startup waits at most ten network seconds, then uses a saved analysis or the base climate. The version-2 cache requires both temperatures, so old pressure/wind-only caches are not silently reused. The world panel shows the source/cycle and fallback status. See `src/data/live-weather.ts`, `src/simulation/live-weather.ts`, and `DATA_SOURCES.md` for the transport, validation and cache rules.

`initialWeather` is immutable replay/source data; `weather` is the evolving background used by grid refresh, point samples, steering and forecasts. Each simulation step advects pressure, wind and air temperature. Current simulated sea/air temperatures drive thermal pressure anomalies and a seasonal Hadley/Ferrel/polar circulation approximation: pressure relaxes toward these fields over 72 hours, and wind adjusts over 12 hours to pressure gradients and trade-wind/westerly forcing with Coriolis response. It does not flatten all pressure to 1010 hPa or damp all wind to zero. Fading pressure tools transfer their lost contribution into `weather` so the original imported low does not reappear when a high-pressure marker expires. Never refresh the current atmosphere from `initialWeather` after creation. Ocean temperature is not advected with atmospheric wind; imported water temperature receives the change in game-season temperature since entry, then the normal climate/tool offsets. Replays retain all five initial fields, with a 2 MB export limit and optional temperature fields for older files.

`npx vitest run tests/live-weather.test.ts tests/replay-file.test.ts` checks real-record decoding, model consistency, failures, caches and replay preservation. `npx playwright test tests/browser/live-weather.spec.ts` checks entry/cache/fallback through the actual worker with offline NOAA fixtures.
