/// <reference types="vite/client" />
import type { HistoricEnvironment } from '../types';

// A glob, not a literal import, so a typhoon without a generated file resolves to null instead of failing the build.
const FILES = import.meta.glob<{ default: HistoricEnvironment }>('./generated/environment/*.json');

/** Reanalysis environment for a historic typhoon, or null where no file was generated or it cannot be loaded. */
export async function loadEnvironment(typhoonId: string): Promise<HistoricEnvironment | null> {
  const load = FILES[`./generated/environment/${typhoonId}.json`];
  if (!load) return null;
  try {
    return (await load()).default;
  } catch {
    return null;
  }
}
