export interface WindBudgetAdjustment { fpsBefore: number; particlesBefore: number; particlesAfter: number }

/** Adjust the visible wind budget from sustained frame timing, with room between down/up thresholds. */
export class WindParticleBudget {
  count: number;
  firstReduction: WindBudgetAdjustment | null = null;
  lastAdjustment: WindBudgetAdjustment | null = null;
  private frameMs = 1000 / 60;
  private slowMs = 0;
  private fastMs = 0;
  private readonly minimum: number;

  constructor(readonly maximum: number, minimum = 800) {
    this.count = maximum;
    this.minimum = Math.min(maximum, Math.max(minimum, Math.ceil(maximum * 0.7)));
  }

  get fps(): number { return Math.round(1000 / this.frameMs); }

  private adjust(next: number): void {
    if (next === this.count) return;
    const adjustment = { fpsBefore: this.fps, particlesBefore: this.count, particlesAfter: next };
    this.lastAdjustment = adjustment;
    if (next < this.count) this.firstReduction ??= adjustment;
    this.count = next;
  }

  sample(elapsedMs: number, active = true): number {
    // Hidden tabs and gestures must not build up a pending change.
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > 2000) {
      this.slowMs = 0; this.fastMs = 0;
      return this.count;
    }
    this.frameMs += (elapsedMs - this.frameMs) * (1 - Math.exp(-elapsedMs / 300));
    if (!active) {
      this.slowMs = 0; this.fastMs = 0;
      return this.count;
    }
    if (this.frameMs > 1000 / 35) {
      this.slowMs += elapsedMs; this.fastMs = 0;
      if (this.slowMs >= 2000) {
        this.adjust(Math.max(this.minimum, Math.floor(this.count * 0.9)));
        this.slowMs = 0;
      }
    } else if (this.frameMs < 1000 / 45) {
      this.fastMs += elapsedMs; this.slowMs = 0;
      if (this.fastMs >= 4000) {
        this.adjust(Math.min(this.maximum, this.count + Math.max(32, Math.round(this.count * 0.1))));
        this.fastMs = 0;
      }
    } else {
      this.slowMs = 0; this.fastMs = 0;
    }
    return this.count;
  }
}
