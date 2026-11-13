import { LOCALES, getLanguage, setLanguage, localizeTree, localizedText, setText, t, typhoonName } from '../i18n';
import { CITIES, SCENARIO } from '../data/world';
import { WEATHER_HAZARDS, isWeatherHazardKind } from '../data/weather-hazards';
import { TRAFFIC_DEPARTURES } from '../data/traffic';
import { isLake } from '../data/lakes';
import { typhoonById } from '../data/typhoons';
import { layerLegend, type LayerLegend } from '../render/fields';
import { tickPosition } from './legend-scale';
import { FINE_EDGES, FINE_RAMP } from '../render/dust-hexes';
import { MapRenderer } from '../render/map';
import type { MapOverlay } from '../render/overlay';
import { wrapLon } from '../render/view';
import { RESET_WAIT, replayWait, waitVerdict } from './replay-wait';
import { SEAS, seaName } from '../data/seas';
import { GENESIS_HOURS, GENESIS_THRESHOLD, disastersActive, TICKS_PER_HOUR, TOOLS, dayOfYear, historicEnvironmentReady, setHistoricEnvironment } from '../simulation/engine';
import { pm25Band } from '../simulation/fine-dust';
import { loadEnvironment } from '../data/environment';
import { distanceKm } from '../simulation/geo';
import { TRAFFIC_SPEED } from '../simulation/traffic';
import { trafficDistance } from '../simulation/traffic-routing';
import { DEFAULT_MAP_OVERLAYS } from '../types';
import type {
  ActionRecord, City, ClimateKey, DisasterRecord, GameState, GeoPoint, MapOverlays, NewsItem, PlacementResult, Storm, StormRecord, ToolDefinition, ToolType, TrafficVehicle, WorkerRequest, WorkerResponse,
} from '../types';
import { stageChanges, stormGradeLabel, stormOutcome } from '../storm-info';
import { estimateCityDamage, stormTotalLossUsd } from '../simulation/damage-news';
import { disasterDamage, disasterName } from '../simulation/disasters';
import { climateScenarioById, type ClimateScenarioId } from '../simulation/climate-scenarios';
import { newsArt } from './art';
import { freshNews } from './news-fresh';
import { DISASTER_HELP, DISASTER_HELP_INTRO, DISASTER_HELP_TIMING } from './disaster-help';
import { el, svgEl, fmtClock, fmtClockLive, fmtClockShort, fmtCoord, fmtInt, fmtMoney, fmtPop, fmtUtc, rovingKeys } from './dom';
import { SEASONS, fmtDateWithYear, fmtSerialDate, fmtMonthDay, parseStartParam, realTimeOfYear, seasonIdOf, showsYear, worldDay } from './calendar';
import { DEFAULT_TIME_SPEED, SCENARIO_TIME_SPEED, TIME_SPEEDS, adjacentTimeSpeed, isFastClimateSpeed, isTimeSpeed, timeSpeedDescription, timeSpeedLabel, type TimeSpeed } from '../time';
import { attachMapInput } from './input';
import { attachPalette } from './palette';
import { SCENARIO_PROBES } from './scenario-probes';
import { EXPERIENCE_ITEMS, SCENARIO_ICON, TYPHOON_ICON, activeExperienceKeys, typhoonTipSource } from './experience';
import { attachTooltips } from './tooltip';
import { createTutorial, shouldAutoStart } from './tutorial';
import { initialiseLocation } from './initial-location';
import { MEASURE_BY_ID, MEASURE_ITEMS, MEASURE_KEYS, ProbeBook, isMeasureId, pinStyle, type MeasureId } from './measure';
import { createMeasurePanel } from './measure-panel';
import { BASIN_SPOTS, createMeasureOnMap, type MeasureOnMap } from './measure-onmap';
import { dockToPalette } from './dock';
import { configureDragFocus } from './drag-focus';
import { shortcutChar, speedKey } from './shortcuts';
import { CLIMATE_ROWS, helpSub, withIcon, CONDITION_GROUPS, CYCLONE_PATH, FORMATION_TOOLS, PALETTE_TABS, FORMATION_KEYS, TOOL_KEYS, footerHtml, shellHtml, terrainIconSvg, toolIconSvg, type FormationToolId, type Terrain } from './shell';
import { MAX_REPLAY_BYTES, actionKey, buildReplay, downloadJson, parseReplay, parseSeedParam, randomSeed, replayExportProblem } from './storage';
import { deleteMyData, queuedCount, flushQueue, resultFromRecord, resultFromDisaster, setNickname, storedNickname, defaultNickname, subscribe as subscribeLeaderboard, submit as submitResult, type LbView, type LbWindow } from '../net/leaderboard';
import { entryFromStorm, entryFromDisaster, localRankingStore, rankBy, upsert, type RankingEntry, type RankingMetric } from './rankings';

/** Ended storms listed before the "Show all" link appears. */
const ARCHIVE_VISIBLE = 8;

type Expect = 'normal' | 'reset' | 'replay';
type ToastKind = 'info' | 'ok' | 'error';

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const END_REASON_LABEL: Record<RankingEntry['endReason'], string> = { active: 'Active', ended: 'Ended', dissipated: 'Dissipated', extratropical: 'Extratropical transition', merged: 'Merged' };
const TOOL_BY_TYPE = new Map<ToolType, ToolDefinition>(TOOLS.map(t => [t.type, t]));
/** Anything the palette can arm: a weather condition, or a formation probe that opens the recipe popover. */
type ArmedTool = ToolType | FormationToolId | MeasureId;
const FORMATION_BY_ID = new Map<ArmedTool, (typeof FORMATION_TOOLS)[number]>(FORMATION_TOOLS.map(f => [f.id, f]));
const isFormation = (tool: ArmedTool | null): tool is FormationToolId => tool !== null && FORMATION_BY_ID.has(tool);
const isMeasure = (tool: ArmedTool | null): tool is MeasureId => isMeasureId(tool);
const PALETTE_TAB_KEY = 'typhoon-lab-palette-tab';
const LEGEND_KEY = 'typhoon-lab-legend';
function storedPaletteTab(): string {
  try { const v = localStorage.getItem(PALETTE_TAB_KEY); return PALETTE_TABS.some(t => t.id === v) ? v! : PALETTE_TABS[0].id; } catch { return PALETTE_TABS[0].id; }
}
const actionsSig = (a: ActionRecord[]) => JSON.stringify(a.map(actionKey));
/** UI-only setting, remembered like the language. */
const PATHS_KEY = 'typhoon-lab-recorded-paths';
function storedShowPaths(): boolean {
  try { return localStorage.getItem(PATHS_KEY) !== 'off'; } catch { return true; }
}

/** Label layers (city names, isobar values, sea names): UI-only, on by default, remembered per layer. */
const LABEL_IDS = ['cities', 'isobars', 'seas'] as const;
type LabelId = (typeof LABEL_IDS)[number];
const labelKey = (id: LabelId | 'graphs') => `typhoon-lab-label-${id}`;
function storedLabel(id: LabelId | 'graphs'): boolean {
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
  const trafficPopup = ref('trafficPopup');
  let selectedTrafficId: string | null = null;
  let trafficPopupAt = 0;
  const closeTrafficPopup = () => { selectedTrafficId = null; trafficPopup.hidden = true; };
  ref('trafficClose').addEventListener('click', () => { closeTrafficPopup(); stage.focus({ preventScroll: true }); });
  const veil = ref('veil');
  const sidebar = ref('sidebar');
  const sidebarBesideMap = window.matchMedia('(min-width: 48rem)');
  const stageWrap = root.querySelector<HTMLElement>('.stage-wrap')!;
  let measureOnMap: MeasureOnMap | undefined;
  // The notes stack sits on the palette; while an icon is dragged the palette gives way to a description card.
  const undock = dockToPalette(stageWrap, ref('palette'), root.querySelector<HTMLElement>('.notes')!, root.querySelector<HTMLElement>('.brandbar')!);
  configureDragFocus({
    host: stageWrap,
    announce: text => announce(text),
    detail: b => {
      const def = b.dataset.variant ? TOOL_BY_TYPE.get(b.dataset.variant as ToolType) : undefined;
      return def ? `${t('Affected radius')} ${def.radiusKm} km` : '';
    },
  });
  /** Width of the map covered by the sidebar: none when it sits beside the stage, its full width when it overlays (phones). */
  const sidebarInset = (): number => {
    if (sidebar.hidden || sidebarBesideMap.matches) return 0;
    const width = sidebar.getBoundingClientRect().width;
    return width >= window.innerWidth - 8 ? 0 : width; // a full-width phone overlay hides the whole map, so nothing is worth keeping clear
  };
  const toolButtons = new Map<ArmedTool, HTMLButtonElement>();
  const experienceButtons = new Map<string, HTMLButtonElement>();
  root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => toolButtons.set(b.dataset.tool as ArmedTool, b));
  const overlayButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-overlay]')];
  const speedButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-speed-action]')];
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
    /** The "Graphs on map" switch (Measure charts drawn beside their pins). */
    graphsOnMap: storedLabel('graphs'),
    speed: DEFAULT_TIME_SPEED as TimeSpeed,
    clockHours: 0,
    playing: true,
    selectedStormId: null as number | null,
    selectedDisasterId: null as string | null,
    selectedCityId: null as string | null,
    expect: 'normal' as Expect,
    /** A +4h skip is posted and its state has not come back: further presses wait. */
    skipping: false,
    expectBaseTick: 0,
    expectUntil: 0,
    expectSeed: 0,
    expectSig: '',
    expectTrafficSig: '',
    newsKey: '',
    /** Id of the newest news item already announced (items are evicted at the cap, so a count cannot say what is new). */
    newsLastId: null as string | null,
    tab: 'storms',
    /** True once "Show all" has revealed the older ended storms. */
    archiveOpen: false,
    placementQueue: [] as ((r: PlacementResult) => void)[],
    lastPlacementAt: 0,
    /** Set when a scenario was just loaded or switched off here: the next state that shows it adds or removes the starter Measure charts. */
    scenarioProbes: null as 'apply' | 'remove' | null,
    /** A scenario load or switch-off is posted and its result has not come back: a second request waits (the state a click sees is stale until then). */
    scenarioPending: false,
    rankMetric: 'lossUsd' as RankingMetric,
    lbWindow: 'live' as LbWindow,
    lbView: null as LbView | null,
    lbError: false,
    /** Spot the tutorial rings on the map. */
    tutorialTarget: null as GeoPoint | null,
  };
  // Measure tab: read-only probes. Nothing here is posted to the worker, recorded in actions or exported in a replay.
  const probes = new ProbeBook();
  let probePinsRev = -1;
  let probePinsCache: NonNullable<MapOverlay['pins']> = [];
  function probePins(): NonNullable<MapOverlay['pins']> {
    if (probePinsRev !== probes.layoutRev) {
      probePinsRev = probes.layoutRev;
      probePinsCache = probes.pins.map(p => { const style = pinStyle(p.n); return { n: p.n, lon: p.lon, lat: p.lat, color: style.color, ink: style.ink }; });
    }
    return probePinsCache;
  }
  /** Called with every accepted worker state (the tutorial watches for the player's moves). */
  const stateListeners: ((state: GameState) => void)[] = [];
  let lbStop: (() => void) | null = null;
  const rankingStore = localRankingStore();
  let rankings = rankingStore.load();
  /** Ranking keys of this world's ended storms already written to the store, by storm id. */
  const rankedKeys = new Map<number, string>();
  const rankedDisasters = new Map<string, string>();
  let expectTimer = 0;
  let expectLastProgress = 0;
  let toastTimer = 0;
  /** Phones show the starting hint for a few seconds only; this stays true once it has timed out. */
  let hintDismissed = false;
  let statsAt = 0;
  let trafficFocusAt = 0;
  let trafficFocusKey = '';

  // ---- renderer ----------------------------------------------------------------------------
  let renderer: MapRenderer | null = null;
  const params = new URLSearchParams(location.search);
  const urlSeed = parseSeedParam(location.search);
  const urlStart = parseStartParam(location.search);
  /** A new world starts at local wall-clock date and time; URL-pinned dates start at midnight. */
  const newStartDay = () => urlStart ?? realTimeOfYear();
  // A pinned scenario date stays reproducible; weather=live can explicitly override it.
  const useLiveWeather = params.get('weather') === 'live' || (params.get('weather') !== 'base' && urlStart === null);
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
  function syncTrafficView(now: number): void {
    if (!renderer || renderer.isInteracting || !ui.latest || !ui.playing || ui.expect !== 'normal' || now - trafficFocusAt < 750) return;
    trafficFocusAt = now;
    const view = renderer.view;
    const projected = new Float64Array(3);
    const visible = (point: GeoPoint, padding = 0) => {
      view.projectZ(point.lon, point.lat, projected);
      return projected[2] > 0.05 && projected[0] >= -padding && projected[0] <= view.width + padding
        && projected[1] >= -padding && projected[1] <= view.height + padding;
    };
    // Prefer links whose destination is also on screen, to keep return services nearby.
    const departures = TRAFFIC_DEPARTURES.filter(departure => visible(departure.start))
      .map(departure => ({ id: departure.id, local: visible(departure.end) }))
      .sort((a, b) => Number(b.local) - Number(a.local)).map(departure => departure.id);
    const visibleVehicles = ui.latest.traffic.vehicles.filter(vehicle => vehicle.status !== 'inactive'
      && vehicle.status !== 'crashed' && vehicle.status !== 'sunk' && visible(vehicle, 40)).map(vehicle => vehicle.id);
    const key = JSON.stringify([ui.latest.seed, ui.latest.tick, departures, visibleVehicles]);
    if (key === trafficFocusKey) return;
    trafficFocusKey = key;
    post({ type: 'traffic-view', tick: ui.latest.tick, departures, visibleVehicles });
  }

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
    setLegendValue('finedust', `${sample.pm25.toFixed(0)} µg/m³ · ${pm25Band(sample.pm25)}`, sample.pm25);
    setLegendValue('yellowdust', `${(sample.dust * 100).toFixed(0)}%`, sample.dust * 100);
    setLegendValue('pressure', `${sample.pressure.toFixed(0)} hPa`, sample.pressure);
    setLegendValue('temperature', sample.land ? '—' : `${sample.temperature.toFixed(1)} °C`, sample.land ? NaN : sample.temperature);
    setLegendValue('airTemperature', `${sample.airTemperature.toFixed(1)} °C`, sample.airTemperature);
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
    const measuring = isMeasure(type ?? null);
    const previewType = type && isFormation(type) ? FORMATION_BY_ID.get(type)!.preview : type;
    const def = previewType && !measuring ? TOOL_BY_TYPE.get(previewType as ToolType) ?? null : null;
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
      pins: probePins(),
      reticle: measuring && !MEASURE_BY_ID.get(type!)!.basin ? (ui.drag ? ui.drag.point : ui.hover ?? ui.cursor) : null,
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
    if (ui.tool) closeTrafficPopup();
    ui.cursor = null;
    closeSpot();
    if (isFormation(ui.tool)) toast(`${FORMATION_BY_ID.get(ui.tool)!.name} armed. Tap or click a spot to see what it needs; Esc puts it away.`, 'info', 3500);
    else if (isMeasure(ui.tool)) {
      const item = MEASURE_BY_ID.get(ui.tool)!;
      toast(item.basin ? `${item.name} armed. Tap or click anywhere on the map to add its chart; Esc puts it away.` : `${item.name} armed. Tap or click the map to measure there; Esc puts it away.`, 'info', 3500);
    }
    else if (ui.tool) toast(`${TOOL_BY_TYPE.get(ui.tool as ToolType)!.name} armed. Tap or click the map to place it; Esc puts it away.`, 'info', 3500);
    renderTools();
    refreshOverlay();
  }

  function armPaletteTool(type: ArmedTool): void {
    const pair = CONDITION_GROUPS.find(([first]) => first === type);
    armTool(pair ? (ui.tool === pair[0] ? pair[1] : pair[0]) : type);
  }

  function draggedVariant(type: ArmedTool): ArmedTool {
    const pair = CONDITION_GROUPS.find(([first]) => first === type);
    return pair && (ui.tool === pair[0] || ui.tool === pair[1]) ? ui.tool : type;
  }

  function renderTools(): void {
    for (const [type, b] of toolButtons) {
      const pair = CONDITION_GROUPS.find(([first]) => first === type);
      const on = pair ? ui.tool === pair[0] || ui.tool === pair[1] : ui.tool === type;
      const variant = on ? ui.tool! : type;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-armed', on);
      if (pair && b.dataset.variant !== variant) {
        const def = TOOL_BY_TYPE.get(variant as ToolType)!;
        const alternate = variant === pair[0] ? pair[1] : pair[0];
        b.dataset.variant = variant;
        b.dataset.alternate = alternate;
        b.style.setProperty('--tool-color', `var(--fx-${variant})`);
        b.style.setProperty('--tool-alt-color', `var(--fx-${alternate})`);
        b.querySelector('.tool__icon:not(.tool__icon--secondary)')!.outerHTML = toolIconSvg(variant as ToolType);
        b.querySelector('.tool__icon--secondary')!.outerHTML = toolIconSvg(alternate, 'tool__icon tool__icon--secondary');
        setText(b.querySelector('.tool__name')!, def.name);
        b.setAttribute('aria-label', `${def.name}: drag onto the map, or press to arm it`);
        b.dataset.tipTitle = def.name;
        b.dataset.tip = def.description;
        localizeTree(b);
      }
    }
    stage.dataset.armed = ui.tool ?? '';
  }

  // ---- clock and controls ------------------------------------------------------------------
  const clockOffset = (s: GameState) => (s.startDayOfYear % 1) * 24;
  function renderClockText(): void {
    const s = ui.latest;
    const hours = s ? ui.clockHours + clockOffset(s) : 0;
    if (s && s.climateTime?.active) { // the fast climate path: the weather clock does not run, the date does
      const month = fmtDateWithYear(s, ui.clockHours, getLanguage(), false);
      setText(ref('clockText'), month);
      ref('clockText').dataset.short = month;
    } else {
      const date = !s ? '' : showsYear(s, ui.clockHours) ? fmtDateWithYear(s, ui.clockHours, getLanguage(), true) : fmtMonthDay(worldDay(s, ui.clockHours));
      setText(ref('clockText'), s ? `${fmtClockLive(hours)} · ${date}` : fmtClockLive(0));
      ref('clockText').dataset.short = fmtClockShort(hours);
    }
    renderer?.setSimulationClock(ui.clockHours, ui.speed, ui.playing && ui.expect === 'normal');
  }

  function renderClock(): void {
    const s = ui.latest;
    renderClockText();
    const play = ref<HTMLButtonElement>('play');
    const label = ui.playing ? 'Pause' : 'Play';
    play.dataset.state = ui.playing ? 'playing' : 'paused';
    play.setAttribute('aria-label', label);
    play.dataset.tipTitle = label;
    localizeTree(play);
    play.disabled = !s;
    syncClimateDisabled();
    if (play.dataset.label !== label) {
      const hint = play.querySelector('.key-hint');
      play.dataset.label = label;
      play.replaceChildren(...(hint ? [hint] : []), playIcon(ui.playing), localizedText(label));
    }
    setText(ref('speedValue'), timeSpeedLabel(ui.speed));
    const speedValue = ref('speedValue'), speedWords = timeSpeedDescription(ui.speed);
    speedValue.setAttribute('aria-label', speedWords);
    speedValue.dataset.tipTitle = speedWords;
    localizeTree(speedValue);
    for (const b of speedButtons) b.disabled = !s;
    ref<HTMLButtonElement>('speedReset').disabled = !s || ui.speed === DEFAULT_TIME_SPEED;
    syncSkip();
  }

  /** Why the +4h button cannot be used right now, or '' when it can. */
  function skipBlock(): string {
    if (!ui.latest) return 'Time cannot be skipped while the world is loading.';
    if (ui.expect === 'replay') return 'Time cannot be skipped while a replay plays.';
    if (ui.expect !== 'normal' || ui.placementQueue.length || ui.scenarioPending) return 'Time cannot be skipped while the world is loading.';
    if (isFastClimateSpeed(ui.speed)) return 'Time cannot be skipped at 7d/s, where the weather is not calculated.';
    return '';
  }
  function syncSkip(): void {
    const btn = ref<HTMLButtonElement>('skip');
    const why = skipBlock();
    btn.disabled = why !== '';
    btn.dataset.tip = why || 'Advance the world by 4 hours at once, as if time had run. Works while paused and while playing. Shortcut: Enter.';
    localizeTree(btn);
  }
  function skipAhead(): void {
    if (skipBlock() || ui.skipping) return;
    ui.skipping = true;
    post({ type: 'skip' });
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

  function setSpeed(speed: TimeSpeed): void {
    if (speed === ui.speed) return;
    ui.speed = speed;
    post({ type: 'speed', speed });
    renderClock();
  }

  function renderMapLegend(): void {
    legendLive.clear();
    windValue = { speed: el('span'), vertical: el('span') };
    rainTip = null;
    const rows: HTMLElement[] = [el('p', { class: 'legend__base', testid: 'legend-wind' }, [
      el('span', { class: 'legend__base-text' }, [localizedText(ui.overlays.wind ? 'Moving streaks show wind.' : 'Wind streaks are hidden.')]),
      el('span', { class: 'legend__value legend__readout', 'data-legend-value': true }, [windValue.speed, windValue.vertical]),
    ])];
    for (const id of ['humidity', 'rain', 'finedust', 'yellowdust', 'pressure', 'temperature', 'population'] as const) {
      if (!ui.overlays[id === 'yellowdust' ? 'finedust' : id]) continue;
      const legend = id === 'finedust' ? {
        title: 'Fine dust (PM2.5)', unit: 'µg/m³',
        gradient: `linear-gradient(to right, ${FINE_RAMP.map((c, i) => `${c} ${(i / FINE_RAMP.length) * 100}% ${((i + 1) / FINE_RAMP.length) * 100}%`).join(', ')})`,
        ticks: FINE_EDGES.map((edge, i) => ({ label: String(Math.floor(edge)), pos: i / FINE_RAMP.length })),
        note: 'Small hexagons show where fine particles (PM2.5) from cities drift with the wind. The colour steps from cream through orange and red to deep purple as the concentration rises; hexagons appear from 12 µg/m³.',
      } : id === 'yellowdust' ? {
        title: 'Yellow dust', unit: '%',
        gradient: 'linear-gradient(to right, rgba(230,196,84,0.25), rgba(230,196,84,0.42) 50%, rgba(230,196,84,0.6))',
        ticks: [{ label: '12', pos: 0 }, { label: '50', pos: 0.5 }, { label: '100', pos: 1 }],
        note: 'Small, spaced sand-yellow hexagons show the extent of a yellow dust event. Darker is denser.',
      } : id === 'humidity' ? {
        title: 'Humidity', unit: '%',
        gradient: 'linear-gradient(to right, var(--ramp-humidity-0), var(--ramp-humidity-1) 50%, var(--ramp-humidity-2))',
        ticks: [{ label: '0', pos: 0 }, { label: '50', pos: 0.5 }, { label: '100', pos: 1 }],
        note: ui.overlays.wind ? 'Higher humidity makes wind streaks brighter.' : 'Turn on Wind to see humidity colours.',
      } : layerLegend(id);
      const row = el('div', { class: 'legend__item', testid: `legend-${id}` });
      const value = el('span', { class: 'legend__value', 'data-legend-value': true, text: legend.unit });
      const info = id === 'humidity' || id === 'rain' || id === 'finedust' || id === 'yellowdust' || id === 'pressure' || id === 'temperature'
        ? el('button', { type: 'button', class: 'legend__info', 'aria-label': legend.title, 'data-tip-title': legend.title, 'data-tip': legend.note, text: '?' })
        : null;
      if (id === 'rain') rainTip = info;
      const title = el('p', { class: 'legend__title' }, [
        id === 'pressure' ? el('span', { class: 'legend__line', 'aria-hidden': 'true' }) : null,
        el('span', { class: 'legend__name' }, [localizedText(legend.title)]), info, id === 'temperature' ? null : value,
      ]);
      row.append(title);
      let airTick: HTMLElement | null = null;
      let airValue: HTMLElement | null = null;
      if (id === 'temperature') {
        airValue = el('span', { class: 'legend__value', 'data-legend-value': true, testid: 'legend-temperature-air', text: '°C' });
        value.dataset.testid = 'legend-temperature-sea';
        const reading = (kind: 'air' | 'sea', label: string, number: HTMLElement) => {
          const icon = svgEl('svg', { class: 'legend__temperature-icon', viewBox: '0 0 24 24', role: 'img', 'aria-label': label, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
            svgEl('path', { d: kind === 'sea'
              ? 'M2 9c2-2 3.5 2 5.5 0s3.5 2 5.5 0 3.5 2 5.5 0 2.5 1 3.5 0M2 16c2-2 3.5 2 5.5 0s3.5 2 5.5 0 3.5 2 5.5 0 2.5 1 3.5 0'
              : 'M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0ZM12 9v9' }),
          ]);
          return el('span', { class: 'legend__temperature-reading', 'data-temperature-kind': kind, title: label }, [icon, number]);
        };
        title.classList.add('legend__title--temperature');
        title.append(el('span', { class: 'legend__temperature-values' }, [
          reading('air', 'Surface air temperature', airValue), reading('sea', 'Sea-surface temperature', value),
        ]));
      }
      let tick: HTMLElement | null = null;
      if (id !== 'humidity' || ui.overlays.wind) {
        tick = el('span', { class: 'legend__tick', hidden: true, 'aria-hidden': 'true' });
        const bar = el('div', { class: 'legend__bar' }, [tick]);
        if (id === 'temperature') {
          tick.classList.add('legend__tick--sea');
          airTick = el('span', { class: 'legend__tick legend__tick--air', hidden: true, 'aria-hidden': 'true' });
          bar.append(airTick);
        }
        bar.style.background = legend.gradient;
        const ticks = el('div', { class: 'legend__ticks' }, legend.ticks.map(t => {
          const label = el('span', { text: t.label, 'data-edge': t.pos === 0 ? 'start' : t.pos === 1 ? 'end' : 'mid' });
          label.style.left = `${t.pos * 100}%`;
          return label;
        }));
        row.append(bar, ticks);
      }
      legendLive.set(id, { value, tick, ticks: legend.ticks });
      if (airValue) legendLive.set('airTemperature', { value: airValue, tick: airTick, ticks: legend.ticks });
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
    setText(ref('sidebarToggleLabel'), open ? 'Hide' : 'Disasters');
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
    ui.selectedDisasterId = null;
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
  const disasterRows = new Map<string, HTMLLIElement>();
  const findDisaster = (id: string | null) => ui.state?.disasters?.find(record => record.id === id);
  function selectDisaster(id: string | null, center = false): void {
    ui.selectedDisasterId = id;
    ui.selectedStormId = null;
    const record = findDisaster(id);
    if (record && center) renderer?.view.centerOn(record.lon, record.lat);
    if (id) activateTab('storms');
    else renderSidebar();
    refreshOverlay();
  }
  function disasterCondition(record: Pick<DisasterRecord, 'kind' | 'airTemperature' | 'humidity' | 'rain' | 'snowCm' | 'wind'>): string {
    if (record.kind === 'heatwave' || record.kind === 'coldwave') return `${t('Air temperature')} ${record.airTemperature.toFixed(1)} °C`;
    if (record.kind === 'drought' || record.kind === 'dust') return `${t('Humidity')} ${(record.humidity * 100).toFixed(0)}%`;
    if (record.kind === 'downpour' || record.kind === 'hail') return `${t('Rainfall')} ${record.rain.toFixed(1)} mm/h`;
    if (record.kind === 'blizzard') return `${t('Snow depth')} ${record.snowCm.toFixed(0)} cm`;
    return `${t('Max wind')} ${record.wind.toFixed(0)} m/s`;
  }
  function renderDisasterRows(state: GameState): void {
    const records = state.disasters ?? [];
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(record.id);
      const archived = record.endedHour !== undefined;
      const list = ref(archived ? 'stormArchive' : 'stormList');
      let li = disasterRows.get(record.id);
      if (!li) {
        const icon = isWeatherHazardKind(record.kind) ? WEATHER_HAZARDS[record.kind].iconPath
          : record.kind === 'blizzard' ? WEATHER_HAZARDS.coldwave.iconPath : record.kind === 'tornado' ? 'M2 4h20M4 8h16M6 12h12M8 16h8M10 20h4' : WEATHER_HAZARDS.downpour.iconPath;
        li = el('li', {}, [el('button', { type: 'button', class: 'storm-row disaster-row', 'data-disaster-id': record.id, 'aria-pressed': 'false' }, [
          el('span', { class: 'storm-row__name' }, [
            svgEl('svg', { class: 'storm-row__icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }, [svgEl('path', { d: icon })]),
            el('span', { class: 'storm-row__title' }),
          ]),
          el('span', { class: 'storm-row__wind', 'data-disaster-reading': '' }),
          el('span', { class: 'storm-row__pos', 'data-disaster-position': '' }),
          el('span', { class: 'storm-row__conditions' }, [
            ...['pressure', 'radius', 'age', 'loss'].map(key => el('span', {}, [
              el('span', { class: 'storm-row__label', text: ({ pressure: 'Pressure', radius: 'Affected radius', age: 'Age', loss: 'Estimated loss' })[key]! }),
              el('span', { class: 'mono', 'data-disaster-metric': key }),
            ])),
          ]),
        ])]);
        disasterRows.set(record.id, li);
      }
      if (li.parentElement !== list) { if (archived) list.prepend(li); else list.append(li); }
      const button = li.firstElementChild as HTMLButtonElement;
      button.dataset.testid = archived ? 'disaster-history-row' : 'disaster-row';
      button.setAttribute('aria-pressed', String(record.id === ui.selectedDisasterId));
      if (isWeatherHazardKind(record.kind)) button.style.setProperty('--disaster-color', WEATHER_HAZARDS[record.kind].color);
      setText(button.querySelector('.storm-row__title')!, `${t(disasterName(record.kind))} #${record.id.split('-').at(-1)}`);
      setText(button.querySelector('[data-disaster-reading]')!, disasterCondition(record));
      setText(button.querySelector('[data-disaster-position]')!, `${t(archived ? 'Ended' : 'Active')} · ${fmtCoord(record.lon, record.lat)}`);
      const values = { pressure: `${record.pressure.toFixed(0)} hPa`, radius: `${record.radiusKm.toFixed(0)} km`, age: `${record.ageHours.toFixed(1)} h`, loss: fmtMoney(disasterDamage(record).lossUsd) };
      for (const [key, value] of Object.entries(values)) setText(button.querySelector(`[data-disaster-metric="${key}"]`)!, value);
    }
    for (const [id, li] of disasterRows) if (!seen.has(id)) { li.remove(); disasterRows.delete(id); }
  }
  function renderDisasterDetail(record: DisasterRecord): void {
    const detail = ref('disasterDetail');
    const damage = disasterDamage(record);
    setText(ref('disasterTitle'), `${t(disasterName(record.kind))} #${record.id.split('-').at(-1)}`);
    const values = { Kind: disasterName(record.kind), Status: record.endedHour === undefined ? 'Active' : 'Ended',
      Intensity: `${(record.intensity * 100).toFixed(0)}%`, Position: fmtCoord(record.lon, record.lat), Radius: `${record.radiusKm.toFixed(0)} km`, Age: `${record.ageHours.toFixed(1)} h`,
      Movement: `${record.movementSpeedKmh.toFixed(1)} km/h`, Pressure: `${record.pressure.toFixed(0)} hPa`, Wind: `${record.wind.toFixed(0)} m/s`, Peak: `${record.peakWind.toFixed(0)} m/s`,
      Temperature: `${record.airTemperature.toFixed(1)} °C`, Humidity: `${(record.humidity * 100).toFixed(0)}%`, Rain: `${record.rain.toFixed(1)} mm/h`, Snow: `${record.snowCm.toFixed(0)} cm`,
      Loss: fmtMoney(damage.lossUsd), Homes: fmtInt(damage.floodedHomes) };
    for (const [key, value] of Object.entries(values)) setMetric(`disaster${key}`, value, detail);
    ref('disasterHistory').replaceChildren(...record.history.slice(-8).map(sample => el('li', {
      text: `${fmtClock(sample.hour + clockOffset(ui.latest!))} · ${disasterCondition({ ...sample, kind: record.kind })} · ${sample.pressure.toFixed(0)} hPa`,
    })));
  }
  function findStorm(id: number | null): Storm | StormRecord | undefined {
    return ui.state?.storms.find(x => x.id === id) ?? ui.state?.stormArchive.find(x => x.id === id);
  }
  function renderStorms(): void {
    const s = ui.state;
    if (!s) return;
    syncResets();
    const disasters = s.disasters ?? [];
    const activeDisasters = s.storms.length + disasters.filter(record => record.endedHour === undefined).length;
    setText(ref('stormSummary'), `${t('Disasters')}: ${activeDisasters} · ${t('Forming patches')}: ${s.candidates.length}`);
    root.querySelector<HTMLElement>('[data-testid="storm-wind-note"]')!.hidden = s.storms.length === 0;
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
        setText(when, fmtClock(record.endedHour + clockOffset(s)));
      } else setText(when, fmtCoord(storm.lon, storm.lat));
      setText(b.querySelector('[data-testid="storm-movement-speed"]')!, `${storm.movementSpeedKmh.toFixed(1)} km/h`);
      setText(b.querySelector('[data-testid="storm-central-pressure"]')!, `${storm.pressure.toFixed(0)} hPa`);
      setText(b.querySelector('[data-testid="storm-gale-radius"]')!, `${storm.galeRadiusKm.toFixed(0)} km`);
      setText(b.querySelector('[data-testid="storm-loss"]')!, fmtMoney(stormTotalLossUsd(storm)));
    }
    for (const [id, li] of stormRows) if (!seen.has(id)) { li.remove(); stormRows.delete(id); }
    renderDisasterRows(s);

    const detail = ref('stormDetail');
    const endedCount = s.stormArchive.length + disasters.filter(record => record.endedHour !== undefined).length;
    ref('stormArchiveEmpty').hidden = endedCount > 0;
    setText(ref('stormActiveTitle'), `${t('Active disasters')} · ${activeDisasters}`);
    setText(ref('stormEndedTitle'), `${t('Ended disasters')} · ${endedCount}`);
    // Newest ended storm first; only the first few stay visible until "Show all" is pressed (a selected record always stays visible).
    const ended = [...ref('stormArchive').children] as HTMLLIElement[];
    if (ended.length <= ARCHIVE_VISIBLE) ui.archiveOpen = false;
    ended.forEach((li, i) => {
      const row = li.firstElementChild as HTMLElement;
      li.hidden = !ui.archiveOpen && i >= ARCHIVE_VISIBLE && Number(row.dataset.stormId) !== ui.selectedStormId && row.dataset.disasterId !== ui.selectedDisasterId;
    });
    const more = ref('stormArchiveMore');
    more.hidden = ui.archiveOpen || ended.length <= ARCHIVE_VISIBLE;
    setText(more.querySelector('.ui-lbl__text')!, `Show all (${ended.length})`);
    const sel = findStorm(ui.selectedStormId);
    detail.hidden = !sel;
    if (sel) renderStormDetail(sel, detail);
    const disaster = findDisaster(ui.selectedDisasterId);
    ref('disasterDetail').hidden = !disaster;
    if (disaster) renderDisasterDetail(disaster);

    ref('patchList').replaceChildren(...s.candidates.map(c => el('li', { class: 'patch' }, [
      el('span', { text: fmtCoord(c.lon, c.lat) }), el('span', { class: 'mono', text: `${Math.min(99, Math.floor((c.progressHours / GENESIS_HOURS) * 100))}% to a depression` }),
    ])));
    ref('patchEmpty').hidden = s.candidates.length > 0;
  }

  function renderRanking(): void {
    const s = ui.state;
    if (!s) return;
    const live = [...s.storms.map(storm => entryFromStorm(s.seed, storm, s.hours, s.actions, undefined, s.traffic.dispatches)),
      ...(s.disasters ?? []).filter(record => record.endedHour === undefined).map(record => entryFromDisaster(s.seed, record, s.hours, s.actions, undefined, s.traffic.dispatches))];
    const worldKeys = new Set([...rankedKeys.values(), ...rankedDisasters.values(), ...live.map(e => e.key)]);
    const ranked = rankBy(live.reduce(upsert, rankings), ui.rankMetric);
    ref('stormRank').replaceChildren(...ranked.map((entry, i) => {
      const storm = !entry.disasterId && worldKeys.has(entry.key) ? findStorm(entry.stormId) : undefined;
      const disaster = entry.disasterId && worldKeys.has(entry.key) ? findDisaster(entry.disasterId) : undefined;
      const content = [
        el('span', { class: 'storm-row__name' }, [el('span', { class: 'storm-rank__no', text: `${i + 1}.` }), localizedText(` ${entry.kind ? `${t(disasterName(entry.kind))} #${entry.disasterId!.split('-').at(-1)}` : entry.name}`)]),
        el('span', { class: 'storm-row__wind', testid: 'rank-value', text: rankValue(entry, ui.rankMetric) }),
        el('span', { class: 'storm-row__pos', text: storm ? stormOutcome(storm) : END_REASON_LABEL[entry.endReason] }),
      ];
      return el('li', {}, [disaster
        ? el('button', { type: 'button', class: 'storm-row', 'data-disaster-id': disaster.id, 'aria-pressed': String(disaster.id === ui.selectedDisasterId) }, content)
        : storm
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
    setMetric('loss', fmtMoney(stormTotalLossUsd(sel)), detail);
    for (const n of metrics.get('windDelta') ?? []) n.parentElement!.hidden = !sel.record;
    for (const n of metrics.get('trackOffset') ?? []) n.parentElement!.hidden = !sel.record;
    setMetric('trackOffset', `${Math.hypot(sel.trackOffset?.east ?? 0, sel.trackOffset?.north ?? 0).toFixed(0)} km`, detail);
    setMetric('windDelta', `${sel.windDelta > 0.5 ? '+' : sel.windDelta < -0.5 ? '\u2212' : ''}${Math.abs(sel.windDelta) < 0.5 ? 0 : Math.abs(sel.windDelta).toFixed(0)} m/s`, detail);
    const spark = ref<HTMLElement>('spark') as unknown as SVGSVGElement;
    const [line, area] = spark.querySelectorAll('path');
    ref('stormStages').replaceChildren(...stageChanges(sel).map(sample => el('li', {
      text: `Grade ${sample.grade} · ${sample.stage} · ${fmtClock(sample.hour + clockOffset(ui.latest!))}`,
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
    syncResets();
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
      ['People exposed to disasters', impact ? `${fmtInt(impact.exposedPopulation)} (${(share * 100).toFixed(0)}%)` : '—'],
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
    const key = `${s.news.length}|${last?.id ?? ''}|${ui.selectedCityId ?? ''}`;
    if (key !== ui.newsKey) {
      ui.newsKey = key;
      const news = ui.selectedCityId ? s.news.filter(item => item.cityId === ui.selectedCityId) : s.news;
      ref('newsList').replaceChildren(...news.slice(-60).reverse().map(newsRow));
      const empty = ref('newsEmpty');
      empty.hidden = news.length > 0;
      const city = CITIES.find(item => item.id === ui.selectedCityId);
      setText(empty, city ? `${city.name}: ${t('No reports yet.')}` : t('No reports yet.'));
    }
  }

  function notifyNews(): void {
    const s = ui.state;
    if (!s) return;
    const last = s.news[s.news.length - 1];
    if (last && last.id !== ui.newsLastId) {
      const fresh = freshNews(s.news, ui.newsLastId);
      const item = last;
      if (ui.newsLastId !== null || fresh.length <= 2) {
        announce(`${t('News')}: ${t(item.title)}. ${t(item.text)}`);
        if (performance.now() - ui.lastPlacementAt > 2000 && item.kind !== 'info') toast(item.title, 'info', 4500);
      }
      ui.newsLastId = last.id;
    } else if (!last) ui.newsLastId = null;
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
    syncResets();
  }
  function syncClimateDisabled(): void {
    for (const { input } of climateInputs.values()) input.disabled = ui.expect === 'replay';
    for (const b of seasonButtons) b.disabled = ui.expect === 'replay';
    for (const [key, b] of experienceButtons) if (key.startsWith('scenario:')) b.setAttribute('aria-disabled', String(ui.expect === 'replay'));
    syncResets();
  }
  /** The World and Disasters tab resets: each is on only while there is something to reset, and never during a replay. */
  function syncResets(): void {
    const replay = ui.expect === 'replay';
    const conditions = ref<HTMLButtonElement>('conditionsReset'), disasters = ref<HTMLButtonElement>('disastersReset');
    const noConditions = !ui.latest || ui.latest.effects.length === 0, noDisasters = !ui.latest || !disastersActive(ui.latest);
    conditions.disabled = replay || noConditions;
    conditions.dataset.tip = replay ? 'Conditions cannot be reset while a replay plays.' : noConditions ? 'No condition is active.' : 'Take every condition off the map: placed, recipe and natural-formation conditions. Storms and disasters keep running.';
    disasters.disabled = replay || noDisasters;
    disasters.dataset.tip = replay ? 'Disasters cannot be reset while a replay plays.' : noDisasters ? 'No disaster is active.' : 'End every active storm and disaster. The damage already done stays on record.';
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

  function weatherSourceLines(state: GameState): HTMLElement[] {
    const lines: HTMLElement[] = [];
    if (state.liveEnded) {
      lines.push(el('p', { text: t('Live weather ended · using base climate') }));
    } else if (state.initialWeather) {
      lines.push(el('p', { text: `${t('Starting weather')} · NOAA GFS · ${fmtUtc(state.initialWeather.modelRun, 0)}${state.weatherSource === 'cached' ? ` · ${t('Saved analysis')}` : ''}` }));
    } else if (state.weatherSource === 'base') {
      lines.push(el('p', { text: t('Live weather unavailable · using base climate') }));
    } else lines.push(el('p', { text: 'base climate' }));
    for (const load of state.historic) {
      const typhoon = typhoonById(load.typhoonId);
      if (!typhoon) continue;
      const ended = load.finished ? state.stormArchive.find(x => x.id === load.stormId)?.endedHour : undefined;
      const hours = (ended ?? state.hours) - load.startHour;
      lines.push(el('p', { text: `${typhoonName(typhoon)} (${typhoon.year}) · ${fmtUtc(typhoon.points[0].t, hours)} · ${load.environment === 'loaded' ? 'NCEP/NCAR R1 + ERSST v5' : 'base climate'}${load.finished ? ' · record ended' : ''}` }));
    }
    return lines;
  }
  function renderWorld(state: GameState): void {
    renderClimate(state);
    renderExperienceActive(state);
    const on = state.genesis.enabled;
    ref('genesisToggle').setAttribute('aria-checked', String(on));
    setText(ref('genesisState'), on ? 'On' : 'Off');
    const wave = ref('genesisWave');
    wave.hidden = !on;
    if (on) setText(wave, `Natural formation · wave ${state.genesis.waves} · next conditions in ${Math.max(0, (state.genesis.nextSpawnTick - state.tick) / TICKS_PER_HOUR).toFixed(0)} h`);
    ref('historicHud').hidden = true;
    const sources = root.querySelector('[data-help-weather]');
    if (sources && helpDialog.open) sources.replaceChildren(...weatherSourceLines(state));
    const totals = state.cities.reduce((sum, impact, i) => {
      const report = estimateCityDamage(CITIES[i], impact);
      sum.displaced += report.displaced; sum.missing += report.missing; sum.deaths += report.deaths;
      sum.flooded += report.floodedHomes; sum.loss += report.lossUsd;
      return sum;
    }, { displaced: 0, missing: 0, deaths: 0, flooded: 0, loss: 0 });
    totals.loss += state.traffic.lossUsd;
    const ended = state.stormArchive;
    const endedDisasters = (state.disasters ?? []).filter(record => record.endedHour !== undefined);
    const endedCount = ended.length + endedDisasters.length;
    const average = endedCount ? (ended.reduce((sum, s) => sum + s.endedHour - (s.history[0]?.hour ?? 0), 0)
      + endedDisasters.reduce((sum, record) => sum + record.endedHour! - record.startedHour, 0)) / endedCount : null;
    setText(ref('damageLoss'), `Estimated loss: ${fmtMoney(totals.loss)}`);
    const scope = ref('damagePanel');
    setMetric('damageDissipated', String(endedCount), scope);
    setMetric('damageTime', average === null ? '—' : `${average.toFixed(1)} h`, scope);
    setMetric('damageDisplaced', fmtInt(totals.displaced), scope);
    setMetric('damageMissing', fmtInt(totals.missing), scope);
    setMetric('damageDeaths', fmtInt(totals.deaths), scope);
    setMetric('damageFlooded', fmtInt(totals.flooded), scope);
    setMetric('damageLoss', fmtMoney(totals.loss), scope);
  }

  function newsRow(n: NewsItem): HTMLElement {
    const row = el('li', { class: `news news--${n.kind}${n.lon !== undefined ? ' news--place' : ''}` }, [
      el('div', { class: 'news__art' }, [newsArt(n)]),
      el('div', { class: 'news__body' }, [
        el('p', { class: 'news__meta', text: `${n.serial !== undefined ? fmtSerialDate(n.serial, getLanguage()) : fmtClock(n.hour + clockOffset(ui.latest!))} · ${kindLabel(n.kind)}` }),
        el('h3', { class: 'news__title', text: n.title }),
        el('p', { class: 'news__text', text: n.text }),
        n.transport && n.transport.lossUsd > 0 ? el('dl', { class: 'news__damage', testid: 'transport-damage' }, [
          ...[
            ['Peak wind here', `${n.transport.windMs.toFixed(0)} m/s`],
            ['Estimated loss', fmtMoney(n.transport.lossUsd)],
          ].map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })])),
        ]) : null,
        n.damage ? el('dl', { class: 'news__damage', testid: 'news-damage' }, [
          ...[
            ['Displaced people', `${fmtInt(n.damage.displaced)} people`],
            ['Missing (estimated)', `${fmtInt(n.damage.missing)} people`],
            ['Deaths (estimated)', `${fmtInt(n.damage.deaths)} people`],
            ['Damaged homes', `${fmtInt(n.damage.floodedHomes)} homes`],
            ['Estimated loss', fmtMoney(n.damage.lossUsd)],
          ].map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })])),
        ]) : null,
        n.damage ? el('p', { class: 'news__meta', text: 'Cumulative city estimate; replaces earlier figures.' }) : null,
      ]),
    ]);
    if (n.lon !== undefined && n.lat !== undefined) { // a climate-driven event or a recorded real event: a click shows the place
      const { lon, lat } = n;
      row.tabIndex = 0;
      row.title = t('Show the place on the map');
      row.addEventListener('click', () => renderer?.view.centerOn(lon, lat));
      row.addEventListener('keydown', ev => { if (ev.key === 'Enter') renderer?.view.centerOn(lon, lat); });
    }
    return row;
  }
  const kindLabel = (k: NewsItem['kind']): string => ({ formation: 'Formation', intensity: 'Intensity', landfall: 'Landfall', city: 'City', ended: 'Dissipated', merger: 'Merger', blizzard: 'Blizzard', tornado: 'Tornado', recovery: 'Recovery', info: 'Watch', transport: 'Transport', weather: 'Weather' })[k];

  function renderReplayPanel(): void {
    const n = ui.latest?.actions.length ?? 0;
    setText(ref('replayCount'), `${n} condition${n === 1 ? '' : 's'} placed so far (tick ${ui.latest?.tick ?? 0}).`);
  }

  function renderSidebar(): void {
    if (sidebar.hidden || !ui.state) return;
    if (ui.tab === 'storms') renderStorms();
    else if (ui.tab === 'environment') renderEnvironment();
    else if (ui.tab === 'measure') measurePanel.refresh();
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
    const toolItems = CONDITION_GROUPS.map(([first, second], i) => {
      const a = TOOL_BY_TYPE.get(first)!, b = TOOL_BY_TYPE.get(second)!;
      return `
      <li class="help-tool" style="--fx: var(--fx-${first})">
        <span class="help-tool__icon">${toolIconSvg(first, 'help-tool__svg')}</span>
        <span class="help-tool__text">
          <span class="help-tool__condition" data-help-condition="${first}"><strong>${a.name}</strong><span>${a.description}</span></span>
          <span class="help-tool__condition" data-help-condition="${second}"><strong>${b.name}</strong><span>${b.description}</span></span>
        </span>
        <kbd class="help-key">${TOOL_KEYS[i].toUpperCase()}</kbd>
      </li>`;
    }).join('');
    const measureMeaning: Record<string, string> = {
      'measure-sea-temperature': 'How warm the sea surface is. Typhoons need about 26.5 °C or more. Over land the line has gaps.',
      'measure-air-temperature': 'The air temperature near the surface. Useful for watching heat, cold, and the Warm air and Cold air conditions.',
      'measure-pressure': 'The sea-level pressure, storms included. A falling line means a low or a storm is coming.',
      'measure-wind': 'The surface wind speed, storms included. Useful to see a storm pass over a place.',
      'measure-humidity': 'Two plots: the humidity and the rainfall. Useful to see when a place turns wet or dry.',
      'measure-shear': 'The wind shear between 200 and 850 hPa. Strong shear tears storms apart; weak shear lets them grow.',
      'measure-formation': 'The typhoon formation score. A storm can start once the line passes the formation threshold. Over land it is 0.',
      'measure-thermocline': 'How deep the boundary between warm surface water and cold deep water lies, and how far that is from normal. It works only in the equatorial Pacific, 120°E to 80°W, and shows an ocean wave passing as the depth rises and falls.',
      'measure-nino34': 'How much warmer or colder than normal the central Pacific is. Above +0.5 counts as El Niño and below −0.5 as La Niña; both lines are drawn. It covers the whole Pacific, so drop it anywhere.',
      'measure-fine-dust': 'The fine dust (PM2.5) concentration at the pin, in µg/m³. Lines mark the air quality bands. It reads 0 where there is no fine dust, so the line stays continuous. It has no shortcut key.',
      'measure-soi-wwv': 'Two plots for the whole Pacific, so drop it anywhere: the Southern Oscillation Index (the pressure difference across the Pacific) and the warm water volume (the warm water stored in the upper ocean) as a change from normal.',
    };
    const measureItems = MEASURE_ITEMS.map(m => `
      <li class="help-tool" style="--fx: var(--color-accent)">
        <span class="help-tool__icon">${toolIconSvg(m.id, 'help-tool__svg')}</span>
        <span class="help-tool__text">
          <span class="help-tool__condition" data-help-measure="${m.id}"><strong>${m.name}</strong><span>${[...new Set(m.plots.map(pl => pl.unit))].join(' · ')}</span><span>${measureMeaning[m.id]}</span></span>
        </span>
        ${m.key ? `<kbd class="help-key">${m.key.toUpperCase()}</kbd>` : ''}
      </li>`).join('');
    const formationItems = FORMATION_TOOLS.map((f, i) => {
      const entry = DISASTER_HELP.find(d => d.kind === f.kind)!;
      return `
      <li class="help-tool" style="--fx: var(--color-accent)">
        <span class="help-tool__icon">${toolIconSvg(f.id, 'help-tool__svg')}</span>
        <span class="help-tool__text">
          <span class="help-tool__condition" data-help-formation="${f.id}"><strong>${f.name}</strong><span>${entry.conditions}</span><span>${entry.description}</span></span>
        </span>
        <kbd class="help-key">${FORMATION_KEYS[i].toUpperCase()}</kbd>
      </li>`;
    }).join('');
    const disasterItems = DISASTER_HELP.map(entry => {
      const icon = FORMATION_TOOLS.find(tool => tool.kind === entry.kind)?.icon ?? `<path d="${WEATHER_HAZARDS.downpour.iconPath}"/>`;
      return `<li class="help-disaster" data-help-disaster="${entry.kind}">
        <h3 class="help-disaster__title"><svg class="help-tool__svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${entry.name}</span></h3>
        <p class="help-disaster__conditions"><strong>Formation conditions</strong>: <span>${entry.conditions}</span></p>
        <p>${entry.description}</p>
      </li>`;
    }).join('');
    const panels: Record<string, string> = {
      basics: `
        <p>The world starts empty and keeps running at the selected speed. You cannot place a storm. You place weather conditions, and storms grow where they overlap.</p>
        <ol class="help__steps">
          <li>Drag <strong>Warm water</strong>, <strong>Moisture</strong> and <strong>Low pressure</strong> from the bottom palette onto the same tropical ocean spot.</li>
          <li>Wait. Overlapping conditions accumulate time, then a depression forms. Several separate spots can each make their own storm.</li>
          <li>Young depressions strengthen and their circulation grows. <strong>High pressure</strong> changes the flow around them and steers them.</li>
        </ol>
        <p>Open Formation for typhoons, blizzards, tornadoes, heatwaves, droughts, downpours, cold waves, hail, yellow dust, wind gusts and fine dust. Tap a map spot to prepare the conditions. The eight weather phenomena begin after six model hours.</p>
        <p>Open Typhoon experience or Climate experience in the palette to start a past typhoon or a climate scenario with one click, or drag its tile onto the map.</p>
        ${helpSub('clock', 'Time')}
        <p>Use the arrows to choose a speed. Real time runs the world at the speed of the clock. 10m/s is 10 minutes of world time per second, 30m/s is 30 minutes, 1h/s is 1 hour, 2h/s is 2 hours and 4h/s is 4 hours; 1d/s, 2d/s and 7d/s are 1, 2 and 7 days per second. Number keys 1–9 select the same nine steps, - and + step slower and faster, and the \` key (₩ on a Korean keyboard) resets the speed. Reset speed returns to 10m/s without changing the world or pause state.</p>
        <p>The +4h button in the speed bar jumps the world ahead by exactly 4 hours at once, as if time had run: storms move, damage and news update, and Measure adds one point at the new time. It works while paused (the world stays paused) and while playing. It is off during a replay, while a world is loading, and at 7d/s. Press Enter to skip when no tool is armed on the map and no button, field or dialog has focus.</p>
        <p class="fine">On a slow device the faster weather steps may not be fully reached, and the clock shows the time that was really simulated, so it can lag behind the speed you chose.</p>
        <p class="fine">At 7d/s the weather is not calculated. The world runs on the fast climate calculation instead: the map, the date and the seasons keep changing, but active storms and tools end without further damage. New storms can form again after you slow down. A world that started from live weather continues on the base climate from then on. See Long-term simulation in the Climate tab.</p>
        ${helpSub('globe', 'The map')}
        <ul class="help__list">
          <li>The map is a globe by default: drag to rotate it and use the wheel or pinch to zoom. Turn Globe view off in Map mode, at the top of the right panel, for the flat Equal Earth map.</li>
          <li>Open the right panel for the storm list, forming patches, news and replay files. Pan and zoom freely: the weather freezes while you move the camera and catches up when you let go.</li>
          <li>Toggle wind streaks, humidity colours, rainfall, pressure lines, a light sea-temperature tint and population independently.</li>
          <li>Humidity colours the wind streaks: higher humidity is brighter. Turn on Wind to see the colours.</li>
          <li>Choose a nickname in the Ranking tab to appear on the online leaderboard. Nicknames are public.</li>
        </ul>
        ${helpSub('keyboard', 'Without a mouse')}
        <p class="fine">Drag a condition button to place its large icon. Click or tap once to select, then again to switch to its opposite; keys Q–U do the same. Click or tap the map to place. A, S, D, F, G, H, J, K, L, ; and ' select the formation tools in order, and Z, X, C, V, B, N, M, comma, period and slash select the measurement tools. 1–9 set the speed steps, - and + step it slower and faster, and \` (₩ on a Korean keyboard) resets it to 10m/s. Arrow keys move an armed map target (Shift ×5, Alt ¼°), Enter places, Space plays or pauses, and Esc puts the tool away.</p>
        <p class="fine">Shortcuts work from anywhere on the page, except while you type in a field or a dialog is open; with a button or tab focused, Space and Enter press it instead of playing or pausing or skipping ahead.</p>`,
      conditions: `
        <p>The bottom palette has seven paired condition buttons. The large icon is the selected setting; the small faded icon shows the opposite. Click or tap once to select, then again to switch, or use Q–U. Drag the large icon onto the map.</p>
        <ul class="help__tools">${toolItems}</ul>
        <p>A condition from the palette lasts 10 days. Formation recipes and natural formation waves use shorter lives, so typhoons are as easy to make as before.</p>
        ${helpSub('cyclone', 'Making a storm')}
        <ul class="help__list">
          <li>Formation recipe: overlap Warm water, Moisture and Low pressure on the same tropical ocean spot, ideally with Low shear. High pressure does not start a storm; it steers one.</li>
          <li>Warm air and Updraft support formation and growth. They do not replace warm water, moisture or a low.</li>
          <li>Warm air, Moisture and Updraft can form thunderstorms over land or sea. Their gusts add city damage. Dry air, Cold air and Downdraft suppress them.</li>
        </ul>
        ${helpSub('cool', 'Weakening a storm')}
        <p>Weakening recipe: overlap Cool water, Dry air, Cold air, Downdraft and Strong shear on a storm or in its path. The more of them overlap, the faster it dissipates.</p>
        ${helpSub('merge', 'Mergers')}
        <p>Nearby storms in the same hemisphere affect each other’s movement: they can rotate around each other and draw closer. They merge within 100 km once both are at least 24 model hours old with winds of 17.2 m/s or more. The stronger storm keeps its ID and wind speed. Forming lows keep their own progress. Overlapping wind areas alone do not trigger a merger.</p>`,
      formation: `
        <p>The Formation tab of the palette holds ten probes, one for each event you can make. Instead of placing conditions one by one, a probe works out what a spot needs and places it for you.</p>
        <ol class="help__steps">
          <li>Drag a Formation icon onto the map. Or select one (click it or press its key) and click or tap a spot; with the keyboard, the arrow keys move the target and Enter opens it.</li>
          <li>A card opens for that spot. It shows the coordinates, the sea or land name, the sea temperature, air temperature, humidity, atmospheric instability, shear and pressure there, and a score compared with the level the event needs.</li>
          <li>Below that is the recipe: the conditions that would be placed, for example Warm water ×3. A note says whether it is enough. Place recipe puts them all on the spot at once, then the card closes and the probe stays armed for the next spot. Esc puts it away.</li>
        </ol>
        <p>Typhoon formation needs an ocean spot; the other nine events can be tried on land or sea. Place recipe is greyed out when a recipe cannot work, for example when the upper winds are too strong to calm, when too many conditions are already active, or when the recipe is already in place.</p>
        <ul class="help__tools">${formationItems}</ul>
        <p class="fine">${DISASTER_HELP_TIMING}</p>
        <p class="fine">Recipe conditions last 2 to 4 days, shorter than the 10 days of conditions from the Conditions tab, and they do not feed the climate model, so they never start an El Niño.</p>
        <p class="fine">Natural typhoon formation in the right panel works differently: nature itself places a wave of formation conditions over warm tropical ocean every two to three days. See the Climate tab.</p>`,
      measure: `
        <p>The Measure tab of the palette records how the world changes at a point, as a graph. It only reads the world: it never changes the simulation and is not saved in replays.</p>
        <ol class="help__steps">
          <li>Drag a Measure icon onto the map. Or select one (click it or press its key) and click or tap the map.</li>
          <li>A numbered pin appears at that spot, and a card with a graph appears in the Measure tab of the right panel. On a phone the panel stays closed so you can keep placing pins; open its Measure tab to see the graphs.</li>
          <li>Drop the same icon at another place to add a line to that chart, with its own pin colour and number. A different icon gets its own chart.</li>
        </ol>
        ${helpSub('graphs', 'Reading a graph')}
        <ul class="help__list">
          <li>The horizontal axis is model time, starting at 0 when measuring began, with five labels in hours, days, months or years. Move the pointer over a graph to read its values at that time.</li>
          <li>Each card shows its unit and the latest value of every pin. The × button removes the card, and Delete all removes every card and pin. A pin disappears when no chart uses it.</li>
          <li>You can use up to 12 pins. Drops within a quarter of a degree of each other share one pin.</li>
          <li>Recording runs only while time is playing. A new world or a loaded replay clears everything. Very long runs are thinned automatically so the graph stays readable.</li>
        </ul>
        ${helpSub('bars', 'The ten items')}
        <ul class="help__tools">${measureItems}</ul>`,
      disasters: `
        <p>${DISASTER_HELP_INTRO}</p>
        <p class="fine">${DISASTER_HELP_TIMING}</p>
        <ul class="help-disasters">${disasterItems}</ul>`,
      climate: `
        ${helpSub('genesis', 'Natural formation')}
        <p>Turn on Natural typhoon formation in the right panel and nature starts storms for you: a wave of formation conditions appears over warm tropical ocean somewhere in the world every two to three days. Use Cool water, Dry air, Cold air and Downdraft to weaken them before a depression forms, or let them grow. Turn it off to stop new waves.</p>
        ${helpSub('enso', 'The El Niño / La Niña layer')}
        <p>An El Niño / La Niña climate layer runs under the weather. The ocean waves, the sea temperature and the winds of the tropical Pacific are calculated. The effects far from there, over land, in the other tropical oceans and at higher latitudes, and the wind shear everywhere, come from observed statistics: maps of how past El Niño and La Niña years changed the world. Together they change the sea temperature, air temperature, pressure, wind, humidity and wind shear, and so the typhoons.</p>
        ${helpSub('wind', 'Conditions and the climate')}
        <p>Conditions you place within 30° of the equator also feed the climate layer. Warm water and Cool water change the sea temperature. Low pressure, Updraft, Warm air and Unstable air heat the air above them; High pressure, Downdraft, Cold air and Stable air cool it. Moisture, Dry air and the shear conditions do not feed it, and neither do formation recipes.</p>
        <ul class="help__list">
          <li>Low pressure or an updraft near the equator pulls in westerly wind on its west side and starts an ocean wave.</li>
          <li>High pressure in the east Pacific with low pressure in the west strengthens the trade winds.</li>
          <li>One condition stays local. Stacking many spreads the effect across the Pacific, and stacked warm water makes the biggest El Niño.</li>
          <li>The ocean answers over weeks, so the Measure tab is the best way to watch it.</li>
        </ul>
        ${helpSub('globe', 'World climate')}
        <p>The Warming, La Niña / El Niño and Polar temperature sliders in the right panel change the whole planet: Warming raises sea and air temperature, La Niña / El Niño holds the Pacific in one phase, and Polar temperature warms or cools the high latitudes. Low shear calms the upper winds around a storm so it can stay upright; Strong shear adds upper-level wind that tilts and tears it apart.</p>
        <dl class="help__defs">
          <dt>${withIcon('warming', 'Warming')}</dt>
          <dd>Warming runs from −2 to +4 °C. More warming makes more of the ocean warm enough to feed storms. A negative value cools the world.</dd>
          <dt>${withIcon('enso', 'La Niña / El Niño')}</dt>
          <dd>An experiment that holds Niño 3.4, the Pacific temperature index that defines El Niño and La Niña, at the value you choose, from −2 to +2 °C. The map responds at once, even when paused. El Niño warms the central and eastern Pacific and moves the typhoon formation area east; La Niña does the reverse. Setting it back to 0 releases the hold and the ocean then evolves by itself.</dd>
          <dt>${withIcon('winter', 'Polar temperature')}</dt>
          <dd>Polar cooling chills the sea and air poleward of about 35° latitude, so storms that curve out of the tropics weaken sooner. Polar warming does the reverse. The effect is full strength from about 50°.</dd>
        </dl>
        <p>The three sliders move the whole climate at once. There is no one-click slider reset: drag each back to 0, or press Restart in the speed bar to start the world over as a page reload would (it asks first, and the current world, its disasters and measurements are lost).</p>
        <p>The Reset button at the top of the World tab takes every condition off the map: placed, recipe and natural-formation conditions. The Reset button of the Disasters tab ends every active storm, hazard, thunderstorm, tornado and blizzard, including fine dust. Both keep the damage already done, the records, the score and the date, and neither works during a replay.</p>
        ${helpSub('calendar', 'Scenarios')}
        <p>The Climate experience tab of the palette loads a historic El Niño or La Niña: press a tile, or drag it onto the map. The world jumps to 1 January of that year, storms, weather hazards and tools already running carry on as they are, and the Pacific starts in the ocean state of the time, with the winds that drove the event added by date. The speed is set to 4h/s so that the weather runs, and Natural typhoon formation is on while the scenario is loaded. Watch it on the map and in the Measure tab. You can change the speed afterwards: at 7d/s the weather is not calculated, so storms and the events below do not form, but the record of real events still appears.</p>
        <p>While a scenario is loaded the model starts weather disasters by itself where its own climate calls for them. During an El Niño these are heavy rain on coastal Peru and Ecuador, in East Africa and in the southern United States, and drought or heat in Indonesia, Australia, India and southern Africa. A La Niña brings the opposite pattern: heavy rain in eastern Australia, Indonesia, South Asia and Colombia, and drought in the Horn of Africa and the southwestern United States. Each event follows the sea temperature, air temperature or humidity of its place, so it stops when the anomaly does. The News tab marks it as El Niño or La Niña, and its damage is counted like any other disaster. A place rests for several weeks after an event, and at most four run at once.</p>
        <p>The News tab also posts real events of the period on their dates, marked as a historical record. They are not model results, cause no damage here and appear at every speed. Click such an item to see its place on the map.</p>
        <p>The Niño 3.4 chart draws the real monthly values of the same months as a dashed line labelled Observed, so you can compare. The slider and your conditions still work on a running scenario, and the model goes on by itself once the script ends.</p>
        <p>Press the tile of the loaded scenario again to switch it off: the world returns to the normal climate at once, and storms that already formed keep running. Changing the season ends a scenario too.</p>
        <p class="fine">This is a simplified model that reproduces the causes of the event, not the exact event. Dates and strengths of the winds are approximate, and the years after the script will not match history.</p>
        ${helpSub('hourglass', 'Long-term simulation')}
        <p>Choose 7d/s to watch the climate over years. At this speed one year takes about 52 seconds. The map, the date with its year, and the seasons keep changing. Individual storms are not simulated: active storms and tools end without further damage, and new storms can form again once you slow down to 2d/s or below.</p>
        <p>At this speed El Niño and La Niña come and go on their own, in a cycle of roughly 2 to 3 years in this model. The real cycle is longer, and big El Niño events happen about twice as often here as in reality.</p>
        <p>To experiment, set up conditions or the La Niña / El Niño slider, then go fast and watch with Measure pins: Niño 3.4, SOI, warm water volume, or the sea temperature at points you choose. Then slow down to see typhoons form on the changed climate.</p>
        <p class="fine">One run allows 200 years of fast time, and a world that started from live weather continues on the base climate from then on. The Warming and Polar temperature sliders are fixed offsets for now, and greenhouse gases, sea ice and volcanoes are not simulated yet.</p>
        ${helpSub('alert', 'Limits')}
        <p class="fine">This is a simplified teaching model, not a forecast.</p>
        <p class="fine">Replays saved by an older version cannot be opened if they used the La Niña / El Niño slider, a Warm water, Cool water, Low pressure, High pressure, Updraft, Downdraft, Warm air, Cold air, Unstable air or Stable air condition within 30° of the equator, or a live-weather start. The new climate layer would not reproduce them.</p>`,
      historic: `
        <dl class="help__defs">
          <dt>Loading</dt>
          <dd>Open the Typhoon experience tab of the palette and press a tile, or drag it onto the map, to bring a recorded typhoon into the world (best tracks from JMA RSMC Tokyo, NOAA NHC HURDAT2 and NOAA IBTrACS: 6-hourly positions, pressure and wind).</dd>
          <dt>Recorded path</dt>
          <dd>Its path follows the record. You can load several. Show recorded paths draws each full path as a dashed line.</dd>
          <dt>Environment data</dt>
          <dd>The sea temperature, air, humidity, pressure and wind follow NCEP/NCAR Reanalysis 1 and ERSST v5 for those dates; damage and news are simulated. Storms outside the western Pacific have no environment record and use the base climate.</dd>
          <dt>Your conditions</dt>
          <dd>Conditions you place change its strength and can also bend its path: a High or Low beside it pushes it off the record, and it stays off after the condition ends. The dashed line keeps the real path for comparison.</dd>
        </dl>`,
      data: `
        ${helpSub('rain', 'Current weather data')}
        <div data-help-weather data-testid="help-weather-data"></div>
        ${helpSub('info', 'About the data')}
        <p>Coastlines and city positions are real (Natural Earth). Weather, population and damage numbers are simulated.</p>
        ${helpSub('archive', 'Sources')}
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
        ${helpSub('heart', 'Acknowledgements')}
        <p>Japan Meteorological Agency (JMA) best-track data. TypoStudio edited and processed this data for the game; JMA did not create the edited version.</p>
        <p>NCEP Reanalysis data provided by the NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov.</p>
        <p>NOAA IBTrACS: Knapp, K. R. et al., 2010, doi:10.1175/2009BAMS2755.1.</p>
        ${helpSub('file', 'License')}
        <p>This game is licensed under CC BY-NC-SA 4.0: free to use and modify, no commercial use, and modified versions must be shared under the same license with credit to TypoStudio.</p>
        <p>Open-source libraries keep their own licenses. Data sources keep their own terms, listed under Sources above.</p>
        <p><a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener license">CC BY-NC-SA 4.0</a> <span aria-hidden="true">·</span> <a href="/third-party-licenses.txt" target="_blank" rel="noopener">Third-party licenses</a></p>
        ${helpSub('coin', 'Damage estimates')}
        <p>Damage figures are fictional story estimates, not hydrology or insurance models. Their rates are gameplay constants fitted to public records of Typhoon Maemi (2003) and cross-checked with Rusa (2002), Hinnamnor (2022) and Haiyan (2013), so they land at the right order of magnitude. Counts are city totals at the time of the report.</p>
        ${helpSub('trophy', 'Online leaderboard and privacy')}
        <p>When a disaster ends, its estimated loss and duration are added to the online leaderboard under this device's anonymous ID. Typhoon grades are included for typhoons. Your public nickname can be changed in Ranking.</p>
        <p>You can delete your nickname and all your uploaded results yourself: open the Ranking tab and press Delete my records. It takes effect immediately. If you no longer have the device, email us at the address in the privacy policy.</p>
        ${footerHtml()}`,
    };
    for (const p of helpPanels) p.innerHTML = panels[p.dataset.helpPanel!] ?? '';
    const sources = root.querySelector('[data-help-weather]');
    if (sources && ui.state) sources.replaceChildren(...weatherSourceLines(ui.state));
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

  // iPhone Safari cannot be forced to full screen; once, point to Hide Toolbar and Add to Home Screen.
  const IPHONE_HINT_KEY = 'typhoon-lab-iphone-hint-seen';
  const inBrowserTab = (navigator as Navigator & { standalone?: boolean }).standalone !== true
    && !matchMedia('(display-mode: standalone)').matches && !matchMedia('(display-mode: fullscreen)').matches;
  if (/iPhone|iPod/.test(navigator.userAgent) && inBrowserTab) {
    let hintSeen = true;
    try { hintSeen = localStorage.getItem(IPHONE_HINT_KEY) !== null; } catch { /* storage is optional */ }
    if (!hintSeen) {
      const showHint = (): void => {
        try { localStorage.setItem(IPHONE_HINT_KEY, '1'); } catch { /* storage is optional */ }
        toast('More room for the map: tap aA in the address bar and choose Hide Toolbar. For full screen, use Share → Add to Home Screen.', 'info', 12000);
      };
      let shown = false;
      stateListeners.push(() => {
        if (shown) return;
        shown = true;
        showHint();
      });
    }
  }

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
    ui.expectTrafficSig = JSON.stringify(r.trafficDispatches ?? []);
    // The worker keeps its previous play state if it rejects the replay, so only pause once it accepts.
    arm('replay', r.untilTick);
    setReplayMessage('Re-running the replay on the simulation…', 'info');
    post({ type: 'replay', seed: r.seed, actions: r.actions, untilTick: r.untilTick, startDayOfYear: r.startDayOfYear, trafficDispatches: r.trafficDispatches, initialWeather: r.initialWeather });
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
  function arm(kind: Expect, untilTick = 0): void {
    ui.expect = kind;
    syncClimateDisabled();
    window.clearTimeout(expectTimer);
    const limits = kind === 'replay' ? replayWait(untilTick) : RESET_WAIT;
    const startedAt = performance.now();
    expectLastProgress = startedAt;
    const check = (): void => {
      if (ui.expect !== kind || kind === 'normal') return;
      const now = performance.now();
      const verdict = waitVerdict(now, startedAt, expectLastProgress, limits);
      if (verdict === 'wait') { expectTimer = window.setTimeout(check, 1000); return; }
      ui.expect = 'normal';
      syncClimateDisabled();
      const text = verdict === 'stalled' ? 'The simulation did not answer in time.' : 'The simulation took too long.';
      toast(`${text} Try again.`, 'error');
      if (kind === 'replay') setReplayMessage(text, 'error');
    };
    expectTimer = window.setTimeout(check, 1000);
  }

  /** Gate a worker state; returns false for stale states that predate a pending reset or replay. */
  function accept(state: GameState): boolean {
    if (ui.expect === 'reset') {
      if (state.seed !== ui.expectSeed) return false;
      if (!(state.actions.length === 0 && (state.tick < ui.expectBaseTick || ui.expectBaseTick <= 8))) return false;
      window.clearTimeout(expectTimer);
      ui.expect = 'normal';
      ui.pendingEvent = 'reset';
      probes.clear();
    } else if (ui.expect === 'replay') {
      if (state.tick !== ui.expectUntil || state.seed !== ui.expectSeed || actionsSig(state.actions) !== ui.expectSig
        || JSON.stringify(state.traffic.dispatches) !== ui.expectTrafficSig) return false;
      window.clearTimeout(expectTimer);
      ui.expect = 'normal';
      ui.pendingEvent = 'replay';
      probes.clear();
      ui.playing = false;
      setReplayMessage(`Replay loaded. The world is restored to tick ${state.tick}, paused. Press Play to continue from here.`, 'ok');
      toast('Replay loaded and paused.', 'ok', 3500);
    }
    ui.latest = state;
    for (const listener of stateListeners) listener(state);
    return true;
  }

  /** The worker registers a historic typhoon's reanalysis for itself; Measure reads on this thread, so it loads the same file here and skips samples until it is in. */
  const historicRequested = new Set<string>();
  function ensureHistoricEnvironment(state: GameState): void {
    for (const load of state.historic) {
      if (load.finished || load.environment !== 'loaded' || historicRequested.has(load.typhoonId)) continue;
      historicRequested.add(load.typhoonId);
      void loadEnvironment(load.typhoonId).then(env => { if (env) setHistoricEnvironment(load.typhoonId, env); else historicRequested.delete(load.typhoonId); });
    }
  }
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    if (msg.type === 'state' || msg.type === 'interaction') {
      if (!accept(msg.state)) return;
      // Probes read the newest state as it arrives, even while a gesture holds back the drawn one; paused time adds no samples.
      ensureHistoricEnvironment(msg.state);
      if (ui.scenarioProbes) applyScenarioProbes(msg.state);
      if (msg.type === 'state' && msg.skipped) ui.skipping = false;
      // A skip adds one sample at the new time even while paused; the jump is not filled in.
      if (probes.size && (ui.playing || (msg.type === 'state' && msg.skipped)) && historicEnvironmentReady(msg.state)) probes.sample(msg.state);
      measurePanel.refresh();
      ui.clockHours = msg.clockHours;
      ui.pending = msg.state;
      renderClock();
      // Settle an in-flight tick at gesture start; releasing never catches up a hidden backlog.
      if (msg.type === 'interaction' && msg.active && renderer?.isInteracting) applyPending();
      if (document.hidden && !renderer?.isInteracting) applyPending();
    } else if (msg.type === 'progress') {
      ui.clockHours = msg.clockHours;
      renderClockText();
    } else if (msg.type === 'replay-progress') {
      if (ui.expect === 'replay' && msg.untilTick === ui.expectUntil) {
        expectLastProgress = performance.now();
        toast(`Loading replay… ${Math.min(99, Math.floor(100 * msg.tick / Math.max(1, msg.untilTick)))}%`, 'info', 4000);
      }
    } else if (msg.type === 'placement') {
      ui.placementQueue.shift()?.(msg.result);
    } else if (msg.type === 'speed') {
      if (isTimeSpeed(msg.speed)) { ui.speed = msg.speed; renderClock(); }
    } else if (msg.type === 'error') {
      const wasReplay = ui.expect === 'replay';
      ui.skipping = false;
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
    trafficFocusKey = '';
    closeTrafficPopup();
    ui.tool = null;
    closeSpot();
    renderTools();
    ui.newsKey = '';
    ui.newsLastId = null;
    ui.selectedStormId = null;
    ui.selectedDisasterId = null;
    ui.cursor = null;
    for (const li of stormRows.values()) li.remove();
    stormRows.clear();
    for (const li of disasterRows.values()) li.remove();
    disasterRows.clear();
    rankedKeys.clear();
    rankedDisasters.clear();
    ui.playing = event !== 'replay';
  }

  /** Writes newly ended storms of this world to the ranking store; active storms are display-only. */
  function recordRankings(state: GameState): void {
    const ended = state.stormArchive.filter(record => !rankedKeys.has(record.id));
    const endedDisasters = (state.disasters ?? []).filter(record => record.endedHour !== undefined && !rankedDisasters.has(record.id));
    const fresh = [...ended.map(record => entryFromStorm(state.seed, record, state.hours, state.actions, undefined, state.traffic.dispatches)),
      ...endedDisasters.map(record => entryFromDisaster(state.seed, record, state.hours, state.actions, undefined, state.traffic.dispatches))];
    if (!fresh.length) return;
    for (const record of ended) {
      const result = resultFromRecord(state.seed, record);
      if (result) void submitResult(result);
    }
    for (const record of endedDisasters) {
      const result = resultFromDisaster(state.seed, record);
      if (result) void submitResult(result);
    }
    // Re-read first so another tab's entries are kept (last writer wins only for the same key).
    rankings = fresh.reduce(upsert, rankingStore.load());
    for (const entry of fresh) {
      if (entry.disasterId) rankedDisasters.set(entry.disasterId, entry.key);
      else rankedKeys.set(entry.stormId, entry.key);
    }
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
    if (ui.selectedDisasterId !== null && !findDisaster(ui.selectedDisasterId)) ui.selectedDisasterId = null;

    renderer?.setState(state);
    stage.dataset.renderedTick = String(state.tick);
    app.dataset.ready = 'true';
    if (renderer && veil.dataset.state !== 'error') veil.hidden = true;
    setText(ref('stormCount'), String(state.storms.length + (state.disasters ?? []).filter(record => record.endedHour === undefined).length));
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
    labelExperience();
    // Money strings are formatted per language, so rebuild everything that shows them.
    ui.newsKey = '';
    if (ui.state) renderWorld(ui.state);
    renderSidebar();
    renderTools();
    measurePanel.relocalize();
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
    onDragStart: tool => { ui.drag = { tool: draggedVariant(tool), point: null }; closeSpot(); refreshOverlay(); },
    onDragMove: (_tool, point) => { if (ui.drag) { ui.drag.point = point; refreshOverlay(); } },
    onDrop: (tool, point) => {
      const variant = ui.drag?.tool ?? draggedVariant(tool);
      ui.drag = null;
      refreshOverlay();
      if (point && isFormation(variant)) { ui.tool = variant; renderTools(); openSpot(point.lon, point.lat); }
      else if (point && isMeasure(variant)) addProbe(variant, point.lon, point.lat);
      else if (point) placeAt(variant as ToolType, point.lon, point.lat);
      else toast('Dropped outside the map. Drag the icon onto the map to place it.', 'error', 3500);
    },
    onCancel: () => { ui.drag = null; refreshOverlay(); },
  });
  for (const [type, b] of toolButtons) b.addEventListener('click', () => armPaletteTool(type));
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
    if (focus || id !== undefined) paletteTabButtons.find(b => b.dataset.paletteTab === id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncPager();
    try { localStorage.setItem(PALETTE_TAB_KEY, id); } catch { /* storage is optional */ }
  }
  for (const b of paletteTabButtons) b.addEventListener('click', () => setPaletteTab(b.dataset.paletteTab!));
  // Previous / next page buttons for whichever row overflows. They are plain buttons outside the tool maps, so they never arm or drag anything.
  const pager = ref('palettePager');
  const pageButtons = [...pager.querySelectorAll<HTMLButtonElement>('[data-page]')];
  const visibleRow = () => palettePanels.find(p => !p.hidden)!;
  function syncPager(): void {
    const row = visibleRow();
    if (!row) return;
    const over = row.scrollWidth > row.clientWidth + 1;
    pager.hidden = !over;
    const [prev, next] = pageButtons;
    prev.disabled = row.scrollLeft <= 1;
    next.disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
  }
  /** One page = the tiles that fit; the new first tile is always whole (never cut at the left edge). */
  function pageRow(dir: 1 | -1): void {
    const row = visibleRow();
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    const room = row.clientWidth - 2 * pad;
    const base = row.getBoundingClientRect().left;
    const tiles = [...row.children].map(c => { const r = c.getBoundingClientRect(); return { left: r.left - base + row.scrollLeft - pad, width: r.width }; });
    let target = row.scrollLeft;
    if (dir > 0) target = tiles.find(x => x.left + x.width > row.scrollLeft + room + 1)?.left ?? row.scrollWidth;
    else target = tiles.find(x => x.left >= row.scrollLeft - room - 1)?.left ?? 0;
    row.scrollTo({ left: Math.max(0, target), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  for (const b of pageButtons) b.addEventListener('click', () => pageRow(Number(b.dataset.page) > 0 ? 1 : -1));
  const pagerResize = new ResizeObserver(syncPager);
  for (const p of palettePanels) { p.addEventListener('scroll', syncPager, { passive: true }); pagerResize.observe(p); }
  rovingKeys(ref('paletteTabs'), b => setPaletteTab(b.dataset.paletteTab!, true));
  setPaletteTab(storedPaletteTab());

  // ---- experience tabs ---------------------------------------------------------------------
  /** English source of each tab's short phone label (translated into data-short), so a language change can translate it again. */
  const shortTabSource = new Map(PALETTE_TABS.flatMap(tab => tab.short ? [[tab.id, tab.short] as const] : []));
  const experienceRows = [ref('experienceTyphoons'), ref('experienceClimate')];
  for (const item of EXPERIENCE_ITEMS) {
    const scenario = item.kind === 'scenario';
    const b = el('button', { type: 'button', class: `tool tool--experience${scenario ? ' tool--wide' : ''}`, 'data-experience': item.key, 'data-testid': `experience-${item.key.replace(':', '-')}`, 'aria-pressed': 'false' }) as HTMLButtonElement;
    b.innerHTML = scenario
      ? `${SCENARIO_ICON[item.id]}<span class="tool__text"><span class="tool__name"></span><span class="tool__desc"></span></span>`
      : `${TYPHOON_ICON}<span class="tool__name"></span><span class="tool__sub"></span>`;
    experienceButtons.set(item.key, b);
    experienceRows[scenario ? 1 : 0].append(b);
  }
  /** Names, labels and tooltips come from data, so they are set here and again when the language changes. */
  function labelExperience(): void {
    for (const b of paletteTabButtons) if (b.dataset.short) b.dataset.short = t(shortTabSource.get(b.dataset.paletteTab!)!);
    for (const item of EXPERIENCE_ITEMS) {
      const b = experienceButtons.get(item.key)!;
      let name: string, tip: string, sub = '';
      if (item.kind === 'scenario') {
        const scenario = climateScenarioById(item.id as ClimateScenarioId);
        name = t(scenario.name); tip = scenario.description;
        b.querySelector('.tool__desc')!.textContent = t(scenario.description);
      } else {
        const typhoon = typhoonById(item.id)!;
        name = typhoonName(typhoon); sub = String(typhoon.year); tip = typhoonTipSource(typhoon);
        b.querySelector('.tool__sub')!.textContent = sub;
      }
      b.querySelector('.tool__name')!.textContent = name;
      b.setAttribute('aria-label', `${name}${sub ? ` (${sub})` : ''}: ${t('click to load, or drag onto the map')}`);
      b.dataset.tipTitle = sub ? `${name} (${sub})` : name;
      b.dataset.tip = tip;
    }
  }
  for (const row of experienceRows) {
    const tiles = () => [...row.querySelectorAll<HTMLButtonElement>('[data-experience]')];
    /** Only one tile per row is a Tab stop; the arrow keys, Home and End move through the rest. */
    const setStop = (stop: HTMLElement) => { for (const b of tiles()) b.tabIndex = b === stop ? 0 : -1; };
    setStop(tiles()[0]);
    row.addEventListener('focusin', ev => { if (ev.target instanceof HTMLButtonElement && ev.target.dataset.experience) setStop(ev.target); });
    row.addEventListener('keydown', ev => {
      const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      const all = tiles();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0 || !(step || ev.key === 'Home' || ev.key === 'End')) return;
      ev.preventDefault();
      ev.stopPropagation();
      all[ev.key === 'Home' ? 0 : ev.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + step))].focus();
    });
    // A mouse wheel scrolls the row sideways, and fades mark the side that has more.
    const syncEdges = () => {
      row.dataset.moreStart = String(row.scrollLeft > 1);
      row.dataset.moreEnd = String(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    row.addEventListener('scroll', syncEdges, { passive: true });
    row.addEventListener('wheel', ev => {
      if (!ev.deltaY || Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.ctrlKey) return;
      const max = row.scrollWidth - row.clientWidth;
      if ((ev.deltaY < 0 && row.scrollLeft <= 0) || (ev.deltaY > 0 && row.scrollLeft >= max)) return;
      ev.preventDefault();
      row.scrollLeft += ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? row.clientWidth : 1); // lines are about 16 px, a page is the row's width
    }, { passive: false });
    new ResizeObserver(syncEdges).observe(row);
  }
  /** Loads the tile's scenario or typhoon. Armed tools stay as they are. */
  function startExperience(key: string, dropped = false): void {
    const item = EXPERIENCE_ITEMS.find(i => i.key === key);
    if (!item) return;
    if (item.kind === 'scenario') {
      if (ui.expect === 'replay') { toast('A replay is playing. Climate scenarios cannot be loaded or switched off until it ends.', 'error', 3500); return; }
      if (ui.scenarioPending) return;
      // A click on the loaded tile switches it off; a drop only ever loads.
      if (!dropped && ui.latest?.climateScenario?.id === item.id) switchScenarioOff(item.id as ClimateScenarioId); else loadScenario(item.id as ClimateScenarioId);
    }
    else loadTyphoon(item.id);
  }
  let experienceSig = '';
  function renderExperienceActive(state: GameState): void {
    const live = activeExperienceKeys(state);
    const sig = [...live].join(',');
    if (sig === experienceSig) return;
    experienceSig = sig;
    for (const [key, b] of experienceButtons) {
      const on = live.has(key);
      b.classList.toggle('is-live', on);
      if (key.startsWith('scenario:')) b.setAttribute('aria-pressed', String(on));
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }
  for (const [key, b] of experienceButtons) b.addEventListener('click', () => startExperience(key));
  labelExperience();
  syncClimateDisabled();
  attachPalette(experienceButtons, {
    mapPoint: (cx, cy) => {
      const r = renderer;
      if (!r || document.elementFromPoint(cx, cy) !== r.overlayCanvas) return null;
      const box = r.overlayCanvas.getBoundingClientRect();
      const at = r.view.pxToLonLat(cx - box.left, cy - box.top);
      return at ? { lon: at[0], lat: at[1] } : null;
    },
    onDragStart: () => {},
    onDragMove: () => {},
    onDrop: (key, point) => {
      if (point) startExperience(key, true);
      else toast('Dropped outside the map. Drag the icon onto the map to place it.', 'error', 3500);
    },
    onCancel: () => {},
  });

  // ---- measure tab -------------------------------------------------------------------------
  const pinCycle = new Map<string, number>();
  let flashTimer = 0;
  /** A ring (or the Niño 3.4 outline) that marks the place for a moment; a DOM overlay, so the renderer is untouched. */
  function flashAt(lon: number, lat: number, box?: [number, number, number, number]): void {
    const view = renderer?.view;
    if (!view) return;
    stageWrap.querySelector('.locate-flash')?.remove();
    window.clearTimeout(flashTimer);
    const mark = el('div', { class: 'locate-flash', 'aria-hidden': 'true' });
    const at = view.lonLatToPx(lon, lat);
    if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return;
    const [x, y] = at;
    const left = stage.offsetLeft, top = stage.offsetTop;
    if (box) {
      const a = view.lonLatToPx(box[0], box[1]), b = view.lonLatToPx(box[2], box[3]);
      if (!a || !b || ![...a, ...b].every(Number.isFinite)) return;
      const [x0, y0] = a, [x1, y1] = b;
      mark.classList.add('locate-flash--box');
      Object.assign(mark.style, { left: `${left + Math.min(x0, x1)}px`, top: `${top + Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    } else Object.assign(mark.style, { left: `${left + x}px`, top: `${top + y}px` });
    stageWrap.append(mark);
    flashTimer = window.setTimeout(() => mark.remove(), 1600);
  }
  /** Centres the map on a chart: its pin (the next one on each repeat, or the given pin), or the ocean box of a basin chart. Phones: the sidebar closes so the map shows. */
  function locateMeasure(id: string, pin: number | null): void {
    const view = renderer?.view;
    if (!view) return;
    const basin = BASIN_SPOTS[id];
    let spot: { lon: number; lat: number; box?: [number, number, number, number] } | undefined = basin;
    if (!spot) {
      const ns = [...(probes.charts.get(id) ?? [])].sort((a, b) => a - b);
      if (!ns.length) return;
      const n = pin ?? ns[(pinCycle.get(id) ?? -1) + 1 >= ns.length ? 0 : (pinCycle.get(id) ?? -1) + 1];
      pinCycle.set(id, Math.max(0, ns.indexOf(n)));
      const found = probes.pins.find(p => p.n === n);
      if (!found) return;
      spot = { lon: found.lon, lat: found.lat };
    }
    view.centerOn(spot.lon, spot.lat);
    if (!sidebarBesideMap.matches && !sidebar.hidden) setSidebar(false);
    requestAnimationFrame(() => flashAt(spot!.lon, spot!.lat, spot!.box));
  }
  const measurePanel = createMeasurePanel({
    onLocate: locateMeasure,
    cards: ref('measureCards'),
    hint: ref('measureHint'),
    clear: ref<HTMLButtonElement>('measureClear'),
    book: probes,
    visible: () => !sidebar.hidden && ui.tab === 'measure' && !document.hidden,
    hasLayer: () => !!ui.latest?.climateLayer,
    onRemove: id => {
      probes.remove(id);
      announce(`${MEASURE_BY_ID.get(id)!.name} removed.`);
      refreshOverlay();
      measurePanel.refresh();
    },
    onClear: () => {
      probes.clear();
      announce('All measurements cleared.');
      refreshOverlay();
      measurePanel.refresh();
    },
  });
  document.addEventListener('visibilitychange', measurePanel.refresh);

  /** Opens the sidebar on the Measure tab, at the card of `id` when given. */
  function openMeasureAt(id: string | null): void {
    setSidebar(true);
    if (ui.tab !== 'measure') activateTab('measure'); else measurePanel.refresh();
    if (!id) return;
    // The cards are built on the next frame once the tab is visible.
    requestAnimationFrame(() => requestAnimationFrame(() => ref('measureCards').querySelector(`[data-item="${id}"]`)?.scrollIntoView({ block: 'start' })));
  }

  // Graphs on the map itself, beside the measured pins that are on screen.
  const onMapHost = el('div', { class: 'onmap-graphs', 'data-testid': 'onmap-graphs', hidden: true });
  stage.append(onMapHost);
  const OBSTACLES = '.brandbar, .clockbar, .zoom, .sidebar-toggle, .palette, .notes > *, .legend-chip, [data-testid="coords"], [data-testid="legend"], .damage-hud, .historic-hud, .tutorial';
  measureOnMap = createMeasureOnMap({
    host: onMapHost,
    book: probes,
    view: () => renderer?.view ?? null,
    enabled: () => ui.graphsOnMap && (sidebarBesideMap.matches || sidebar.hidden),
    obstacles: () => [...root.querySelectorAll<HTMLElement>(OBSTACLES)].filter(n => !n.hidden && getComputedStyle(n).visibility !== 'hidden').map(n => n.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0),
    mapObstacles: () => {
      const seen = renderer && 'overlayObstacles' in renderer ? renderer.overlayObstacles() : null;
      return seen ? { hard: [...seen.hard, ...onMapExtraBoxes], soft: seen.soft } : null;
    },
    mapRev: () => (renderer && 'overlayRev' in renderer ? renderer.overlayRev : 0),
    onLocate: locateMeasure,
    onOpen: openMeasureAt,
  });
  /** Test hook: extra boxes the on-map cards must avoid, to force the crowded case. */
  let onMapExtraBoxes: [number, number, number, number][] = [];
  const onMapFree = new ResizeObserver(() => measureOnMap?.invalidate());
  for (const node of root.querySelectorAll('.notes, .palette, .map-status, .clockbar, .brandbar, .legend')) onMapFree.observe(node);

  /** Drops a measurement: puts the pin on the map, records the first value now and shows the graphs. */
  function addProbe(id: MeasureId, lon: number, lat: number): void {
    const state = ui.latest;
    if (!state) return;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) { toast('Choose a position on the map (latitude within ±90°).', 'error'); return; }
    const added = probes.add(id, lon, lat);
    const name = added.item.name;
    if (!added.ok) {
      if (added.reason === 'strip') toast('The thermocline exists only in the equatorial Pacific, 120°E to 80°W. Drop it inside that strip.', 'error');
      else if (added.reason === 'pins') toast('Twelve pins are in use. Remove a chart or clear all to measure somewhere new.', 'error');
      else toast(added.item.basin ? `${name} is already graphed.` : `${name} is already measured at this pin.`, 'info', 3500);
      if (added.reason === 'duplicate') showMeasureTab();
      return;
    }
    if (historicEnvironmentReady(state)) probes.sample(state);
    const phone = !sidebarBesideMap.matches; // a full-screen sidebar would block placing the next pin: the map stays, the toast says where the graph is
    toast(added.pin ? `${name} measured at pin ${added.pin.n}.${phone ? " Open the panel's Measure tab for the graph." : ''}` : `${name} chart added.${phone ? " Open the panel's Measure tab to see it." : ''}`, 'ok', phone ? 5000 : 3500);
    announce(added.pin ? `${name} pin ${added.pin.n} placed.` : `${name} chart added.`);
    showMeasureTab();
    refreshOverlay();
    measurePanel.refresh();
  }
  /** Opens the sidebar on the Measure tab without moving focus, so play and the map keys carry on. On a phone it only selects the tab. */
  /** A loaded scenario brings a starter set of Measure charts and pins; switching it off or loading another one replaces them. UI only: nothing is posted or recorded. */
  function applyScenarioProbes(state: GameState): void {
    const mode = ui.scenarioProbes;
    if (!mode || (mode === 'apply') !== !!state.climateScenario) return; // an older state is still in flight
    ui.scenarioProbes = null;
    probes.removeAuto();
    if (mode === 'apply') probes.addSet(SCENARIO_PROBES);
    if (historicEnvironmentReady(state)) probes.sample(state);
    if (mode === 'apply') showMeasureTab();
    refreshOverlay();
    measurePanel.refresh();
  }
  function showMeasureTab(): void {
    if (!sidebarBesideMap.matches) { if (ui.tab !== 'measure') activateTab('measure'); return; } // phones: the sidebar covers the screen, so it stays closed
    if (sidebar.hidden) setSidebar(true);
    if (ui.tab !== 'measure') activateTab('measure');
    else measurePanel.refresh();
  }

  ref('play').addEventListener('click', togglePlay);
  ref('speedReset').addEventListener('click', () => setSpeed(DEFAULT_TIME_SPEED));
  ref('skip').addEventListener('click', skipAhead);
    function loadScenario(id: ClimateScenarioId): void {
    const scenario = climateScenarioById(id);
    setSpeed(SCENARIO_TIME_SPEED); // weather has to run for storms and climate-driven events to form on the changed climate; the player may change the speed afterwards
    ui.scenarioPending = true;
    ui.placementQueue.push(result => {
      ui.scenarioPending = false;
      if (result.ok) { ui.scenarioProbes = 'apply'; toast(`${scenario.name} loaded. The Pacific starts in its state of that January; watch it in Measure.`, 'ok'); }
      else toast(result.reason ?? `${scenario.name} could not be loaded.`, 'error');
    });
    post({ type: 'climate-scenario', scenarioId: scenario.id });
  }
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
  const restartDialog = ref<HTMLDialogElement>('restartDialog');
  ref('restart').addEventListener('click', () => { localizeTree(restartDialog); restartDialog.showModal(); });
  ref('restartCancel').addEventListener('click', () => restartDialog.close());
  // The same as reloading the page: the seed and start date in the URL stay, nothing else of the world does.
  ref('restartConfirm').addEventListener('click', () => location.reload());
  ref('conditionsReset').addEventListener('click', () => {
    ui.placementQueue.push(result => {
      if (result.ok) toast('Conditions reset.', 'ok');
      else toast(result.reason ?? 'The conditions could not be reset.', 'error');
    });
    post({ type: 'conditions-reset' });
  });
  ref('disastersReset').addEventListener('click', () => {
    ui.placementQueue.push(result => {
      if (result.ok) toast('All disasters reset.', 'ok');
      else toast(result.reason ?? 'The disasters could not be reset.', 'error');
    });
    post({ type: 'disaster-reset' });
  });
    /** Pressing the loaded scenario's tile again: the climate goes back to normal at once. */
  function switchScenarioOff(id: ClimateScenarioId): void {
    const scenario = climateScenarioById(id);
    ui.scenarioPending = true;
    ui.placementQueue.push(result => {
      ui.scenarioPending = false;
      if (result.ok) { ui.scenarioProbes = 'remove'; toast(`${scenario.name} switched off. The climate is back to normal.`, 'ok'); }
      else toast(result.reason ?? `${scenario.name} could not be switched off.`, 'error');
    });
    post({ type: 'climate-scenario-off' });
  }
  function loadTyphoon(id: string): void {
    const typhoon = typhoonById(id);
    if (!typhoon) return;
    ui.lastPlacementAt = performance.now();
    ui.placementQueue.push(result => {
      if (result.ok) toast(`${typhoon.name} (${typhoon.year}) loaded. It follows the record; conditions change its strength and path.`, 'ok');
      else toast(result.reason ?? `${typhoon.name} could not be loaded.`, 'error');
    });
    post({ type: 'historic', typhoonId: typhoon.id });
  }
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
    const id = button.dataset.label as LabelId | 'graphs';
    button.setAttribute('aria-pressed', String(storedLabel(id)));
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      try { localStorage.setItem(labelKey(id), on ? 'on' : 'off'); } catch { /* storage is optional */ }
      if (id === 'graphs') { ui.graphsOnMap = on; measureOnMap?.invalidate(); return; }
      renderer?.setLabels({ [id]: on });
    });
  }
  const detachTooltips = attachTooltips(root, ref('tip'));
  const globeToggle = ref('globeToggle');
  function renderGlobeToggle(): void {
    const on = renderer?.mode === 'globe';
    globeToggle.setAttribute('aria-checked', String(on));
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
  for (const b of speedButtons) b.addEventListener('click', () => setSpeed(adjacentTimeSpeed(ui.speed, b.dataset.speedAction === 'next' ? 1 : -1)));
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
    const disaster = (ev.target as HTMLElement).closest<HTMLElement>('[data-disaster-id]');
    if (disaster) {
      const id = disaster.dataset.disasterId!;
      selectDisaster(ui.tab === 'rank' || id !== ui.selectedDisasterId ? id : null, true);
      return;
    }
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-storm-id]');
    if (b) selectStorm(Number(b.dataset.stormId) === ui.selectedStormId ? null : Number(b.dataset.stormId), true);
  });
  ref('stormCenter').addEventListener('click', () => {
    selectStorm(ui.selectedStormId, true);
  });
  ref('disasterCenter').addEventListener('click', () => selectDisaster(ui.selectedDisasterId, true));

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

  const trafficTime = (state: GameState, hour: number): string => {
    const localHour = hour + clockOffset(state);
    const within = ((Math.round(localHour * 60) % 1440) + 1440) % 1440;
    return `${fmtMonthDay(worldDay(state, hour))} · ${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}`;
  };

  function renderTrafficPopup(): void {
    const state = ui.state;
    const r = renderer;
    if (!state || !r || !selectedTrafficId) return;
    const vehicle: TrafficVehicle | undefined = state.traffic.vehicles.find(item => item.id === selectedTrafficId);
    if (!vehicle || vehicle.status !== 'travelling' || vehicle.grounded) { closeTrafficPopup(); return; }
    const point = r.trafficPoint(vehicle.id);
    if (!point) { trafficPopup.hidden = true; return; }
    setText(ref('trafficKind'), vehicle.kind === 'planes' ? 'Plane' : 'Ship');
    setText(ref('trafficTitle'), vehicle.id);
    setText(ref('trafficFrom'), vehicle.homeName);
    setText(ref('trafficTo'), vehicle.destinationName);
    const speed = vehicle.holding ? 0 : TRAFFIC_SPEED[vehicle.kind];
    setText(ref('trafficSpeed'), `${speed.toLocaleString(getLanguage())} km/h`);
    setText(ref('trafficDeparture'), vehicle.departedAtHour === undefined ? '—' : trafficTime(state, vehicle.departedAtHour));
    let remaining = 0;
    let from: GeoPoint = vehicle;
    for (let i = vehicle.next; i < vehicle.route.length; i++) {
      remaining += trafficDistance(from, vehicle.route[i]);
      from = vehicle.route[i];
    }
    const modelHour = Math.max(state.hours, ui.clockHours);
    remaining = Math.max(0, remaining - (vehicle.holding ? 0 : TRAFFIC_SPEED[vehicle.kind] * (modelHour - state.hours)));
    setText(ref('trafficArrival'), vehicle.holding ? '—' : trafficTime(state, modelHour + remaining / TRAFFIC_SPEED[vehicle.kind]));
    trafficPopup.hidden = false;
    const box = r.overlayCanvas.getBoundingClientRect();
    const x = box.left + point[0], y = box.top + point[1], gap = 18;
    const width = trafficPopup.offsetWidth, height = trafficPopup.offsetHeight;
    const right = x + gap + width <= innerWidth - 8 || x - gap - width < 8;
    trafficPopup.style.left = `${Math.round(clamp(right ? x + gap : x - gap - width, 8, Math.max(8, innerWidth - width - 8)))}px`;
    trafficPopup.style.top = `${Math.round(clamp(y - height / 2, 8, Math.max(8, innerHeight - height - 8)))}px`;
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
    setText(ref('spotInstability'), readings.instability > 0.05 ? `+${readings.instability.toFixed(1)}` : readings.instability < -0.05 ? readings.instability.toFixed(1) : '0');
    setText(ref('spotShear'), `${readings.shear.toFixed(1)} m/s`);
    setText(ref('spotPressure'), `${readings.pressure.toFixed(0)} hPa`);
    setText(ref('spotScore'), `${advice.scoreLabel}: ${advice.potential.toFixed(2)} / ${advice.threshold.toFixed(2)}`);
    const hasRecipe = (!advice.requiresSea || !advice.land) && !advice.impossibleShear;
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
    const note = advice.requiresSea && advice.land ? 'Typhoons cannot form over land. Tap an ocean spot.'
      : advice.impossibleShear ? 'The upper winds here are too strong to calm. No recipe can work.'
      : advice.maxEffects ? 'Too many conditions are active. Wait for some to fade.'
      : advice.note ? advice.note
      : !advice.ok ? 'Even this recipe is not enough here.'
      : !advice.placements.length ? 'The recipe is already in place. Give it time to organise.'
      : advice.cold ? 'The water is very cold, so this needs many warm-water patches.'
      : 'The recipe stacks as much as needed. Let the conditions build up to form the event.';
    setText(ref('spotNote'), note);
    ref('spotNote').dataset.kind = advice.ok && !advice.maxEffects ? 'ok' : 'warn';
    ref<HTMLButtonElement>('spotPlaceBtn').disabled = !advice.ok || (advice.requiresSea && advice.land) || advice.maxEffects || !advice.placements.length;
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
    ui.placementQueue.push(result => {
      if (!result.ok) toast(result.reason ?? 'The formation recipe could not be prepared.', 'error');
      else { toast(`Recipe placed at ${fmtCoord(at.lon, at.lat)}.`, 'ok', 3500); announce('Recipe placed.'); }
    });
    const kind = FORMATION_BY_ID.get(spotTool)!.kind;
    post({ type: 'formation', kind, lon: at.lon, lat: at.lat });
    // The recipe is placed: close the popover but keep the formation probe armed for the next spot.
    closeSpot();
    stage.focus({ preventScroll: true });
  });

  let detachInput = () => {};
  if (renderer) {
    const r = renderer;
    detachInput = attachMapInput(r.overlayCanvas, () => r.view, {
      onHold: (px, py) => {
        if (!phoneLayout.matches || ui.tool || ui.drag) return false;
        const at = r.view.pxToLonLat(px, py);
        if (!at) return false;
        showAt(at[0], at[1]);
        setLegendOpen(true, false);
        return true;
      },
      onHoldEnd: () => setLegendOpen(false, false),
      onTap: (px, py) => {
        const at = r.view.pxToLonLat(px, py);
        stage.focus({ preventScroll: true });
        if (ui.tool) {
          closeTrafficPopup();
          if (!at) toast('Outside the map.', 'error');
          else if (isFormation(ui.tool)) openSpot(at[0], at[1]);
          else if (isMeasure(ui.tool)) addProbe(ui.tool, at[0], at[1]);
          else placeAt(ui.tool, at[0], at[1]);
          return;
        }
        if (!at) {
          closeTrafficPopup();
          ui.selectedCityId = null;
          ui.selectedStormId = null;
          renderSidebar();
          refreshOverlay();
          return;
        }
        const stormId = r.pickStorm(px, py);
        if (stormId !== null) {
          closeTrafficPopup();
          const name = findStorm(stormId)?.name;
          selectStorm(stormId);
          showReadout(name ? `${name} selected. Open the panel for details.` : `Storm #${stormId} selected. Open the panel for details.`);
          return;
        }
        const disaster = (ui.state?.disasters ?? []).filter(record => record.endedHour === undefined).map(record => {
          const point = r.view.lonLatToPx(record.lon, record.lat);
          return { record, distance: point ? Math.hypot(point[0] - px, point[1] - py) : Infinity };
        }).sort((a, b) => a.distance - b.distance)[0];
        if (disaster && disaster.distance < 18) {
          closeTrafficPopup();
          selectDisaster(disaster.record.id);
          setSidebar(true);
          return;
        }
        const trafficId = r.pickTraffic(px, py);
        if (trafficId) {
          selectedTrafficId = trafficId;
          trafficPopupAt = 0;
          renderTrafficPopup();
          return;
        }
        closeTrafficPopup();
        const cityId = r.pickCity(px, py);
        if (cityId) { selectCity(cityId); return; }
        ui.selectedCityId = null;
        ui.selectedStormId = null;
        ui.selectedDisasterId = null;
        showAt(at[0], at[1]);
        renderSidebar();
        refreshOverlay();
      },
      onHover: (px, py) => {
        const at = px === null || py === null ? null : r.view.pxToLonLat(px, py);
        stage.dataset.trafficHover = String(!!at && px !== null && py !== null && r.pickTraffic(px, py) !== null);
        if (!at) ui.hover = null;
        else {
          ui.hover = { lon: at[0], lat: at[1] };
          showAt(at[0], at[1]);
        }
        refreshOverlay();
      },
      onInteract: active => {
        if (active) stage.dataset.trafficHover = 'false';
        if (active) { ui.hover = null; closeSpot(); refreshOverlay(); }
        if (active) applyPending();
        r.setInteracting(active);
        stage.dataset.interacting = String(active);
        post({ type: 'interaction', active });
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

  /** Only text entry blocks shortcuts; a range slider, checkbox or radio keeps focus after use and must not swallow them. */
  const TYPING = 'input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="color"], [type="file"], [type="image"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
  /** Things Space and Enter press, so Space must not also play or pause. */
  const PRESSABLE = 'button, a[href], summary, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], input[type="checkbox"], input[type="radio"]';
  /** Arrow keys belong to these (tab and radio roving, scrolling the panel) rather than to the map. */
  const ARROW_OWNERS = '.sidebar, [role="tablist"], [role="radiogroup"], input[type="range"], dialog';
  // Shortcuts are global: they work with focus anywhere (map, sidebar, palette) except while typing or with a dialog open.
  const onKey = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey) return;
    const t = ev.target instanceof Element ? ev.target : document.body;
    if (t.closest(TYPING) || document.querySelector('dialog[open]')) return;
    // Tool shortcuts follow the typed character, falling back to the physical key under a non-Latin layout (Korean, Japanese, Chinese input).
    const letter = shortcutChar(ev);
    const slot = letter ? (TOOL_KEYS as readonly string[]).indexOf(letter) : -1;
    const formationSlot = letter ? (FORMATION_KEYS as readonly string[]).indexOf(letter) : -1;
    const measureSlot = letter ? MEASURE_KEYS.indexOf(letter) : -1;
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const speedAction = speedKey(ev);
    if (ev.key === 'Tab' && !ev.altKey && ui.latest) {
      ev.preventDefault();
      if (!ev.repeat) setSpeed(adjacentTimeSpeed(ui.speed, ev.shiftKey ? -1 : 1));
    } else if (speedAction) {
      ev.preventDefault();
      if (ui.latest && !ev.repeat) setSpeed(speedAction === 'reset' ? DEFAULT_TIME_SPEED : adjacentTimeSpeed(ui.speed, speedAction === 'prev' ? -1 : 1));
    } else if (ev.key === 'Escape') {
      if (ui.tool) { ev.preventDefault(); armTool(null); }
      else if (selectedTrafficId) { ev.preventDefault(); closeTrafficPopup(); }
    } else if (/^[1-9]$/.test(ev.key) && !ev.altKey) {
      ev.preventDefault();
      const n = Number(ev.key) - 1; // 1-9 are the nine speed steps
      if (n < TIME_SPEEDS.length) setSpeed(TIME_SPEEDS[n]);
    } else if (slot >= 0 && slot < CONDITION_GROUPS.length) {
      setPaletteTab('conditions');
      armPaletteTool(CONDITION_GROUPS[slot][0]);
    } else if (formationSlot >= 0 && formationSlot < FORMATION_TOOLS.length) {
      setPaletteTab('formation');
      armTool(FORMATION_TOOLS[formationSlot].id);
    } else if (measureSlot >= 0) {
      ev.preventDefault(); // / opens Quick Find in Firefox
      setPaletteTab('measure');
      armTool(MEASURE_ITEMS[measureSlot].id);
    } else if (ev.key === ' ') {
      if (t.closest(PRESSABLE)) return;
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === '+') { ev.preventDefault(); zoomCentre(1.5); }
    else if (ev.key === '_') { ev.preventDefault(); zoomCentre(1 / 1.5); }
    else if (renderer && dir[ev.key] && (t === stage || !t.closest(ARROW_OWNERS))) {
      const step = ev.altKey ? 0.25 : ev.shiftKey ? 5 : 1;
      const d = dir[ev.key];
      ev.preventDefault();
      if (ui.tool) moveCursor(d[0] * step, d[1] * step);
      else renderer.view.panPx(-d[0] * (ev.shiftKey ? 240 : 60), d[1] * (ev.shiftKey ? 240 : 60));
    } else if (ev.key === 'Enter' && !(renderer && ui.tool && t === stage)) {
      // Nothing armed on the stage and nothing that presses itself: Enter skips ahead 4 hours.
      if (ev.shiftKey || ev.altKey || ev.repeat || t.closest(PRESSABLE) || (t !== stage && t.matches('[tabindex]:not(.report-panel, .stage)'))) return;
      ev.preventDefault();
      skipAhead();
    } else if (renderer && ev.key === 'Enter' && ui.tool && t === stage) {
      ev.preventDefault();
      const [centreLon, centreLat] = renderer.view.centerLonLat();
      const c = ui.cursor ?? { lon: centreLon, lat: centreLat };
      if (isFormation(ui.tool)) openSpot(c.lon, c.lat, true);
      else if (isMeasure(ui.tool)) addProbe(ui.tool, c.lon, c.lat);
      else placeAt(ui.tool, c.lon, c.lat);
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
  if (useLiveWeather) setText(ref('veilText'), 'Loading global weather…');
  post({ type: 'init', seed: ui.expectSeed, startDayOfYear: newStartDay(), weather: useLiveWeather ? 'live' : 'base' });

  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!renderer?.isInteracting) applyPending();
    renderer?.frame(now);
    measureOnMap?.update();
    syncTrafficView(now);
    if (selectedTrafficId && now - trafficPopupAt > 150) { trafficPopupAt = now; renderTrafficPopup(); }
    if (spotAt) positionSpot();
    if (renderer && now - statsAt > 750) {
      statsAt = now;
      const st = renderer.stats();
      stage.dataset.fps = String(st.fps);
      stage.dataset.particles = String(st.particles);
      if (st.firstWindReduction) stage.dataset.windFpsBeforeReduction = String(st.firstWindReduction.fpsBefore);
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
      get renderStats() { return renderer?.stats() ?? null; },
      /** 'globe' or 'flat'. */
      get mapMode() { return renderer?.mode ?? 'none'; },
      get playing() { return ui.playing; },
      /** Tick of the state currently drawn. */
      get renderedTick() { return ui.state?.tick ?? -1; },
      get interacting() { return renderer?.isInteracting ?? false; },
      get renderer() { return renderer?.kind ?? 'none'; },
      get speed() { return ui.speed; },
      /** Measure tab probes: pin numbers and places, and the charts' item ids. */
      /** Cost of the on-map graph placement: runs, total and last milliseconds. */
      /** What the overlay drew last frame (disaster objects and labels, stage pixels). */
      get overlayObstacles() { return renderer && 'overlayObstacles' in renderer ? renderer.overlayObstacles() : null; },
      /** Test hook: extra boxes (stage pixels) the on-map graph cards must avoid. */
      set onMapExtraBoxes(boxes: [number, number, number, number][]) { onMapExtraBoxes = boxes; measureOnMap?.invalidate(); },
      get onMapStats() { return measureOnMap?.stats() ?? null; },
      get probes() { return { pins: probes.pins.map(p => ({ ...p })), charts: [...probes.charts.keys()] }; },
    },
  });

  return {
    dispose() {
      cancelAnimationFrame(raf);
      stopLocation();
      detachInput();
      detachTooltips();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', measurePanel.refresh);
      measurePanel.dispose();
      undock();
      onMapFree.disconnect();
      window.removeEventListener('resize', refreshOverlay);
      renderer?.dispose();
      worker.terminate();
    },
  };
}
