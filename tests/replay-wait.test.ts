import { describe, expect, it } from 'vitest';
import { RESET_WAIT, replayWait, waitVerdict } from '../src/ui/replay-wait';

describe('replay wait', () => {
  const longest = replayWait(5760); // 60 model days
  it('scales the hard limit with the replay length and keeps a generous floor', () => {
    expect(replayWait(0).hardMs).toBeGreaterThanOrEqual(60_000);
    expect(longest.hardMs).toBeGreaterThan(replayWait(96).hardMs);
    expect(longest.hardMs).toBeGreaterThan(100_000); // the 25 s load run of the browser test is far inside it
  });
  it('keeps waiting while progress arrives, past the old fixed 15 s', () => {
    expect(waitVerdict(40_000, 0, 38_000, longest)).toBe('wait');
    expect(waitVerdict(100_000, 0, 99_000, longest)).toBe('wait');
  });
  it('fails after a silent period', () => {
    expect(waitVerdict(21_000, 0, 0, longest)).toBe('stalled');
    expect(waitVerdict(50_000, 0, 20_000, longest)).toBe('stalled');
  });
  it('fails at the hard limit even with progress', () => {
    expect(waitVerdict(longest.hardMs, 0, longest.hardMs - 100, longest)).toBe('too-long');
  });
  it('treats a reset as a plain 15 s wait', () => {
    expect(waitVerdict(14_000, 0, 0, RESET_WAIT)).toBe('wait');
    expect(waitVerdict(15_000, 0, 0, RESET_WAIT)).not.toBe('wait');
  });
});
