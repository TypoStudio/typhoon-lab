import { LOCALES, getLanguage, setLanguage, localizeTree, localizedText, setText, t, typhoonName } from '../i18n';
import { CITIES, SCENARIO } from '../data/world';
import { isLake } from '../data/lakes';
import { TYPHOONS, typhoonById } from '../data/typhoons';
import { layerLegend, type LayerLegend } from '../render/fields';
import { tickPosition } from './legend-scale';
import { MapRenderer } from '../render/map';
import type { MapOverlay } from '../render/overlay';
import { wrapLon } from '../render/view';
import { SEAS, seaName } from '../data/seas';
import { GENESIS_HOURS, GENESIS_THRESHOLD, TICKS_PER_HOUR, TOOLS, dayOfYear } from '../simulation/engine';
import { distanceKm } from '../simulation/geo';
import { DEFAULT_MAP_OVERLAYS } from '../types';
import type {
  ActionRecord, City, ClimateKey, GameState, GeoPoint, MapOverlays, NewsItem, PlacementResult, Storm, StormRecord, ToolDefinition, ToolType, WorkerRequest, WorkerResponse,
} from '../types';
import { stageChanges, stormGradeLabel, stormOutcome } from '../storm-info';
import { estimateCityDamage, stormLossUsd } from '../simulation/damage-news';
import { newsArt } from './art';
import { el, svgEl, fmtClock, fmtClockDate, fmtClockShort, fmtCoord, fmtInt, fmtMoney, fmtPop, fmtUtc, rovingKeys } from './dom';
import { SEASONS, fmtMonthDay, parseStartParam, realDayOfYear, seasonIdOf } from './calendar';
import { attachMapInput } from './input';
import { attachPalette } from './palette';
import { attachTooltips } from './tooltip';
import { createTutorial, shouldAutoStart } from './tutorial';
import { initialiseLocation } from './initial-location';
import { CLIMATE_ROWS, CYCLONE_PATH, FORMATION_TOOLS, PALETTE_TABS, FORMATION_KEYS, SPEEDS, TOOL_KEYS, footerHtml, shellHtml, terrainIconSvg, toolIconSvg, type FormationToolId, type Terrain } from './shell';
import { MAX_REPLAY_BYTES, buildReplay, downloadJson, parseReplay, parseSeedParam, randomSeed, replayExportProblem } from './storage';
import { deleteMyData, queuedCount, flushQueue, resultFromRecord, setNickname, storedNickname, defaultNickname, subscribe as subscribeLeaderboard, submit as submitResult, type LbView, type LbWindow } from '../net/leaderboard';
import { entryFromStorm, localRankingStore, rankBy, upsert, type RankingEntry, type RankingMetric } from './rankings';

/** Ended storms listed before the "Show all" link appears. */
const ARCHIVE_VISIBLE = 8;

type Expect = 'normal' | 'reset' | 'replay';
type ToastKind = 'info' | 'ok' | 'error';

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const END_REASON_LABEL: Record<RankingEntry['endReason'], string> = { active: 'Active', dissipated: 'Dissipated', extratropical: 'Extratropical transition', merged: 'Merged' };
const TOOL_BY_TYPE = new Map<ToolType, ToolDefinition>(TOOLS.map(t => [t.type, t]));
/** Anything the palette can arm: a weather condition, or a formation probe that opens the recipe popover. */
type ArmedTool = ToolType | FormationToolId;
const FORMATION_BY_ID = new Map<ArmedTool, (typeof FORMATION_TOOLS)[number]>(FORMATION_TOOLS.map(f => [f.id, f]));
const isFormation = (tool: ArmedTool | null): tool is FormationToolId => tool !== null && FORMATION_BY_ID.has(tool);
const PALETTE_TAB_KEY = 'typhoon-lab-palette-tab';
const LEGEND_KEY = 'typhoon-lab-legend';
function storedPaletteTab(): string {
  try { const v = localStorage.getItem(PALETTE_TAB_KEY); return PALETTE_TABS.some(t => t.id === v) ? v! : PALETTE_TABS[0].id; } catch { return PALETTE_TABS[0].id; }
}
const actionsSig = (a: ActionRecord[]) => JSON.stringify(a.map(x => x.type === 'genesis' ? [x.tick, x.type, x.on] : x.type === 'historic' ? [x.tick, x.type, x.typhoonId] : x.type === 'climate' ? [x.tick, x.type, x.key, x.value] : x.type === 'season' ? [x.tick, x.type, x.dayOfYear] : [x.tick, x.type, x.lon, x.lat]));
/** UI-only setting, remembered like the language. */
const PATHS_KEY = 'typhoon-lab-recorded-paths';
function storedShowPaths(): boolean {
  try { return localStorage.getItem(PATHS_KEY) !== 'off'; } catch { return true; }
}

/** Label layers (city names, isobar values, sea names): UI-only, on by default, remembered per layer. */
const LABEL_IDS = ['cities', 'isobars', 'seas'] as const;
type LabelId = (typeof LABEL_IDS)[number];
const labelKey = (id: LabelId) => `typhoon-lab-label-${id}`;
function storedLabel(id: LabelId): boolean {
  try { return localStorage.getItem(labelKey(id)) !== 'off'; } catch { return true; }
}

const MAP_MODE_KEY = 'typhoon-lab-map-mode';
function storedMapMode(): 'flat' | 'globe' | null {
  try { const v = localStorage.getItem(MAP_MODE_KEY); return v === 'flat' || v === 'globe' ? v : null; } catch { return null; }
}

export interface AppHandle { dispose(): void }

/** Wires the DOM shell, map renderer and simulation worker together. */
export function createApp(root: HTMLElement, worker: Worker): AppHandle {
  root.innerHTML = shellHtml();
  setLanguage(getLanguage());
  localizeTree(root);
  const app = root.querySelector<HTMLElement>('.app')!;
  const ref = <T extends HTMLElement = HTMLElement>(name: string): T => {
    const node = root.querySelector<T>(`[data-ref="${name}"]`);
    if (!node) throw new Error(`Missing UI element: ${name}`);
    return node;
  };
  const metrics = new Map<string, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>('[data-metric]').forEach(n => {
    const list = metrics.get(n.dataset.metric!) ?? [];
    list.push(n);
    metrics.set(n.dataset.metric!, list);
  });
  const setMetric = (name: string, text: string, scope?: Element) => {
    for (const n of metrics.get(name) ?? []) if ((!scope || scope.contains(n)) && n.textContent !== text) setText(n, text);
  };

  const stage = ref('stage');
  const veil = ref('veil');
  const sidebar = ref('sidebar');
  const sidebarBesideMap = window.matchMedia('(min-width: 48rem)');
  /** Width of the map covered by the sidebar: none when it sits beside the stage, its full width when it overlays (phones). */
  const sidebarInset = (): number => {
    if (sidebar.hidden || sidebarBesideMap.matches) return 0;
    const width = sidebar.getBoundingClientRect().width;
    return width >= window.innerWidth - 8 ? 0 : width; // a full-width phone overlay hides the whole map, so nothing is worth keeping clear
  };
  const toolButtons = new Map<ArmedTool, HTMLButtonElement>();
  root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => toolButtons.set(b.dataset.tool as ArmedTool, b));
  const overlayButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-overlay]')];
  const speedButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  const historicSelect = ref<HTMLSelectElement>('historicSelect');
  /** Typhoon names are data, so options are labelled here instead of through the translation tables. */
  function labelHistoricOptions(): void {
    const selected = historicSelect.value;
    historicSelect.replaceChildren(...TYPHOONS.map(h => el('option', { value: h.id, title: `${h.peakPressure} hPa`, text: `${typhoonName(h)} (${h.year}) · ${t(h.basin)}` })));
    historicSelect.value = selected || TYPHOONS[0].id;
    showHistoricPeak();
  }
  function showHistoricPeak(): void {
    historicSelect.title = `${typhoonById(historicSelect.value)?.peakPressure ?? ''} hPa`;
  }
  const tabButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const helpDialog = ref<HTMLDialogElement>('helpDialog');
  const seasonButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-season]')];
  const climateInputs = new Map<ClimateKey, { input: HTMLInputElement; output: HTMLElement }>(
    CLIMATE_ROWS.map(r => [r.key, { input: ref<HTMLInputElement>(r.ref), output: ref(`${r.ref}Value`) }]));
  /** Sliders mid-drag: the worker's older value must not pull the thumb back before `change` posts the new one. */
  const climateDirty = new Set<ClimateKey>();

  // ---- state -------------------------------------------------------------------------------
  const ui = {
    /** What the map and panels currently show. */
    state: null as GameState | null,
    /** Newest state accepted from the worker; may be ahead of `state` during a camera gesture. */
    latest: null as GameState | null,
    pending: null as GameState | null,
    pendingEvent: null as 'reset' | 'replay' | null,
    tool: null as ArmedTool | null,
    cursor: null as GeoPoint | null,
    hover: null as GeoPoint | null,
    drag: null as { tool: ArmedTool; point: GeoPoint | null } | null,
    overlays: { ...DEFAULT_MAP_OVERLAYS },
    showRecordedPaths: storedShowPaths(),
    speed: 1 as number,
    playing: true,
    selectedStormId: null as number | null,
    selectedCityId: null as string | null,
    expect: 'normal' as Expect,
    expectBaseTick: 0,
    expectUntil: 0,
    expectSeed: 0,
    expectSig: '',
    newsKey: '',
    newsSeen: 0,
    tab: 'storms',
    /** True once "Show all" has revealed the older ended storms. */
    archiveOpen: false,
    placementQueue: [] as ((r: PlacementResult) => void)[],
    lastPlacementAt: 0,
    rankMetric: 'lossUsd' as RankingMetric,
    lbWindow: 'live' as LbWindow,
    lbView: null as LbView | null,
    lbError: false,
    /** Spot the tutorial rings on the map. */
    tutorialTarget: null as GeoPoint | null,
  };
  /** Called with every accepted worker state (the tutorial watches for the player's moves). */
  const stateListeners: ((state: GameState) => void)[] = [];
  let lbStop: (() => void) | null = null;
  const rankingStore = localRankingStore();
  let rankings = rankingStore.load();
  /** Ranking keys of this world's ended storms already written to the store, by storm id. */
  const rankedKeys = new Map<number, string>();
  let expectTimer = 0;
  let toastTimer = 0;
  /** Phones show the starting hint for a few seconds only; this stays true once it has timed out. */
  let hintDismissed = false;
  let statsAt = 0;

  // ---- renderer ----------------------------------------------------------------------------
  let renderer: MapRenderer | null = null;
  const params = new URLSearchParams(location.search);
  const urlSeed = parseSeedParam(location.search);
  const urlStart = parseStartParam(location.search);
  /** A new world starts on the real date (UTC), or on the `?start=` / `?doy=` date that tests pin. */
  const newStartDay = () => urlStart ?? realDayOfYear();
  const canvasNote = 'Canvas 2D map (WebGL unavailable). Fewer wind particles; the simulation is unaffected. Globe view needs WebGL; showing the flat map.';
  const queryMode = params.get('map');
  const requestedMode: 'flat' | 'globe' = queryMode === 'flat' || queryMode === 'globe' ? queryMode : storedMapMode() ?? 'globe';
  try {
    renderer = new MapRenderer(stage, { forceCanvas: params.get('renderer') === 'canvas' });
    stage.dataset.renderer = renderer.kind;
    renderer.setMode(requestedMode);
    renderer.setLabels(Object.fromEntries(LABEL_IDS.map(id => [id, storedLabel(id)])));
    const note = ref('rendererNote');
    if (renderer.kind === 'canvas') {
      note.hidden = false;
      setText(note, canvasNote);
    }
    renderer.onLostChange = lost => {
      note.hidden = !lost && renderer?.kind !== 'canvas';
      if (lost) setText(note, 'Graphics context lost. Waiting for the browser to restore it…');
      else if (renderer?.kind === 'canvas') setText(note, canvasNote);
    };
  } catch (error) {
    stage.dataset.renderer = 'none';
    setText(ref('veilText'), `The map could not start: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }

  // ---- helpers -----------------------------------------------------------------------------
  const post = (msg: WorkerRequest) => worker.postMessage(msg);

  function toast(text: string, kind: ToastKind = 'info', ms = 5000): void {
    const t = ref('status');
    setText(t, text);
    t.dataset.kind = kind;
    t.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.hidden = true; }, kind === 'error' ? Math.max(ms, 8000) : ms);
  }

  function announce(text: string): void {
    const a = ref('announce');
    setText(a, '');
    requestAnimationFrame(() => { setText(a, text); });
  }

  /** The position line above the legend keeps its last text. */
  function showReadout(text: string, terrain?: Terrain): void {
    const line = ref('coords');
    if (!terrain) { setText(line, text); return; }
    const label = t({ sea: 'Sea', land: 'Land', lake: 'Lake' }[terrain]);
    const icon = el('span', { class: 'legend-pos__terrain', role: 'img', 'aria-label': label, title: label, 'data-terrain': terrain });
    icon.innerHTML = terrainIconSvg(terrain);
    line.replaceChildren(el('span', { class: 'legend-pos__text' }, [localizedText(text)]), icon);
  }

  /** Live legend values: rows keep their value span and marker, so a hover only rewrites text and `left`. */
  const legendLive = new Map<string, { value: HTMLElement; tick: HTMLElement | null; ticks: LayerLegend['ticks'] }>();
  let windValue: { speed: HTMLElement; vertical: HTMLElement } | null = null;
  let rainTip: HTMLElement | null = null;
  let lastSampleAt: { lon: number; lat: number } | null = null;
  type MapSample = NonNullable<ReturnType<MapRenderer['sampleAt']>>;

  function setLegendValue(id: string, text: string, value: number): void {
    const row = legendLive.get(id);
    if (!row) return;
    setText(row.value, text);
    if (!row.tick) return;
    const pos = tickPosition(row.ticks, value, id === 'population');
    row.tick.hidden = pos === null;
    if (pos !== null) row.tick.style.left = `${pos * 100}%`;
  }

  function writeLegendValues(sample: MapSample): void {
    if (windValue) {
      setText(windValue.speed, `Wind ${sample.wind.toFixed(0)} m/s`);
      setText(windValue.vertical, sample.updraft < 0 ? `Downdraft ${(-sample.updraft).toFixed(1)} m/s` : `Updraft ${sample.updraft.toFixed(1)} m/s`);
    }
    setLegendValue('humidity', `${(sample.humidity * 100).toFixed(0)}%`, sample.humidity * 100);
    const snowing = sample.blizzard || sample.snow >= 0.5;
    const precipitation = snowing ? sample.snow : sample.rain;
    const rain = [`${precipitation.toFixed(1)} mm/h${snowing ? ' ❄' : ''}`];
    if (sample.blizzard) rain.push('Blizzard');
    setLegendValue('rain', rain.join(' · '), precipitation);
    if (rainTip) {
      const note = layerLegend('rain').note;
      rainTip.setAttribute('data-tip', sample.snowCm >= 1 ? `${note} · ${sample.snowCm.toFixed(0)} cm on ground` : note);
    }
    setLegendValue('pressure', `${sample.pressure.toFixed(0)} hPa`, sample.pressure);
    setLegendValue('temperature', sample.land ? `${sample.airTemperature.toFixed(1)} °C` : `${sample.temperature.toFixed(1)} / ${sample.airTemperature.toFixed(1)} °C`, sample.land ? NaN : sample.temperature);
    setLegendValue('population', fmtPop(sample.population), sample.population);
  }

  /** Position line plus every legend value at a map point. */
  function showAt(lon: number, lat: number): void {
    lastSampleAt = { lon, lat };
    const sample = renderer?.sampleAt(lon, lat);
    showReadout(fmtCoord(lon, lat), sample ? (isLake(lon, lat) ? 'lake' : sample.land ? 'land' : 'sea') : undefined);
    if (sample) writeLegendValues(sample);
  }

  // ---- overlay -----------------------------------------------------------------------------
  function refreshOverlay(): void {
    if (!renderer) return;
    const type = ui.drag?.tool ?? ui.tool;
    // A formation probe previews the footprint of the low it would seed.
    const def = type ? TOOL_BY_TYPE.get(isFormation(type) ? 'low' : type) ?? null : null;
    const overlay: MapOverlay = {
      tool: def,
      target: ui.drag ? ui.drag.point : ui.tool ? ui.hover ?? ui.cursor : null,
      dragging: !!ui.drag,
      hover: !ui.drag ? ui.hover : null,
      selectedCityId: ui.selectedCityId,
      selectedStormId: ui.selectedStormId,
      showRecordedPaths: ui.showRecordedPaths,
      rightInset: sidebarInset(),
      tutorialTarget: ui.tutorialTarget,
    };
    renderer.setOverlay(overlay);
  }

  // ---- placement ---------------------------------------------------------------------------
  function placeAt(type: ToolType, lon: number, lat: number): void {
    const def = TOOL_BY_TYPE.get(type);
    if (!def) return;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      toast('Choose a position on the map (latitude within ±90°).', 'error');
      return;
    }
    const lonW = round2(wrapLon(lon));
    const latC = round2(clamp(lat, -90, 90));
    ui.lastPlacementAt = performance.now();
    ui.placementQueue.push(result => {
      if (result.ok) {
        toast(`${def.name} placed at ${fmtCoord(lonW, latC)}.`, 'ok', 3500);
        announce(`${def.name} placed.`);
      } else {
        toast(result.reason ?? `${def.name} could not be placed there.`, 'error');
      }
    });
    post({ type: 'place', tool: type, lon: lonW, lat: latC });
  }

  function armTool(type: ArmedTool | null): void {
    ui.tool = ui.tool === type ? null : type;
    ui.cursor = null;
    closeSpot();
    if (isFormation(ui.tool)) toast(`${FORMATION_BY_ID.get(ui.tool)!.name} armed. Tap or click a spot to see what it needs; Esc puts it away.`, 'info', 3500);
    else if (ui.tool) toast(`${TOOL_BY_TYPE.get(ui.tool)!.name} armed. Tap or click the map to place it; Esc puts it away.`, 'info', 3500);
    renderTools();
    refreshOverlay();
  }

  function renderTools(): void {
    for (const [type, b] of toolButtons) {
      const on = ui.tool === type;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-armed', on);
    }
    stage.dataset.armed = ui.tool ?? '';
  }

  // ---- clock and controls ------------------------------------------------------------------
  function renderClock(): void {
    const s = ui.latest;
    setText(ref('clockText'), s ? fmtClockDate(s.hours, fmtMonthDay(dayOfYear(s))) : fmtClock(0));
    ref('clockText').dataset.short = fmtClockShort(s?.hours ?? 0);
    const play = ref<HTMLButtonElement>('play');
    const label = ui.playing ? 'Pause' : 'Play';
    play.dataset.state = ui.playing ? 'playing' : 'paused';
    play.setAttribute('aria-label', label);
    play.dataset.tipTitle = label;
    localizeTree(play);
    play.disabled = !s;
    syncClimateDisabled();
    if (play.dataset.label !== label) {
      play.dataset.label = label;
      play.replaceChildren(playIcon(ui.playing), localizedText(label));
    }
    for (const b of speedButtons) {
      const on = Number(b.dataset.speed) === ui.speed;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  function playIcon(playing: boolean): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'btn__icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', playing ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M8 5.5v13l11-6.5z');
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  function togglePlay(): void {
    if (!ui.latest || ui.expect !== 'normal') return;
    ui.playing = !ui.playing;
    post({ type: 'play', playing: ui.playing });
    renderClock();
  }

  function setSpeed(speed: number): void {
    ui.speed = speed;
    post({ type: 'speed', speed });
    renderClock();
  }

  function resetWorld(): void {
    ui.playing = true;
    ui.speed = 1;
    ui.tool = null;
    ui.cursor = null;
    closeSpot();
    ui.expectBaseTick = ui.latest?.tick ?? 0;
    ui.expectSeed = urlSeed ?? randomSeed();
    arm('reset');
    post({ type: 'reset', seed: ui.expectSeed, startDayOfYear: newStartDay() });
    post({ type: 'speed', speed: 1 });
    toast('World reset. It is empty again.', 'info', 3000);
    renderTools();
    renderClock();
    refreshOverlay();
  }

  function renderMapLegend(): void {
    legendLive.clear();
    windValue = { speed: el('span'), vertical: el('span') };
    rainTip = null;
    const rows: HTMLElement[] = [el('p', { class: 'legend__base', testid: 'legend-wind' }, [
      el('span', { class: 'legend__base-text' }, [localizedText(ui.overlays.wind ? 'Moving streaks show wind.' : 'Wind streaks are hidden.')]),
      el('span', { class: 'legend__value legend__readout', 'data-legend-value': true }, [windValue.speed, windValue.vertical]),
    ])];
    for (const id of ['humidity', 'rain', 'pressure', 'temperature', 'population'] as const) {
      if (!ui.overlays[id]) continue;
      const legend = id === 'humidity' ? {
        title: 'Humidity', unit: '%',
        gradient: 'linear-gradient(to right, var(--ramp-humidity-0), var(--ramp-humidity-1) 50%, var(--ramp-humidity-2))',
        ticks: [{ label: '0', pos: 0 }, { label: '50', pos: 0.5 }, { label: '100', pos: 1 }],
        note: ui.overlays.wind ? 'Higher humidity makes wind streaks brighter.' : 'Turn on Wind to see humidity colours.',
      } : layerLegend(id);
      if (id === 'temperature') legend.note = 'Sea-surface / air temperature; over land, air only. Water above about 26.5 °C helps development.';
      const row = el('div', { class: 'legend__item', testid: `legend-${id}` });
      const value = el('span', { class: 'legend__value', 'data-legend-value': true, text: legend.unit });
      const info = id === 'humidity' || id === 'rain' || id === 'pressure' || id === 'temperature'
        ? el('button', { type: 'button', class: 'legend__info', 'aria-label': legend.title, 'data-tip-title': legend.title, 'data-tip': legend.note, text: '?' })
        : null;
      if (id === 'rain') rainTip = info;
      row.append(el('p', { class: 'legend__title' }, [
        id === 'pressure' ? el('span', { class: 'legend__line', 'aria-hidden': 'true' }) : null,
        el('span', { class: 'legend__name' }, [localizedText(legend.title)]), info, value,
      ]));
      let tick: HTMLElement | null = null;
      if (id !== 'humidity' || ui.overlays.wind) {
        tick = el('span', { class: 'legend__tick', hidden: true, 'aria-hidden': 'true' });
        const bar = el('div', { class: 'legend__bar' }, [tick]);
        bar.style.background = legend.gradient;
        const ticks = el('div', { class: 'legend__ticks' }, legend.ticks.map(t => {
          const label = el('span', { text: t.label, 'data-edge': t.pos === 0 ? 'start' : t.pos === 1 ? 'end' : 'mid' });
          label.style.left = `${t.pos * 100}%`;
          return label;
        }));
        row.append(bar, ticks);
      }
      legendLive.set(id, { value, tick, ticks: legend.ticks });
      rows.push(row);
    }
    ref('legend').replaceChildren(...rows);
    const sample = lastSampleAt && renderer?.sampleAt(lastSampleAt.lon, lastSampleAt.lat);
    if (sample) writeLegendValues(sample);
  }

  function setMapOverlays(overlays: MapOverlays): void {
    ui.overlays = { ...overlays };
    renderer?.setOverlays(ui.overlays);
    for (const button of overlayButtons) button.setAttribute('aria-pressed', String(ui.overlays[button.dataset.overlay as keyof MapOverlays]));
    renderMapLegend();
  }

  // ---- sidebar -----------------------------------------------------------------------------
  function setSidebar(open: boolean): void {
    sidebar.hidden = !open;
    app.dataset.sidebar = open ? 'open' : 'closed';
    ref('sidebarToggle').setAttribute('aria-expanded', String(open));
    setText(ref('sidebarToggleLabel'), open ? 'Hide' : 'Storms');
    if (open) renderSidebar();
    refreshOverlay();
    syncLeaderboard();
  }

  function activateTab(id: string, focus = false): void {
    ui.tab = id;
    for (const b of tabButtons) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of panels) p.hidden = p.dataset.panel !== id;
    renderSidebar();
    syncLeaderboard();
  }

  function selectStorm(id: number | null, center = false): void {
    ui.selectedStormId = id;
    const s = findStorm(id);
    if (s && center) {
      if ('endReason' in s) {
        if (window.innerWidth < 700) setSidebar(false);
        renderer?.view.fitTrack(s.track, sidebarInset());
      } else renderer?.view.centerOn(s.lon, s.lat);
    }
    renderSidebar();
    refreshOverlay();
  }

  const stormRows = new Map<number, HTMLLIElement>();
  function findStorm(id: number | null): Storm | StormRecord | undefined {
    return ui.state?.storms.find(x => x.id === id) ?? ui.state?.stormArchive.find(x => x.id === id);
  }
  function renderStorms(): void {
    const s = ui.state;
    if (!s) return;
    setText(ref('stormSummary'), s.thunderstorms.length > 0
      ? `Tropical storms: ${s.storms.length} · Thunderstorms: ${s.thunderstorms.length} · Forming patches: ${s.candidates.length}`
      : s.storms.length === 0
      ? s.candidates.length > 0 ? `No storms yet. ${s.candidates.length} patch${s.candidates.length === 1 ? ' is' : 'es are'} forming.` : 'No storms. The world is calm.'
      : `${s.storms.length} active storm${s.storms.length === 1 ? '' : 's'}${s.candidates.length ? ` · ${s.candidates.length} forming` : ''}.`);
    const seen = new Set<number>();
    for (const storm of [...s.storms, ...s.stormArchive]) {
      const archived = 'endReason' in storm;
      const list = ref(archived ? 'stormArchive' : 'stormList');
      seen.add(storm.id);
      let li = stormRows.get(storm.id);
      if (!li) {
        li = el('li', {}, [el('button', { type: 'button', class: 'storm-row', 'data-storm-id': storm.id, 'data-testid': 'storm-row', 'aria-pressed': 'false' }, [
          el('span', { class: 'storm-row__name' }, [
            svgEl('svg', { class: 'storm-row__icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', fill: 'currentColor', 'fill-rule': 'evenodd' }, [svgEl('path', { d: CYCLONE_PATH })]),
            el('span', { class: 'storm-row__title' }),
          ]),
          el('span', { class: 'storm-row__wind' }, [
            el('span', { class: 'storm-row__label', text: 'Max wind' }),
            el('span', { testid: 'storm-max-wind' }),
          ]),
          el('span', { class: 'storm-row__pos' }, [el('span', { class: 'storm-row__chip', hidden: true }), el('span', { class: 'storm-row__when' })]),
          el('span', { class: 'storm-row__conditions' }, [
            el('span', {}, [el('span', { class: 'storm-row__label', text: 'Movement speed' }), el('span', { class: 'mono', testid: 'storm-movement-speed' })]),
            el('span', {}, [el('span', { class: 'storm-row__label', text: 'Central pressure' }), el('span', { class: 'mono', testid: 'storm-central-pressure' })]),
            el('span', {}, [el('span', { class: 'storm-row__label', text: 'Gale radius' }), el('span', { class: 'mono', testid: 'storm-gale-radius' })]),
            el('span', {}, [el('span', { class: 'storm-row__label', text: 'Estimated loss' }), el('span', { class: 'mono', testid: 'storm-loss' })]),
          ]),
        ])]);
        stormRows.set(storm.id, li);
      }
      if (li.parentElement !== list) { if (archived) list.prepend(li); else list.append(li); }
      const b = li.firstElementChild as HTMLButtonElement;
      b.dataset.testid = archived ? 'storm-history-row' : 'storm-row';
      b.setAttribute('aria-pressed', String(storm.id === ui.selectedStormId));
      const [name, wind, pos] = [...b.children] as HTMLElement[];
      setText(name.lastElementChild!, `${storm.name ?? `#${storm.id}`} ${storm.stage}`);
      setText(wind.lastElementChild!, `${storm.wind.toFixed(0)} m/s`);
      const [chip, when] = [...pos.children] as HTMLElement[];
      chip.hidden = !archived;
      if (archived) {
        const record = storm as StormRecord;
        chip.dataset.reason = record.endReason;
        setText(chip, record.endReason === 'merged' ? 'Merged' : stormOutcome(record));
        setText(when, fmtClock(record.endedHour));
      } else setText(when, fmtCoord(storm.lon, storm.lat));
      setText(b.querySelector('[data-testid="storm-movement-speed"]')!, `${storm.movementSpeedKmh.toFixed(1)} km/h`);
      setText(b.querySelector('[data-testid="storm-central-pressure"]')!, `${storm.pressure.toFixed(0)} hPa`);
      setText(b.querySelector('[data-testid="storm-gale-radius"]')!, `${storm.galeRadiusKm.toFixed(0)} km`);
      setText(b.querySelector('[data-testid="storm-loss"]')!, fmtMoney(stormLossUsd(storm.damageScore)));
    }
    for (const [id, li] of stormRows) if (!seen.has(id)) { li.remove(); stormRows.delete(id); }

    const detail = ref('stormDetail');
    ref('stormArchiveEmpty').hidden = s.stormArchive.length > 0;
    setText(ref('stormActiveTitle'), `Active storms · ${s.storms.length}`);
    setText(ref('stormEndedTitle'), `Ended storms · ${s.stormArchive.length}`);
    // Newest ended storm first; only the first few stay visible until "Show all" is pressed (a selected record always stays visible).
    const ended = [...ref('stormArchive').children] as HTMLLIElement[];
    if (ended.length <= ARCHIVE_VISIBLE) ui.archiveOpen = false;
    ended.forEach((li, i) => { li.hidden = !ui.archiveOpen && i >= ARCHIVE_VISIBLE && Number((li.firstElementChild as HTMLElement).dataset.stormId) !== ui.selectedStormId; });
    const more = ref('stormArchiveMore');
    more.hidden = ui.archiveOpen || ended.length <= ARCHIVE_VISIBLE;
    setText(more, `Show all (${ended.length})`);
    const sel = findStorm(ui.selectedStormId);
    detail.hidden = !sel;
    if (sel) renderStormDetail(sel, detail);

    ref('patchList').replaceChildren(...s.candidates.map(c => el('li', { class: 'patch' }, [
      el('span', { text: fmtCoord(c.lon, c.lat) }), el('span', { class: 'mono', text: `${Math.min(99, Math.floor((c.progressHours / GENESIS_HOURS) * 100))}% to a depression` }),
    ])));
    ref('patchEmpty').hidden = s.candidates.length > 0;
  }

  function renderRanking(): void {
    const s = ui.state;
    if (!s) return;
    const live = s.storms.map(storm => entryFromStorm(s.seed, storm, s.hours, s.actions));
    const worldKeys = new Set([...rankedKeys.values(), ...live.map(e => e.key)]);
    const ranked = rankBy(live.reduce(upsert, rankings), ui.rankMetric);
    ref('stormRank').replaceChildren(...ranked.map((entry, i) => {
      const storm = worldKeys.has(entry.key) ? findStorm(entry.stormId) : undefined;
      const content = [
        el('span', { class: 'storm-row__name' }, [el('span', { class: 'storm-rank__no', text: `${i + 1}.` }), ` ${entry.name}`]),
        el('span', { class: 'storm-row__wind', testid: 'rank-value', text: rankValue(entry, ui.rankMetric) }),
        el('span', { class: 'storm-row__pos', text: storm ? stormOutcome(storm) : END_REASON_LABEL[entry.endReason] }),
      ];
      return el('li', {}, [storm
        ? el('button', { type: 'button', class: 'storm-row', 'data-storm-id': storm.id, 'aria-pressed': String(storm.id === ui.selectedStormId) }, content)
        : el('div', { class: 'storm-row storm-row--past' }, content)]);
    }));
    ref('stormRankEmpty').hidden = ranked.length > 0;
    ref('rankClear').hidden = rankings.length === 0;
  }

  // ---- world leaderboard (Firestore; the SDK loads only when the ranking tab is first shown) ----
  /** Runs the live subscription only while the ranking tab is visible; the table is rebuilt from `ui.lbView`. */
  function syncLeaderboard(): void {
    const want = !sidebar.hidden && ui.tab === 'rank' && !document.hidden;
    if (want === (lbStop !== null)) return;
    if (!want) { lbStop?.(); lbStop = null; return; }
    startLeaderboard();
  }
  function startLeaderboard(): void {
    lbStop?.();
    ui.lbView = null;
    ui.lbError = false;
    renderLeaderboard();
    lbStop = subscribeLeaderboard(ui.lbWindow, view => {
      ui.lbView = view;
      ui.lbError = false;
      if (!lbNickname.value && document.activeElement !== lbNickname) lbNickname.value = storedNickname() ?? defaultNickname(view.uid);
      renderLeaderboard();
    }, () => { ui.lbError = true; renderLeaderboard(); });
  }
  const lbNickname = ref<HTMLInputElement>('lbNickname');
  lbNickname.value = storedNickname() ?? '';
  function renderLeaderboard(): void {
    const view = ui.lbView;
    const unavailable = ui.lbError || (!!view && view.fromCache && view.rows.length === 0);
    const message = unavailable ? 'Leaderboard unavailable' : !view ? 'Loading leaderboard…' : view.rows.length === 0 ? 'No results yet. Finish a storm to get on the board.' : '';
    setText(ref('lbStatus'), message);
    ref('lbStatus').hidden = !message;
    const rows = unavailable || !view ? [] : view.rows;
    ref('lbTable').hidden = rows.length === 0;
    // Nicknames are user text: build cells with textContent so they are never run through the translator.
    ref('lbBody').replaceChildren(...rows.map((row, i) => {
      const tr = document.createElement('tr');
      if (row.uid === view!.me?.uid) tr.dataset.me = 'true';
      for (const text of [String(i + 1), row.nickname, fmtInt(row.storms), String(row.maxGrade), fmtMoney(row.lossUsd)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }));
    const me = unavailable ? null : view?.me;
    ref('lbMe').textContent = me
      ? `${t('My record')}: ` + [`${t('Storms')} ${fmtInt(me.storms)}`, `${t('Max grade')} ${me.maxGrade}`, `${t('Loss')} ${fmtMoney(me.lossUsd)}`, `${t('Rank')} ${view!.myRank ?? '—'}`].join(' · ')
      : `${t('My record')}: —`;
  }
  const lbWindowButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-lb-window]')];
  function setLbWindow(id: LbWindow): void {
    ui.lbWindow = id;
    for (const b of lbWindowButtons) {
      const on = b.dataset.lbWindow === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (lbStop) startLeaderboard();
  }
  lbWindowButtons.forEach(b => b.addEventListener('click', () => setLbWindow(b.dataset.lbWindow as LbWindow)));
  rovingKeys(ref('lbWindows'), b => setLbWindow(b.dataset.lbWindow as LbWindow));
  ref('lbNicknameForm').addEventListener('submit', ev => {
    ev.preventDefault();
    void setNickname(lbNickname.value).then(nickname => {
      if (nickname === null) { toast('Enter a nickname of 1 to 20 characters.', 'error'); return; }
      lbNickname.value = nickname;
      toast('Nickname saved.');
    });
  });
  const lbDelete = ref<HTMLButtonElement>('lbDelete');
  const lbDeleteDialog = ref<HTMLDialogElement>('lbDeleteDialog');
  const lbDeleteConfirm = ref<HTMLButtonElement>('lbDeleteConfirm');
  lbDelete.addEventListener('click', () => { localizeTree(lbDeleteDialog); lbDeleteDialog.showModal(); });
  ref('lbDeleteCancel').addEventListener('click', () => lbDeleteDialog.close());
  lbDeleteConfirm.addEventListener('click', () => {
    lbDelete.disabled = lbDeleteConfirm.disabled = true;
    deleteMyData().then(() => {
      toast('Your leaderboard records were deleted.');
      ui.lbView = null;
      if (lbStop) startLeaderboard(); else renderLeaderboard();
    }, (e: unknown) => {
      toast(e instanceof Error && e.message === 'Leaderboard unavailable' ? e.message : 'Could not delete your records. Try again later.', 'error');
    }).finally(() => { lbDelete.disabled = lbDeleteConfirm.disabled = false; lbDeleteDialog.close(); });
  });
  document.addEventListener('visibilitychange', syncLeaderboard);
  window.addEventListener('online', () => { if (queuedCount() > 0) void flushQueue().catch(() => undefined); });

  function rankValue(entry: RankingEntry, metric: RankingMetric): string {
    if (metric === 'lossUsd') return fmtMoney(entry.lossUsd);
    if (metric === 'floodedHomes') return `${fmtInt(entry.floodedHomes)} homes`;
    if (metric === 'grade') return `Grade ${entry.grade}`;
    if (metric === 'lifetimeHours') return `${entry.lifetimeHours.toFixed(1)} h`;
    return `${fmtInt(entry[metric])} people`;
  }

  function renderStormDetail(sel: Storm | StormRecord, detail: HTMLElement): void {
    setText(ref('stormTitle'), sel.name ?? `Storm #${sel.id}`);
    setMetric('stage', `${stormGradeLabel(sel)} · ${sel.stage}`, detail);
    setMetric('outcome', stormOutcome(sel), detail);
    setMetric('wind', `${sel.wind.toFixed(0)} m/s · ${(sel.wind * 3.6).toFixed(0)} km/h`, detail);
    setMetric('movementSpeed', `${sel.movementSpeedKmh.toFixed(1)} km/h`, detail);
    setMetric('pressure', `${sel.pressure.toFixed(0)} hPa`, detail);
    setMetric('position', fmtCoord(sel.lon, sel.lat), detail);
    setMetric('rmw', `${sel.radiusKm.toFixed(0)} km`, detail);
    setMetric('gale', `${sel.galeRadiusKm.toFixed(0)} km`, detail);
    setMetric('age', `${sel.ageHours.toFixed(0)} h`, detail);
    setMetric('peak', `${sel.peakWind.toFixed(0)} m/s`, detail);
    setMetric('loss', fmtMoney(stormLossUsd(sel.damageScore)), detail);
    for (const n of metrics.get('windDelta') ?? []) n.parentElement!.hidden = !sel.record;
    setMetric('windDelta', `${sel.windDelta > 0.5 ? '+' : sel.windDelta < -0.5 ? '\u2212' : ''}${Math.abs(sel.windDelta) < 0.5 ? 0 : Math.abs(sel.windDelta).toFixed(0)} m/s`, detail);
    const spark = ref<HTMLElement>('spark') as unknown as SVGSVGElement;
    const [line, area] = spark.querySelectorAll('path');
    ref('stormStages').replaceChildren(...stageChanges(sel).map(sample => el('li', {
      text: `Grade ${sample.grade} · ${sample.stage} · ${fmtClock(sample.hour)}`,
    })));
    const h = sel.history.map(sample => ({ h: sample.hour, wind: sample.wind }));
    if (h.length >= 2) {
      const t0 = h[0].h;
      const scaleMax = Math.max(80, Math.ceil(sel.peakWind / 20) * 20);
      const span = Math.max(24, h[h.length - 1].h - t0);
      const pts = h.map(p => `${(((p.h - t0) / span) * 240).toFixed(1)} ${(54 - clamp(p.wind / scaleMax, 0, 1) * 50).toFixed(1)}`);
      line.setAttribute('d', `M${pts.join(' L')}`);
      area.setAttribute('d', `M0 56 L${pts.join(' L')} L${(((h[h.length - 1].h - t0) / span) * 240).toFixed(1)} 56 Z`);
      setText(ref('sparkCaption'), `Max wind over ${Math.round(h[h.length - 1].h - t0)} h, scale 0–${scaleMax} m/s.`);
    } else {
      line.setAttribute('d', '');
      area.setAttribute('d', '');
      setText(ref('sparkCaption'), 'Wind history appears as time passes.');
    }
  }

  function renderEnvironment(): void {
    const s = ui.state;
    if (!s) return;
    ref('effectList').replaceChildren(...s.effects.map(e => {
      const def = TOOL_BY_TYPE.get(e.type);
      return el('li', { class: `effect effect--${e.type}` }, [
        el('span', { class: 'effect__name', text: def?.name ?? e.type }),
        el('span', { class: 'effect__where', text: fmtCoord(e.lon, e.lat) }),
        el('span', { class: 'mono', text: `${Math.ceil(e.remainingHours)} h left` }),
      ]);
    }));
    ref('effectEmpty').hidden = s.effects.length > 0;
    const scope = ref('panel-environment');
    setMetric('score', fmtInt(s.score), scope);
    setMetric('exposed', fmtInt(s.exposedPopulation), scope);
    setMetric('peak', `${s.peakWind.toFixed(0)} m/s`, scope);
    renderCityList(s);
    root.querySelectorAll<HTMLElement>('[data-city]').forEach(b => {
      const id = b.dataset.city!;
      b.setAttribute('aria-pressed', String(id === ui.selectedCityId));
      const impact = s.cities[CITY_INDEX.get(id) ?? -1];
      const out = b.querySelector<HTMLElement>('.city__score')!;
      const text = impact && (impact.score > 0 || impact.maxWind > 0) ? `${impact.maxWind.toFixed(0)} m/s · ${fmtInt(impact.score)}` : '—';
      if (out.textContent !== text) setText(out, text);
    });
    renderCityDetail();
  }

  function renderCityDetail(): void {
    const s = ui.state;
    const detail = ref('cityDetail');
    const city = CITIES.find(c => c.id === ui.selectedCityId);
    if (!city) {
      detail.replaceChildren(el('p', { class: 'empty', text: 'Select a city on the map or in the list.' }));
      return;
    }
    const impact = s?.cities[CITY_INDEX.get(city.id) ?? -1];
    const share = impact ? impact.exposedPopulation / city.population : 0;
    const items: [string, string][] = [
      ['Population', `${fmtPop(city.population)} (${city.populationYear})`],
      ['In gale-force winds', impact ? `${fmtInt(impact.exposedPopulation)} (${(share * 100).toFixed(0)}%)` : '—'],
      ['Peak wind here', impact ? `${impact.maxWind.toFixed(0)} m/s` : '—'],
      ['Total impact score', impact ? fmtInt(impact.score) : '—'],
      ['Current damage', impact ? fmtInt(impact.damage) : '—'],
    ];
    detail.replaceChildren(
      el('h3', { class: 'city-detail__name', text: city.name }),
      el('p', { class: 'tag tag--inline', text: `Population, ${city.populationYear}` }),
      el('dl', { class: 'kv' }, items.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    );
  }

  /** The list shows at most this many cities: those with exposure or damage first, then the largest. */
  const CITY_LIST_MAX = 60;
  const CITY_INDEX = new Map(CITIES.map((c, i) => [c.id, i]));
  let cityListKey = '';
  let cityListAt = 0;
  let cityListTimer = 0;

  /** Cities with any exposure or damage by loss (then people in gales), followed by the rest by population; CITIES is largest first. */
  function rankedCities(s: GameState | null): City[] {
    const hit: number[] = [];
    s?.cities.forEach((c, i) => { if (c.score > 0 || c.exposedPopulation > 0) hit.push(i); });
    hit.sort((a, b) => s!.cities[b].score - s!.cities[a].score || s!.cities[b].exposedPopulation - s!.cities[a].exposedPopulation || a - b);
    const picked = new Set(hit.slice(0, CITY_LIST_MAX));
    const out = hit.slice(0, CITY_LIST_MAX).map(i => CITIES[i]);
    for (let i = 0; i < CITIES.length && out.length < CITY_LIST_MAX; i++) if (!picked.has(i)) out.push(CITIES[i]);
    return out;
  }

  /** Rebuilds the rows when the ranking changes, at most about once a second while a storm keeps reshuffling it. */
  function renderCityList(s: GameState | null): void {
    const list = ref('cityList');
    const rows = rankedCities(s);
    const key = rows.map(c => c.id).join();
    const now = performance.now();
    if (key === cityListKey) return;
    if (list.childElementCount > 0 && now - cityListAt < 1000) {
      cityListTimer ||= window.setTimeout(() => { cityListTimer = 0; renderCityList(ui.state); }, 1000 - (now - cityListAt));
      return;
    }
    cityListKey = key;
    cityListAt = now;
    list.replaceChildren(...rows.map(c => el('li', {}, [
      el('button', { type: 'button', class: 'city', 'data-city': c.id, 'data-testid': `city-${c.id}`, 'aria-pressed': String(c.id === ui.selectedCityId) }, [
        el('span', { class: 'city__name', text: c.name }),
        el('span', { class: 'city__pop', text: `${fmtPop(c.population)} (${c.populationYear})` }),
        el('span', { class: 'city__score', text: '—' }),
      ]),
    ])));
    setText(ref('cityCount'), `Showing ${rows.length} of ${fmtInt(CITIES.length)} cities`);
  }

  function buildCityList(): void {
    const list = ref('cityList');
    renderCityList(null);
    setText(ref('populationNote'), SCENARIO.populationNote);
    list.addEventListener('click', ev => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-city]');
      if (b) selectCity(ui.selectedCityId === b.dataset.city ? null : b.dataset.city!, true);
    });
  }

  function selectCity(id: string | null, center = false): void {
    ui.selectedCityId = id;
    const city = CITIES.find(c => c.id === id);
    if (city) {
      if (center) renderer?.view.centerOn(city.lon, city.lat);
      showReadout(`${city.name} · population ${fmtPop(city.population)} (${city.populationYear})`);
    }
    renderSidebar();
    refreshOverlay();
  }

  function renderNews(): void {
    const s = ui.state;
    if (!s) return;
    const last = s.news[s.news.length - 1];
    const key = `${s.news.length}|${last?.id ?? ''}`;
    if (key !== ui.newsKey) {
      ui.newsKey = key;
      ref('newsList').replaceChildren(...[...s.news].reverse().slice(0, 60).map(newsRow));
      ref('newsEmpty').hidden = s.news.length > 0;
    }
  }

  function notifyNews(): void {
    const s = ui.state;
    if (!s) return;
    if (s.news.length > ui.newsSeen) {
      const fresh = s.news.slice(ui.newsSeen);
      const item = fresh[fresh.length - 1];
      if (ui.newsSeen > 0 || fresh.length <= 2) {
        announce(`${t('News')}: ${t(item.title)}. ${t(item.text)}`);
        if (performance.now() - ui.lastPlacementAt > 2000 && item.kind !== 'info') toast(item.title, 'info', 4500);
      }
      ui.newsSeen = s.news.length;
    } else if (s.news.length < ui.newsSeen) ui.newsSeen = s.news.length;
  }

  const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Number(Math.abs(n).toFixed(1))}`;
  const nino = (n: number): string => `${n > 0 ? 'El Niño' : 'La Niña'} ${signed(n)}`;
  function climateText(key: ClimateKey, value: number): string {
    if (key === 'enso') return value === 0 ? 'Neutral' : nino(value);
    return `${signed(value)} °C`;
  }
  function showClimateValue(key: ClimateKey, value: number): void {
    const { input, output } = climateInputs.get(key)!;
    const text = climateText(key, value);
    setText(output, text);
    input.setAttribute('aria-valuetext', t(text));
    syncClimateReset();
  }
  function syncClimateDisabled(): void {
    for (const { input } of climateInputs.values()) input.disabled = ui.expect === 'replay';
    for (const b of seasonButtons) b.disabled = ui.expect === 'replay';
    syncClimateReset();
  }
  /** Reset is only useful while at least one slider is away from 0 and the climate can still be changed. */
  function syncClimateReset(): void {
    ref<HTMLButtonElement>('climateReset').disabled = ui.expect === 'replay' || [...climateInputs.values()].every(({ input }) => Number(input.value) === 0);
  }
  function renderClimate(state: GameState): void {
    const { warming, enso, polar } = state.climate;
    const today = dayOfYear(state);
    const seasonId = seasonIdOf(today);
    for (const b of seasonButtons) b.setAttribute('aria-checked', String(b.dataset.season === seasonId));
    for (const [key, { input }] of climateInputs) {
      if (climateDirty.has(key)) continue;
      if (Number(input.value) !== state.climate[key]) input.value = String(state.climate[key]);
      showClimateValue(key, state.climate[key]);
    }
    const hud = ref('climateHud');
    const parts = [warming !== 0 ? `${signed(warming)} °C ocean` : '', enso !== 0 ? nino(enso) : '', polar !== 0 ? `poles ${signed(polar)} °C` : ''].filter(Boolean);
    const key = `${getLanguage()}|${parts.join('|')}`;
    hud.hidden = parts.length === 0;
    if (hud.dataset.key === key) return;
    hud.dataset.key = key;
    hud.replaceChildren(...(parts.length ? [localizedText('Climate:'), ' ', ...parts.flatMap((p, i) => [i ? ' · ' : '', localizedText(p)])] : []));
  }

  function renderWorld(state: GameState): void {
    renderClimate(state);
    const on = state.genesis.enabled;
    ref('genesisToggle').setAttribute('aria-checked', String(on));
    setText(ref('genesisState'), on ? 'On' : 'Off');
    const wave = ref('genesisWave');
    wave.hidden = !on;
    if (on) setText(wave, `Natural formation · wave ${state.genesis.waves} · next conditions in ${Math.max(0, (state.genesis.nextSpawnTick - state.tick) / TICKS_PER_HOUR).toFixed(0)} h`);
    const lines: HTMLElement[] = [];
    for (const load of state.historic) {
      const typhoon = typhoonById(load.typhoonId);
      if (!typhoon) continue;
      const ended = load.finished ? state.stormArchive.find(x => x.id === load.stormId)?.endedHour : undefined;
      const hours = (ended ?? state.hours) - load.startHour;
      lines.push(el('p', { text: `${typhoonName(typhoon)} (${typhoon.year}) · ${fmtUtc(typhoon.points[0].t, hours)} · ${load.environment === 'loaded' ? 'NCEP/NCAR R1 + ERSST v5' : 'base climate'}${load.finished ? ' · record ended' : ''}` }));
    }
    ref('historicHud').replaceChildren(...lines);
    ref('historicHud').hidden = lines.length === 0;
    const totals = state.cities.reduce((sum, impact, i) => {
      const report = estimateCityDamage(CITIES[i], impact);
      sum.displaced += report.displaced; sum.missing += report.missing; sum.deaths += report.deaths;
      sum.flooded += report.floodedHomes; sum.loss += report.lossUsd;
      return sum;
    }, { displaced: 0, missing: 0, deaths: 0, flooded: 0, loss: 0 });
    const ended = state.stormArchive.filter(s => s.endReason === 'dissipated');
    const average = ended.length ? ended.reduce((sum, s) => sum + s.endedHour - (s.history[0]?.hour ?? 0), 0) / ended.length : null;
    setText(ref('damageLoss'), `Estimated loss: ${fmtMoney(totals.loss)}`);
    const scope = ref('damagePanel');
    setMetric('damageDissipated', String(ended.length), scope);
    setMetric('damageTime', average === null ? '—' : `${average.toFixed(1)} h`, scope);
    setMetric('damageDisplaced', fmtInt(totals.displaced), scope);
    setMetric('damageMissing', fmtInt(totals.missing), scope);
    setMetric('damageDeaths', fmtInt(totals.deaths), scope);
    setMetric('damageFlooded', fmtInt(totals.flooded), scope);
    setMetric('damageLoss', fmtMoney(totals.loss), scope);
  }

  function newsRow(n: NewsItem): HTMLElement {
    return el('li', { class: `news news--${n.kind}` }, [
      el('div', { class: 'news__art' }, [newsArt(n)]),
      el('div', { class: 'news__body' }, [
        el('p', { class: 'news__meta', text: `${fmtClock(n.hour)} · ${kindLabel(n.kind)}` }),
        el('h3', { class: 'news__title', text: n.title }),
        el('p', { class: 'news__text', text: n.text }),
        n.damage ? el('dl', { class: 'news__damage', testid: 'news-damage' }, [
          ...[
            ['Displaced people', `${fmtInt(n.damage.displaced)} people`],
            ['Missing (estimated)', `${fmtInt(n.damage.missing)} people`],
            ['Deaths (estimated)', `${fmtInt(n.damage.deaths)} people`],
            ['Flooded homes', `${fmtInt(n.damage.floodedHomes)} homes`],
            ['Estimated loss', fmtMoney(n.damage.lossUsd)],
          ].map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })])),
        ]) : null,
        n.damage ? el('p', { class: 'news__meta', text: 'Cumulative city estimate; replaces earlier figures.' }) : null,
      ]),
    ]);
  }
  const kindLabel = (k: NewsItem['kind']): string => ({ formation: 'Formation', intensity: 'Intensity', landfall: 'Landfall', city: 'City', ended: 'Dissipated', merger: 'Merger', blizzard: 'Blizzard', recovery: 'Recovery', info: 'Watch' })[k];

  function renderReplayPanel(): void {
    const n = ui.latest?.actions.length ?? 0;
    setText(ref('replayCount'), `${n} condition${n === 1 ? '' : 's'} placed so far (tick ${ui.latest?.tick ?? 0}).`);
  }

  function renderSidebar(): void {
    if (sidebar.hidden || !ui.state) return;
    if (ui.tab === 'storms') renderStorms();
    else if (ui.tab === 'environment') renderEnvironment();
    else if (ui.tab === 'news') renderNews();
    else if (ui.tab === 'rank') renderRanking();
    else renderReplayPanel();
  }

  // ---- help --------------------------------------------------------------------------------
  const HELP_SEEN_KEY = 'typhoon-lab-help-seen';
  const helpTabButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-help-tab]')];
  const helpPanels = [...root.querySelectorAll<HTMLElement>('[data-help-panel]')];
  function setHelpTab(id: string, focus = false): void {
    for (const b of helpTabButtons) {
      const on = b.dataset.helpTab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of helpPanels) p.hidden = p.dataset.helpPanel !== id;
    ref('helpScroll').scrollTop = 0;
  }
  function buildHelp(): void {
    const toolItems = TOOLS.map((t, i) => `
      <li class="help-tool" style="--fx: var(--fx-${t.type})">
        <span class="help-tool__icon">${toolIconSvg(t.type, 'help-tool__svg')}</span>
        <span class="help-tool__text"><strong>${t.name}</strong> (${t.radiusKm} km, ${t.durationHours} h): ${t.description}</span>
        <kbd class="help-key">${TOOL_KEYS[i]}</kbd>
      </li>`).join('');
    const panels: Record<string, string> = {
      basics: `
        <p>The world starts empty and keeps running in real time. You cannot place a storm. You place weather conditions, and storms grow where they overlap.</p>
        <ol class="help__steps">
          <li>Drag <strong>Warm water</strong>, <strong>Moisture</strong> and <strong>Low pressure</strong> from the bottom palette onto the same tropical ocean spot.</li>
          <li>Wait. Overlapping conditions accumulate time, then a depression forms. Several separate spots can each make their own storm.</li>
          <li>Young depressions strengthen and their circulation grows. <strong>High pressure</strong> changes the flow around them and steers them.</li>
        </ol>
        <p>Open the Formation tab, pick Typhoon formation and tap a sea spot to see what it needs to form a typhoon, then place the recipe in one click.</p>
        <h3 class="dialog__sub">Time</h3>
        <p>Play and Pause start and stop time, the speed buttons run the world faster, and Reset starts over with an empty world.</p>
        <h3 class="dialog__sub">The map</h3>
        <ul class="help__list">
          <li>The map is a globe by default: drag to rotate it and use the wheel or pinch to zoom. Switch Globe view off in the right panel for the flat Equal Earth map.</li>
          <li>Open the right panel for the storm list, forming patches, news and replay files. Pan and zoom freely: the weather freezes while you move the camera and catches up when you let go.</li>
          <li>Toggle wind streaks, humidity colours, rainfall, pressure lines, a light sea-temperature tint and population independently.</li>
          <li>Humidity colours the wind streaks: higher humidity is brighter. Turn on Wind to see the colours.</li>
          <li>Choose a nickname in the Ranking tab to appear on the online leaderboard. Nicknames are public.</li>
        </ul>
        <h3 class="dialog__sub">Without a mouse</h3>
        <p class="fine">Press a palette button to arm it, then click or tap the map. Or focus the map: arrow keys move the target (Shift ×5, Alt ¼°) and Enter places. Number keys 1–9, 0, - and = select a condition, Q, W, E and R select a formation tool, Shift + and Shift - zoom, Space plays or pauses, Esc puts the tool away. The World tab can place by exact coordinates.</p>
        <p class="fine">Shortcuts work from anywhere on the page, except while you type in a field or a dialog is open; with a button or tab focused, Space and Enter press it instead of playing or pausing.</p>`,
      conditions: `
        <p>The bottom palette has twelve conditions. Each covers a radius for a set time, and the key on the right selects it.</p>
        <ul class="help__tools">${toolItems}</ul>
        <h3 class="dialog__sub">Making a storm</h3>
        <ul class="help__list">
          <li>Formation recipe: overlap Warm water, Moisture and Low pressure on the same tropical ocean spot, ideally with Low shear. High pressure does not start a storm; it steers one.</li>
          <li>Warm air and Updraft support formation and growth. They do not replace warm water, moisture or a low.</li>
          <li>Warm air, Moisture and Updraft can form thunderstorms over land or sea. Their gusts add city damage. Dry air, Cold air and Downdraft suppress them.</li>
        </ul>
        <h3 class="dialog__sub">Weakening a storm</h3>
        <p>Weakening recipe: overlap Cool water, Dry air, Cold air, Downdraft and Strong shear on a storm or in its path. The more of them overlap, the faster it dissipates.</p>
        <h3 class="dialog__sub">Mergers</h3>
        <p>Nearby storms in the same hemisphere affect each other’s movement: they can rotate around each other and draw closer. They merge within 100 km once both are at least 24 model hours old with winds of 17.2 m/s or more. The stronger storm keeps its ID and wind speed. Forming lows keep their own progress. Overlapping wind areas alone do not trigger a merger.</p>`,
      climate: `
        <h3 class="dialog__sub">Natural formation</h3>
        <p>Turn on Natural typhoon formation in the right panel and nature starts storms for you: a wave of formation conditions appears over warm tropical ocean somewhere in the world every two to three days. Use Cool water, Dry air, Cold air and Downdraft to weaken them before a depression forms, or let them grow. Turn it off to stop new waves.</p>
        <h3 class="dialog__sub">World climate</h3>
        <p>World climate in the right panel changes the whole planet: Warming raises sea and air temperature, La Niña / El Niño shifts warm water and wind shear across the Pacific, and Polar temperature warms or cools the high latitudes. Low shear calms the upper winds around a storm so it can stay upright; Strong shear adds upper-level wind that tilts and tears it apart.</p>
        <dl class="help__defs">
          <dt>Warming</dt>
          <dd>Warming runs from −2 to +4 °C. More warming makes more of the ocean warm enough to feed storms. A negative value cools the world.</dd>
          <dt>La Niña / El Niño</dt>
          <dd>El Niño warms the central and eastern Pacific, cools the far western Pacific and adds wind shear over the western Pacific, so fewer storms form near Asia. La Niña does the reverse: warmer water and calmer winds in the west.</dd>
          <dt>Polar temperature</dt>
          <dd>Polar cooling chills the sea and air poleward of about 35° latitude, so storms that curve out of the tropics weaken sooner. Polar warming does the reverse. The effect is full strength from about 50°.</dd>
        </dl>`,
      historic: `
        <dl class="help__defs">
          <dt>Loading</dt>
          <dd>Pick a Past typhoon in the right panel and press Load to bring a recorded one into the world (best tracks from JMA RSMC Tokyo, NOAA NHC HURDAT2 and NOAA IBTrACS: 6-hourly positions, pressure and wind).</dd>
          <dt>Recorded path</dt>
          <dd>Its path follows the record. You can load several. Show recorded paths draws each full path as a dashed line.</dd>
          <dt>Environment data</dt>
          <dd>The sea temperature, air, humidity, pressure and wind follow NCEP/NCAR Reanalysis 1 and ERSST v5 for those dates; damage and news are simulated. Storms outside the western Pacific have no environment record and use the base climate.</dd>
          <dt>Your conditions</dt>
          <dd>Conditions you place change its strength but not its path.</dd>
        </dl>`,
      data: `
        <h3 class="dialog__sub">About the data</h3>
        <p>Coastlines and city positions are real (Natural Earth). Weather, population and damage numbers are simulated.</p>
        <h3 class="dialog__sub">Sources</h3>
        <dl class="help__defs">
          <dt>JMA RSMC Tokyo</dt>
          <dd>Best track of recorded typhoons: 6-hourly positions, central pressure and 10-minute wind.</dd>
          <dt>NOAA NHC HURDAT2</dt>
          <dd>Best track of Atlantic and northeast Pacific hurricanes: 6-hourly positions, central pressure and wind. The 1-minute wind is scaled by 0.93 to a 10-minute wind.</dd>
          <dt>NOAA IBTrACS</dt>
          <dd>Best track of storms in the Indian Ocean, South Pacific and South Atlantic: 6-hourly positions, central pressure and wind (WMO agency values where given, otherwise US values scaled by 0.93).</dd>
          <dt>NCEP/NCAR Reanalysis 1</dt>
          <dd>Air temperature, humidity, pressure and wind on the dates of a past typhoon.</dd>
          <dt>ERSST v5</dt>
          <dd>NOAA sea-surface temperature on the dates of a past typhoon.</dd>
          <dt>Natural Earth</dt>
          <dd>Coastlines, and the positions and populations of cities.</dd>
        </dl>
        <h3 class="dialog__sub">Damage estimates</h3>
        <p>Damage figures are fictional story estimates, not hydrology or insurance models. Their rates are gameplay constants fitted to public records of Typhoon Maemi (2003) and cross-checked with Rusa (2002), Hinnamnor (2022) and Haiyan (2013), so they land at the right order of magnitude. Counts are city totals at the time of the report.</p>
        <h3 class="dialog__sub">Online leaderboard and privacy</h3>
        <p>When a storm ends, your score (storm count, grade and estimated damage) is uploaded to the online leaderboard under an anonymous ID created on this device. The nickname shown there is chosen by you and is public, so do not use your real name. You can change it any time in the Ranking tab. Details are in the privacy policy linked below.</p>
        <p>You can delete your nickname and all your uploaded results yourself: open the Ranking tab and press Delete my records. It takes effect immediately. If you no longer have the device, email us at the address in the privacy policy.</p>
        ${footerHtml()}`,
    };
    for (const p of helpPanels) p.innerHTML = panels[p.dataset.helpPanel!] ?? '';
  }
  /** The policy opens in a popup in the player's current language; the href stays for middle-click and new-tab use. */
  const privacyDialog = ref<HTMLDialogElement>('privacyDialog');
  const privacyBody = ref('privacyBody');
  let privacyDoc: Promise<Document> | undefined;
  /** Fetches `/privacy.html` once and caches the parsed page. */
  function loadPrivacyDoc(): Promise<Document> {
    privacyDoc ??= fetch('/privacy.html').then(r => {
      if (!r.ok) throw new Error(`privacy.html ${r.status}`);
      return r.text();
    }).then(text => new DOMParser().parseFromString(text, 'text/html')).catch(err => { privacyDoc = undefined; throw err; });
    return privacyDoc;
  }
  async function renderPrivacy(): Promise<void> {
    const code = getLanguage();
    const doc = await loadPrivacyDoc();
    const section = doc.querySelector(`section[lang="${code}"]`) ?? doc.querySelector('section[lang="en"]');
    if (!section) throw new Error('privacy.html has no section');
    const copy = section.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('script, .langs, .back').forEach(n => n.remove());
    privacyBody.lang = section.getAttribute('lang') ?? 'en';
    privacyBody.innerHTML = copy.innerHTML;
    privacyBody.scrollTop = 0;
    (ref('privacyFull') as HTMLAnchorElement).href = `/privacy.html?lang=${code}`;
  }
  async function openPrivacy(href: string): Promise<void> {
    try { await renderPrivacy(); } catch { location.href = href; return; }
    localizeTree(privacyDialog);
    if (!privacyDialog.open) privacyDialog.showModal();
  }
  root.addEventListener('click', ev => {
    const link = (ev.target as HTMLElement).closest<HTMLAnchorElement>('a[data-privacy-link]');
    if (!link || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    void openPrivacy(link.href);
  });
  privacyDialog.addEventListener('click', ev => { if ((ev.target as HTMLElement).closest('[data-act="close-privacy"]')) privacyDialog.close(); });
  function syncPrivacyLinks(): void {
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-privacy-link]')) a.href = `/privacy.html?lang=${getLanguage()}`;
    if (privacyDialog.open) void renderPrivacy().catch(() => { /* the cached text is already shown */ });
  }
  function openHelp(): void { buildHelp(); syncPrivacyLinks(); localizeTree(helpDialog); helpDialog.showModal(); }
  ref('helpOpen').addEventListener('click', openHelp);
  helpDialog.addEventListener('click', ev => {
    if ((ev.target as HTMLElement).closest('[data-act="close-help"]')) helpDialog.close();
    else if ((ev.target as HTMLElement).closest('[data-act="start-tutorial"]')) { helpDialog.close(); tutorial.start(); }
  });
  for (const b of helpTabButtons) b.addEventListener('click', () => setHelpTab(b.dataset.helpTab!));
  rovingKeys(ref('helpTabs'), b => setHelpTab(b.dataset.helpTab!, true));
  helpDialog.addEventListener('close', () => { try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch { /* storage is optional */ } });
  /** First visit only. `?help=0` keeps it shut for automated runs. */
  const helpSeen = (): boolean => { try { return localStorage.getItem(HELP_SEEN_KEY) !== null; } catch { return true; } };
  // First visit: the tutorial replaces the help dialog (its last step points to Help). `?help=0` and a stored flag keep it shut.
  const tutorial = createTutorial({
    root: app,
    state: () => ui.latest,
    onState: cb => { stateListeners.push(cb); },
    setOverlayMarker: point => {
      ui.tutorialTarget = point;
      if (point) renderer?.view.centerOn(point.lon, point.lat);
      refreshOverlay();
    },
    showConditions: () => setPaletteTab('conditions'),
  });
  let tutorialPending = shouldAutoStart(window.location.search, (() => { try { return localStorage; } catch { return null; } })());
  if (tutorialPending) {
    try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch { /* storage is optional */ }
    stateListeners.push(state => {
      if (!tutorialPending) return;
      tutorialPending = false;
      if (state.actions.length === 0) tutorial.start();
    });
  } else if (new URL(window.location.href).searchParams.get('help') !== '0' && !helpSeen()) openHelp();

  // ---- replay files ------------------------------------------------------------------------
  function exportReplay(): void {
    const s = ui.latest;
    if (!s) return;
    const problem = replayExportProblem(s);
    if (problem) {
      setReplayMessage(problem, 'error');
      toast(problem, 'error');
      return;
    }
    downloadJson(`typhoon-lab-replay-${s.seed}-t${s.tick}.json`, buildReplay(s));
    setReplayMessage(`Exported the world at tick ${s.tick} with ${s.actions.length} condition${s.actions.length === 1 ? '' : 's'}.`, 'ok');
  }

  function setReplayMessage(text: string, kind: ToastKind): void {
    const m = ref('replayMessage');
    setText(m, text);
    m.dataset.kind = kind;
  }

  function importReplayText(text: string): void {
    const parsed = parseReplay(text);
    if (!parsed.ok) {
      setReplayMessage(parsed.error, 'error');
      toast(`Replay not loaded: ${parsed.error}`, 'error');
      return;
    }
    const r = parsed.replay;
    ui.expectUntil = r.untilTick;
    ui.expectSeed = r.seed;
    ui.expectSig = actionsSig(r.actions);
    // The worker keeps its previous play state if it rejects the replay, so only pause once it accepts.
    arm('replay');
    setReplayMessage('Re-running the replay on the simulation…', 'info');
    post({ type: 'replay', seed: r.seed, actions: r.actions, untilTick: r.untilTick, startDayOfYear: r.startDayOfYear });
    renderClock();
  }

  ref('replayExport').addEventListener('click', exportReplay);
  ref('replayImport').addEventListener('click', () => ref<HTMLInputElement>('replayFile').click());
  ref<HTMLInputElement>('replayFile').addEventListener('change', async ev => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_REPLAY_BYTES) { setReplayMessage(`That file is larger than ${Math.round(MAX_REPLAY_BYTES / 1000)} kB, so it is not a replay.`, 'error'); return; }
    try { importReplayText(await file.text()); } catch { setReplayMessage('The file could not be read.', 'error'); }
  });
  ref('replayPaste').addEventListener('click', () => {
    const t = ref<HTMLTextAreaElement>('replayText');
    if (!t.value.trim()) { setReplayMessage('Paste replay JSON first.', 'error'); return; }
    importReplayText(t.value);
  });

  // ---- worker traffic ----------------------------------------------------------------------
  /** Wait for the answer to reset/replay and ignore stale states from before it. */
  function arm(kind: Expect): void {
    ui.expect = kind;
    syncClimateDisabled();
    window.clearTimeout(expectTimer);
    expectTimer = window.setTimeout(() => {
      if (ui.expect === kind && kind !== 'normal') {
        ui.expect = 'normal';
        syncClimateDisabled();
        toast('The simulation did not answer in time. Try again.', 'error');
        if (kind === 'replay') setReplayMessage('The simulation did not answer in time.', 'error');
      }
    }, 15_000);
  }

  /** Gate a worker state; returns false for stale states that predate a pending reset or replay. */
  function accept(state: GameState): boolean {
    if (ui.expect === 'reset') {
      if (state.seed !== ui.expectSeed) return false;
      if (!(state.actions.length === 0 && (state.tick < ui.expectBaseTick || ui.expectBaseTick <= 8))) return false;
      window.clearTimeout(expectTimer);
      ui.expect = 'normal';
      ui.pendingEvent = 'reset';
    } else if (ui.expect === 'replay') {
      if (state.tick !== ui.expectUntil || state.seed !== ui.expectSeed || actionsSig(state.actions) !== ui.expectSig) return false;
      window.clearTimeout(expectTimer);
      ui.expect = 'normal';
      ui.pendingEvent = 'replay';
      ui.playing = false;
      setReplayMessage(`Replay loaded. The world is restored to tick ${state.tick}, paused. Press Play to continue from here.`, 'ok');
      toast('Replay loaded and paused.', 'ok', 3500);
    }
    ui.latest = state;
    for (const listener of stateListeners) listener(state);
    return true;
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    if (msg.type === 'state') {
      if (!accept(msg.state)) return;
      ui.pending = msg.state;
      renderClock();
      if (document.hidden && !renderer?.isInteracting) applyPending();
    } else if (msg.type === 'placement') {
      ui.placementQueue.shift()?.(msg.result);
    } else if (msg.type === 'error') {
      const wasReplay = ui.expect === 'replay';
      if (ui.expect !== 'normal') { window.clearTimeout(expectTimer); ui.expect = 'normal'; syncClimateDisabled(); }
      for (const cb of ui.placementQueue.splice(0)) cb({ ok: false, reason: msg.message });
      toast(msg.message, 'error');
      if (wasReplay) setReplayMessage(msg.message, 'error');
    }
  };
  worker.onerror = ev => {
    veil.hidden = false;
    setText(ref('veilText'), `The simulation worker stopped${ev.message ? `: ${ev.message}` : '.'} Reload the page to try again.`);
    veil.dataset.state = 'error';
  };
  worker.onmessageerror = () => toast('The simulation sent a message this page could not read.', 'error');

  function applyPending(): void {
    const next = ui.pending;
    if (!next) return;
    ui.pending = null;
    applyState(next);
  }

  function beginWorld(event: 'reset' | 'replay' | null): void {
    ui.tool = null;
    closeSpot();
    renderTools();
    ui.newsKey = '';
    ui.newsSeen = 0;
    ui.selectedStormId = null;
    ui.cursor = null;
    for (const li of stormRows.values()) li.remove();
    stormRows.clear();
    rankedKeys.clear();
    ui.playing = event !== 'replay';
  }

  /** Writes newly ended storms of this world to the ranking store; active storms are display-only. */
  function recordRankings(state: GameState): void {
    const ended = state.stormArchive.filter(record => !rankedKeys.has(record.id));
    const fresh = ended.map(record => entryFromStorm(state.seed, record, state.hours, state.actions));
    if (!fresh.length) return;
    for (const record of ended) {
      const result = resultFromRecord(state.seed, record);
      if (result) void submitResult(result);
    }
    // Re-read first so another tab's entries are kept (last writer wins only for the same key).
    rankings = fresh.reduce(upsert, rankingStore.load());
    for (const entry of fresh) rankedKeys.set(entry.stormId, entry.key);
    rankingStore.save(rankings);
  }

  function applyState(state: GameState): void {
    const prev = ui.state;
    const event = ui.pendingEvent;
    ui.pendingEvent = null;
    if (event || !prev || state.seed !== prev.seed || state.tick < prev.tick) beginWorld(event);
    ui.state = state;
    recordRankings(state);

    const followLiveMerger = prev?.storms.some(s => s.id === ui.selectedStormId);
    for (const item of state.news) {
      if (item.kind === 'merger' && item.absorbedId === ui.selectedStormId && followLiveMerger && item.mergedIntoId !== undefined) ui.selectedStormId = item.mergedIntoId;
    }
    if (ui.selectedStormId !== null && !findStorm(ui.selectedStormId)) ui.selectedStormId = null;

    renderer?.setState(state);
    stage.dataset.renderedTick = String(state.tick);
    app.dataset.ready = 'true';
    if (renderer && veil.dataset.state !== 'error') veil.hidden = true;
    setText(ref('stormCount'), String(state.storms.length + state.thunderstorms.length));
    renderWorld(state);
    ref('hint').hidden = state.storms.length > 0 || state.thunderstorms.length > 0 || state.candidates.length > 0 || state.effects.length > 0 || state.actions.length > 0 || hintDismissed;
    renderClock();
    renderSidebar();
    notifyNews();
    refreshOverlay();
    renderSpot();
  }

  // ---- wiring ------------------------------------------------------------------------------
  const languageSelect = ref<HTMLSelectElement>('language');
  languageSelect.value = getLanguage();
  syncPrivacyLinks();
  languageSelect.addEventListener('change', () => {
    setLanguage(LOCALES.find(l => l.code === languageSelect.value)?.code ?? 'en');
    localizeTree(root);
    syncPrivacyLinks();
    labelHistoricOptions();
    // Money strings are formatted per language, so rebuild everything that shows them.
    ui.newsKey = '';
    if (ui.state) renderWorld(ui.state);
    renderSidebar();
    renderLeaderboard();
    refreshOverlay();
    spotSig = '';
    renderSpot();
  });
  attachPalette(toolButtons, {
    mapPoint: (cx, cy) => {
      const r = renderer;
      if (!r || document.elementFromPoint(cx, cy) !== r.overlayCanvas) return null;
      const box = r.overlayCanvas.getBoundingClientRect();
      const at = r.view.pxToLonLat(cx - box.left, cy - box.top);
      return at ? { lon: at[0], lat: at[1] } : null;
    },
    onDragStart: tool => { ui.drag = { tool, point: null }; closeSpot(); refreshOverlay(); },
    onDragMove: (_tool, point) => { if (ui.drag) { ui.drag.point = point; refreshOverlay(); } },
    onDrop: (tool, point) => {
      ui.drag = null;
      refreshOverlay();
      if (point && isFormation(tool)) { ui.tool = tool; renderTools(); openSpot(point.lon, point.lat); }
      else if (point) placeAt(tool as ToolType, point.lon, point.lat);
      else toast('Dropped outside the map. Drag the icon onto the map to place it.', 'error', 3500);
    },
    onCancel: () => { ui.drag = null; refreshOverlay(); },
  });
  for (const [type, b] of toolButtons) b.addEventListener('click', () => armTool(type));
  const paletteTabButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-palette-tab]')];
  const palettePanels = [...root.querySelectorAll<HTMLElement>('[data-palette-panel]')];
  function setPaletteTab(id: string, focus = false): void {
    for (const b of paletteTabButtons) {
      const on = b.dataset.paletteTab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of palettePanels) p.hidden = p.dataset.palettePanel !== id;
    try { localStorage.setItem(PALETTE_TAB_KEY, id); } catch { /* storage is optional */ }
  }
  for (const b of paletteTabButtons) b.addEventListener('click', () => setPaletteTab(b.dataset.paletteTab!));
  rovingKeys(ref('paletteTabs'), b => setPaletteTab(b.dataset.paletteTab!, true));
  setPaletteTab(storedPaletteTab());

  ref('play').addEventListener('click', togglePlay);
  ref('reset').addEventListener('click', resetWorld);
  labelHistoricOptions();
  historicSelect.addEventListener('change', showHistoricPeak);
  ref('genesisToggle').addEventListener('click', () => {
    ui.placementQueue.push(result => { if (!result.ok) toast(result.reason ?? 'Natural formation could not be changed.', 'error'); });
    post({ type: 'genesis', on: ref('genesisToggle').getAttribute('aria-checked') !== 'true' });
  });
  for (const [key, { input }] of climateInputs) {
    input.addEventListener('input', () => { climateDirty.add(key); showClimateValue(key, Number(input.value)); });
    // `change` fires once when the drag ends, so a replay records one action per adjustment rather than one per pixel.
    input.addEventListener('change', () => {
      climateDirty.delete(key);
      ui.placementQueue.push(result => { if (!result.ok) toast(result.reason ?? 'The climate could not be changed.', 'error'); });
      post({ type: 'climate', key, value: Number(input.value) });
    });
  }
  for (const b of seasonButtons) b.addEventListener('click', () => {
    ui.placementQueue.push(result => { if (!result.ok) toast(result.reason ?? 'The season could not be changed.', 'error'); });
    post({ type: 'season', dayOfYear: SEASONS.find(s => s.id === b.dataset.season)!.doy });
  });
  ref('climateReset').addEventListener('click', () => {
    for (const [key, { input }] of climateInputs) {
      if (Number(input.value) === 0 && (ui.latest?.climate[key] ?? 0) === 0) continue;
      input.value = '0';
      climateDirty.delete(key);
      showClimateValue(key, 0);
      ui.placementQueue.push(result => { if (!result.ok) toast(result.reason ?? 'The climate could not be changed.', 'error'); });
      post({ type: 'climate', key, value: 0 });
    }
    // The button disables itself now, so hand keyboard focus to the first slider instead of dropping it.
    climateInputs.get('warming')!.input.focus({ preventScroll: true });
  });
  ref('historicLoad').addEventListener('click', () => {
    const typhoon = typhoonById(historicSelect.value);
    if (!typhoon) return;
    ui.lastPlacementAt = performance.now();
    ui.placementQueue.push(result => {
      if (result.ok) toast(`${typhoon.name} (${typhoon.year}) loaded. Its path is recorded; conditions change its strength.`, 'ok');
      else toast(result.reason ?? `${typhoon.name} could not be loaded.`, 'error');
    });
    post({ type: 'historic', typhoonId: typhoon.id });
  });
  const pathToggle = ref('pathToggle');
  function renderPathToggle(): void {
    pathToggle.setAttribute('aria-checked', String(ui.showRecordedPaths));
    setText(ref('pathState'), ui.showRecordedPaths ? 'On' : 'Off');
  }
  pathToggle.addEventListener('click', () => {
    ui.showRecordedPaths = !ui.showRecordedPaths;
    try { localStorage.setItem(PATHS_KEY, ui.showRecordedPaths ? 'on' : 'off'); } catch { /* storage is optional */ }
    renderPathToggle();
    refreshOverlay();
  });
  renderPathToggle();
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-label]')) {
    const id = button.dataset.label as LabelId;
    button.setAttribute('aria-pressed', String(storedLabel(id)));
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      try { localStorage.setItem(labelKey(id), on ? 'on' : 'off'); } catch { /* storage is optional */ }
      renderer?.setLabels({ [id]: on });
    });
  }
  const detachTooltips = attachTooltips(root, ref('tip'));
  const globeToggle = ref('globeToggle');
  function renderGlobeToggle(): void {
    const on = renderer?.mode === 'globe';
    globeToggle.setAttribute('aria-checked', String(on));
    setText(globeToggle, on ? 'On' : 'Off');
    if (renderer?.kind === 'canvas') globeToggle.setAttribute('aria-disabled', 'true');
  }
  globeToggle.addEventListener('click', () => {
    if (!renderer || renderer.kind === 'canvas') return;
    const mode = renderer.mode === 'globe' ? 'flat' : 'globe';
    renderer.setMode(mode);
    try { localStorage.setItem(MAP_MODE_KEY, mode); } catch { /* storage is optional */ }
    renderGlobeToggle();
    refreshOverlay();
  });
  renderGlobeToggle();
  for (const b of speedButtons) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  rovingKeys(ref('speedGroup'), b => setSpeed(Number(b.dataset.speed)));
  for (const button of overlayButtons) button.addEventListener('click', () => {
    const id = button.dataset.overlay as keyof MapOverlays;
    setMapOverlays({ ...ui.overlays, [id]: !ui.overlays[id] });
  });
  for (const b of tabButtons) b.addEventListener('click', () => activateTab(b.dataset.tab!));
  rovingKeys(ref('reportTabs'), b => activateTab(b.dataset.tab!));
  // The Settings tab only exists on phones; from 48rem the settings block sits above the tabs, so fall back to Storms.
  const wideSidebar = window.matchMedia('(min-width: 48rem)');
  wideSidebar.addEventListener('change', () => {
    if (wideSidebar.matches && ui.tab === 'settings') activateTab('storms');
  });
  ref('sidebarToggle').addEventListener('click', () => setSidebar(sidebar.hidden));
  function setRankMetric(id: RankingMetric): void {
    ui.rankMetric = id;
    root.querySelectorAll<HTMLButtonElement>('[data-rank-metric]').forEach(b => {
      const on = b.dataset.rankMetric === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    renderSidebar();
  }
  root.querySelectorAll<HTMLButtonElement>('[data-rank-metric]').forEach(b => b.addEventListener('click', () => setRankMetric(b.dataset.rankMetric as RankingMetric)));
  rovingKeys(ref('rankMetrics'), b => setRankMetric(b.dataset.rankMetric as RankingMetric));
  ref('rankClear').addEventListener('click', () => {
    if (!confirm(t('Clear the saved ranking on this device?'))) return;
    rankings = [];
    rankingStore.save(rankings);
    renderSidebar();
  });
  ref('stormArchiveMore').addEventListener('click', () => { ui.archiveOpen = true; renderStorms(); });
  for (const name of ['stormList', 'stormArchive', 'stormRank']) ref(name).addEventListener('click', ev => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-storm-id]');
    if (b) selectStorm(Number(b.dataset.stormId) === ui.selectedStormId ? null : Number(b.dataset.stormId), true);
  });
  ref('stormCenter').addEventListener('click', () => {
    selectStorm(ui.selectedStormId, true);
  });
  ref('placeConfirm').addEventListener('click', () => {
    const type = ref<HTMLSelectElement>('placeTool').value as ToolType;
    placeAt(type, parseFloat(ref<HTMLInputElement>('placeLon').value), parseFloat(ref<HTMLInputElement>('placeLat').value));
  });

  ref('zoomIn').addEventListener('click', () => zoomCentre(1.5));
  ref('zoomOut').addEventListener('click', () => zoomCentre(1 / 1.5));
  ref('zoomReset').addEventListener('click', () => renderer?.view.reset());

  // Phones: the legend is a chip until opened, and the starting hint is a one-line banner that times out.
  const mapStatus = ref('mapStatus');
  const setLegendOpen = (open: boolean, remember = true): void => {
    mapStatus.dataset.legend = open ? 'open' : 'closed';
    ref('legendChip').setAttribute('aria-expanded', String(open));
    if (remember) try { localStorage.setItem(LEGEND_KEY, open ? 'open' : 'closed'); } catch { /* storage is optional */ }
  };
  try { setLegendOpen(localStorage.getItem(LEGEND_KEY) === 'open', false); } catch { /* storage is optional */ }
  ref('legendChip').addEventListener('click', () => setLegendOpen(mapStatus.dataset.legend !== 'open'));
  ref('legendClose').addEventListener('click', () => { setLegendOpen(false); ref('legendChip').focus({ preventScroll: true }); });
  const hint = ref('hint');
  const phoneLayout = window.matchMedia('(max-width: 47.9375rem), (max-height: 30rem)');
  let hintTimer = 0;
  const armHintTimeout = (): void => {
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => { hintDismissed = true; hint.hidden = true; }, 8000);
  };
  if (phoneLayout.matches) armHintTimeout();
  hint.addEventListener('click', () => {
    if (!phoneLayout.matches) return;
    const expand = hint.dataset.expanded !== 'true';
    hint.dataset.expanded = String(expand);
    if (expand) window.clearTimeout(hintTimer); else armHintTimeout();
  });
  function zoomCentre(f: number): void {
    const v = renderer?.view;
    if (v) { closeSpot(); v.zoomAt(f, v.width / 2, v.height / 2); }
  }

  // ---- formation popover -------------------------------------------------------------------
  const spot = ref('spotPopover');
  const spotGap = 14;
  let spotAt: GeoPoint | null = null;
  let spotTool: ArmedTool = FORMATION_TOOLS[0].id;
  let spotSig = '';
  let spotPlacements: ToolType[] = [];

  /** The nearest sea or ocean label, when the point is close enough for the name to be fair. */
  function seaNear(lon: number, lat: number): string | null {
    const reachKm = [2500, 1000, 600, 300];
    let best: (typeof SEAS)[number] | null = null;
    let bestShare = 1;
    for (const sea of SEAS) {
      const share = distanceKm(sea.lon, sea.lat, lon, lat) / reachKm[sea.rank];
      if (share < bestShare) { best = sea; bestShare = share; }
    }
    return best ? seaName(best, getLanguage()) : null;
  }

  function positionSpot(): void {
    const r = renderer;
    if (!spotAt || !r) return;
    const px = r.view.lonLatToPx(spotAt.lon, spotAt.lat);
    if (!px) { closeSpot(); return; } // rotated behind the globe's limb
    const box = r.overlayCanvas.getBoundingClientRect();
    const x = box.left + px[0];
    const y = box.top + px[1];
    const width = Math.min(spot.offsetWidth, innerWidth - 16);
    const height = spot.offsetHeight;
    const below = y + spotGap + height <= innerHeight - 8 || y - spotGap - height < 8;
    const left = clamp(x - width / 2, 8, Math.max(8, innerWidth - width - 8));
    const top = clamp(below ? y + spotGap : y - spotGap - height, 8, Math.max(8, innerHeight - height - 8));
    spot.dataset.side = below ? 'bottom' : 'top';
    spot.style.left = `${Math.round(left)}px`;
    spot.style.top = `${Math.round(top)}px`;
    spot.style.setProperty('--caret-x', `${Math.round(clamp(x - left, 14, width - 14))}px`);
  }

  /** Recomputes the recipe from the newest state; the list is rebuilt only when it changes so focus and tooltips survive. */
  function renderSpot(): void {
    const state = ui.latest;
    if (!spotAt || !state) return;
    const advice = FORMATION_BY_ID.get(spotTool)!.recipe(state, spotAt.lon, spotAt.lat);
    const { readings } = advice;
    setText(ref('spotTitle'), fmtCoord(spotAt.lon, spotAt.lat));
    setText(ref('spotName'), advice.land ? 'Land' : seaNear(spotAt.lon, spotAt.lat));
    setText(ref('spotSst'), readings.land ? '–' : `${readings.sst.toFixed(1)} °C`);
    setText(ref('spotAir'), `${readings.airTemperature.toFixed(1)} °C`);
    setText(ref('spotHumidity'), `${(readings.humidity * 100).toFixed(0)}%`);
    setText(ref('spotShear'), `${readings.shear.toFixed(1)} m/s`);
    setText(ref('spotPressure'), `${readings.pressure.toFixed(0)} hPa`);
    setText(ref('spotScore'), `Formation score: ${advice.potential.toFixed(2)} / ${GENESIS_THRESHOLD.toFixed(2)}`);
    const hasRecipe = !advice.land && !advice.impossibleShear;
    ref('spotRecipeBox').hidden = !hasRecipe;
    const sig = hasRecipe ? advice.placements.join(',') : '';
    if (sig !== spotSig) {
      spotSig = sig;
      const counts = new Map<ToolType, number>();
      for (const type of advice.placements) counts.set(type, (counts.get(type) ?? 0) + 1);
      ref('spotRecipe').replaceChildren(...[...counts].map(([type, n]) => {
        const icon = el('span', { class: 'popover__icon' });
        icon.innerHTML = toolIconSvg(type, 'popover__svg');
        return el('li', { class: 'popover__item', style: `--fx: var(--fx-${type})` }, [icon, el('span', { class: 'popover__name', text: TOOL_BY_TYPE.get(type)!.name }), el('b', { class: 'popover__count', text: `×${n}` })]);
      }));
    }
    spotPlacements = advice.placements;
    const note = advice.land ? 'Typhoons cannot form over land. Tap an ocean spot.'
      : advice.impossibleShear ? 'The upper winds here are too strong to calm. No recipe can work.'
      : advice.maxEffects ? 'Too many conditions are active. Wait for some to fade.'
      : !advice.ok ? 'Even this recipe is not enough here.'
      : !advice.placements.length ? 'The recipe is already in place. Give it time to organise.'
      : advice.cold ? 'The water is very cold, so this needs many warm-water patches.'
      : 'Place these together, then give them time to organise.';
    setText(ref('spotNote'), note);
    ref('spotNote').dataset.kind = advice.ok && !advice.maxEffects ? 'ok' : 'warn';
    ref<HTMLButtonElement>('spotPlaceBtn').disabled = !advice.ok || advice.land || advice.maxEffects || !advice.placements.length;
    positionSpot();
  }

  function openSpot(lon: number, lat: number, focus = false): void {
    if (!ui.latest || !isFormation(ui.tool)) return;
    spotTool = ui.tool;
    spotAt = { lon: round2(wrapLon(lon)), lat: round2(clamp(lat, -90, 90)) };
    spotSig = '';
    spot.hidden = false;
    renderSpot();
    if (!focus) return;
    const place = ref<HTMLButtonElement>('spotPlaceBtn');
    (place.disabled ? ref('spotClose') : place).focus({ preventScroll: true });
  }

  function closeSpot(): void {
    if (!spotAt) return;
    spotAt = null;
    spot.hidden = true;
  }

  ref('spotClose').addEventListener('click', () => { closeSpot(); stage.focus({ preventScroll: true }); });
  ref('spotPlaceBtn').addEventListener('click', () => {
    if (!spotAt) return;
    const at = spotAt;
    const types = spotPlacements;
    if (!types.length) return;
    ui.lastPlacementAt = performance.now();
    types.forEach((type, i) => ui.placementQueue.push(result => {
      if (!result.ok) toast(result.reason ?? `${TOOL_BY_TYPE.get(type)!.name} could not be placed there.`, 'error');
      else if (i === types.length - 1) { toast(`Recipe placed at ${fmtCoord(at.lon, at.lat)}.`, 'ok', 3500); announce('Recipe placed.'); }
    }));
    for (const type of types) post({ type: 'place', tool: type, lon: at.lon, lat: at.lat });
    // The recipe is placed: close the popover but keep the formation probe armed for the next spot.
    closeSpot();
    stage.focus({ preventScroll: true });
  });

  let detachInput = () => {};
  if (renderer) {
    const r = renderer;
    detachInput = attachMapInput(r.overlayCanvas, () => r.view, {
      onTap: (px, py) => {
        const at = r.view.pxToLonLat(px, py);
        stage.focus({ preventScroll: true });
        if (ui.tool) {
          if (!at) toast('Outside the map.', 'error');
          else if (isFormation(ui.tool)) openSpot(at[0], at[1]);
          else placeAt(ui.tool, at[0], at[1]);
          return;
        }
        if (!at) {
          ui.selectedCityId = null;
          ui.selectedStormId = null;
          renderSidebar();
          refreshOverlay();
          return;
        }
        const stormId = r.pickStorm(px, py);
        if (stormId !== null) {
          const name = findStorm(stormId)?.name;
          selectStorm(stormId);
          showReadout(name ? `${name} selected. Open the panel for details.` : `Storm #${stormId} selected. Open the panel for details.`);
          return;
        }
        const cityId = r.pickCity(px, py);
        if (cityId) { selectCity(cityId); return; }
        ui.selectedCityId = null;
        ui.selectedStormId = null;
        showAt(at[0], at[1]);
        renderSidebar();
        refreshOverlay();
      },
      onHover: (px, py) => {
        const at = px === null || py === null ? null : r.view.pxToLonLat(px, py);
        if (!at) ui.hover = null;
        else {
          ui.hover = { lon: at[0], lat: at[1] };
          showAt(at[0], at[1]);
        }
        refreshOverlay();
      },
      onInteract: active => {
        if (active) { ui.hover = null; closeSpot(); refreshOverlay(); }
        r.setInteracting(active);
        stage.dataset.interacting = String(active);
        if (!active) applyPending();
      },
    });
  }

  function moveCursor(dLon: number, dLat: number): void {
    const v = renderer?.view;
    if (!v) return;
    ui.hover = null;
    const [centreLon, centreLat] = v.centerLonLat();
    const base = ui.cursor ?? { lon: centreLon, lat: centreLat };
    ui.cursor = { lon: wrapLon(base.lon + dLon), lat: clamp(base.lat + dLat, -90, 90) };
    let px = v.lonLatToPx(ui.cursor.lon, ui.cursor.lat);
    if (!px) {
      v.centerOn(ui.cursor.lon, ui.cursor.lat);
      px = v.lonLatToPx(ui.cursor.lon, ui.cursor.lat);
    }
    const [x, y] = px ?? [v.width / 2, v.height / 2];
    const pad = 60;
    const dx = x < pad ? pad - x : x > v.width - pad ? v.width - pad - x : 0;
    const dy = y < pad ? pad - y : y > v.height - pad ? v.height - pad - y : 0;
    if (dx || dy) v.panPx(dx, dy);
    announce(`Target ${fmtCoord(ui.cursor.lon, ui.cursor.lat)}`);
    showAt(ui.cursor.lon, ui.cursor.lat);
    refreshOverlay();
  }

  const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  /** Things Space and Enter press, so Space must not also play or pause. */
  const PRESSABLE = 'button, a[href], summary, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"]';
  /** Arrow keys belong to these (tab and radio roving, scrolling the panel) rather than to the map. */
  const ARROW_OWNERS = '.sidebar, [role="tablist"], [role="radiogroup"], dialog';
  // Shortcuts are global: they work with focus anywhere (map, sidebar, palette) except while typing or with a dialog open.
  const onKey = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey) return;
    const t = ev.target instanceof Element ? ev.target : document.body;
    if (t.closest(TYPING) || document.querySelector('dialog[open]')) return;
    const slot = (TOOL_KEYS as readonly string[]).indexOf(ev.key);
    // Letter shortcuts follow the typed character, falling back to the physical key under a non-Latin layout (Korean, Japanese, Chinese input).
    const letter = /^[a-z]$/i.test(ev.key) ? ev.key.toLowerCase() : /^Key([A-Z])$/.exec(ev.code)?.[1].toLowerCase() ?? '';
    const formationSlot = ev.altKey || ev.shiftKey ? -1 : (FORMATION_KEYS as readonly string[]).indexOf(letter);
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (ev.key === 'Escape') {
      if (ui.tool) { ev.preventDefault(); armTool(null); }
    } else if (slot >= 0 && slot < TOOLS.length && !ev.altKey) {
      setPaletteTab('conditions');
      armTool(TOOLS[slot].type);
    } else if (formationSlot >= 0 && formationSlot < FORMATION_TOOLS.length) {
      setPaletteTab('formation');
      armTool(FORMATION_TOOLS[formationSlot].id);
    } else if (ev.key === ' ') {
      if (t.closest(PRESSABLE)) return;
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === '+') { ev.preventDefault(); zoomCentre(1.5); } // '-' and '=' select the 11th and 12th conditions
    else if (ev.key === '_') { ev.preventDefault(); zoomCentre(1 / 1.5); }
    else if (renderer && dir[ev.key] && (t === stage || !t.closest(ARROW_OWNERS))) {
      const step = ev.altKey ? 0.25 : ev.shiftKey ? 5 : 1;
      const d = dir[ev.key];
      ev.preventDefault();
      if (ui.tool) moveCursor(d[0] * step, d[1] * step);
      else renderer.view.panPx(-d[0] * (ev.shiftKey ? 240 : 60), d[1] * (ev.shiftKey ? 240 : 60));
    } else if (renderer && ev.key === 'Enter' && ui.tool && t === stage) {
      ev.preventDefault();
      const [centreLon, centreLat] = renderer.view.centerLonLat();
      const c = ui.cursor ?? { lon: centreLon, lat: centreLat };
      if (isFormation(ui.tool)) openSpot(c.lon, c.lat, true); else placeAt(ui.tool, c.lon, c.lat);
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', refreshOverlay);

  // ---- boot --------------------------------------------------------------------------------
  const stopLocation = renderer ? initialiseLocation(renderer, root, status => { stage.dataset.location = status; }) : () => {};
  buildCityList();
  setMapOverlays(ui.overlays);
  activateTab('storms');
  setSidebar(window.matchMedia('(min-width: 70rem)').matches);
  renderTools();
  renderClock();
  renderCityDetail();
  veil.hidden = false;
  ui.expectSeed = urlSeed ?? randomSeed();
  post({ type: 'init', seed: ui.expectSeed, startDayOfYear: newStartDay() });

  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!renderer?.isInteracting) applyPending();
    renderer?.frame(now);
    if (spotAt) positionSpot();
    if (renderer && now - statsAt > 750) {
      statsAt = now;
      const st = renderer.stats();
      stage.dataset.fps = String(st.fps);
      stage.dataset.particles = String(st.particles);
      const note = ref('rendererNote');
      if (renderer.kind === 'webgl' && !st.lost) { note.hidden = !st.reduced; if (st.reduced) setText(note, `Particles reduced to ${fmtInt(st.particles)} to keep the map smooth.`); }
    }
  };
  raf = requestAnimationFrame(loop);

  Object.defineProperty(window, '__typhoonLab', {
    configurable: true,
    value: {
      /** Newest state received from the worker (can be ahead of what the map shows during a gesture). */
      get state() { return ui.latest; },
      /** Map camera; lonLatToPx / pxToLonLat convert between geography and stage pixels. */
      get mapView() { return renderer?.view ?? null; },
      /** 'globe' or 'flat'. */
      get mapMode() { return renderer?.mode ?? 'none'; },
      get playing() { return ui.playing; },
      /** Tick of the state currently drawn. */
      get renderedTick() { return ui.state?.tick ?? -1; },
      get interacting() { return renderer?.isInteracting ?? false; },
      get renderer() { return renderer?.kind ?? 'none'; },
      get speeds() { return SPEEDS; },
    },
  });

  return {
    dispose() {
      cancelAnimationFrame(raf);
      stopLocation();
      detachInput();
      detachTooltips();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', refreshOverlay);
      renderer?.dispose();
      worker.terminate();
    },
  };
}
