/** First-visit tutorial: a step card that explains typhoon formation, has the player build one, then try a defence. */
import { setText } from '../i18n';
import { distanceKm } from '../simulation/geo';
import { MAX_TIME_SPEED, TIME_SPEEDS, timeSpeedLabel } from '../time';
import type { GameState, GeoPoint, ToolType } from '../types';
import { el } from './dom';

export const TUTORIAL_KEY = 'typhoon-lab:tutorial';
/** Where the player builds the first typhoon: open tropical sea, well away from the equator. */
export const TUTORIAL_SPOT: GeoPoint = { lon: 140, lat: 16 };
export const TUTORIAL_RADIUS_KM = 400;
/** Hours without a storm on the play step before the card suggests placing the conditions again. */
const STUCK_HOURS = 72;
const WEAKENING: readonly ToolType[] = ['cool', 'dry', 'high', 'cold-air', 'downdraft', 'high-shear'];

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** CSS selectors of controls to outline while the step is shown. */
  highlight?: string[];
  /** Spot on the map to ring and label. */
  marker?: GeoPoint;
  /** Show the Conditions section of the palette. */
  palette?: boolean;
  /** Auto-advance once true. Steps without it advance with Next. */
  done?: (state: GameState) => boolean;
  /** Extra line shown when `hours` of world time pass on this step without `done`. */
  stuck?: { hours: number; text: string };
}

const placed = (type: ToolType) => (state: GameState): boolean =>
  state.effects.some(e => e.type === type && distanceKm(e.lon, e.lat, TUTORIAL_SPOT.lon, TUTORIAL_SPOT.lat) <= TUTORIAL_RADIUS_KM);
const paired: Record<string, string> = { cool: 'warm', dry: 'moisture', high: 'low', 'cold-air': 'warm-air', downdraft: 'updraft', 'high-shear': 'low-shear', 'stable-air': 'unstable-air' };
const tool = (type: string) => `[data-testid="tool-${paired[type] ?? type}"]`;

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: 'welcome', title: 'Welcome to Typhoon Lab', body: 'You place weather conditions on the map and watch what happens. Let\'s make a typhoon.' },
  {
    id: 'conditions', title: 'What a typhoon needs',
    body: 'A typhoon needs warm sea (above about 26.5 °C), moist air, and a low-pressure disturbance. It must also be at least 5° from the equator, so the Earth\'s spin can make it turn. Weak wind shear helps.',
    highlight: [tool('warm'), tool('moisture'), tool('low')], palette: true,
  },
  { id: 'warm', title: 'Add warm water', body: 'The seven condition buttons each have two settings. The large icon is active; the small faded icon shows the other setting. Click or tap to select, then press again to switch. Choose Warm water (+), then drag it onto the marked spot. Q switches this pair.', highlight: [tool('warm')], marker: TUTORIAL_SPOT, palette: true, done: placed('warm') },
  { id: 'moisture', title: 'Add moisture', body: 'On the Moisture / Dry air button, select Moisture and drag it onto the same spot. W switches this pair.', highlight: [tool('moisture')], marker: TUTORIAL_SPOT, palette: true, done: placed('moisture') },
  { id: 'low', title: 'Add low pressure', body: 'On the Low pressure / High pressure button, select Low pressure and drag it onto the same spot. E switches this pair.', highlight: [tool('low')], marker: TUTORIAL_SPOT, palette: true, done: placed('low') },
  {
    id: 'play', title: 'Let time run',
    body: `Use the speed arrows to select ${timeSpeedLabel(MAX_TIME_SPEED)} (or press ${TIME_SPEEDS.length}), then press Play if time is paused. A depression forms after the conditions overlap for a while.`,
    highlight: ['[data-testid="play-toggle"]', '[data-testid="speed-next"]'], marker: TUTORIAL_SPOT,
    done: state => state.storms.length > 0,
    stuck: { hours: STUCK_HOURS, text: 'Nothing yet? Make sure all three conditions sit on the marked spot. Place them again if they faded.' },
  },
  {
    id: 'formed', title: 'A depression formed',
    body: 'A tropical depression formed. It strengthens over warm water and weakens over cool water, dry air, or land. The label shows its grade 0–5.',
  },
  {
    id: 'damage', title: 'Storms hurt cities',
    body: 'Storms damage cities in their path. Estimated loss and city news appear in the panel. To protect a city, change the climate ahead of the storm.',
    highlight: ['[data-testid="sidebar-toggle"]'],
  },
  {
    id: 'weaken', title: 'Weaken the storm',
    body: 'Cool water cuts off the ocean heat supply. Dry air and Strong shear also weaken storms; High pressure can steer them. On the Warm water / Cool water button, click or tap until Cool water is the large icon, or press Q to switch. Drag it in front of the storm.',
    highlight: [tool('cool'), tool('dry'), tool('high'), tool('high-shear')], palette: true,
    done: state => state.effects.some(e => WEAKENING.includes(e.type)),
  },
  {
    id: 'done', title: 'You did it',
    body: 'Watch the wind drop. Try seasons, world climate, and the past-storm library in the settings. You can reopen this tutorial from Help.',
  },
];

/** The tutorial opens by itself on the first visit only. `?help=0` (automated runs) and a stored flag keep it shut. */
export function shouldAutoStart(search: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  if (new URLSearchParams(search).get('help') === '0') return false;
  try { return storage !== null && storage.getItem(TUTORIAL_KEY) === null; } catch { return false; }
}

/** Finishing and skipping both leave the flag that keeps the tutorial from opening again on its own. */
export function markTutorialDone(storage: Pick<Storage, 'setItem'> | null): void {
  try { storage?.setItem(TUTORIAL_KEY, 'done'); } catch { /* storage is optional */ }
}

export interface MachineView { index: number; step: TutorialStep; showNext: boolean; stuck: boolean }

/**
 * Step order and auto-advance, free of the DOM. A step reached with Back stays put while its goal is still met
 * (so Back is usable); it re-arms once the goal has been seen unmet.
 */
export function createTutorialMachine(
  steps: readonly TutorialStep[],
  getState: () => GameState | null,
  onChange: (view: MachineView | null) => void,
  onEnd: () => void,
) {
  let index = -1;
  let armed = true;
  let enterHours = 0;
  let last = '';

  const view = (): MachineView | null => {
    if (index < 0) return null;
    const step = steps[index];
    const state = getState();
    const stuck = !!(step.stuck && state && state.hours - enterHours >= step.stuck.hours);
    return { index, step, showNext: !step.done || !armed, stuck };
  };
  const emit = (): void => {
    const v = view();
    const key = v ? `${v.index}|${v.showNext}|${v.stuck}` : '';
    if (key === last) return;
    last = key;
    onChange(v);
  };
  const enter = (i: number, viaBack: boolean): void => {
    index = i;
    armed = !viaBack;
    enterHours = getState()?.hours ?? 0;
    last = '';
    update();
  };
  const end = (): void => { index = -1; last = ''; onChange(null); onEnd(); };
  function update(): void {
    const step = steps[index];
    const state = getState();
    if (step?.done && state) {
      if (!step.done(state)) armed = true;
      else if (armed) { advance(); return; }
    }
    emit();
  }
  function advance(): void {
    if (index + 1 >= steps.length) end(); else enter(index + 1, false);
  }
  return {
    get active() { return index >= 0; },
    get index() { return index; },
    start(): void { enter(0, false); },
    next(): void { if (index >= 0) advance(); },
    back(): void { if (index > 0) enter(index - 1, true); },
    skip(): void { if (index >= 0) end(); },
    /** Call on every accepted world state. */
    update(): void { if (index >= 0) update(); },
  };
}

export interface TutorialDeps {
  /** Element the card is added to; highlighted controls are looked up inside it. */
  root: HTMLElement;
  /** Newest state from the worker. */
  state(): GameState | null;
  /** Registers a listener called on every accepted state. */
  onState(cb: (state: GameState) => void): void;
  /** Rings a spot on the map with a 'Drop here' label; null removes it. */
  setOverlayMarker(point: GeoPoint | null): void;
  /** Shows the Conditions section of the palette. */
  showConditions(): void;
  storage?: Pick<Storage, 'setItem'> | null;
}

export function createTutorial(deps: TutorialDeps) {
  const { root } = deps;
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  const count = el('span', { class: 'tutorial__count', testid: 'tutorial-count' });
  const skip = el('button', { type: 'button', class: 'link-btn tutorial__skip', testid: 'tutorial-skip', 'aria-label': 'Skip tutorial', text: 'Skip' });
  const title = el('h2', { class: 'tutorial__title', testid: 'tutorial-title' });
  const body = el('p', { class: 'tutorial__body', testid: 'tutorial-body' });
  const stuck = el('p', { class: 'tutorial__stuck', testid: 'tutorial-stuck', hidden: true });
  const back = el('button', { type: 'button', class: 'btn', testid: 'tutorial-back', text: 'Back' });
  const next = el('button', { type: 'button', class: 'btn btn--primary', testid: 'tutorial-next', text: 'Next' });
  const card = el('section', { class: 'tutorial', testid: 'tutorial', role: 'region', 'aria-label': 'Tutorial', hidden: true }, [
    el('header', { class: 'tutorial__head' }, [count, skip]), title, body, stuck, el('footer', { class: 'tutorial__foot' }, [back, next]),
  ]);
  root.append(card);
  const appRoot = root.closest<HTMLElement>('.app') ?? root;

  let highlighted: HTMLElement[] = [];
  const clearHighlight = (): void => { for (const n of highlighted) n.classList.remove('tutorial-highlight'); highlighted = []; };

  const machine = createTutorialMachine(TUTORIAL_STEPS, deps.state, v => {
    if (!v) {
      card.hidden = true;
      delete appRoot.dataset.tutorial;
      clearHighlight();
      deps.setOverlayMarker(null);
      return;
    }
    const { step } = v;
    const entering = card.dataset.step !== step.id || card.hidden;
    card.hidden = false;
    appRoot.dataset.tutorial = 'on';
    card.dataset.step = step.id;
    setText(count, `${v.index + 1} / ${TUTORIAL_STEPS.length}`);
    setText(title, step.title);
    setText(body, step.body);
    stuck.hidden = !v.stuck;
    if (step.stuck) setText(stuck, step.stuck.text);
    const last = v.index === TUTORIAL_STEPS.length - 1;
    back.disabled = v.index === 0;
    next.hidden = !v.showNext;
    setText(next, last ? 'Finish' : 'Next');
    if (!entering) return;
    if (step.palette) deps.showConditions();
    clearHighlight();
    highlighted = (step.highlight ?? []).flatMap(sel => [...root.querySelectorAll<HTMLElement>(sel)]);
    for (const n of highlighted) n.classList.add('tutorial-highlight');
    highlighted[0]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    deps.setOverlayMarker(step.marker ?? null);
  }, () => markTutorialDone(storage));

  next.addEventListener('click', () => machine.next());
  back.addEventListener('click', () => machine.back());
  skip.addEventListener('click', () => machine.skip());
  deps.onState(() => machine.update());

  return {
    /** Starts from the first step (also used by the Help dialog). */
    start(): void { machine.start(); },
    skip(): void { machine.skip(); },
    get active(): boolean { return machine.active; },
  };
}

function safeStorage(): Storage | null {
  try { return localStorage; } catch { return null; }
}
