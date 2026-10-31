import { LOCALES } from '../i18n';
import { version as appVersion } from '../../package.json';
import { CLIMATE_LIMITS, TOOLS, blizzardRecipe, formationRecipe, tornadoRecipe, weatherHazardRecipe } from '../simulation/engine';
import { WEATHER_HAZARDS, WEATHER_HAZARD_KINDS } from '../data/weather-hazards';
import type { GameState } from '../types';
import type { ClimateKey, MapOverlays, ToolType } from '../types';
import { SEASONS } from './calendar';
import { RANKING_METRICS } from './rankings';

/** The cyclone glyph shared by the brand mark and the active-storm rows. */
export const CYCLONE_PATH = 'M8.84 5.23C14.60 2.55 19.27 5.24 23.00 7.33Q19.64 6.61 16.28 5.88A7.47 7.47 0 0 1 15.16 18.77C9.40 21.45 4.73 18.76 1.00 16.67Q4.36 17.39 7.72 18.12A7.47 7.47 0 0 1 8.84 5.23ZM15.06 12.00a3.06 3.06 0 1 0 -6.12 0a3.06 3.06 0 1 0 6.12 0Z';

const TOOL_ICON: Record<ToolType, string> = {
  cool: '<path d="M2 19c2-2 4 2 6 0s4 2 6 0 4 2 6 0 3 1 4 0M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0ZM12 14v4M17 6h4"/>',
  dry: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11M3 21 21 3"/>',
  'cold-air': '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z M12 14v4M17 6h5"/>',
  downdraft: '<path d="M5 3v12M2 12l3 3 3-3M12 5v16M9 18l3 3 3-3M19 3v12M16 12l3 3 3-3"/>',
  'warm-air': '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z"/><path d="M12 9v9M17 7h5M19.5 4.5v5"/>',
  updraft: '<path d="M5 21V9M2 12l3-3 3 3M12 19V3M9 6l3-3 3 3M19 21V9M16 12l3-3 3 3"/>',
  warm: '<path d="M2 19c2-2 4 2 6 0s4 2 6 0 4 2 6 0 3 1 4 0M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0ZM12 9v9M17 6h5M19.5 3.5v5"/>',
  moisture: '<path d="M12 3c3.6 4.6 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.4-6.4 6-11z"/><path d="M9.5 14.5a2.6 2.6 0 0 0 2 2.2"/>',
  low: '<circle cx="12" cy="12" r="9"/><path d="M10 7v10h5"/>',
  high: '<circle cx="12" cy="12" r="9"/><path d="M9.5 7v10M14.5 7v10M9.5 12h5"/>',
  'low-shear': '<path d="M3 7h18M3 12h18M3 17h18" opacity=".55"/><path d="M9 4l-3 3 3 3M15 14l3 3-3 3"/>',
  'high-shear': '<path d="M3 7h14M3 17h14M7 12h14"/><path d="M14 4l3 3-3 3M10 14l-3 3 3 3M18 9l3 3-3 3"/>',
  'unstable-air': '<path d="M4 20h16M7 17c-2-3 2-4 0-7s2-4 0-7M12 17c-2-3 2-4 0-7s2-4 0-7M17 17c-2-3 2-4 0-7s2-4 0-7"/><path d="m9 5 3-3 3 3"/>',
  'stable-air': '<path d="M3 7h18M3 12h18M3 17h18M9 21h6"/>',
};

/** Each button cycles between two conditions; dragging an untouched button uses its first condition. */
export const CONDITION_GROUPS: readonly (readonly [ToolType, ToolType])[] = [
  ['warm', 'cool'], ['moisture', 'dry'], ['low', 'high'], ['low-shear', 'high-shear'],
  ['warm-air', 'cold-air'], ['updraft', 'downdraft'], ['unstable-air', 'stable-air'],
];

/** Formation probes explain and place the conditions for each weather event. */
export const FORMATION_TOOLS = [
  {
    id: 'genesis-typhoon', kind: 'typhoon', preview: 'low', name: 'Typhoon formation', tip: 'Pick a sea spot to see what it needs to form a typhoon and place the recipe.',
    icon: `<path d="${CYCLONE_PATH}" transform="translate(0 4.5) scale(.8)" fill="currentColor" fill-rule="evenodd" stroke="none"/><path d="M19 2.5v6M16 5.5h6"/>`,
    recipe: formationRecipe,
  },
  {
    id: 'genesis-blizzard', kind: 'blizzard', preview: 'cold-air', name: 'Blizzard formation', tip: 'Pick a cold spot to see what it needs for snow and gale-force wind.',
    icon: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M8 20h8"/>', recipe: blizzardRecipe,
  },
  {
    id: 'genesis-tornado', kind: 'tornado', preview: 'unstable-air', name: 'Tornado formation', tip: 'Pick a spot to build moist, unstable rotating thunderstorms.',
    icon: '<path d="M2 4h20M4 8h16M6 12h12M8 16h8M10 20h4"/>', recipe: tornadoRecipe,
  },
  ...WEATHER_HAZARD_KINDS.map(kind => ({
    id: `genesis-${kind}` as const, kind, preview: WEATHER_HAZARDS[kind].anchor,
    name: `${WEATHER_HAZARDS[kind].name} formation`,
    tip: 'Pick a spot to prepare the conditions for this weather phenomenon.',
    icon: `<path d="${WEATHER_HAZARDS[kind].iconPath}"/>`,
    recipe: (state: GameState, lon: number, lat: number) => weatherHazardRecipe(state, kind, lon, lat),
  })),
] as const;
/** Keyboard shortcut per formation tool, in list order (A is Typhoon formation). */
export const FORMATION_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'z'] as const;
export type FormationToolId = (typeof FORMATION_TOOLS)[number]['id'];

export const PALETTE_TABS = [
  { id: 'conditions', label: 'Conditions' },
  { id: 'formation', label: 'Formation' },
] as const;

export const toolIconSvg = (type: ToolType | FormationToolId, cls = 'tool__icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${type in TOOL_ICON ? TOOL_ICON[type as ToolType] : FORMATION_TOOLS.find(f => f.id === type)!.icon}</svg>`;

export const MAP_OVERLAY_OPTIONS: { id: keyof MapOverlays; label: string; tip: string }[] = [
  { id: 'wind', label: 'Wind', tip: 'Moving streaks show surface wind speed and direction.' },
  { id: 'humidity', label: 'Humidity', tip: 'Colours the wind streaks by moisture. Brighter is wetter.' },
  { id: 'rain', label: 'Rain', tip: 'Shades the areas where rain is falling.' },
  { id: 'pressure', label: 'Pressure', tip: 'Draws isobars, lines of equal sea-level pressure.' },
  { id: 'temperature', label: 'Temperature', tip: 'Colours the ocean by water temperature and land by air temperature.' },
  { id: 'population', label: 'Population', tip: 'Shows how many people live in each area.' },
  { id: 'ships', label: 'Ships', tip: 'Ships avoid land and storms. Prolonged strong winds can cause a sinking.' },
  { id: 'planes', label: 'Planes', tip: 'Flights detour around storms or land at a nearby alternate airport. Prolonged strong winds can cause a crash.' },
];

/** Label layers (stored in the renderer) and the simulation switch that share the overlay icon row. */
export type RowToggleId = 'recordedPaths' | 'cities' | 'isobars' | 'seas' | 'genesis';
export const ROW_TOGGLES: { id: RowToggleId; label: string; tip: string; testid: string; ref?: string; stateRef?: string; world?: boolean; on: boolean }[] = [
  { id: 'recordedPaths', label: 'Recorded paths', tip: 'Draws the full dashed track of every loaded past typhoon.', testid: 'recorded-path-toggle', ref: 'pathToggle', stateRef: 'pathState', on: true },
  { id: 'cities', label: 'City names', tip: 'Shows the names of cities and places. Their dots always stay.', testid: 'label-cities-toggle', on: true },
  { id: 'isobars', label: 'Isobar values', tip: 'Shows the pressure number on each isobar.', testid: 'label-isobars-toggle', on: true },
  { id: 'seas', label: 'Sea names', tip: 'Shows sea, lake and river names.', testid: 'label-seas-toggle', on: true },
  { id: 'genesis', label: 'Natural typhoon formation', tip: 'Changes the world, not just the view. When on, nature starts new storms every two to three days. Saved in your replay.', testid: 'genesis-toggle', ref: 'genesisToggle', stateRef: 'genesisState', world: true, on: false },
];

const MAP_ICON = {
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h5a3 3 0 1 1-3 3"/>',
  humidity: '<path d="M12 2C9 6 5 10 5 14a7 7 0 0 0 14 0c0-4-4-8-7-12Z"/><path d="M8 14a4 4 0 0 0 4 4"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.5-7.9A5.5 5.5 0 0 1 17 6.5a4.5 4.5 0 0 1 0 8.5"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  pressure: '<circle cx="12" cy="12" r="9"/><path d="M6 13a6 6 0 0 1 12 0M12 13l4-5M8 18h8"/><circle cx="12" cy="13" r="1"/>',
  temperature: '<path d="M5 13V4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0ZM7 7v9M14 7h5M14 11h3M13 18c2-2 4 2 6 0s2 0 3 0M14 22c2-2 4 2 6 0"/>',
  population: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 13a5 5 0 0 1 4 5v3"/>',
  ships: '<path d="M4 12 12 9l8 3-2 7H6ZM7 10V5h10v5M10 5V2h4v3M2 21c2-2 3 2 5 0s3 2 5 0 3 2 5 0 3 2 5 0M12 9v9"/>',
  planes: '<path d="m12 2 2 8 8 5v2l-8-2v5l3 2H7l3-2v-5l-8 2v-2l8-5Z"/>',
  recordedPaths: '<path d="M3 19c3-9 7 1 10-6s5-3 7-8" stroke-dasharray="2.4 3.2"/><circle cx="20.5" cy="4.5" r="1.6"/>',
  cities: '<path d="M12 21.5s-6.5-5.8-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11.2-6.5 11.2Z"/><circle cx="12" cy="10.3" r="2.4"/>',
  isobars: '<path d="M2 6.5c4-3 7 2.5 11 0s6-1 9-1"/><path d="M2 19c4-3 7 2.5 11 0s6-1 9-1"/><text x="12" y="15" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" font-weight="700" fill="currentColor" stroke="none">1008</text>',
  seas: '<path d="M2 20c2-2 3.5 2 5.5 0s3.5 2 5.5 0 3.5 2 5.5 0 2.5 1 3.5 0"/><path d="M7.5 15 12 3.5 16.5 15M9.2 11h5.6"/>',
  genesis: '<circle cx="10.5" cy="12.5" r="2.2"/><path d="M10.5 5.5c4.5-.3 7.5 2.5 7.5 6.5M10.5 19.5c-4.5.3-7.5-2.5-7.5-6.5"/><path d="M18.5 17v5M16 19.5h5"/>',
  spring: '<path d="M12 21v-9"/><path d="M12 13c0-4-3-6-7-6 0 4 3 6 7 6Z"/><path d="M12 11c0-3.5 2.5-6 7-6 0 3.5-2.5 6-7 6Z"/>',
  summer: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  autumn: '<path d="M5 19C4 10 10 4 20 4c0 10-6 16-15 15Z"/><path d="M5 19 14 10"/>',
  winter: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7"/><path d="M9.5 3.8 12 6.3l2.5-2.5M9.5 20.2 12 17.7l2.5 2.5"/>',
};
const mapIconSvg = (id: keyof typeof MAP_ICON) =>
  `<svg class="map-overlay-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${MAP_ICON[id]}</svg>`;

const TERRAIN_ICON = {
  sea: '<path d="M2 9c2-2 3.5 2 5.5 0s3.5 2 5.5 0 3.5 2 5.5 0 2.5 1 3.5 0"/><path d="M2 16c2-2 3.5 2 5.5 0s3.5 2 5.5 0 3.5 2 5.5 0 2.5 1 3.5 0"/>',
  land: '<path d="M2 20 9 7l4 7 2.5-4L22 20Z"/>',
  lake: '<rect x="3" y="4" width="18" height="16" rx="8"/><path d="M7 12c1.7-2 3.3 2 5 0s3.3 2 5 0"/>',
};
export type Terrain = keyof typeof TERRAIN_ICON;
/** The position line's terrain marker: 18 px, same stroke style as the map icons; the caller sets `aria-label`/`title`. */
export const terrainIconSvg = (id: Terrain) =>
  `<svg class="terrain-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TERRAIN_ICON[id]}</svg>`;

/** Keyboard shortcut per paired condition button. Repeating a key switches its two conditions. */
export const TOOL_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u'] as const;

export const CLIMATE_ROWS: { key: ClimateKey; ref: string; label: string; ticks: number[] }[] = [
  { key: 'warming', ref: 'climateWarming', label: 'Warming', ticks: [-2, -1, 0, 1, 2, 3, 4] },
  { key: 'enso', ref: 'climateEnso', label: 'La Niña / El Niño', ticks: [-2, -1, 0, 1, 2] },
  { key: 'polar', ref: 'climatePolar', label: 'Polar temperature', ticks: [-10, -5, 0, 5, 10] },
];

export const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'storms', label: 'Disasters' },
  { id: 'environment', label: 'World' },
  { id: 'news', label: 'News' },
  { id: 'rank', label: 'Ranking' },
  { id: 'replay', label: 'Replay' },
] as const;

export const HELP_TABS = [
  { id: 'basics', label: 'Basics' },
  { id: 'conditions', label: 'Conditions' },
  { id: 'disasters', label: 'Disaster types' },
  { id: 'climate', label: 'Climate' },
  { id: 'historic', label: 'Past typhoons' },
  { id: 'data', label: 'Data' },
] as const;

const metric = (name: string, label: string) =>
  `<div class="metric"><dt>${label}</dt><dd data-metric="${name}">—</dd></div>`;

/**
 * Static markup for the whole screen. The map stage fills a wrapper beside the sidebar (the full viewport
 * when the sidebar is closed or overlaying); every other map control is a floating sibling above it inside
 * that wrapper. Dynamic text is filled in by app.ts through data-ref / data-metric hooks.
 */
export function shellHtml(): string {
  const tools = CONDITION_GROUPS.map(([first, second], i) => {
    const t = TOOLS.find(tool => tool.type === first)!;
    return `
    <button type="button" class="tool" data-tool="${first}" data-variant="${first}" data-pair="${second}" data-alternate="${second}" data-testid="tool-${first}" style="--tool-color: var(--fx-${first}); --tool-alt-color: var(--fx-${second})" aria-pressed="false" aria-keyshortcuts="${TOOL_KEYS[i].toUpperCase()}"
      aria-label="${t.name}: drag onto the map, or press to arm it" data-tip-title="${t.name}" data-tip="${t.description.replace(/"/g, '&quot;')}">
      <span class="tool__key" aria-hidden="true">${TOOL_KEYS[i].toUpperCase()}</span>
      ${toolIconSvg(first)}
      ${toolIconSvg(second, 'tool__icon tool__icon--secondary')}
      <span class="tool__name">${t.name}</span>
    </button>`;
  }).join('');
  const formationTools = FORMATION_TOOLS.map((f, i) => `
    <button type="button" class="tool" data-tool="${f.id}" data-testid="tool-${f.id}" aria-pressed="false" aria-keyshortcuts="${FORMATION_KEYS[i].toUpperCase()}"
      aria-label="${f.name}: drag onto the map, or press to arm it" data-tip-title="${f.name}" data-tip="${f.tip}">
      <span class="tool__key" aria-hidden="true">${FORMATION_KEYS[i].toUpperCase()}</span>
      ${toolIconSvg(f.id)}
      <span class="tool__name">${f.name}</span>
    </button>`).join('');
  const paletteTabs = PALETTE_TABS.map((t, i) => `
    <button type="button" role="tab" class="palette__tab" id="palette-tab-${t.id}" data-palette-tab="${t.id}" data-testid="palette-tab-${t.id}"
      aria-selected="${i === 0}" aria-controls="palette-panel-${t.id}" tabindex="${i === 0 ? 0 : -1}">${t.label}</button>`).join('');
  const overlays = MAP_OVERLAY_OPTIONS.map(l => `
    <button type="button" class="overlay-toggle" data-overlay="${l.id}" data-testid="layer-${l.id}"
      aria-pressed="true" aria-label="${l.label}" data-tip-title="${l.label}" data-tip="${l.tip}">${mapIconSvg(l.id)}</button>`).join('')
    + ROW_TOGGLES.map(l => {
      const common = `class="overlay-toggle${l.world ? ' overlay-toggle--world' : ''}" data-testid="${l.testid}" aria-label="${l.label}" data-tip-title="${l.label}" data-tip="${l.tip}"`;
      if (!l.stateRef) return `
    <button type="button" ${common} data-label="${l.id}" aria-pressed="${l.on}">${mapIconSvg(l.id)}</button>`;
      return `
    <button type="button" ${common} role="switch" aria-checked="${l.on}" data-ref="${l.ref}">${mapIconSvg(l.id)}<span class="sr-only" data-ref="${l.stateRef}">${l.on ? 'On' : 'Off'}</span></button>`;
    }).join('');
  const seasonButtons = SEASONS.map(l => `
    <button type="button" role="radio" class="overlay-toggle season-toggle" data-season="${l.id}" data-testid="season-${l.id}"
      aria-checked="false" aria-label="${l.label}" title="${l.label}">${mapIconSvg(l.id)}</button>`).join('');
  const climateRows = CLIMATE_ROWS.map(r => {
    const [min, max] = CLIMATE_LIMITS[r.key];
    const id = `climate-${r.key}`;
    const ticks = r.ticks.map(value => `<span style="left:${(value - min) / (max - min) * 100}%" data-edge="${value === min ? 'start' : value === max ? 'end' : 'mid'}">${value < 0 ? '−' : value > 0 ? '+' : ''}${Math.abs(value)}</span>`).join('');
    return `<div class="setting setting--range">
      <div class="setting__range-head"><label class="setting__label" for="${id}" id="${id}-label">${r.label}</label><output class="setting__value" for="${id}" data-ref="${r.ref}Value" data-testid="${id}-value">0</output></div>
      <div class="setting__range-control"><input id="${id}" aria-labelledby="${id}-label" type="range" min="${min}" max="${max}" step="0.1" value="0" data-ref="${r.ref}" data-testid="${id}"><span class="legend__ticks setting__ticks" aria-hidden="true">${ticks}</span></div>
    </div>`;
  }).join('');
  const speeds = `
    <button type="button" class="speed__opt" data-speed-action="prev" data-testid="speed-prev" aria-label="Slower" data-tip-title="Slower" data-tip="Select the previous speed.">
      <svg class="speed__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m11 6-6 6 6 6M19 6l-6 6 6 6"/></svg>
    </button>
    <output class="speed__value" data-ref="speedValue" data-testid="speed-value" aria-live="polite">x1</output>
    <button type="button" class="speed__opt" data-speed-action="next" data-testid="speed-next" aria-label="Faster" data-tip-title="Faster" data-tip="Select the next speed.">
      <svg class="speed__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 6 6 6-6 6M13 6l6 6-6 6"/></svg>
    </button>`;
  const tabs = TABS.map(t => `
    <button type="button" role="tab" class="report-tab" id="tab-${t.id}" data-tab="${t.id}" data-testid="tab-${t.id}"
      aria-selected="${t.id === 'storms'}" aria-controls="panel-${t.id}" tabindex="${t.id === 'storms' ? 0 : -1}">${t.label}</button>`).join('');

  const helpTabs = HELP_TABS.map((t, i) => `
    <button type="button" role="tab" class="help-tab" id="help-tab-${t.id}" data-help-tab="${t.id}" data-testid="help-tab-${t.id}"
      aria-selected="${i === 0}" aria-controls="help-panel-${t.id}" tabindex="${i === 0 ? 0 : -1}">${t.label}</button>`).join('');
  const helpPanels = HELP_TABS.map((t, i) => `
    <div class="help-panel" role="tabpanel" id="help-panel-${t.id}" aria-labelledby="help-tab-${t.id}" data-help-panel="${t.id}" data-testid="help-panel-${t.id}" tabindex="0"${i === 0 ? '' : ' hidden'}></div>`).join('');

  return `
  <div class="app" data-testid="app" data-ready="false" data-sidebar="closed">
    <div class="stage-wrap">
    <main class="stage" id="map-stage" data-ref="stage" data-testid="map-stage" data-renderer="pending" data-interacting="false" data-rendered-tick="-1"
      tabindex="0" role="group" aria-roledescription="map" aria-label="World weather map" aria-describedby="map-help">
      <div class="stage__veil" data-ref="veil" data-testid="map-veil"><p data-ref="veilText">Starting the world…</p></div>
    </main>
    <p id="map-help" class="sr-only">Map controls. With a weather tool armed, arrow keys move the placement target one degree, Shift five degrees, Alt a quarter degree, and Enter places it. Without a tool, arrow keys pan the map. Keys Q to U cycle paired conditions. Keys A, S and D select a formation tool. Number keys 1–6 set the speed steps. Shift plus and Shift minus zoom. Space plays or pauses, Escape disarms.</p>

    <header class="brandbar">
      <svg class="brand__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" fill-rule="evenodd"><path d="${CYCLONE_PATH}"/></svg>
      <h1 class="brand__name">Typhoon Lab</h1>
      <span class="tag">Weather lab</span>
      <button type="button" class="btn btn--float btn--help" data-ref="helpOpen" data-testid="help-open" aria-label="How to play" data-tip-title="How to play" data-tip="Open the guide to the controls and conditions.">?</button>
    </header>

    <div class="zoom" role="group" aria-label="Map view">
      <button type="button" class="icon-btn" data-ref="zoomIn" data-testid="zoom-in" aria-label="Zoom in" data-tip-title="Zoom in" data-tip="Magnify the map. Shortcut: Shift +."><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      <button type="button" class="icon-btn" data-ref="zoomOut" data-testid="zoom-out" aria-label="Zoom out" data-tip-title="Zoom out" data-tip="Show more of the world. Shortcut: Shift -."><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
      <button type="button" class="icon-btn" data-ref="zoomReset" data-testid="view-reset" aria-label="Reset map view" data-tip-title="Reset map view" data-tip="Return the map to its starting position and zoom."><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
    </div>

    <button type="button" class="btn btn--float sidebar-toggle" data-ref="sidebarToggle" data-testid="sidebar-toggle" aria-expanded="false" aria-controls="sidebar">
      <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
      <span data-ref="sidebarToggleLabel">Disasters</span><span class="sidebar-toggle__count" data-ref="stormCount">0</span>
    </button>

    <div class="map-status" data-ref="mapStatus" data-legend="closed">
      <button type="button" class="legend-chip" data-ref="legendChip" data-testid="legend-toggle" aria-expanded="false" aria-controls="legend-panel">
        <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>
        <span>Legend</span>
      </button>
      <p class="legend-pos" data-ref="coords" data-testid="coords" aria-live="off">Move the pointer over the map</p>
      <div class="legend-wrap" id="legend-panel">
        <div class="legend" data-ref="legend" data-testid="legend"></div>
        <button type="button" class="legend-close" data-ref="legendClose" data-testid="legend-close" aria-label="Close legend">×</button>
      </div>
      <div class="damage-hud" data-ref="damageHud" data-testid="damage-hud">
        <p data-ref="genesisWave" data-testid="genesis-wave" hidden></p><p data-ref="climateHud" data-testid="climate-hud" hidden></p><p data-ref="damageLoss"></p>
      </div>
      <div class="historic-hud" data-ref="historicHud" data-testid="historic-hud" hidden></div>
    </div>

    <div class="clockbar" role="group" aria-label="Time controls">
      <button type="button" class="btn btn--float btn--play" data-ref="play" data-testid="play-toggle" aria-label="Pause" data-tip-title="Pause" data-tip="Stop or resume time. Shortcut: Space.">Pause</button>
      <div class="speed" role="group" aria-label="Simulation speed" data-ref="speedGroup">${speeds}</div>
      <button type="button" class="btn btn--float" data-ref="speedReset" data-testid="speed-reset" aria-label="Reset speed" data-tip-title="Reset speed" data-tip="Return only the speed to x1."><svg class="btn__icon btn__icon--phone" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/></svg><span class="btn__label">Reset speed</span></button>
      <p class="clock__text" data-ref="clockText" data-testid="clock" data-short="D1 00:00">Day 1 · 00:00:00</p>
    </div>

    <div class="notes">
      <p class="renderer-note" data-ref="rendererNote" data-testid="renderer-note" hidden></p>
      <p class="hint" data-ref="hint" data-testid="hint">The world is calm. Drag <strong>Warm water</strong>, <strong>Moisture</strong> and <strong>Low pressure</strong> onto the same tropical ocean spot, then give them time. Overlapping conditions slowly form a depression.</p>
      <p class="toast" role="status" data-ref="status" data-testid="status" data-kind="info" hidden></p>
    </div>

    <nav class="palette" data-ref="palette" data-testid="weather-palette" aria-label="Weather tools">
      <div class="palette__head">
        <div class="palette__tabs" role="tablist" aria-label="Palette sections" data-ref="paletteTabs">${paletteTabs}</div>
        <p class="palette__label">Drag onto the map</p>
      </div>
      <div class="palette__tools" role="tabpanel" id="palette-panel-conditions" aria-labelledby="palette-tab-conditions" data-palette-panel="conditions">${tools}</div>
      <div class="palette__tools" role="tabpanel" id="palette-panel-formation" aria-labelledby="palette-tab-formation" data-palette-panel="formation" hidden>${formationTools}</div>
    </nav>
    </div>

    <aside class="sidebar" id="sidebar" data-ref="sidebar" data-testid="sidebar" aria-label="Disasters and world" hidden>
      <div class="sidebar__head"><select data-ref="language" data-testid="language-select" aria-label="Language">${LOCALES.map(l => `<option value="${l.code}" lang="${l.htmlLang}">${l.label}</option>`).join('')}</select></div>
      <div class="report-tabs" role="tablist" aria-label="Panel sections" data-ref="reportTabs">${tabs}</div>

      <div class="settings-panel" role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" data-panel="settings" tabindex="0" hidden>
      <div class="settings" role="group" aria-label="World settings">
        <div class="setting"><label class="setting__label" for="historic-select">Past typhoon</label><select id="historic-select" data-ref="historicSelect" data-testid="historic-select"></select><button type="button" class="btn btn--small" data-ref="historicLoad" data-testid="historic-load">Load</button></div>
        <label class="setting"><span class="setting__label">Globe view</span><button type="button" class="switch" role="switch" aria-checked="true" data-ref="globeToggle" data-testid="globe-toggle" data-tip-title="Globe view" data-tip="Switch between the 3D globe and the flat Equal Earth map.">On</button></label>
        <div class="settings__group" role="group" aria-label="World climate">
          <div class="settings__head">
            <p class="settings__title">World climate</p>
            <button type="button" class="btn btn--small settings__reset" data-ref="climateReset" data-testid="climate-reset" data-tip-title="Reset" data-tip="Set ocean warming, ENSO and polar temperature back to 0" disabled>Reset</button>
          </div>
          <div class="setting"><span class="setting__label">Season</span><div class="season-row" role="radiogroup" aria-label="Season" data-ref="seasonRow">${seasonButtons}</div></div>
          <p class="fine">Changing the season shifts the calendar; the world keeps running.</p>
          ${climateRows}
        </div>
        <div class="setting setting--overlays"><span class="setting__label">Map overlays</span><div class="map-overlays" role="group" aria-label="Map overlays" data-ref="mapOverlays">${overlays}</div></div>
      </div>
      </div>

      <div class="report-panel" role="tabpanel" id="panel-storms" aria-labelledby="tab-storms" data-panel="storms" tabindex="0">
        <section data-ref="damagePanel" data-testid="damage-panel">
          <h2 class="panel-title">Damage report</h2>
          <p class="fine">City losses are cumulative estimates.</p>
          <dl class="metrics">
            ${metric('damageDissipated', 'Ended disasters')}${metric('damageTime', 'Average lifetime')}
            ${metric('damageDisplaced', 'Displaced people')}${metric('damageMissing', 'Missing (estimated)')}
            ${metric('damageDeaths', 'Deaths (estimated)')}
            ${metric('damageFlooded', 'Damaged homes')}${metric('damageLoss', 'Estimated loss')}
          </dl>
        </section>
        <section class="storm-section storm-section--active" aria-labelledby="storms-active-title">
          <h2 class="panel-title storm-section__title" id="storms-active-title"><span class="live-dot" aria-hidden="true"></span><span data-ref="stormActiveTitle" data-testid="storm-active-title">Active disasters</span></h2>
          <p class="fine" data-ref="stormSummary">No storms yet.</p>
          <p class="fine" data-testid="storm-wind-note">Movement speed measures travel, not wind. Gale radius estimates the area with winds of at least 17.2 m/s.</p>
          <ul class="storm-list storm-list--active" data-ref="stormList" data-testid="storm-list"></ul>
        </section>
        <div class="storm-detail" data-ref="stormDetail" data-testid="storm-detail" hidden>
          <h2 class="panel-title" data-ref="stormTitle">Storm</h2>
          <dl class="metrics" data-testid="telemetry">
            ${metric('stage', 'Stage')}
            ${metric('wind', 'Max wind')}
            ${metric('movementSpeed', 'Movement speed')}
            ${metric('pressure', 'Central pressure')}
            ${metric('outcome', 'Status')}
            ${metric('position', 'Position')}
            ${metric('rmw', 'Max-wind radius')}
            ${metric('gale', 'Gale radius')}
            ${metric('age', 'Age')}
            ${metric('peak', 'Peak wind')}
            ${metric('loss', 'Estimated loss')}
            ${metric('windDelta', 'Player effect')}
          </dl>
          <h3 class="panel-title">Development stages</h3>
          <ol class="storm-stages" data-ref="stormStages" data-testid="storm-stages"></ol>
          <figure class="spark">
            <svg viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label="Maximum wind over time" data-ref="spark"><path class="spark__line" d=""/><path class="spark__area" d=""/></svg>
            <figcaption data-ref="sparkCaption">Wind history appears as time passes.</figcaption>
          </figure>
          <button type="button" class="btn" data-ref="stormCenter" data-testid="storm-center">Centre map on storm</button>
        </div>
        <div class="storm-detail" data-ref="disasterDetail" data-testid="disaster-detail" hidden>
          <h2 class="panel-title" data-ref="disasterTitle">Disaster</h2>
          <dl class="metrics">
            ${metric('disasterKind', 'Disaster type')}${metric('disasterStatus', 'Status')}
            ${metric('disasterIntensity', 'Strength')}${metric('disasterPosition', 'Position')}
            ${metric('disasterRadius', 'Affected radius')}${metric('disasterAge', 'Age')}
            ${metric('disasterMovement', 'Movement speed')}${metric('disasterPressure', 'Pressure')}
            ${metric('disasterWind', 'Max wind')}${metric('disasterPeak', 'Peak wind')}
            ${metric('disasterTemperature', 'Air temperature')}${metric('disasterHumidity', 'Humidity')}
            ${metric('disasterRain', 'Rainfall')}${metric('disasterSnow', 'Snow depth')}
            ${metric('disasterLoss', 'Estimated loss')}${metric('disasterHomes', 'Damaged homes')}
          </dl>
          <h3 class="panel-title">Observations</h3>
          <ol class="storm-stages" data-ref="disasterHistory" data-testid="disaster-history"></ol>
          <button type="button" class="btn" data-ref="disasterCenter" data-testid="disaster-center">Centre map on disaster</button>
        </div>
        <section class="storm-section storm-section--ended" aria-labelledby="storms-ended-title">
          <h2 class="panel-title storm-section__title" id="storms-ended-title"><span data-ref="stormEndedTitle" data-testid="storm-ended-title">Ended disasters</span></h2>
          <p class="fine">Select a disaster to view its final conditions and damage. Export a replay to keep this world's history before resetting.</p>
          <ul class="storm-list storm-list--ended" data-ref="stormArchive" data-testid="storm-history"></ul>
          <p class="empty" data-ref="stormArchiveEmpty">No ended disasters yet.</p>
          <button type="button" class="link-btn" data-ref="stormArchiveMore" data-testid="storm-history-more" hidden>Show all (0)</button>
        </section>
        <h2 class="panel-title">Forming patches</h2>
        <ul class="patch-list" data-ref="patchList" data-testid="patch-list"></ul>
        <p class="empty" data-ref="patchEmpty">None. Overlapping Warm water, Moisture and Low pressure over warm ocean start one.</p>
      </div>

      <div class="report-panel" role="tabpanel" id="panel-environment" data-ref="panel-environment" aria-labelledby="tab-environment" data-panel="environment" tabindex="0" hidden>
        <h2 class="panel-title">Active conditions</h2>
        <ul class="effect-list" data-ref="effectList" data-testid="effect-list"></ul>
        <p class="empty" data-ref="effectEmpty">Nothing placed. Conditions fade after a while.</p>
        <h2 class="panel-title">World totals</h2>
        <dl class="metrics metrics--impact" data-testid="impact">
          ${metric('score', 'Impact score')}
          ${metric('exposed', 'People exposed to disasters')}
          ${metric('peak', 'Peak wind')}
        </dl>
        <p class="fine">Impact measures wind over populated areas.</p>
        <h2 class="panel-title">Cities</h2>
        <div class="city-detail" data-ref="cityDetail" data-testid="city-detail"></div>
        <p class="fine" data-ref="cityCount" data-testid="city-count"></p>
        <ul class="city-list" data-ref="cityList" data-testid="city-list"></ul>
        <p class="fine" data-ref="populationNote"></p>
      </div>

      <div class="report-panel" role="tabpanel" id="panel-news" aria-labelledby="tab-news" data-panel="news" tabindex="0" hidden>
        <p class="fine">Damage figures are cumulative estimates.</p>
        <ol class="news-list" data-ref="newsList" data-testid="news-list"></ol>
        <p class="empty" data-ref="newsEmpty">No reports yet.</p>
      </div>

      <div class="report-panel" role="tabpanel" id="panel-rank" aria-labelledby="tab-rank" data-panel="rank" tabindex="0" hidden>
        <h2 class="panel-title">World leaderboard</h2>
        <div class="rank-metrics" role="radiogroup" aria-label="Leaderboard period" data-ref="lbWindows">
          <button type="button" role="radio" class="rank-metric" data-lb-window="live" data-testid="lb-window-live" aria-checked="true" tabindex="0">Live 24 h</button>
          <button type="button" role="radio" class="rank-metric" data-lb-window="7d" data-testid="lb-window-7d" aria-checked="false" tabindex="-1">7 days</button>
          <button type="button" role="radio" class="rank-metric" data-lb-window="30d" data-testid="lb-window-30d" aria-checked="false" tabindex="-1">1 month</button>
          <button type="button" role="radio" class="rank-metric" data-lb-window="all" data-testid="lb-window-all" aria-checked="false" tabindex="-1">All time</button>
        </div>
        <form class="lb-nickname" data-ref="lbNicknameForm">
          <label class="lb-nickname__label" for="lb-nickname">Nickname</label>
          <input id="lb-nickname" class="lb-nickname__input" type="text" maxlength="20" autocomplete="off" spellcheck="false" data-ref="lbNickname" data-testid="lb-nickname">
          <button type="submit" class="btn" data-testid="lb-nickname-save">Save</button>
        </form>
        <p class="fine" data-ref="lbNicknameNote">Your nickname is public. Only a random anonymous ID, this nickname and your disaster results are sent; nicknames are not filtered.</p>
        <p class="fine lb-me" data-ref="lbMe" data-testid="lb-me"></p>
        <button type="button" class="btn btn--danger lb-delete" data-ref="lbDelete" data-testid="lb-delete">Delete my records</button>
        <p class="empty" data-ref="lbStatus" data-testid="lb-status" role="status"></p>
        <table class="lb-table" data-ref="lbTable" data-testid="lb-table" hidden>
          <thead><tr><th scope="col">Rank</th><th scope="col">Nickname</th><th scope="col">Disasters</th><th scope="col">Max grade</th><th scope="col">Loss</th></tr></thead>
          <tbody data-ref="lbBody"></tbody>
        </table>
        <h2 class="panel-title">This world</h2>
        <p class="fine">Disasters from every world on this device. Active disasters update until they end.</p>
        <div class="rank-metrics" role="radiogroup" aria-label="Ranking metric" data-ref="rankMetrics">${RANKING_METRICS.map((m, i) => `
          <button type="button" role="radio" class="rank-metric" data-rank-metric="${m.id}" data-testid="rank-metric-${m.id}" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${m.label}</button>`).join('')}
        </div>
        <ol class="storm-rank" data-ref="stormRank" data-testid="storm-rank"></ol>
        <p class="empty" data-ref="stormRankEmpty">No ranked disasters yet.</p>
        <button type="button" class="btn rank-clear" data-ref="rankClear" data-testid="rank-clear">Clear ranking</button>
        <p class="fine">Map grades: 0 Depression, 1 Tropical Storm, 2 Severe Tropical Storm, 3 Typhoon / Hurricane / Cyclone, 4 Very Strong, 5 Violent, then one more grade every 10 m/s above that.</p>
      </div>

      <div class="report-panel" role="tabpanel" id="panel-replay" aria-labelledby="tab-replay" data-panel="replay" tabindex="0" hidden>
        <p class="fine">A replay is the seed plus every condition you placed, up to a tick. Importing re-runs the world to that moment, paused, so the result is recomputed rather than trusted.</p>
        <p class="replay__count" data-ref="replayCount">0 conditions placed.</p>
        <div class="replay__actions">
          <button type="button" class="btn" data-ref="replayExport" data-testid="export-replay">Export replay</button>
          <button type="button" class="btn" data-ref="replayImport" data-testid="import-replay">Import replay file</button>
          <input type="file" accept="application/json,.json" class="sr-only" tabindex="-1" aria-label="Replay file" data-ref="replayFile" data-testid="import-replay-input">
        </div>
        <details class="replay__paste">
          <summary>Paste replay JSON</summary>
          <label class="field field--wide"><span>Replay JSON</span><textarea rows="5" spellcheck="false" data-ref="replayText" data-testid="import-replay-text"></textarea></label>
          <button type="button" class="btn" data-ref="replayPaste" data-testid="import-replay-paste">Import pasted JSON</button>
        </details>
        <p class="replay__message" role="status" data-ref="replayMessage" data-testid="replay-message" data-kind="info"></p>
      </div>
      ${footerHtml()}
    </aside>

    <dialog class="dialog dialog--help" data-ref="helpDialog" data-testid="help-dialog" aria-labelledby="help-title">
      <header class="help__head">
        <h2 id="help-title" class="dialog__title">How to play</h2>
        <div class="help-tabs" role="tablist" aria-label="Help sections" data-ref="helpTabs">${helpTabs}</div>
      </header>
      <div class="help__scroll" data-ref="helpScroll">${helpPanels}</div>
      <footer class="help__foot"><button type="button" class="btn" data-act="start-tutorial" data-testid="help-tutorial">Tutorial</button><button type="button" class="btn btn--primary" data-act="close-help" data-testid="help-close">Got it</button></footer>
    </dialog>

    <dialog class="dialog dialog--privacy" data-ref="privacyDialog" data-testid="privacy-dialog" aria-labelledby="privacy-title">
      <header class="privacy__head">
        <h2 id="privacy-title" class="dialog__title">Privacy policy</h2>
        <a class="btn" href="/privacy.html" target="_blank" rel="noopener" data-ref="privacyFull" data-testid="privacy-full">Open full page</a>
        <button type="button" class="icon-btn privacy__x" data-act="close-privacy" data-testid="privacy-x" aria-label="Close">×</button>
      </header>
      <div class="privacy__scroll" data-ref="privacyBody" data-testid="privacy-body" tabindex="0"></div>
      <footer class="help__foot"><button type="button" class="btn btn--primary" data-act="close-privacy" data-testid="privacy-close">Close</button></footer>
    </dialog>

    <dialog class="dialog dialog--confirm" data-ref="lbDeleteDialog" data-testid="lb-delete-dialog" aria-labelledby="lb-delete-text">
      <p id="lb-delete-text" class="dialog__text">This removes your nickname and all your uploaded disaster results from the world leaderboard. Your local game is not affected. Continue?</p>
      <div class="dialog__actions">
        <button type="button" class="btn" data-ref="lbDeleteCancel" data-testid="lb-delete-cancel">Cancel</button>
        <button type="button" class="btn btn--danger" data-ref="lbDeleteConfirm" data-testid="lb-delete-confirm">Delete</button>
      </div>
    </dialog>

    <section class="traffic-popup" role="dialog" aria-labelledby="traffic-title" data-ref="trafficPopup" data-testid="traffic-popup" hidden>
      <header class="traffic-popup__head"><div><span data-ref="trafficKind"></span><strong id="traffic-title" data-ref="trafficTitle"></strong></div>
        <button type="button" class="icon-btn traffic-popup__close" data-ref="trafficClose" data-testid="traffic-close" aria-label="Close">×</button></header>
      <div class="traffic-popup__route"><div><small>From</small><strong data-ref="trafficFrom"></strong></div><span aria-hidden="true">→</span><div><small>To</small><strong data-ref="trafficTo"></strong></div></div>
      <dl class="traffic-popup__facts"><div><dt>Current speed</dt><dd data-ref="trafficSpeed"></dd></div>
        <div><dt>Departed</dt><dd data-ref="trafficDeparture"></dd></div>
        <div><dt>Estimated arrival</dt><dd data-ref="trafficArrival"></dd></div></dl>
    </section>

    <section class="popover" role="dialog" aria-labelledby="spot-title" data-ref="spotPopover" data-testid="spot-popover" hidden>
      <header class="popover__head">
        <div class="popover__where"><strong id="spot-title" data-ref="spotTitle" data-testid="spot-title"></strong><span data-ref="spotName"></span></div>
        <button type="button" class="icon-btn popover__close" data-ref="spotClose" data-testid="spot-close" aria-label="Close" data-tip="Close">×</button>
      </header>
      <dl class="popover__readings" data-testid="spot-readings">
        <div><dt>Sea temp</dt><dd data-ref="spotSst"></dd></div>
        <div><dt>Air</dt><dd data-ref="spotAir"></dd></div>
        <div><dt>Humidity</dt><dd data-ref="spotHumidity"></dd></div>
        <div><dt>Atmospheric instability</dt><dd data-ref="spotInstability"></dd></div>
        <div><dt>Shear</dt><dd data-ref="spotShear"></dd></div>
        <div><dt>Pressure</dt><dd data-ref="spotPressure"></dd></div>
      </dl>
      <p class="popover__score" data-ref="spotScore" data-testid="spot-score"></p>
      <div data-ref="spotRecipeBox">
        <h3 class="popover__sub">Recipe</h3>
        <ul class="popover__recipe" data-ref="spotRecipe" data-testid="spot-recipe"></ul>
      </div>
      <p class="popover__note" data-ref="spotNote" data-testid="spot-note"></p>
      <button type="button" class="btn btn--primary popover__place" data-ref="spotPlaceBtn" data-testid="spot-place" data-tip-title="Place recipe" data-tip="Places every condition in the recipe on this spot at once. Then give them a few hours to organise.">Place recipe</button>
    </section>

    <div class="tip" role="tooltip" id="tip" data-ref="tip" hidden></div>
    <div class="sr-only" aria-live="polite" data-ref="announce" data-testid="announce"></div>
  </div>`;
}

const inquiryUrl = `https://mail.google.com/mail/?${new URLSearchParams({
  view: 'cm', fs: '1', to: 'typ0s2d10@gmail.com',
  su: `Typhoon Lab v${appVersion} — Inquiry`,
  body: `Typhoon Lab\nVersion: ${appVersion}\n\n`,
})}`.replaceAll('&', '&amp;');

/** Shared copyright links for the sidebar and help dialog. */
export const footerHtml = (): string => `<footer class="sidebar__foot"><span>© 2026 TypoStudio</span><span aria-hidden="true">·</span><a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener license">CC BY-NC-SA 4.0</a><span aria-hidden="true">·</span><a href="${inquiryUrl}" target="_blank" rel="noopener noreferrer" data-inquiry-link>Contact support</a><span aria-hidden="true">·</span><a href="/privacy.html" data-privacy-link>Privacy policy</a><span aria-hidden="true">·</span><a href="https://buymeacoffee.com/typ0s2d10" target="_blank" rel="noopener">Buy me a coffee</a></footer>`;
