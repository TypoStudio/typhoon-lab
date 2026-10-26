# Validation — worldwide sandbox revision

Checked on 2026-10-23 with Node.js 26.10.0 and Chromium through Playwright.


## Current verification — humidity wind colours and sparse isobars

- Added a fifth 32 px droplet toggle. Local relative humidity colours wind trails from dark blue to pale white; the same 16 colour steps are used in Canvas and WebGL. Humidity off restores the existing wind colours. Wind off hides all trails without changing the humidity setting or cyclone clouds.
- Pressure lines use 8 hPa steps from 1000 hPa up and 20 hPa steps below. Contours are traced into continuous paths and smoothed twice, retaining closed rings and date-line continuity instead of clipping crowded segments. The deep-low fixture has four rings instead of about 12–13 under the previous rule. Physics and replay state are unchanged.
- **165 unit tests across 18 files pass**, including local humidity sampling, brighter colours for higher humidity, sparse closed contours, smoothing, date-line continuity, deterministic output and unchanged raster layers. TypeScript and production build pass. No screenshots or captures.

## Previous verification — wind toggle

- Wind is now an independent toggle like the other three map icons, on by default. Turning it off skips particle motion and drawing in Canvas and WebGL; cyclone clouds and other overlays continue. The legend and help describe the current wind state in English and Korean.
- TypeScript and production build pass; `dist/` is regenerated. Relevant rendering/localization checks total **22 passing tests** after updating the combined-map default assertion for the fourth toggle. No screenshots or captures.
- **3 focused browser cases verified**: Canvas, combined WebGL and 320 px icon layout. Instrumented renderer calls receive particle alpha 1 → 0 → 1; cloud visibility, other overlays and replay state are preserved. Keyboard toggles, Korean off-state text and reset persistence pass. The test spy was corrected to import Vite's exact loaded module URL before the successful renderer reruns. `TYPHOON_SCREENSHOTS=0` throughout.

## Previous verification — compact map icons

- Replaced Wind, Pressure, Sea temperature and Population text controls with distinct inline SVG icons (wind trails, pressure gauge, thermometer/water and people). Icons are 18×18 px in 32×32 px cells, with a content-sized toolbar. Wind remains a labelled static base indicator; the other three retain independent toggle behaviour.
- Korean/English accessible names and tooltips preserve each control's meaning. TypeScript and production build pass; `dist/` is regenerated. No screenshots or captures.
- **8 focused browser cases verified**: two language cases, Canvas fallback and five viewport sizes (320–1440 px). Initial size checks caught the 15 px root font making rem-based cells smaller than intended; explicit 32 px cells / 18 px icons fixed this, and all five layout reruns passed. Toolbar width stays below 150 px, with no visible text or clipped controls. Runs used `TYPHOON_SCREENSHOTS=0`.

## Previous verification — lighter population overlay

- Reduced population tint from 18–96% opacity to **8–35% opacity (65–92% transparency)** according to density, in both the individual raster helper and shared combined raster.
- Existing composite-raster tests pass **9/9**; TypeScript and production build pass and `dist/` is regenerated. The existing bundle-size warning remains. No screenshots or captures.

## Previous verification — combined map overlays

- Replaced the four exclusive map modes with a fixed wind/cyclone-cloud base and independent pressure, sea-temperature and population overlays, all on initially. Accessible toggle buttons use `aria-pressed`; the combined legend lists enabled information. Pressure uses isobars with dark casing; population uses a cell tint, sized city dots and population labels.
- Ocean SST uses alpha **64/255** (about 25% opacity / 75% transparency), down from 214/255. `buildCombinedImage` composites population over SST and supplies the same raster to WebGL and Canvas. Wind streaks and cyclone clouds remain visible when overlays toggle. No wind/pressure heatmap is mixed into the temperature colours. Disabling both raster overlays clears the raster; pressure-only toggles do not rebuild it.
- `npm test -- --maxWorkers=2`: **155/155 passed** across 16 files, including nine new composite-raster checks for simultaneous SST/population, ocean masking, source-over alpha, independent toggles, transparent clearing and deterministic output.
- All **45 Chromium cases verified** with `TYPHOON_SCREENSHOTS=0`: full suite passed 44, while the expanded two-replay combined-view case exceeded its previous 45-second budget. That test alone was given the existing long-scenario 90-second budget and passed on focused rerun (52.9 s), with no application-code changes. Checks cover independent keyboard toggles, clouds remaining visible, legend filtering, Korean/English text, combined coordinate readouts, replay equality, reset clearing, WebGL recovery and unclipped overlay labels at 320–1440 px.
- TypeScript and production build pass; `dist/` is regenerated. The existing bundle-size warning remains. Simulation, replay and cloud-generation rules are unchanged. No screenshots or captures.

## Previous verification — cyclone-only clouds

- Removed background cloud and standalone thunderstorm anvils. Only active cyclone footprints generate cloud; no cyclone means a fully transparent raster, even in moist, warm, rising air. Thunderstorm physics, damage and lightning markers are unchanged.
- Cyclone cloud follows centre, radius and strength, with a dense core, spiral bands and a mature eye. Weaker storms have thinner cloud without a clear eye. Corrected temporal rotation to be anticlockwise in the north and clockwise in the south; each eye clears only its own cyclone cloud. Local temperature, humidity, lift and pressure modulate density. This remains a visual game approximation.
- `npm test -- --maxWorkers=2`: **146/146 passed** across 15 files. Nine cloud tests cover cyclone-only support, clear surroundings, local weather, strength/eye development, both hemispheres' rotation, deterministic timing, reused-buffer clearing, dateline continuity, real game genesis and performance.
- Final focused Chromium checks with `TYPHOON_SCREENSHOTS=0`: **2/2 passed** in Canvas and WebGL. Calm, tool-only and thunderstorm-only worlds hide clouds; a replay-generated cyclone shows them in Wind; other layers hide them; Korean text, thunderstorm summaries and replay state remain correct; reset clears clouds. Empty-storm snapshots bypass raster throttling to clear the old texture immediately.
- TypeScript and production build pass, with `dist/` regenerated. The existing bundle-size warning remains. Simulation and replay versions are unchanged. The independent temperature assertion also passes in the final **9/9** focused cloud run.
- The original dark map palette is retained. No screenshots or captures were taken.

## Previous verification — dark terrain and local-weather clouds

- Restored the original dark sea and land colours and bright wind trails in both WebGL and Canvas. Removed the temporary light-map palette tokens and renderer overrides.
- Removed seeded decorative fronts, the fixed tropical belt and independent cirrus. Local air temperature, humidity, updraft and pressure now determine background cloud support; noise only textures supported cloud. Cyclone bands and thunderstorm anvils additionally respond to moisture and sinking air. These are simplified game rules, not a physical cloud forecast.
- `npm test -- --maxWorkers=2`: **145/145 tests passed** across 15 files. Eight cloud tests cover dry-air suppression across seeds/hours, individual weather inputs, deterministic texture, cyclone eyes/bands, actual generated cyclones and thunderstorms, moist versus dry regions, dateline continuity and performance. Cloud coverage no longer targets a fixed percentage.
- TypeScript and production build pass; `dist/` is regenerated. The existing bundle-size warning remains. Simulation and replay versions are unchanged.
- Final focused Chromium run with `TYPHOON_SCREENSHOTS=0`: **2/2 passed**, covering Canvas fallback/drop/cloud display and WebGL clouds, layer switching, thunderstorm summaries and Korean help. An earlier concurrent-development run was interrupted by Vite reload; the final run used stable source.
- No screenshots or captures were taken.

## Previous verification — automatic Wind clouds and weakening labels

- Removed the separate Infrared view. Wind now combines a blue/green basemap, lower-opacity wind-speed colours, automatic off-white cloud textures and dark wind trails drawn above them. Other layers hide clouds. There is no satellite feed.
- Korean weakening labels are 차가운 바다 / 건조한 공기 / 차가운 공기 / 하강 기류 / 고기압, including button text, accessibility labels, placement errors and help.
- Added world-coordinate noise, broken background cloud, frontal bands, wispy high cloud, cyclone spiral bands with cleared eyes, and thunderstorm anvils. The default untouched East Asia sample has 33% of pixels above alpha 40, with clear gaps; tested alternative seeds give 36–39%. Rendering is deterministic for a seed/hour and continuous at the dateline.
- Both Canvas and WebGL draw the same viewport raster. During gestures the camera reprojects frozen weather at reduced detail, keeping new areas covered; full detail returns on release. Raster updates are coalesced and the full-detail longest side is capped at 720 pixels. The module benchmark measured roughly 25–31 ms for a 720×450 typhoon view on the development machine; this is not a device frame-rate guarantee.
- `npm test -- --maxWorkers=2`: **142/142 tests passed** across 15 files, including five cloud coverage/determinism/eye/dateline/performance checks.
- Focused Chromium regression run: **8/8 passed** for defense label/play/replay/reset, narrow and desktop layouts, segmented keyboard selection, frozen-weather panning and wheel zoom, Canvas clouds, WebGL context recovery, and WebGL clouds/layer switching/Korean summary/help. Earlier initial three-case cloud/layout checks also passed.
- Production build and TypeScript checks pass; the pre-existing bundle-size warning remains. No screenshots, captures, or pixel-based visual QA were used. The supplied image guided the procedural appearance; visual equivalence to that image was not asserted.

## Previous verification — v0.7 controls, cities, thunderstorms and infrared

- `npm test -- --maxWorkers=2`: **140/140 tests passed** across 15 files. Covers longer natural lifetime, active weakening, independent thunderstorm damage, suppression, cumulative caps, exact replay, infrared brightness/motion/dateline continuity, and 71-city data validation.
- `TYPHOON_SCREENSHOTS=0 npm run test:e2e`: **45/45 Chromium browser tests passed** (3.2 minutes). Includes segmented keyboard navigation/reset/replay synchronization, full condition labels and layouts at 320–1440 px, WebGL/Canvas infrared selection, Korean thunderstorm counts/help, live simulation and worker replay, history, mergers, gesture freezing and context recovery.
- `npm run build`: TypeScript and Vite production build passed. The pre-existing large-bundle warning remains. `dist/` was regenerated after the final source edits.
- Production preview smoke check on port 5187 passed: version 0.7.0, 71 city states, Korean infrared legend, WebGL rendering and segmented switch to defense; no page errors. No captures.
- Cities expanded from 24 to 71 with pinned Natural Earth coordinates and fictional rounded populations. Regeneration is byte-identical and leaves land geometry unchanged.
- Natural ocean decay uses 96 h instead of 20 h; a full weakening condition restores the faster ocean decay rate. Natural shear loss and inland decay are gentler. The western-Pacific lifetime test requires more than 160 h and eventual dissipation before 400 h; defense interventions still reduce mature-storm wind strongly.
- Thunderstorm damage scales by the footprint within a population cell and shares maximum-damage accounting. The existing exposure flag is cell-wide, so exposure counts remain coarse 2° population-cell estimates. Cloud temperature, gusts and damage are gameplay approximations; downpour/flood descriptions do not imply simulated rainfall or flood depths.
- Infrared is synthetic cloud imagery shared by both renderers, with cyclone bands/eyes and thunderstorm cloud tops. No satellite service, captures, screenshots, video or visual screenshot QA were used. Browser validation used DOM, state and drawing-command assertions.
- Simulation version is 0.7.0. Prior 0.6.0 replay files are rejected clearly because model/data rules changed; older explicitly supported sandbox imports are recalculated under current rules.

## Previous verification — defense mode and weakening tools

- Added sandbox/defense selection in the right sidebar. Defense opens with a randomized seeded western-Pacific typhoon and schedules further waves 48–72 model hours apart, deferring automatic arrivals while three storms remain active. Switching modes starts a fresh world; defense reset picks a fresh seed and returns to 1×. Sandbox still starts empty.
- Added cool water, dry air, cold air and downdrafts. Build/Weaken palette sets keep controls usable on phones; both sets work in either mode. Opposing air effects offset one another, negative fields have caps, and cool water is ocean-only. Readouts distinguish sea temperature, air temperature, humidity and rising/sinking motion. Each tool lowers genesis potential and strengthening in focused tests; repeated protection dissipates the tested incoming storm sooner and reduces damage relative to its same-seed unattended counterpart.
- Defense overlay/report tracks wave timing, current cumulative city estimates, dissipated storms and average lifetime from appearance. Totals do not sum repeated news reports or erase previously sustained damage. Natural dissipation is included without claiming player causation. Forecast paths still freeze intensity, as before.
- Replay format 3 / simulation 0.5.0 records mode along with seed/actions/tick. Engine and actual browser worker reproduce arrivals, storms, archive, fields and damage exactly. Format 2 / simulation 0.4.0 sandbox files are normalized on import; ambiguous legacy mode/defense actions and invalid modes are rejected.
- **125/125 unit tests pass** across 12 files, including seven new defense tests. TypeScript and production build pass; the existing bundle-size warning remains.
- **8/8 browser checks pass**: defense mode/drop/play/export/import/reset/sandbox round-trip; defense layout at 320/375/768/1440 px; two sandbox replay regressions; and four real-worker tests including automatic defense waves and exact replay. Korean labels and metric rendering are checked. No screenshots, image captures or pixel inspection were used.

## Previous verification — warm air and updraft conditions

- Added Warm air / 따뜻한 기온 and Updraft / 상승 기류 to the six-button palette, coordinate placement, keyboard shortcuts 5/6, map glyphs, hover/drag ranges and replay validation. Air temperature and upward velocity appear in the map readout separately from SST and horizontal wind. Distinct icons/colors and compact labels fit narrow layouts.
- Effects have their own radius/duration and capped stacking (+6 °C air heating, 3 m/s updraft). Convective support improves favourable genesis and positive ocean strengthening; cold water, dry air, land and the equator still block genesis. Cached rendered fields match point sampling and clear after expiry. Original-tool behaviour is unchanged when the new tools are absent.
- TypeScript and production build pass; **118/118 unit tests** pass. Five new tests cover scalar independence/caps, physical gates, earlier formation, field consistency/expiry and exact replay. The initial new replay test incorrectly treated the result wrapper as a raw state; it was corrected to inspect `result.state` before the clean full-suite run.
- **7/7 browser checks** pass: drag/keyboard/Korean readout/replay in Canvas and WebGL plus layouts at 1440, 768, 414, 375 and 320 px. The first concurrent software-WebGL run reached 50.75 model hours before pausing at 12×, legitimately expiring the 48 h updraft. Using 4× and serial renderer checks verified the live field before expiry; no gameplay duration was changed to accommodate the test.
- No screenshots or image captures. Existing bundle-size warning remains. Replay format and simulation version remain unchanged for this additive tool extension.

## Previous verification — fictional damage news

- Damage bulletins include displaced/missing people, flooded homes, estimated loss in USD, and generic residential-area flooding narratives. English/Korean cards label cumulative estimates and fictional flood locations. A city emits only its highest crossed damage tier per step, avoiding duplicate estimates when several tiers are crossed together.
- Production build passes; all **113 unit tests** pass, including zero/bounded estimates, monotonic snapshots and translation/units. A real Chromium integration check passes for actual city-impact news, exact replay regeneration, translated statistics and prose, and 375 px card bounds. The original browser fixture caused no qualifying city damage; the fixture was moved to 130°E, 18°N after inspecting city impacts, with no threshold or physics tuning.
- No screenshots or pixel captures. Existing bundle-size warning remains. Simulation physics, original impact scores and replay format are unchanged; news is derived from cumulative city damage.

## Previous verification — storm labels and condition hover ranges

- Live labels show the storm number, current game grade, outer circulation radius and movement speed (km/h), with Korean translations. Two-line placement flips/clamps inside the viewport.
- Armed-tool previews follow the mouse like drag previews. Unarmed hover within 22 CSS pixels of a placed condition icon reveals its range; moving away hides it. Longitude wrapping is respected. Keyboard aiming retains its crosshair, and pan/zoom clears stale hover.
- TypeScript and production build pass. Four Chromium checks pass for live label values/language switching, armed/placed hover ranges, drop anchoring and interrupted-drag cleanup. Verification uses drawing commands, not screenshots or pixels. Existing bundle warning remains; simulation/replay formats are unchanged.

## Previous verification — condition ranges only during dragging

- Placed conditions show their glyph and remaining time without a filled range or boundary. Armed hover has no range; keyboard targeting keeps its crosshair. Only an active drag shows the range and radius label. Simulation effect sizes are unchanged.
- TypeScript and production build pass. A focused Chromium check of canvas drawing commands passed for armed hover, active drag, completed drop and cancelled drag; no screenshots or pixel extraction. Existing bundle-size warning remains.

## Previous verification — clearer equator and tropics

- Added dedicated reference parallels at 0° and approximately ±23.44°: solid 2.4 px gold equator and dashed 1.8 px cyan tropics, both with a dark under-stroke for contrast over weather layers. Dark-backed name/latitude badges support English and Korean, and ordinary grid labels near the reference lines are suppressed to reduce overlap.
- Production build and TypeScript pass. A focused Chromium check observed canvas text/stroke commands (no pixel extraction or screenshots): all three latitudes, solid/dashed styles, wind/pressure/temperature/population layers, language switching and label bounds at 375 px passed. Stroke comparisons allow normal canvas floating-point precision.
- This is a visual-only change; simulation and replay versions are unchanged. No new automated test files were added for this styling adjustment. Existing bundle-size warning remains.

## Previous verification — location-based opening region

- Startup shows Southeast Asia immediately (115°E, 10°N; 60° span across the viewport’s shorter side). Browser geolocation replaces it with the returned region at a 36° span, within camera limits. Permission denial, unavailable/throwing API, invalid coordinates or an unanswered request after 8 seconds retain the fallback.
- Location uses `getCurrentPosition` with low-accuracy preference, a five-minute maximum cache age and an eight-second timeout, plus an explicit application deadline. No IP lookup, external location service, location storage or simulation changes were introduced.
- Pointer, wheel or keyboard interaction prevents a late result from moving the camera. Timed-out or disposed callbacks cannot change it either. Map reset returns to the configured opening region; regional framing adapts to resize, while players can still zoom out to the world.
- `npm test`: **110/110 passed**, including five new startup-location tests for success/reset/resize, denial/missing/throwing/invalid providers, timeout and late-result rejection, interaction/disposal, mobile fallback and world zoom-out.
- Focused Chromium startup/palette checks: **11/11 passed**, including actual browser geolocation permission with a supplied test position, denied/missing-provider fallback on desktop/mobile, permission wait timeout, an in-progress map gesture, and existing drop reliability cases. The gameplay fixtures now explicitly choose a world overview when they need two distant basins instead of assuming the production opening view is global.
- Additional gameplay checks: **5/5 passed** for multi-basin drag-to-genesis, Canvas drops, touch placement/cancellation, wheel zoom and keyboard placement/land rejection. Combined browser verification: **16/16 passed**.
- TypeScript and production build pass. Existing chunk-size warning remains. No screenshots or image captures were taken; all browser runs used `TYPHOON_SCREENSHOTS=0`.

## Previous verification — radii, storm history and map grades

- Removed exact-centre/eye wind from storm rows and detail. Rows now show movement, central pressure, outer circulation radius and gale radius; detail retains maximum wind and maximum-wind radius. The radius note explains the outer model cutoff versus estimated ≥17.2 m/s gale extent, in both languages.
- Map-following labels use current game grade 0–5 (existing stage thresholds), not ID, wind speed or lifetime peak. Sidebar/news retain stable IDs; the stage legend explains the game scale.
- The engine stores birth, hourly and stage-change samples, plus final samples at dissipation, high-latitude exit or absorption. Both strengthening and weakening are preserved. Full tracks are no longer truncated at 1,000 points. `stormArchive` keeps ended records independently of the bounded news feed; forecast-only mergers never archive or mutate live histories.
- Selecting a history row fits the entire dateline-aware route, draws static grade/stage/time markers and an outcome endpoint, and shows a recorded wind chart and stage list. History labels avoid one another and stay left of the sidebar; on narrow screens selecting history closes the sidebar to expose the map. Manually selected absorbed records remain selected across new worker snapshots, while an actively selected storm still follows its surviving merger partner.
- Records belong to the current world. Reset clears them; replay export/import reconstructs them exactly. Simulation 0.4.0 / replay format 2 remain unchanged because physics and action interpretation are unchanged.
- `npm test`: **105/105 passed**, including natural growth→weakening→dissipation with complete archived replay, one-time absorbed records, forecast isolation, current-strength grade labels and fitting a dateline-crossing route.
- Focused Chromium browser checks: **7/7 passed** (`storm-history`, `storm-metrics`, `merger`, `worker`). Covers English/Korean labels, missing eye-wind fields, model-derived radius values, history selection and replay restoration, mobile map visibility, full-path fit, non-overlapping stage-label bounding boxes beside the sidebar, actual canvas text commands, selected absorbed-record retention, worker exact replay/pause/reset and continuous play.
- TypeScript and production build pass; the existing chunk-size warning remains. All browser checks used `TYPHOON_SCREENSHOTS=0`; no screenshots, image captures or pixel extraction were used. Canvas checks observed text drawing commands and geometry only.

## Previous verification — reliable palette drops

- Reproduced two failures before changing code: pointerup at a distant target with no intervening pointermove produced no placement; releasing pointer capture mid-drag discarded a later in-window release. Both browser regressions failed before the fix and pass afterward.
- Palette completion now checks release displacement as well as prior move events. Losing capture falls back to window listeners; actual pointer cancellation, Escape, blur, hidden-page changes and released mouse buttons still clean up the ghost/preview without placement.
- Touch preview, visible lifted icon and drop all use the same point (44 CSS px above the finger). The mobile touch check verifies the ghost centre and actual 140°E/16°N placement using coordinates, without screenshots.
- Secondary pointers cannot replace the active drag or start a map gesture. Delayed drag clicks are suppressed until consumed or a new intentional press begins; keyboard activation remains available. Repeated drops do not arm tools or move the camera.
- Ten distinct focused Chromium browser checks passed: all six `palette.spec.ts` cases plus gameplay drag-to-genesis, Canvas drops, touch placement/cancellation, and keyboard placement/land rejection. The secondary-pointer case was rerun after adding protection against clicks during a drag. Sixteen consecutive rapid drops yield exactly sixteen actions in the correct tool order.
- `npm test`: **101/101 passed**. TypeScript and production build pass; the existing large-chunk warning remains. No simulation/replay version change for this input-only fix.
- No screenshots or image captures were taken. Browser tests used `TYPHOON_SCREENSHOTS=0` with capture disabled in Playwright config. These checks cover Chromium mouse/touch and synthetic event interruption/pen release paths; they do not establish behavior on every physical device/browser.

## Previous verification — movement speed and mutual steering (simulation 0.4.0)

- Storm list and selected details show movement speed in km/h in English and Korean, separately from wind. This is actual last-step displacement per model hour, initially 0. A merger’s weighted centre adjustment is excluded.
- Same-hemisphere neighbours now induce bounded rotation and close-range convergence. Directions reverse in the south; longitude offsets wrap. Interaction fades by 1,000 km, ramps with the younger storm’s age over 24 h, and the combined perturbation is capped at 8 m/s. These are tuned game parameters, not universal meteorological thresholds. Independent genesis and the 100 km / 24 h / 17.2 m/s merger gates remain.
- Live steering, surface-wind asymmetry and forecast motion share the interaction function. Forecasts advance all cloned centres together at 0.25 h with frozen intensity/effect strength, applying merger gates and ending absorbed paths. They do not mutate live positions, news or ages.
- `npm test`: **101/101 passed**. New checks cover measured speed including dateline travel, both hemispheres, isolated/newborn/distant/opposite-spin cases, crowded/coincident finite motion and caps, stable summation order, natural convergence and merger of an initially ~214 km separated 40/19 m/s pair, merger displacement exclusion, and forecast isolation. Existing independent genesis, exact replay and field consistency tests pass.
- `TYPHOON_SCREENSHOTS=0 npx playwright test tests/browser/storm-metrics.spec.ts tests/browser/merger.spec.ts tests/browser/genesis.spec.ts tests/browser/worker.spec.ts`: **6/6 passed**. Checks include Korean/English speed in rows/details, mobile 320 px and desktop 1440 px DOM overflow checks, live metric updates, selection through mergers, independent nearby births, exact worker replay, pause/reset and continuous play past 180 model hours. No screenshots or image captures were taken.
- `npm run build`: TypeScript and production build pass. Main JS 379.96 kB gzip; worker 553.63 kB minified. Existing chunk-size warning remains.
- Simulation/scenario/package versions are 0.4.0; older-model replays are rejected because paths now change. Replay file format remains 2. This is a simplified interaction model, not a full fluid/weather simulation or real-device performance validation.

## Previous verification — explicit mature-storm mergers (simulation 0.3.0)

- Added deterministic mergers after genesis. Both storms must be in the same hemisphere, at least 24 model hours old, at least 17.2 m/s, and within 100 km. Closest disjoint pairs merge per step, with ID tie breaks. Young storms and forming lows keep their independent progress.
- The stronger current wind/ID survives; wind speeds are not added. The centre is weighted by squared wind, with dateline-safe offsets. Age and historic peak are preserved, pressure/radii are recomputed, and track/forecast update immediately. News records absorbed/surviving IDs; selected-storm details follow the survivor, including chained mergers.
- This is a bounded game approximation, not a full simulation of mutual orbital motion.
- `npm test`: **93/93 passed**, including natural independent birth→merger→exact replay, no duplicate merger events, candidate preservation, stronger-ID retention, age/strength/distance/hemisphere exclusions, dateline handling, pressure/field consistency and deterministic disjoint pairing.
- Browser checks: **3/3 passed** in `merger.spec.ts`, `genesis.spec.ts` and `storm-metrics.spec.ts`. The merger check uses the live worker, follows selection from the absorbed storm, verifies Korean/English news and exact post-merger replay. Earlier independent genesis and wind/pressure displays remain covered.
- Build and TypeScript passed. Main JS: 379.39 kB gzip; worker: 552.71 kB minified. The existing bundle-size warning remains. No screenshots were taken.
- Simulation/scenario/package versions are now 0.3.0; the replay parser rejects 0.2.1 as well as older model versions rather than silently changing their outcomes. Replay file format remains version 2.

## Previous verification — storm list wind and pressure readings

- The existing list speed is explicitly labelled maximum wind. Each row also shows central pressure in hPa and wind at the exact centre in m/s; the selected-storm details include the same centre-wind reading. Korean and English labels explain that wind is not movement speed.
- Centre wind uses the magnitude of `totalWind(state, storm.lon, storm.lat)`, including background and neighbouring circulations. Pressure uses the storm's already-synchronised central pressure. This is display-only; simulation/replay behaviour is unchanged.
- `tests/browser/storm-metrics.spec.ts`: **passed**, verifying both storms against the model, selected details, live updates, Korean/English switching, and non-overflowing rows at 320/1440 px. No screenshots were taken.
- Production build and TypeScript pass. Main JS: 378.71 kB gzip; CSS: 5.07 kB gzip. The existing chunk-size warning remains.

## Previous verification — independent nearby genesis (simulation 0.2.1)

- Removed the 600 km genesis exclusion and the cleanup that silently consumed other nearby lows. Each low retains its candidate ID/progress, produces one depression when its own threshold is met, and consumes only its own effect. Nearby, overlapping, staggered and newly added lows can all form independently.
- Simulation tests: 29 passed, including overlapping/simultaneous genesis, preserved staggered progress, genesis near an existing storm, cross-basin formation, exact replay, centre-pressure consistency and no duplicate formation events.
- Full unit run: 87/88 passed initially; the only failure was the scenario test's old version literal. After updating it to 0.2.1, all 40 data tests passed in a focused rerun. All 88 cases now have passing results across those runs.
- Browser checks: **4/4 passed** with `TYPHOON_SCREENSHOTS=0 npx playwright test tests/browser/genesis.spec.ts tests/browser/worker.spec.ts --workers=1 --reporter=line`. The live UI test observes three nearby progress rows become three distinct storm rows. Worker checks cover exact replay, growth, pause/reset and continuous play.
- **No screenshots were taken.** Automatic screenshots and trace screenshots are disabled; existing explicit capture calls are opt-in via `TYPHOON_SCREENSHOTS=1` only when capture is expressly requested.
- TypeScript and production build passed. Main JS remains 376.85 kB gzip; worker is 551.39 kB minified. The existing chunk-size warning remains.
- Formation semantics changed, so simulation/scenario/package versions are 0.2.1. Replay format remains 2, but 0.2.0 simulation replays are rejected explicitly instead of silently producing different outcomes. The replay parser test covers that rejection.

## Previous verification — Korean language support

- Korean/English selection is available in the right sidebar, applies without restarting the simulation, and persists locally. Korean browser locales start in Korean; `?lang=ko` provides a direct override.
- Controls, help, accessible labels, city/storm map labels, news, placement messages and replay errors are translated. Source text is retained for live switching. IDs, simulation data and replay JSON remain unchanged.
- Unit suite: **85 passed**. The two translation tests were rerun successfully after the final dictionary changes.
- Browser suite: the full 22-case run passed 21 cases and found an untranslated replay confirmation in the new language test. That message was added; the language suite then exposed an incorrect fixed storm ID in its test fixture. After correcting the assertion to use the actual generated ID, **all 3 language tests passed**. Thus all 22 browser cases have passing results across the full run and focused rerun; a second complete 22-case run was not performed.
- Checks cover Korean default selection, persistence, Korean→English→Korean switching without state changes, help/error messages, translated generated storm news, unchanged replay/model data, and 320 px layout. Existing gameplay, mobile layouts, drag cleanup, touch, replay, rendering recovery and worker tests passed in the full run. This resolves the earlier outstanding browser-validation concern recorded below.
- `npm run build`: passed, including TypeScript. Main JS: 1,140.68 kB minified / 376.85 kB gzip. CSS: 21.41 kB / 5.03 kB gzip. Worker: 551.67 kB minified. The existing Vite chunk-size warning remains.
- Inspected Korean desktop panel/help text and 320 px screenshots. No physical-device performance claim is made.

The sections below retain the earlier integration history.

## Follow-up: floating icons left after a drag

The palette previously only finished a drag on its button's `pointerup` or `pointercancel`. Lost capture or focus could leave both its fixed-position ghost and the map's placement preview active. Drag state is now shared across the palette, release/cancellation is observed at the window, and capture loss, blur, hidden tabs, Escape and a mouse returning with no button pressed clear the drag. Cleanup resets ownership before releasing capture to avoid duplicate callbacks.

- `npm run build`: passed after this fix (main bundle 1,115.46 kB / 365.76 kB gzip; the existing chunk-size warning remains).
- Focused Chromium browser run: **5/5 passed**. This includes normal drop cleanup and geographic anchoring during a pan; interrupted drags and retargeted releases; touch drop/cancellation; keyboard placement; and the full live multiple-storm test, including its final reset. The prior long-gameplay timeout did not recur in this run.
- Command: `npx playwright test tests/browser/palette.spec.ts tests/browser/gameplay.spec.ts --grep 'drop removes|interrupted drags|touch dragging|free drag-and-drop|keyboard' --workers=1 --reporter=line`.
- A complete rerun of every browser test was not performed for this focused fix. The earlier integration record below is retained as history.

## Results

- `npm test`: **83 passed** (40 geography, 26 simulation, 11 renderer, 6 replay-file tests).
- `npm run build`: **passed**, including TypeScript checking. The final main bundle is 1,114.89 kB minified / 365.65 kB gzip; CSS is 20.94 kB / 4.92 kB gzip, and the worker is 551.67 kB minified. Vite reports its >500 kB chunk warning.
- The completed 17-test browser run had **16 passes and 1 timeout**. The long gameplay test successfully placed six conditions, switched layers, formed two storms and observed growth to typhoon strength, then exhausted its 60-second deadline during the final reset check. Reset and automatic restart passed in other browser tests.
- Passing browser coverage includes five viewport widths (1440, 768, 414, 375, 320 px), mouse-pan freeze while worker time continues, wheel zoom, touch placement/cancellation, keyboard placement and land rejection, snapshot export/import, same-tick replay field replacement, Canvas fallback, WebGL context recovery, and all three real-worker tests. Worker checks include exact full-state replay and continued empty-world play past 180 model hours.
- Final integration also fixed Play-button hover contrast and prevented adaptive particle resizing during gestures. The gameplay test now avoids transferring the weather grid on each UI poll and has a 90-second deadline; the layout test additionally checks speed buttons against their clipping container.
- The final browser reruns **did not finish successfully**. One run timed out in gameplay and mobile layout; a serial retry timed out during the initial state read. Observed machine load averages rose above 100 and later 298. The reruns were stopped rather than counted as passes. The final source builds, but a clean complete browser rerun remains outstanding. No production-browser smoke result is claimed.

Run `npm run test:e2e -- --workers=1` when the host has available capacity. These results supersede the old regional game's 58-unit / 11-browser record.

## Implemented behaviors

- Empty initial world, automatic live clock, explicit pause, reset into live play.
- Free overlapping conditions, delayed genesis, multiple independent storms, progressive intensity and circulation growth.
- Global coastlines, both hemispheres, wrapped longitude physics.
- Full viewport map at desktop and narrow mobile widths; only a right sidebar; bottom drag-and-drop tools; no budget/cost UI.
- Frozen rendered weather during map gestures while worker time continues, followed by catch-up on release.
- Deterministic snapshot replay, bounded malformed-input handling, Canvas fallback and WebGL recovery.

These checks establish software behavior and internal consistency, not forecast skill or physical-device frame rate. Weather, population, vulnerability, and scores are fictional. The map is flat, the weather grid is 2°, and particle advection uses the CPU.
