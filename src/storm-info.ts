import { stageRank } from './simulation/engine';
import type { Storm, StormRecord, StormSample } from './types';

/** The game's existing six strength stages, not a separate hurricane category scale. */
export function stormGradeLabel(storm: Storm): string { return `Grade ${stageRank(storm.wind)}`; }
export function stageChanges(storm: Storm): StormSample[] {
  return storm.history.filter((sample, i, history) => i === 0 || sample.stage !== history[i - 1].stage);
}
export function stormOutcome(storm: Storm | StormRecord): string {
  if (!('endReason' in storm)) return 'Active';
  if (storm.endReason === 'merged') return `Merged into storm #${storm.mergedIntoId}`;
  return storm.endReason === 'extratropical' ? 'Extratropical transition' : 'Dissipated';
}
