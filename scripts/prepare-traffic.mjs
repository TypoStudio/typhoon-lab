import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Precompute calm-weather sea routes so opening the map never runs all the ocean searches.
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { TRAFFIC_ROUTES } = await server.ssrLoadModule('/src/data/traffic.ts');
  const { planTrafficRoute } = await server.ssrLoadModule('/src/simulation/traffic-routing.ts');
  const paths = {};
  for (const route of TRAFFIC_ROUTES.filter(r => r.kind === 'ships')) {
    const path = planTrafficRoute(route.start, route.end, 'ships');
    if (!path) throw new Error(`No ocean route: ${route.from} → ${route.to}`);
    paths[route.id] = path;
  }
  await writeFile(new URL('../src/data/generated/traffic-routes.json', import.meta.url), JSON.stringify(paths) + '\n');
  console.log(`Prepared ${Object.keys(paths).length} ocean routes.`);
} finally {
  await server.close();
}
