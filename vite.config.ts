import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' }, // ES workers code-split, so each typhoon's environment JSON loads on demand instead of inflating the worker bundle
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)) } } }, // privacy.html is a static second page
  server: { host: '0.0.0.0', port: 5186, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 }, // long simulation runs exceed 5 s when files run in parallel
});
