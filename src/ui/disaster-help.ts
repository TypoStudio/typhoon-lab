import type { DisasterKind, FormationKind } from '../types';

/** English display keys for the simulation's disaster guide. Locales translate each field separately. */
export const DISASTER_HELP = [
  { kind: 'typhoon', name: 'Typhoon',
    conditions: 'Warm water, moisture and low pressure over ocean. Weak shear helps it grow.',
    description: 'A rotating storm with strong wind and rain. It follows the surrounding flow, can strengthen over warm ocean and weakens over land.' },
  { kind: 'blizzard', name: 'Blizzard',
    conditions: 'Moisture, cold air and low pressure that brings snow and gale-force winds together.',
    description: 'Snow and strong wind reduce visibility. Snow builds up on land and its weight damages homes. The remaining snow load is tracked after winds ease.' },
  { kind: 'tornado', name: 'Tornado',
    conditions: 'Warm air, moisture, updraft, strong shear and unstable air.',
    description: 'A narrow rotating vortex inside a thunderstorm. It follows a curving path and causes local wind damage. It ends when the parent storm loses support.' },
  { kind: 'heatwave', name: 'Heatwave',
    conditions: 'Warm air and dry air.',
    description: 'Extreme heat develops with a high-pressure area. Prolonged heat builds damage and strains health services and electricity supplies.' },
  { kind: 'drought', name: 'Drought',
    conditions: 'Dry air and stable air over land.',
    description: 'A persistent high-pressure area keeps humidity low and suppresses rain. Long-lasting water shortages damage crops and water supplies.' },
  { kind: 'downpour', name: 'Downpour',
    conditions: 'Moisture, warm air, updraft and unstable air.',
    description: 'A low-pressure rain area moves with the flow. Heavy rain causes flood damage. Rain in freezing air falls as snow.' },
  { kind: 'coldwave', name: 'Cold wave',
    conditions: 'Cold air.',
    description: 'A cold high-pressure area lowers air temperature. Freezing conditions damage crops, pipes and transport. Precipitation in the cold area falls as snow.' },
  { kind: 'hail', name: 'Hail',
    conditions: 'Moisture, warm air, strong updraft and unstable air.',
    description: 'A short-lived hail and gust area moves with the wind. It damages roofs, vehicles and crops and changes the nearby pressure and wind.' },
  { kind: 'dust', name: 'Yellow dust',
    conditions: 'Dry air and stable air over land.',
    description: 'A dry, windy dust area moves with the flow. It reduces visibility and disrupts outdoor work and transport. A nearby low-pressure area changes the wind.' },
  { kind: 'gust', name: 'Wind gust',
    conditions: 'Moisture and downdraft.',
    description: 'A short burst of strong wind with a local pressure rise. It damages trees and buildings and can put ships and flights at risk.' },
  { kind: 'thunderstorm', name: 'Thunderstorm',
    conditions: 'Warm air, moisture and updraft. Unstable air helps it develop.',
    description: 'Short-lived rain cells move with the wind and their gusts damage small areas. Strong shear and unstable air can let a tornado develop inside one.' },
] as const satisfies readonly { kind: FormationKind | DisasterKind; name: string; conditions: string; description: string }[];

export const DISASTER_HELP_INTRO = 'These descriptions explain disasters in this simulation. Choose a disaster in Formation and place its recipe on the map. The required stack adapts to the location.';
export const DISASTER_HELP_TIMING = 'Heatwaves, droughts, downpours, cold waves, hail, yellow dust and wind gusts begin six model hours after their recipe is placed. Typhoons, blizzards and tornadoes form as their conditions develop. Thunderstorms can also grow from placed conditions.';
