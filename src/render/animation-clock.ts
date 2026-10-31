/** A shared clock for map animations; camera gestures consume no animation time. */
export class AnimationClock {
  private pausedAt: number | null = null;
  private pausedMs = 0;

  read(now: number): number { return (this.pausedAt ?? now) - this.pausedMs; }

  setPaused(paused: boolean, now: number): void {
    if (paused && this.pausedAt === null) this.pausedAt = now;
    else if (!paused && this.pausedAt !== null) {
      this.pausedMs += now - this.pausedAt;
      this.pausedAt = null;
    }
  }
}
