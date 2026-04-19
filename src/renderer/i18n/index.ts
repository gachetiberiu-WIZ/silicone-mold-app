// src/renderer/i18n/index.ts
//
// Minimal i18next bootstrap for the renderer.
//
// - English only at v1 (per CLAUDE.md: "English only ships at v1, but all
//   user-visible strings go through i18n from day 1").
// - Single namespace ("translation", i18next default).
// - Synchronous init so callers can `t('key')` immediately at module load
//   time — no hydration race in the DOM.
// - Exposes `getUnitSystem()` / `setUnitSystem()` for the mm/inches toggle.
//   Persisted to `localStorage.units`; defaults to `'mm'` (project constraint).
//   Emits a `units-changed` CustomEvent on `document` so any component can
//   re-render when the user flips the toggle.
//
// This file deliberately holds the unit state (a renderer-global concern)
// rather than a separate store — the app is tiny and an extra abstraction
// layer would be noise at this stage.

import i18next from 'i18next';
import en from './en.json';

export type UnitSystem = 'mm' | 'in';

const UNITS_STORAGE_KEY = 'units';
const DEFAULT_UNITS: UnitSystem = 'mm';

/**
 * Initialise i18next with the English bundle. Synchronous — uses the
 * `initImmediate: false` flag so `t()` is usable right after this call.
 * Safe to call more than once; i18next no-ops subsequent init calls.
 */
export function initI18n(): void {
  if (i18next.isInitialized) return;
  void i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'translation',
    ns: ['translation'],
    resources: {
      en: {
        translation: en,
      },
    },
    // Synchronous init — we ship a single bundled resource, no HTTP backend.
    initImmediate: false,
    interpolation: {
      // We don't need HTML escaping for a string returned into textContent.
      escapeValue: false,
    },
  });
}

/**
 * Translation helper. Thin wrapper over `i18next.t` so call sites don't need
 * to import i18next directly and we can swap the backing lib later without
 * a widespread refactor.
 */
export function t(key: string): string {
  if (!i18next.isInitialized) {
    initI18n();
  }
  // i18next's `t()` returns string when called with a plain key + no options.
  return i18next.t(key);
}

/**
 * Read the persisted unit system from localStorage. Defaults to 'mm'.
 * Any corrupt value falls back to the default — we never throw here since
 * this runs during UI mount.
 */
export function getUnitSystem(): UnitSystem {
  try {
    const raw = localStorage.getItem(UNITS_STORAGE_KEY);
    if (raw === 'mm' || raw === 'in') return raw;
  } catch {
    // localStorage may be disabled (private mode, tests). Fall through.
  }
  return DEFAULT_UNITS;
}

/**
 * Persist the selected unit system and broadcast a `units-changed`
 * CustomEvent on `document`. Listeners should prefer the event over polling.
 */
export function setUnitSystem(unit: UnitSystem): void {
  try {
    localStorage.setItem(UNITS_STORAGE_KEY, unit);
  } catch {
    // Swallow — the toggle still works for the current session.
  }
  const event = new CustomEvent<UnitSystem>('units-changed', { detail: unit });
  document.dispatchEvent(event);
}
