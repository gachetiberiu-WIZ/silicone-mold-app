// tests/renderer/ui/parameters/panel.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the right-sidebar parameter panel. Uses happy-dom
// (a lightweight DOM implementation for Vitest) — a devDependency, not a
// runtime dep. Runtime behaviour in production is Chromium-in-Electron;
// happy-dom is the standard Vitest choice for UI assertions that don't
// need a real browser.
//
// Coverage:
//   1. Renders one row per field (8 rows + a reset button).
//   2. The reset button disables when all values equal defaults, and
//      re-enables after any change.
//   3. Out-of-range input surfaces the "Out of range" error live.
//   4. Blur clamps the value back into [min, max] and clears the error.
//   5. Flipping the units-changed event re-renders length fields in the
//      new unit without mutating the store (internal mm value unchanged).
//   6. Every visible string goes through i18n (no hardcoded English on the
//      factories' output — verified by checking that the rendered labels
//      equal the values we set on the i18n resource bundle).

import i18next from 'i18next';
import { beforeEach, describe, expect, test } from 'vitest';

import { initI18n, setUnitSystem } from '@/renderer/i18n';
import {
  DEFAULT_PARAMETERS,
  createParametersStore,
} from '@/renderer/state/parameters';
import { mountParameterPanel } from '@/renderer/ui/parameters/panel';

function mount(): {
  container: HTMLElement;
  store: ReturnType<typeof createParametersStore>;
  panel: ReturnType<typeof mountParameterPanel>;
} {
  const container = document.createElement('aside');
  container.id = 'sidebar';
  document.body.appendChild(container);
  const store = createParametersStore();
  const panel = mountParameterPanel(container, store);
  return { container, store, panel };
}

beforeEach(() => {
  // happy-dom carries state between tests — scrub the document + reset i18n /
  // persisted units so every test starts from a clean slate.
  document.body.innerHTML = '';
  try {
    window.localStorage.removeItem('units');
  } catch {
    /* ignore */
  }
  // i18next is initialised once; if a previous test set a non-default unit,
  // reset it explicitly.
  setUnitSystem('mm');
  initI18n();
});

describe('parameter panel — rendering', () => {
  test('renders one field per parameter + title + reset button', () => {
    const { container } = mount();

    // Title
    const title = container.querySelector('.sidebar__title');
    expect(title).toBeTruthy();
    expect(title?.textContent).toBe(i18next.t('parameters.title'));

    // One field per parameter — 8 total (keyed by data-testid).
    const fieldIds = [
      'wallThickness',
      'baseThickness',
      'sideCount',
      'sprueDiameter',
      'ventDiameter',
      'ventCount',
      'registrationKeyStyle',
      'draftAngle',
    ];
    for (const id of fieldIds) {
      expect(
        container.querySelector(`[data-testid="param-field-${id}"]`),
      ).toBeTruthy();
      expect(
        container.querySelector(`[data-testid="param-input-${id}"]`),
      ).toBeTruthy();
    }

    // Reset button
    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="param-reset"]',
    );
    expect(reset).toBeTruthy();
    expect(reset?.textContent).toBe(i18next.t('parameters.reset'));
  });

  test('default values populate every input', () => {
    const { container } = mount();
    const val = (id: string): string =>
      (container.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-testid="param-input-${id}"]`,
      ) as HTMLInputElement | HTMLSelectElement).value;

    // Length defaults render with 1 decimal in mm.
    expect(val('wallThickness')).toBe('10.0');
    expect(val('baseThickness')).toBe('5.0');
    expect(val('sprueDiameter')).toBe('5.0');
    expect(val('ventDiameter')).toBe('1.5');

    // Count (integer) renders plain.
    expect(val('ventCount')).toBe('2');

    // Angle (1 decimal).
    expect(val('draftAngle')).toBe('0.0');

    // Enum selects: stringified sideCount, enum key for keyStyle.
    expect(val('sideCount')).toBe('4');
    expect(val('registrationKeyStyle')).toBe('asymmetric-hemi');
  });

  test('tab order follows DOM order (keyboard reachability)', () => {
    const { container } = mount();
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '[data-testid^="param-input-"]',
      ),
    );
    // Expected order mirrors the spec.
    const expected = [
      'wallThickness',
      'baseThickness',
      'sideCount',
      'sprueDiameter',
      'ventDiameter',
      'ventCount',
      'registrationKeyStyle',
      'draftAngle',
    ];
    expect(inputs.map((el) => el.id)).toEqual(expected);
  });
});

describe('parameter panel — reset button', () => {
  test('disabled on mount (store starts at defaults)', () => {
    const { container } = mount();
    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="param-reset"]',
    );
    expect(reset?.disabled).toBe(true);
  });

  test('enables after a store mutation; disables again after reset', () => {
    const { container, store } = mount();
    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="param-reset"]',
    )!;

    store.update({ wallThickness_mm: 12 });
    expect(reset.disabled).toBe(false);

    store.reset();
    expect(reset.disabled).toBe(true);
  });

  test('clicking reset restores every input value to the default', () => {
    const { container, store } = mount();
    store.update({
      wallThickness_mm: 15,
      baseThickness_mm: 10,
      sideCount: 2,
    });

    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="param-reset"]',
    )!;
    reset.click();

    expect(store.get()).toEqual(DEFAULT_PARAMETERS);
    // The inputs should have been re-rendered from the store.
    const wall = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    );
    expect(wall?.value).toBe('10.0');
  });
});

describe('parameter panel — validation + clamp-on-blur', () => {
  test('typing out-of-range value surfaces the error message', () => {
    const { container } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    input.value = '99';
    input.dispatchEvent(new Event('input'));

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-wallThickness"]',
    )!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBeTruthy();
    // Interpolated with the mm range (min=6, max=25).
    expect(err.textContent).toMatch(/6/);
    expect(err.textContent).toMatch(/25/);

    // aria-invalid flag is also set for a11y.
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('blur clamps out-of-range value AND clears the error', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    input.value = '100';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));

    // Clamped to max (25 mm).
    expect(input.value).toBe('25.0');
    expect(store.get().wallThickness_mm).toBe(25);

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-wallThickness"]',
    )!;
    expect(err.hidden).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('blur with an in-range value commits without error', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    input.value = '12';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));

    expect(input.value).toBe('12.0');
    expect(store.get().wallThickness_mm).toBe(12);
  });

  test('blur on empty input clamps to min (sensible fallback)', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    input.value = '';
    input.dispatchEvent(new Event('blur'));

    // NaN → clamped to min.
    expect(input.value).toBe('6.0');
    expect(store.get().wallThickness_mm).toBe(6);
  });

  test('ventCount rounds non-integer input on blur', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-ventCount"]',
    )!;

    input.value = '3.7';
    input.dispatchEvent(new Event('blur'));

    // `integer: true` → trunc during parse, then clamp into [0, 8].
    expect(input.value).toBe('3');
    expect(store.get().ventCount).toBe(3);
  });
});

describe('parameter panel — units flip', () => {
  test('flipping to inches redisplays length fields without losing precision', () => {
    const { container, store } = mount();
    const wall = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    // Default wallThickness_mm = 10 mm.
    expect(wall.value).toBe('10.0');

    // Flip to inches.
    setUnitSystem('in');

    // 10 mm / 25.4 mm·in⁻¹ ≈ 0.3937…, rendered with 3 decimals.
    expect(wall.value).toBe('0.394');

    // Internal mm value is unchanged.
    expect(store.get().wallThickness_mm).toBe(10);

    // Flip back.
    setUnitSystem('mm');
    expect(wall.value).toBe('10.0');
    expect(store.get().wallThickness_mm).toBe(10);
  });

  test('typing an inches value commits the correct mm to the store', () => {
    const { container, store } = mount();

    setUnitSystem('in');
    const wall = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;

    // User types 0.5 inches → 12.7 mm internal.
    wall.value = '0.5';
    wall.dispatchEvent(new Event('blur'));

    expect(store.get().wallThickness_mm).toBeCloseTo(12.7, 3);
  });

  test('angle field is NOT unit-flipped (always degrees)', () => {
    const { container } = mount();
    const draft = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-draftAngle"]',
    )!;
    const before = draft.value;

    setUnitSystem('in');
    expect(draft.value).toBe(before);

    setUnitSystem('mm');
    expect(draft.value).toBe(before);
  });
});

describe('parameter panel — i18n', () => {
  test('labels and reset button resolve through i18next (no hardcoded English)', () => {
    const { container } = mount();

    // Title, reset, and the label for each field match the en bundle.
    expect(
      container.querySelector('.sidebar__title')?.textContent,
    ).toBe(i18next.t('parameters.title'));
    expect(
      container.querySelector('[data-testid="param-reset"]')?.textContent,
    ).toBe(i18next.t('parameters.reset'));

    // Per-field label pairs. We assert by matching the <label> to the i18n
    // key. If an English string is hardcoded somewhere these would diverge.
    const pairs: Array<[string, string]> = [
      ['wallThickness', i18next.t('parameters.wall')],
      ['baseThickness', i18next.t('parameters.base')],
      ['sideCount', i18next.t('parameters.sideCount')],
      ['sprueDiameter', i18next.t('parameters.sprue')],
      ['ventDiameter', i18next.t('parameters.vent')],
      ['ventCount', i18next.t('parameters.ventCount')],
      ['registrationKeyStyle', i18next.t('parameters.keyStyle')],
      ['draftAngle', i18next.t('parameters.draft')],
    ];
    for (const [id, expected] of pairs) {
      const label = container.querySelector(
        `[data-testid="param-field-${id}"] label`,
      );
      expect(label?.textContent).toBe(expected);
    }
  });

  test('key-style select options render through i18n', () => {
    const { container } = mount();
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="param-input-registrationKeyStyle"]',
    )!;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual([
      i18next.t('parameters.keyStyleOptions.asymmetric-hemi'),
      i18next.t('parameters.keyStyleOptions.cone'),
      i18next.t('parameters.keyStyleOptions.keyhole'),
    ]);
  });

  test('error message uses i18n key + interpolation (no literal "Out of range")', () => {
    // If a developer hardcoded "Out of range" somewhere, this test fails
    // when a future locale edit changes the key's format.
    const { container } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-wallThickness"]',
    )!;
    input.value = '99';
    input.dispatchEvent(new Event('input'));

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-wallThickness"]',
    )!;
    // Whatever the English text is, it must come from the i18n bundle and
    // have the min/max interpolation applied. The bundle's canonical value
    // is "Out of range ({{min}}–{{max}})" — after interpolation with the
    // wallThickness constraints we expect a string ending in ")".
    expect(err.textContent).toBe(
      i18next.t('parameters.invalid', { min: '6.0', max: '25.0' }),
    );
  });
});
