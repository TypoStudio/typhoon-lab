import '../tokens.css';
import './style.css';
import { CITIES } from './data/world';
import { LOCALES, registerNames } from './i18n';
import { createApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app mount point.');

registerNames(Object.fromEntries(CITIES.flatMap(c => (c.nameKo ? [[c.name, c.nameKo]] : []))));
for (const { code } of LOCALES) {
  if (code === 'en' || code === 'ko') continue;
  registerNames(Object.fromEntries(CITIES.flatMap(c => (c.names?.[code] ? [[c.name, c.names[code]!]] : []))), code);
}
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
createApp(root, worker);
