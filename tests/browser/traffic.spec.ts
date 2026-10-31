import { test, expect } from '@playwright/test';

test('tapping a plane or ship opens a compact route popup beside its moving icon', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/?renderer=canvas&seed=42&help=0&lang=ko');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  for (const kind of ['planes', 'ships']) {
    const target = await page.evaluate(kind => {
      const lab = (window as any).__typhoonLab;
      const vehicle = lab.state.traffic.vehicles.find((item: any) => item.kind === kind && item.status === 'travelling');
      lab.mapView.setHome(vehicle.lon, vehicle.lat, 80);
      const [x, y] = lab.mapView.projectZ(vehicle.lon, vehicle.lat);
      return { x, y, id: vehicle.id, from: vehicle.homeName, to: vehicle.destinationName };
    }, kind);
    const box = (await page.getByTestId('map-stage').boundingBox())!;
    await page.mouse.click(box.x + target.x, box.y + target.y);
    const popup = page.getByTestId('traffic-popup');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(target.id);
    const names = await page.evaluate(async ({ from, to }) => {
      const path = '/src/i18n.ts';
      const { t } = await import(path);
      return { from: t(from), to: t(to) };
    }, target);
    await expect(popup).toContainText(names.from);
    await expect(popup).toContainText(names.to);
    await expect(popup).toContainText(kind === 'planes' ? '850 km/h' : '30 km/h');
    await expect(popup).toContainText('출발 시각');
    await expect(popup).toContainText('예상 도착');
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
    await page.getByTestId('traffic-close').click();
    await expect(popup).toBeHidden();
  }
  await page.setViewportSize({ width: 320, height: 700 });
  const mobile = await page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    const vehicle = lab.state.traffic.vehicles.find((item: any) => item.kind === 'planes' && item.status === 'travelling');
    lab.mapView.setHome(vehicle.lon, vehicle.lat, 80);
    return { lon: vehicle.lon, lat: vehicle.lat };
  });
  await expect.poll(() => page.evaluate(({ lon, lat }) => {
    const view = (window as any).__typhoonLab.mapView;
    const [x, y] = view.projectZ(lon, lat);
    return x >= 0 && x <= view.width && y >= 0 && y <= view.height;
  }, mobile)).toBe(true);
  const xy = await page.evaluate(({ lon, lat }) => {
    const [x, y] = (window as any).__typhoonLab.mapView.projectZ(lon, lat);
    return { x, y };
  }, mobile);
  const stageBox = (await page.getByTestId('map-stage').boundingBox())!;
  await page.mouse.click(stageBox.x + xy.x, stageBox.y + xy.y);
  const popup = page.getByTestId('traffic-popup');
  await expect(popup).toBeVisible();
  const mobileBounds = (await popup.boundingBox())!;
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(320);
});

test('globe view can select a moving plane', async ({ page }) => {
  await page.goto('/?seed=42&help=0&lang=ko&map=globe');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  const xy = await page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    const plane = lab.state.traffic.vehicles.find((item: any) => item.kind === 'planes' && item.status === 'travelling');
    lab.mapView.setHome(plane.lon, plane.lat, 80);
    const [x, y] = lab.mapView.projectZ(plane.lon, plane.lat);
    return { x, y, id: plane.id };
  });
  const stage = (await page.getByTestId('map-stage').boundingBox())!;
  await page.mouse.click(stage.x + xy.x, stage.y + xy.y);
  await expect(page.getByTestId('traffic-popup')).toContainText(xy.id);
});

test('x1 moves planes and ships at cruising speed between weather steps', async ({ page }) => {
  await page.goto('/?renderer=canvas&seed=42&help=0&lang=en');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('speed-value')).toHaveText('x1');
  await page.evaluate(async () => {
    const path = '/src/render/traffic.ts';
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === path) ?? path;
    const { TrafficAnimation } = await import(url);
    const original = TrafficAnimation.prototype.frame;
    TrafficAnimation.prototype.frame = function (...args: Parameters<typeof original>) {
      const markers = original.apply(this, args);
      (window as any).__trafficMarkers = { at: args[0], markers: markers.map((marker: { id: string; kind: string; lon: number; lat: number }) =>
        ({ id: marker.id, kind: marker.kind, lon: marker.lon, lat: marker.lat })) };
      return markers;
    };
  });
  const sample = () => page.evaluate(() => {
    const state = (window as any).__typhoonLab.state;
    const drawn = (window as any).__trafficMarkers;
    const vehicles = state.traffic.vehicles.filter((v: any) => v.status === 'travelling' && !v.holding);
    const find = (kind: string) => {
      const vehicle = vehicles.find((v: any) => v.kind === kind && drawn?.markers.some((m: any) => m.id === v.id));
      return drawn?.markers.find((m: any) => m.id === vehicle?.id);
    };
    return { tick: state.tick, at: drawn?.at, plane: find('planes'), ship: find('ships') };
  });
  await expect.poll(async () => { const s = await sample(); return !!s.plane && !!s.ship; }).toBe(true);
  const before = await sample();
  await page.waitForTimeout(1500);
  const after = await sample();
  expect(after.tick).toBe(before.tick);
  const distances = await page.evaluate(async ({ before, after }) => {
    const path = '/src/simulation/traffic-routing.ts';
    const { trafficDistance } = await import(path);
    return { seconds: (after.at - before.at) / 1000,
      plane: trafficDistance(before.plane, after.plane), ship: trafficDistance(before.ship, after.ship) };
  }, { before, after });
  expect(distances.seconds).toBeGreaterThan(1);
  expect(distances.plane / distances.seconds).toBeCloseTo(850 / 3600, 1);
  expect(distances.ship / distances.seconds).toBeCloseTo(30 / 3600, 2);
});

for (const renderer of ['canvas', 'webgl'] as const) {
  test(`${renderer}: active traffic scales down with visible hubs and replays exactly`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?seed=42&help=0&lang=ko${renderer === 'canvas' ? '&renderer=canvas' : ''}`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('play-toggle').click();
    await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(130, 30, 50));
    const before = await page.evaluate(() => {
      const lab = (window as any).__typhoonLab, view = lab.mapView;
      const visible = lab.state.traffic.vehicles.filter((v: any) => {
        const [x, y, z] = view.projectZ(v.lon, v.lat);
        return z > 0.05 && x >= -40 && x <= view.width + 40 && y >= -40 && y <= view.height + 40;
      }).map((v: any) => ({ id: v.id, lon: v.lon, lat: v.lat, kind: v.kind }));
      return { hours: lab.state.hours, dispatches: lab.state.traffic.dispatches.length, visible };
    });
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => (window as any).__typhoonLab.state.traffic.dispatches.length)).toBe(before.dispatches);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.traffic.dispatches.length)).toBeGreaterThan(before.dispatches);
    const preserved = await page.evaluate(async before => {
      const path = '/src/simulation/traffic-routing.ts';
      const { trafficDistance } = await import(path);
      const state = (window as any).__typhoonLab.state;
      const reassigned = new Set(state.traffic.dispatches.slice(before.dispatches).flatMap((d: any) => d.assignments.map((a: any) => a.vehicleId)));
      return before.visible.every((old: any) => {
        const vehicle = state.traffic.vehicles.find((v: any) => v.id === old.id);
        return reassigned.has(old.id) || trafficDistance(old, vehicle) <= (state.hours - before.hours) * (old.kind === 'planes' ? 850 : 30) + 0.1;
      });
    }, before);
    expect(preserved).toBe(true);
    const stage = page.getByTestId('map-stage');
    const activeCounts = () => page.evaluate(() => {
      const vehicles = (window as any).__typhoonLab.state.traffic.vehicles.filter((v: any) => v.status !== 'inactive');
      return { planes: vehicles.filter((v: any) => v.kind === 'planes').length, ships: vehicles.filter((v: any) => v.kind === 'ships').length };
    });
    await expect.poll(async () => (await activeCounts()).planes).toBeGreaterThan(1);
    await expect.poll(async () => (await activeCounts()).ships).toBeGreaterThan(1);
    // Taipei has many outbound services, but only one visible airport and one visible port.
    await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(121.9, 25.3, 3));
    await expect.poll(activeCounts).toEqual({ planes: 1, ships: 1 });
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-planes'))).toBeLessThanOrEqual(1);
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-ships'))).toBeLessThanOrEqual(1);
    await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(170, 0, 10));
    await expect.poll(activeCounts).toEqual({ planes: 0, ships: 0 });
    await expect(stage).toHaveAttribute('data-traffic-planes', '0');
    await expect(stage).toHaveAttribute('data-traffic-ships', '0');
    const previous = await page.evaluate(() => (window as any).__typhoonLab.state.traffic.dispatches.length);
    await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(-35, 40, 110));
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.traffic.dispatches.length)).toBeGreaterThan(previous);
    await expect.poll(async () => (await activeCounts()).planes).toBeGreaterThan(1);
    await expect.poll(async () => (await activeCounts()).ships).toBeGreaterThan(1);
    expect(await page.evaluate(() => {
      const { vehicles, lossUsd, crashes, sinkings } = (window as any).__typhoonLab.state.traffic;
      return { planes: vehicles.filter((v: any) => v.kind === 'planes').length, ships: vehicles.filter((v: any) => v.kind === 'ships').length, lossUsd, crashes, sinkings };
    })).toEqual({ planes: 10, ships: 16, lossUsd: 0, crashes: 0, sinkings: 0 });
    await page.getByTestId('play-toggle').click();
    const replay = await page.evaluate(async () => {
      const storage = '/src/ui/storage.ts', engine = '/src/simulation/engine.ts';
      const { buildReplay, parseReplay } = await import(storage);
      const { replayGame } = await import(engine);
      const state = (window as any).__typhoonLab.state;
      const file = buildReplay(state), parsed = parseReplay(JSON.stringify(file));
      if (!parsed.ok) throw new Error(parsed.error);
      const result = replayGame(file.seed, file.actions, file.untilTick, file.startDayOfYear, file.trafficDispatches);
      return { ok: result.ok && JSON.stringify(result.state.traffic) === JSON.stringify(state.traffic), file: JSON.stringify(file), traffic: JSON.stringify(state.traffic) };
    });
    expect(replay.ok).toBe(true);
    if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('tab-replay').click();
    await page.getByTestId('import-replay-input').setInputFiles({ name: 'traffic.json', mimeType: 'application/json', buffer: Buffer.from(replay.file) });
    await expect(page.getByTestId('replay-message')).toContainText('일시정지했습니다');
    expect(await page.evaluate(() => JSON.stringify((window as any).__typhoonLab.state.traffic))).toBe(replay.traffic);
    expect(errors).toEqual([]);
  });
}

for (const { renderer, width } of [{ renderer: 'canvas', width: 1440 }, { renderer: 'webgl', width: 1440 }, { renderer: 'canvas', width: 320 }]) {
  test(`${renderer}, ${width}px: ship and plane icons switch independently without changing the world`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?help=0&seed=42&lang=ko${renderer === 'canvas' ? '&renderer=canvas' : ''}`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('play-toggle').click();
    await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
    await page.evaluate(() => {
      const view = (window as any).__typhoonLab.mapView;
      view.setHome(130, 22, 65);
    });
    const stage = page.getByTestId('map-stage');
    await expect(stage).toHaveAttribute('data-renderer', renderer);
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-ships'))).toBeGreaterThan(0);
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-planes'))).toBeGreaterThan(0);
    const before = await page.evaluate(() => {
      const { seed, tick, actions } = (window as any).__typhoonLab.state;
      return { seed, tick, actions };
    });
    const ship = page.getByTestId('layer-ships'), plane = page.getByTestId('layer-planes');
    if (width < 768) {
      if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
      await page.getByTestId('tab-settings').click();
    }
    for (const button of [ship, plane]) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.width).toBe(28);
      expect(bounds.height).toBe(28);
    }
    await expect(ship).toHaveAccessibleName('배');
    await expect(plane).toHaveAccessibleName('비행기');
    await expect(ship.locator('svg')).toHaveCount(1);
    await expect(plane.locator('svg')).toHaveCount(1);
    await ship.press('Space');
    await expect(ship).toHaveAttribute('aria-pressed', 'false');
    await expect(stage).toHaveAttribute('data-traffic-ships', '0');
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-planes'))).toBeGreaterThan(0);
    await plane.press('Enter');
    await expect(plane).toHaveAttribute('aria-pressed', 'false');
    await expect(stage).toHaveAttribute('data-traffic-planes', '0');
    await ship.click();
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-ships'))).toBeGreaterThan(0);
    await expect(stage).toHaveAttribute('data-traffic-planes', '0');
    await plane.click();
    await expect.poll(async () => Number(await stage.getAttribute('data-traffic-planes'))).toBeGreaterThan(0);
    expect(await page.evaluate(() => {
      const { seed, tick, actions } = (window as any).__typhoonLab.state;
      return { seed, tick, actions };
    })).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test('unavoidable accidents disappear from the map and appear in Korean news and damage totals', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).__trafficTestWorker = this;
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&seed=42&help=0&lang=ko');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  const fixture = await page.evaluate(async () => {
    const paths = ['/tests/fixtures/traffic.ts', '/src/data/world.ts', '/src/simulation/damage-news.ts', '/src/ui/dom.ts', '/src/simulation/engine.ts'];
    const [{ transportAccidentFixture }, { CITIES }, { estimateCityDamage, stormTotalLossUsd }, { fmtMoney }, { stepGame }] = await Promise.all(paths.map(path => import(path)));
    const state = transportAccidentFixture(42);
    while (state.tick <= (window as any).__typhoonLab.state.tick) stepGame(state);
    const landLoss = state.cities.reduce((sum: number, impact: any, i: number) => sum + estimateCityDamage(CITIES[i], impact).lossUsd, 0);
    (window as any).__trafficTestWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } }));
    return { tick: state.tick, total: fmtMoney(landLoss + state.traffic.lossUsd), stormLoss: fmtMoney(stormTotalLossUsd(state.storms[0])) };
  });
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-rendered-tick', String(fixture.tick));
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-traffic-planes', '0');
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-traffic-ships', '0');
  await expect(page.getByTestId('damage-hud')).toContainText(fixture.total);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-storms').click();
  await expect(page.getByTestId('storm-loss').first()).toHaveText(fixture.stormLoss);
  await page.getByTestId('tab-news').click();
  await expect(page.getByTestId('news-list')).toContainText('강풍');
  await expect(page.getByTestId('news-list')).toContainText('추락');
  await expect(page.getByTestId('news-list')).toContainText('침몰');
  await expect(page.getByTestId('transport-damage')).toHaveCount(2);
  await expect(page.locator('.art--transport')).toHaveCount(2);
  await expect(page.getByTestId('news-list')).not.toContainText('crashes in strong winds');
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.getByTestId('transport-damage').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
  expect(errors).toEqual([]);
});
