import { describe, expect, it } from 'vitest';
import { createGame, tornadoSteering } from '../src/simulation/engine';
import { ThunderstormAnimation } from '../src/render/thunderstorm-animation';
import { moveTornado } from '../src/simulation/tornado-motion';
import { distanceKm, offsetKm } from '../src/simulation/geo';
import type { Thunderstorm } from '../src/types';

function tornado(lon: number, track: number[]): Thunderstorm {
  return { id: 1, lon, lat: 10, intensity: 0.8, radiusKm: 30, gustMs: 60, cloudTopC: -60,
    ageHours: 3, durationHours: 8, tornado: true, tornadoTrack: track.map(x => ({ lon: x, lat: 10 })) };
}

describe('tornado movement', () => {
  it('follows a smooth, visibly curved track in constant wind, with repeatable paths per seed', () => {
    const walk = (seed: number) => {
      const storm = tornado(127, [127]);
      storm.ageHours = 0; storm.tornadoStartAgeHours = 0;
      for (let i = 0; i < 32; i++) {
        const before = { lon: storm.lon, lat: storm.lat };
        moveTornado(storm, seed, 0.25, () => ({ u: 20, v: 0, shear: 20 }));
        storm.ageHours += 0.25;
        const distance = distanceKm(before.lon, before.lat, storm.lon, storm.lat);
        expect(distance).toBeGreaterThan(17.9);
        expect(distance).toBeLessThan(27.1);
      }
      return storm;
    };
    const storm = walk(42), track = storm.tornadoTrack!;
    const start = track[0], end = track.at(-1)!;
    const chord = offsetKm(start.lon, start.lat, end.lon, end.lat);
    const deviations = track.map(point => {
      const offset = offsetKm(start.lon, start.lat, point.lon, point.lat);
      return Math.abs(chord.dx * offset.dy - chord.dy * offset.dx) / Math.hypot(chord.dx, chord.dy);
    });
    expect(Math.max(...deviations)).toBeGreaterThan(8);
    const headings = track.slice(1).map((point, index) => {
      const { dx, dy } = offsetKm(track[index].lon, track[index].lat, point.lon, point.lat);
      return Math.atan2(dy, dx);
    });
    for (let i = 1; i < headings.length; i++) {
      const angle = headings[i] - headings[i - 1];
      expect(Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)))).toBeLessThan(4 * Math.PI / 180);
    }
    expect(walk(42)).toEqual(storm);
    expect(walk(43).tornadoTrack).not.toEqual(track);
  });

  it('limits turns when steering reverses, and crosses the date line without a jump', () => {
    const storm = tornado(179.9, [179.9]);
    storm.ageHours = 0; storm.tornadoStartAgeHours = 0;
    moveTornado(storm, 42, 0.25, () => ({ u: 30, v: 0, shear: 20 }));
    expect(storm.lon).toBeLessThan(0);
    const before = { lon: storm.lon, lat: storm.lat }, heading = storm.tornadoMotion!.headingRad;
    storm.ageHours += 0.25;
    moveTornado(storm, 42, 0.25, () => ({ u: -30, v: 0, shear: 20 }));
    const turn = storm.tornadoMotion!.headingRad - heading;
    expect(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)))).toBeLessThanOrEqual(Math.PI / 12 + 1e-9);
    expect(distanceKm(before.lon, before.lat, storm.lon, storm.lat)).toBeLessThan(27.1);
  });

  it('uses the model velocity to animate finely sampled tracks at the correct speed', () => {
    const storm = tornado(127, [126.94, 127]);
    storm.tornadoMotion = { headingRad: 0, u: 30, v: 0 };
    const animation = new ThunderstormAnimation();
    animation.setClock(1, 3600, true, 0);
    animation.update({ seed: 1, hours: 1, thunderstorms: [storm] }, 0);
    const frame = animation.frame(125)[0];
    expect(distanceKm(storm.lon, storm.lat, frame.lon, frame.lat)).toBeCloseTo(13.5, 5);
    animation.setClock(1.125, 3600, false, 125);
    expect(animation.frame(1000)[0].lon).toBeCloseTo(frame.lon);
  });

  it('interpolates steering wind across grid boundaries', () => {
    const state = createGame(1);
    for (const cell of state.grid) { cell.u = cell.lon > 0 ? 30 : 0; cell.v = cell.lon > 0 ? 0 : 20; }
    const left = tornadoSteering(state.grid, -0.001, 10);
    const right = tornadoSteering(state.grid, 0.001, 10);
    expect(Math.abs(left.u - right.u)).toBeLessThan(0.1);
    expect(Math.abs(left.v - right.v)).toBeLessThan(0.1);
  });

  it('moves continuously between snapshots and freezes with the clock', () => {
    const animation = new ThunderstormAnimation();
    animation.setClock(1, 3600, true, 0);
    animation.update({ seed: 1, hours: 1, thunderstorms: [tornado(0, [-1, 0])] }, 0);
    expect(animation.frame(125)[0].lon).toBeCloseTo(0.5);
    animation.setClock(1.125, 3600, false, 125);
    expect(animation.frame(1000)[0].lon).toBeCloseTo(0.5);
    animation.setClock(1.25, 3600, true, 250);
    const before = animation.frame(250)[0].lon;
    animation.update({ seed: 1, hours: 1.25, thunderstorms: [tornado(0.9, [0, 0.9])] }, 250);
    expect(animation.frame(250)[0].lon).toBeCloseTo(before);
    expect(animation.frame(500)[0].lon).toBeGreaterThan(before);
    expect(animation.frame(500, true)[0].lon).toBe(0.9);
  });

  it('takes the short path over the date line', () => {
    const animation = new ThunderstormAnimation();
    animation.setClock(1, 3600, true, 0);
    animation.update({ seed: 1, hours: 1, thunderstorms: [tornado(-179.8, [179.8, -179.8])] }, 0);
    expect(animation.frame(125)[0].lon).toBeCloseTo(-179.6);
  });
});
