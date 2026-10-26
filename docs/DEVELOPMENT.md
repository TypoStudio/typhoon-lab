# Typhoon Lab

A full-screen, worldwide weather game in one world. Build storms by placing conditions, switch on natural typhoon formation, or load a recorded past typhoon. The October 23 interaction revision supersedes the regional, budget-based round in [GAME_PLAN.md](../GAME_PLAN.md); the current contract is [IMPLEMENTATION.md](../IMPLEMENTATION.md).

## Run locally

Use Node.js 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:5186. To enable the leaderboard, copy `.env.example` to `.env.local` and fill in your Firebase web config; without it the game runs with the leaderboard disabled.

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run preview
```

Browser tests do not capture screenshots by default. Set `TYPHOON_SCREENSHOTS=1` only when screenshot capture is explicitly requested.

The production output in `dist/` is a static site. Serve it over HTTP because module workers do not run through `file://`. Geographic data is bundled locally.

## Language

English, Korean (한국어), Japanese (日本語), Simplified Chinese (简体中文) and Traditional Chinese (繁體中文) are available in the right sidebar’s **Language** selector. Changes apply immediately without resetting the world, and the choice is saved locally. A browser set to Korean, Japanese or Chinese starts in that language (`zh-TW`, `zh-HK` and `zh-Hant` get Traditional Chinese, other `zh` gets Simplified); other browsers start in English. You can also open `http://localhost:5186/?lang=ko` (or `en`, `ja`, `zh-CN`, `zh-TW`) directly. Damage is simulated in USD and shown in dollars for English, and at fixed game rates (not live exchange rates) in won (1,350/USD), yen (150/USD), RMB yuan (7.2/USD) or New Taiwan dollars (32/USD) for the other languages. Interface text, help, accessibility labels, map labels, storm news and errors are translated; simulation state and replay JSON keep the same format.

## Play

The world starts running with **no storms**. Drag **Warm water**, **Moisture**, and **Low pressure** from the bottom palette onto the same tropical ocean area. These tools are free. Suitable conditions must persist before a depression forms; wind strength and circulation size then develop gradually. Each low can form its own storm, including nearby lows with overlapping conditions. Their progress is independent; the first storm does not consume the others. **High pressure** changes the surrounding steering flow. Two additional conditions help convection: **Warm air** (450 km, 72 h) raises lower-air temperature by up to 3 °C per placement, capped at +6 °C when stacked; **Updraft** (400 km, 48 h) adds up to 1 m/s of rising air, capped at 3 m/s when stacked. They help favourable disturbances form sooner and strengthen faster, without changing sea temperature or replacing the warm-ocean/moisture/low-pressure requirements. The map readout shows air temperature and updraft separately from sea temperature and horizontal wind. All ten conditions share one bottom palette; keys 1–9 select the first nine and 0 selects the tenth, in palette order. Each button shows its key in the top-left corner.

Turn on **Natural typhoon formation / 태풍 자연 발생** in the right sidebar and the world starts storms by itself. Each wave places warm water, moisture, low pressure, warm air and updraft at a seeded open-ocean location in the western Pacific. The conditions ramp up normally; sustained favorable conditions produce a young depression, which can gradually grow into a typhoon. You can weaken the patch before formation. Turning it on brings the first wave at once, and new waves arrive every 48–72 model hours; waves wait in four-hour increments when active storms plus pending lows reach three, or the full five-condition recipe would exceed the active-effect limit. Turning it off stops new waves. Every page load and Reset picks a fresh random seed, so natural formation differs from game to game; open `?seed=<0–4294967295>` (for example `?seed=20261022`) to start, and reset to, a fixed world. The same seed and actions reproduce the same world in a replay.

**Cool water / 차가운 바다**, **Dry air / 건조한 공기**, **Cold air / 차가운 공기** and **Downdraft / 하강 기류** weaken storms; **High pressure / 고기압** steers them. Place weakening conditions on and ahead of the storm, then follow its track as it leaves their range. Cool water lowers SST by up to 3 °C per placement (9 °C cooling cap); dry air subtracts humidity; cold air and downdrafts suppress convection and add decay. Cold/warm air and rising/sinking air offset each other before their ±6 °C / ±3 m/s caps. Tools are free and always available.

**Past typhoon / 과거 태풍**: pick one of 14 recorded typhoons (1959–2022) in the right sidebar and press **Load typhoon / 태풍 불러오기**. The loaded storm follows the recorded 6-hourly JMA RSMC Tokyo best track, pressure and 10-minute wind, and the map HUD shows its real UTC date. Sea temperature, air, humidity, pressure and wind follow NCEP/NCAR Reanalysis 1 and ERSST v5 where an environment record exists. Conditions you place change its strength but not its path, and you can load several typhoons into the same world. **Show recorded paths / 기록 경로 표시** draws each full recorded path as a dashed line (on by default, remembered in the browser). Damage and news still come from the game model. The record ends when the best track does. Source and licence: [DATA_SOURCES.md](../DATA_SOURCES.md).

**Thunderstorms** form over land or sea where Warm air, Moisture and Updraft overlap. They drift with the surface flow, last around 3–6 model hours, and add localized gust damage to cities without needing a tropical cyclone. Lightning symbols mark them on every layer; the storm summary counts them separately. Dry air, Cold air and Downdraft suppress them. Damage remains bounded and cumulative; weaker repeat events do not count the same damage again.

**Map overlays** combine wind, humidity, rainfall, pressure, sea-surface temperature and population in one view. All six icon toggles start enabled. Humidity colours the wind trails from dark blue in dry air to pale white in humid air, using local relative humidity; the droplet toggle restores the original wind colours when switched off. Turning wind off hides its trails, including humidity colours. Rainfall (mm/h) is a display-only estimate from storm winds, humidity and convection, drawn as a blue-to-violet tint with a dry eye in strong storms. Pressure contours are smoothed and spaced every 8 hPa from 1000 hPa up, and every 20 hPa below 1000, reducing crowded rings around deep lows. Sea temperature uses about **25% opacity (75% transparency)**, reduced from 84% opacity. Population shading uses **8–35% opacity (65–92% transparency)**, increasing with density, and also appears as sized city markers and population labels. The legend shows the enabled overlays.


Typhoons weaken more slowly over the ocean: natural intensity decay now uses a 96-hour relaxation scale (previously 20 hours), natural shear loss is also slower, land decay is slightly gentler, and weakening tools still reduce their strength. This is a decay scale, not a fixed storm lifespan.

The map HUD shows natural-formation wave timing (while it is on) and estimated city losses. The right panel shows dissipated storms, average time from appearance to dissipation, displaced/missing people, flooded homes and estimated USD losses. These are cumulative fictional city estimates; preventing more damage does not undo damage already sustained. A naturally dissipated storm is included in the count; it is not presented as proof of player-caused elimination. There is no round deadline or compulsory end screen.

The opening camera requests browser geolocation and zooms to the returned area. Southeast Asia (115°E, 10°N) is shown immediately while lookup runs, and remains the fallback if permission is denied, the API is unavailable, the result is invalid, or no result arrives within eight seconds. Location uses the browser API only, with no external IP lookup or saved coordinates. A result arriving after you start interacting does not move the map. **Reset view** returns to the selected opening region; zoom out to see the wider world.

Condition buttons use their original full tool names in both languages, including on narrow screens. Condition ranges appear while dragging, while moving the mouse over the map after selecting a tool, or while hovering over a placed condition icon. Otherwise placed conditions show only their icons and remaining time.

Use the map to pan and zoom. During map movement, weather animation freezes while the simulation clock continues; releasing the gesture shows the latest weather. Controls float over the map, and the only sidebar opens on the right. Pause, speed, layers, and reset let you explore the simulation. At 1×, one real second advances one model hour; 4× and 12× run faster. There is no round deadline or game-over screen: individual storms can fade while the world keeps running.

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
