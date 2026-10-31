import { test, expect } from '@playwright/test';

// Run the actual bundled worker independently of the app's rendering workload.
test.beforeEach(async ({ page }) => {
  await page.route('**/__worker-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Worker integration</title>' }));
  await page.goto('/__worker-test');
});

test('x1 advances in real time and x4 advances 600 model seconds per real second', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    const request = (message: object): Promise<any> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker clock timed out')), 10_000);
      const listener = (event: MessageEvent) => {
        if (event.data.type !== 'state' && event.data.type !== 'error') return;
        clearTimeout(timer);
        worker.removeEventListener('message', listener);
        if (event.data.type === 'error') reject(new Error(event.data.message));
        else resolve(event.data);
      };
      worker.addEventListener('message', listener);
      worker.postMessage(message);
    });
    try {
      const initial = await request({ type: 'init', seed: 1 });
      const firstWall = performance.now();
      await new Promise(resolve => setTimeout(resolve, 1100));
      const one = await request({ type: 'play', playing: false });
      const oneWall = performance.now() - firstWall;
      await request({ type: 'speed', speed: 600 });
      await request({ type: 'play', playing: true });
      const secondWall = performance.now();
      await new Promise(resolve => setTimeout(resolve, 1600));
      const two = await request({ type: 'play', playing: false });
      const twoWall = performance.now() - secondWall;
      await request({ type: 'speed', speed: 28800 });
      await request({ type: 'play', playing: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      const twelve = await request({ type: 'play', playing: false });
      return { initial, one, two, twelve, oneWall, twoWall };
    } finally { worker.terminate(); }
  });
  const oneSeconds = (result.one.clockHours - result.initial.clockHours) * 3600;
  const twoSeconds = (result.two.clockHours - result.one.clockHours) * 3600;
  expect(oneSeconds / result.oneWall * 1000).toBeGreaterThan(0.7);
  expect(oneSeconds / result.oneWall * 1000).toBeLessThan(1.3);
  expect(twoSeconds / result.twoWall * 1000).toBeGreaterThan(450);
  expect(twoSeconds / result.twoWall * 1000).toBeLessThan(750);
  expect(result.two.state.tick).toBeGreaterThan(result.one.state.tick);
  expect((result.twelve.clockHours - result.two.clockHours) * 3600).toBeGreaterThan(10_000);
});

test('map gestures stop worker time, preserve speed, and respect an explicit pause', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    const next = (type = 'state'): Promise<any> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error(`Worker timed out: ${type}`)); }, 10_000);
      const listener = (event: MessageEvent) => {
        if (event.data.type === type || event.data.type === 'error') {
          clearTimeout(timeout); worker.removeEventListener('message', listener);
          if (event.data.type === 'error') reject(new Error(event.data.message));
          else resolve(event.data);
        }
      };
      worker.addEventListener('message', listener);
    });
    const request = (message: object, type = 'state') => { const pending = next(type); worker.postMessage(message); return pending; };
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    try {
      await request({ type: 'init', seed: 42 });
      await request({ type: 'speed', speed: 28800 });
      const frozen = (await request({ type: 'interaction', active: true }, 'interaction')).state;
      await delay(700);
      const held = (await request({ type: 'speed', speed: 28800 })).state;
      const release = (await request({ type: 'interaction', active: false }, 'interaction')).state;
      const resumed = (await next()).state;
      const paused = (await request({ type: 'interaction', active: true }, 'interaction')).state;
      await request({ type: 'play', playing: false });
      await request({ type: 'interaction', active: false }, 'interaction');
      await delay(600);
      const stillPaused = (await request({ type: 'speed', speed: 28800 })).state;
      // Reset starts playing, but must still respect an ongoing camera gesture.
      await request({ type: 'interaction', active: true }, 'interaction');
      await request({ type: 'reset' });
      await delay(600);
      const resetHeld = (await request({ type: 'speed', speed: 28800 })).state;
      await request({ type: 'interaction', active: false }, 'interaction');
      const resetResumed = (await next()).state;
      return { frozen, held, release, resumedTick: resumed.tick, paused, stillPaused, resetHeldTick: resetHeld.tick, resetResumedTick: resetResumed.tick };
    } finally { worker.terminate(); }
  });
  expect(result.held).toEqual(result.frozen);
  expect(result.release).toEqual(result.frozen);
  expect(result.resumedTick).toBeGreaterThan(result.frozen.tick);
  expect(result.stillPaused).toEqual(result.paused);
  expect(result.resetHeldTick).toBe(0);
  expect(result.resetResumedTick).toBeGreaterThan(0);
});

test('live worker starts empty, creates multiple growing storms, and replays a snapshot exactly', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    const next = (type: string, predicate: (data: any) => boolean = () => true): Promise<any> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error(`Worker timed out: ${type}`)); }, 30_000);
      const listener = (event: MessageEvent) => {
        if (event.data.type === 'error') { clearTimeout(timeout); worker.removeEventListener('message', listener); reject(new Error(event.data.message)); }
        else if (event.data.type === type && predicate(event.data)) { clearTimeout(timeout); worker.removeEventListener('message', listener); resolve(event.data); }
      };
      worker.addEventListener('message', listener);
    });
    const request = (message: object, response = 'state') => { const promise = next(response); worker.postMessage(message); return promise; };
    try {
      const initial = (await request({ type: 'init' })).state;
      await request({ type: 'speed', speed: 28800 });
      const running = (await next('state', data => data.state.tick > 0)).state;
      await request({ type: 'play', playing: false });
      const invalid = (await request({ type: 'place', tool: 'warm', lon: Number.NaN, lat: 16 }, 'placement')).result;
      const valid = [];
      for (const [lon, lat] of [[140, 16], [-55, 16]]) {
        for (const tool of ['warm', 'moisture', 'low']) valid.push((await request({ type: 'place', tool, lon, lat }, 'placement')).result);
      }
      const placed = (await request({ type: 'speed', speed: 28800 })).state;
      const forming = next('state', data => data.state.storms.length >= 2);
      worker.postMessage({ type: 'play', playing: true });
      const first = (await forming).state;
      const developed = (await next('state', data => data.state.hours >= first.hours + 20)).state;
      const snapshot = (await request({ type: 'play', playing: false })).state;
      const replay = (await request({ type: 'replay', seed: snapshot.seed, actions: snapshot.actions, untilTick: snapshot.tick })).state;
      return { initialTick: initial.tick, initialStorms: initial.storms.length, runningTick: running.tick, invalid, valid, placedStorms: placed.storms.length, first, developed, snapshot, replay };
    } finally { worker.terminate(); }
  });
  expect(result.initialTick).toBe(0);
  expect(result.initialStorms).toBe(0);
  expect(result.runningTick).toBeGreaterThan(0);
  expect(result.invalid.ok).toBe(false);
  expect(result.valid.every(p => p.ok)).toBe(true);
  expect(result.placedStorms).toBe(0);
  expect(result.first.storms.length).toBeGreaterThanOrEqual(2);
  expect(result.first.hours).toBeGreaterThan(0);
  for (const young of result.first.storms) {
    const older = result.developed.storms.find((s: any) => s.id === young.id);
    expect(older).toBeTruthy();
    expect(older.wind).toBeGreaterThan(young.wind);
    expect(older.galeRadiusKm).toBeGreaterThan(young.galeRadiusKm);
  }
  expect(result.snapshot.actions).toHaveLength(6);
  expect(result.snapshot).not.toHaveProperty('resources');
  expect(result.replay).toEqual(result.snapshot);
});

test('worker pauses explicitly, rejects malformed replay, and resets into a live empty world', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    const next = (type: string): Promise<any> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error(`Worker timed out: ${type}`)); }, 10_000);
      const listener = (event: MessageEvent) => { if (event.data.type === type) { clearTimeout(timeout); worker.removeEventListener('message', listener); resolve(event.data); } };
      worker.addEventListener('message', listener);
    });
    const request = (message: object, response = 'state') => { const promise = next(response); worker.postMessage(message); return promise; };
    try {
      const initial = (await request({ type: 'init', seed: 42 })).state;
      await request({ type: 'speed', speed: 28800 });
      await new Promise(resolve => setTimeout(resolve, 700));
      const paused = (await request({ type: 'play', playing: false })).state;
      await new Promise(resolve => setTimeout(resolve, 600));
      const afterPause = (await request({ type: 'speed', speed: 28800 })).state;
      const invalid = await request({ type: 'replay', seed: 42, untilTick: 10, actions: [{ tick: -1, type: 'low', lon: 130, lat: 20 }] }, 'error');
      const reset = (await request({ type: 'reset' })).state;
      await request({ type: 'speed', speed: 28800 });
      const resumed = (await next('state')).state;
      return { initial, paused, afterPause, invalid, reset, resumed };
    } finally { worker.terminate(); }
  });
  expect(result.initial.storms).toEqual([]);
  expect(result.paused.tick).toBeGreaterThan(0);
  expect(result.afterPause).toEqual(result.paused);
  expect(result.invalid.message).toMatch(/replay/i);
  expect(result.reset).toEqual(result.initial);
  expect(result.resumed.tick).toBeGreaterThan(0);
  expect(result.resumed.storms).toEqual([]);
});

test('an empty live world keeps running beyond the old round deadline', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    try {
      return await new Promise<{ hours: number; storms: number; phase: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Continuous world stopped advancing')), 30_000);
        worker.onmessage = event => {
          if (event.data.type === 'error') { clearTimeout(timeout); reject(new Error(event.data.message)); }
          if (event.data.type === 'state' && event.data.state.hours > 180) {
            clearTimeout(timeout);
            resolve({ hours: event.data.state.hours, storms: event.data.state.storms.length, phase: event.data.state.phase });
          }
        };
        worker.postMessage({ type: 'init' });
        worker.postMessage({ type: 'speed', speed: 28800 });
      });
    } finally { worker.terminate(); }
  });
  expect(result.hours).toBeGreaterThan(180);
  expect(result.storms).toBe(0);
  expect(result.phase).toBe('seeding');
});

test('worker toggles natural formation, loads a past typhoon, replays both exactly and resets to a clean world', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/worker.ts', { type: 'module' });
    const wait = <T>(accept: (data: any) => T | undefined, label: string): Promise<T> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error(`Worker timed out: ${label}`)); }, 25_000);
      const listener = (ev: MessageEvent) => {
        const value = accept(ev.data);
        if (value === undefined) return;
        clearTimeout(timeout); worker.removeEventListener('message', listener); resolve(value);
      };
      worker.addEventListener('message', listener);
    });
    const state = (predicate: (state: any) => boolean = () => true) => wait(data => (data.type === 'state' && predicate(data.state) ? data.state : undefined), 'state');
    const request = (message: object) => { const pending = state(); worker.postMessage(message); return pending; };
    /** genesis and historic answer with a placement result and then the state. */
    const exchange = (message: object) => {
      let result: any;
      const pending = wait(data => {
        if (data.type === 'placement') result = data.result;
        else if (data.type === 'state' && result !== undefined) return { result, state: data.state };
        return undefined;
      }, 'placement');
      worker.postMessage(message);
      return pending;
    };
    const failure = (message: object) => {
      const pending = wait(data => (data.type === 'error' ? data.message : undefined), 'error');
      worker.postMessage(message);
      return pending;
    };
    try {
      const initial = await request({ type: 'init', seed: 4 });
      await request({ type: 'play', playing: false });
      const errors = [
        await failure({ type: 'genesis', on: 'yes' }),
        await failure({ type: 'historic', typhoonId: 'nope' }),
        await failure({ type: 'replay', seed: 4, untilTick: 4, actions: [{ tick: 0, type: 'genesis' }] }),
        await failure({ type: 'replay', seed: 4, untilTick: 4, actions: [{ tick: 0, type: 'historic', typhoonId: 'nope' }] }),
      ];
      const on = await exchange({ type: 'genesis', on: true });
      const loaded = await exchange({ type: 'historic', typhoonId: 'maemi-2003' });
      await request({ type: 'speed', speed: 28800 });
      await request({ type: 'play', playing: true });
      await state(s => s.genesis.waves >= 2);
      const snapshot = await request({ type: 'play', playing: false });
      const replay = await request({ type: 'replay', seed: snapshot.seed, actions: snapshot.actions, untilTick: snapshot.tick });
      const reset = await request({ type: 'reset', seed: 9 });
      return { initial, errors, on, loaded, snapshot, replay, reset };
    } finally { worker.terminate(); }
  });
  expect(result.initial.genesis).toEqual({ enabled: false, waves: 0, nextSpawnTick: 0 });
  expect(result.initial.storms).toHaveLength(0); expect(result.initial.effects).toHaveLength(0);
  expect(result.errors).toEqual(['Natural formation needs on or off.', 'Unknown typhoon.', 'Replay rejected: Action 1 needs natural formation set to on or off.', 'Replay rejected: Action 1 names an unknown typhoon.']);
  expect(result.on.result).toEqual({ ok: true }); expect(result.on.state.genesis).toMatchObject({ enabled: true, waves: 1 });
  expect(result.on.state.effects).toHaveLength(5);
  expect(result.loaded.result).toEqual({ ok: true });
  expect(result.loaded.state.historic).toMatchObject([{ typhoonId: 'maemi-2003', finished: false }]);
  expect(result.loaded.state.storms[0]).toMatchObject({ name: 'Maemi', record: { typhoonId: 'maemi-2003' } });
  expect(result.snapshot.genesis.waves).toBeGreaterThanOrEqual(2);
  expect(result.snapshot.actions.map((a: any) => a.type)).toEqual(['genesis', 'historic']);
  expect(result.replay).toEqual(result.snapshot);
  expect(result.reset.seed).toBe(9);
  expect(result.reset.genesis).toEqual({ enabled: false, waves: 0, nextSpawnTick: 0 });
  expect(result.reset.historic).toEqual([]); expect(result.reset.storms).toHaveLength(0);
  expect(result.reset.tick).toBe(0); expect(result.reset.actions).toEqual([]);
});
