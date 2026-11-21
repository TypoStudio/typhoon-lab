import type { LiveEvent } from '../types';

// GDACS (UN/EC Global Disaster Alert and Coordination System): keyless, browser CORS enabled.
const ENDPOINT = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE_KEY = '/__weather-cache/gdacs-events-v1';
const KINDS = { TC: 'cyclone', FL: 'flood', DR: 'drought' } as const;
const ALERTS = ['green', 'orange', 'red'] as const;
type CachedEvents = { fetchedAt: number; events: LiveEvent[] };

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';

/** Keep current or just-ended events with a usable point; anything malformed is dropped. */
export function parseGdacsEvents(json: unknown, now = Date.now()): LiveEvent[] {
  const features = (json as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const events: LiveEvent[] = [];
  for (const feature of features) {
    const p = feature?.properties, g = feature?.geometry;
    const kind = KINDS[p?.eventtype as keyof typeof KINDS];
    const alert = text(p?.alertlevel).toLowerCase() as LiveEvent['alert'];
    const [lon, lat] = g?.type === 'Point' && Array.isArray(g.coordinates) ? g.coordinates : [];
    if (!kind || !ALERTS.includes(alert) || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const end = Date.parse(text(p.todate) + 'Z');
    if (!(String(p.iscurrent) === 'true' || now - end < (p.eventtype === 'DR' ? 10 : 2) * DAY)) continue;
    const kmh = p.severitydata?.severity;
    const url = text(p.url?.report);
    const event: LiveEvent = { kind, name: text(p.eventname) || text(p.name) || kind, lon, lat, alert };
    if (kind === 'cyclone' && typeof kmh === 'number' && kmh > 0 && kmh < 400) event.windKmh = kmh;
    if (url.startsWith('https://www.gdacs.org/')) event.url = url;
    if (text(p.country)) event.country = text(p.country);
    events.push(event);
  }
  return events;
}

/** Current real-world cyclones, floods and droughts from GDACS; any failure gives []. */
export async function loadLiveEvents(now = Date.now()): Promise<LiveEvent[]> {
  let cache: Cache | undefined, cached: CachedEvents | undefined;
  try {
    cache = await caches.open('typhoon-weather-v2');
    const value = (await (await cache.match(CACHE_KEY))?.json()) as CachedEvents | undefined;
    if (value && Array.isArray(value.events) && value.fetchedAt <= now && now - value.fetchedAt < 24 * HOUR) cached = value;
  } catch { /* private browsing and offline storage restrictions do not prevent play */ }
  if (cached && now - cached.fetchedAt < HOUR) return cached.events;
  try {
    const url = `${ENDPOINT}?eventlist=TC;FL;DR&fromdate=${isoDay(now - 10 * DAY)}&todate=${isoDay(now)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GDACS HTTP ${response.status}`);
    const events = parseGdacsEvents(await response.json(), now);
    try { await cache?.put(CACHE_KEY, new Response(JSON.stringify({ fetchedAt: now, events }), { headers: { 'Content-Type': 'application/json' } })); } catch { /* optional cache */ }
    return events;
  } catch { return cached?.events ?? []; }
}
