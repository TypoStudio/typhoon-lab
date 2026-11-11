/** How long the page waits for the worker to answer a reset or a replay. Pure so it can be unit tested. */
export interface WaitLimits { stallMs: number; hardMs: number }
export type WaitVerdict = 'wait' | 'stalled' | 'too-long';

/** A reset has no progress reports: it simply has to answer in time. */
export const RESET_WAIT: WaitLimits = { stallMs: 15_000, hardMs: 15_000 };
/** A replay reports its tick as it runs, so it may run long (up to the hard limit, which grows with its length) as long as the reports keep coming. */
export const replayWait = (untilTick: number): WaitLimits => ({ stallMs: 20_000, hardMs: 60_000 + 25 * Math.max(0, untilTick) });

/** 'stalled': nothing heard for stallMs; 'too-long': the hard limit passed even though progress kept coming. */
export function waitVerdict(now: number, startedAt: number, lastProgressAt: number, limits: WaitLimits): WaitVerdict {
  if (now - startedAt >= limits.hardMs) return 'too-long';
  return now - Math.max(startedAt, lastProgressAt) >= limits.stallMs ? 'stalled' : 'wait';
}
