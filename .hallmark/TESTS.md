# Test record (UI and renderer, v0.2 worldwide sandbox)

Run 2026-10-23.

Simulation 0.3.0 merger update: 93 unit tests and 3 focused browser tests passed, including live merger news/selection, independent genesis, and storm metrics. No screenshots were taken. Build/TypeScript pass; main bundle is 379.39 kB gzip. See `VALIDATION.md`.

Latest follow-up (simulation 0.2.1): nearby genesis and worker browser checks pass 4/4. Three nearby progress rows become three distinct storms. No screenshots were taken; automatic/trace screenshots are disabled and explicit captures are opt-in. See `VALIDATION.md`.

- `npm run build`: passes, including TypeScript (main bundle 376.85 kB gzip; Vite warns about a >500 kB chunk).
- `tests/render.test.ts` and `tests/replay-file.test.ts` (17 tests, pass): camera round-trips on phone and desktop, initial fit shows the 140°E/16°N and 55°W/16°N drop sites, dateline nearest-copy and camera wrapping, polar clamp, 2° field sampling alignment and periodicity, latitude-aware range ellipses (including 55°S), particle direction, zoom-independent particle speed and dateline wrap, replay version 2 files (strict parsing, engine limits, southern and ±180 positions, export refusal beyond the replay limit while live play is unaffected).
- Playwright smoke (scratch script outside the repo) at 1440, 768, 414, 375, 320 px: no page errors, no horizontal scroll, no button outside the viewport, WebGL active. Screenshots reviewed for the floating layout.
- Current browser validation: 21/22 passed in the full run; after translating the missing replay confirmation and correcting the new language test's storm-ID assumption, all 3 language tests passed in a focused rerun. All 22 cases now have passing results across these runs. Korean controls, persistence, live switching, news and 320 px layout are covered. See `VALIDATION.md` for run details and historical results.
- Review fixes applied: isobar contours join across the dateline, Canvas field padded and clipped per tile, field rebuilt for every new worker state object, forming progress shown as percent of `GENESIS_HOURS`, shared `MIN_COS` floor, replay acceptance also checks the seed, a rejected replay no longer leaves the UI paused, reset returns to 1×.
- Not measured: GPU frame rate on real devices. Headless Chromium uses software GL and lowers the particle count automatically. No 60 fps claim is made.
