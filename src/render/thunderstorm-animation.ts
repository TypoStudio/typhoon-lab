import type { GameState, Thunderstorm } from '../types';
import { STEP_HOURS } from '../simulation/engine';
import { clamp, moveKm } from '../simulation/geo';
import { wrapLon } from './view';

interface Entry {
  storm: Thunderstorm;
  offsetLon: number;
  offsetLat: number;
  updatedAt: number;
}

/** Display-only movement between worker snapshots; the simulation remains authoritative. */
export class ThunderstormAnimation {
  private entries = new Map<number, Entry>();
  private hours = 0;
  private seed: number | undefined;
  private clock: { hours: number; speed: number; playing: boolean; at: number } | null = null;

  setClock(hours: number, speed: number, playing: boolean, now: number): void {
    this.clock = { hours, speed, playing, at: now };
  }

  private position(entry: Entry, now: number): [number, number] {
    const { storm } = entry;
    const track = storm.tornadoTrack;
    if (!storm.tornado || (!storm.tornadoMotion && (!track || track.length < 2)) || !this.clock) return [storm.lon, storm.lat];
    const elapsed = this.clock.playing ? Math.max(0, now - this.clock.at) * this.clock.speed / 3_600_000 : 0;
    const fraction = clamp((this.clock.hours + elapsed - this.hours) / STEP_HOURS, 0, 1);
    const correction = this.clock.playing ? 1 - clamp((now - entry.updatedAt) / 250, 0, 1) : 0;
    const previous = track?.[track.length - 2], latest = track?.[track.length - 1];
    const point = storm.tornadoMotion
      ? moveKm(storm.lon, storm.lat, storm.tornadoMotion.u * STEP_HOURS * fraction * 3.6, storm.tornadoMotion.v * STEP_HOURS * fraction * 3.6)
      : { lon: storm.lon + wrapLon(latest!.lon - previous!.lon) * fraction, lat: storm.lat + (latest!.lat - previous!.lat) * fraction };
    return [wrapLon(point.lon + entry.offsetLon * correction), clamp(point.lat + entry.offsetLat * correction, -90, 90)];
  }

  update(state: Pick<GameState, 'seed' | 'hours' | 'thunderstorms'>, now: number): void {
    const keep = this.seed === state.seed && state.hours >= this.hours && state.hours - this.hours <= 16;
    const priorPositions = new Map<number, [number, number]>();
    if (keep) for (const [id, entry] of this.entries) priorPositions.set(id, this.position(entry, now));
    this.hours = state.hours;
    const next = new Map<number, Entry>();
    for (const storm of state.thunderstorms) {
      const entry: Entry = { storm, offsetLon: 0, offsetLat: 0, updatedAt: now };
      const prior = priorPositions.get(storm.id);
      if (prior && storm.tornado) {
        const target = this.position(entry, now);
        entry.offsetLon = wrapLon(prior[0] - target[0]);
        entry.offsetLat = prior[1] - target[1];
      }
      next.set(storm.id, entry);
    }
    this.entries = next;
    this.seed = state.seed;
  }

  frame(now: number, reducedMotion = false): Thunderstorm[] {
    return Array.from(this.entries.values(), entry => {
      const storm = entry.storm;
      if (reducedMotion || !storm.tornado) return storm;
      const [lon, lat] = this.position(entry, now);
      const track = storm.tornadoTrack;
      return { ...storm, lon, lat, tornadoTrack: track && (lon !== storm.lon || lat !== storm.lat)
        ? [...track, { lon, lat }] : track };
    });
  }
}
