// tests/renderer/ui/parameters/panel.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the right-sidebar parameter panel. Wave-A (issue
// #69) reduces the form to four rows: silicone thickness, print-shell
// thickness, side count, draft angle. The sprue / vent / ventCount /
// registration-key fields are gone.

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
  document.body.innerHTML = '';
  try {
    window.localStorage.removeItem('units');
  } catch {
    /* ignore */
  }
  setUnitSystem('mm');
  initI18n();
});

describe('parameter panel — rendering', () => {
  test('renders one field per parameter + title + reset button', () => {
    const { container } = mount();

    const title = container.querySelector('.sidebar__title');
    expect(title).toBeTruthy();
    expect(title?.textContent).toBe(i18next.t('parameters.title'));

    // Post-#84: eight rows — Wave E+F adds brimWidth + brimThickness.
    const fieldIds = [
      'siliconeThickness',
      'printShellThickness',
      'baseSlabThickness',
      'baseSlabOverhang',
      'brimWidth',
      'brimThickness',
      'sideCount',
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

    // No leftover fields from pre-#69.
    for (const deletedId of [
      'wallThickness',
      'baseThickness',
      'sprueDiameter',
      'ventDiameter',
      'ventCount',
      'registrationKeyStyle',
    ]) {
      expect(
        container.querySelector(`[data-testid="param-field-${deletedId}"]`),
      ).toBeNull();
    }

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

    // Post-#69 Wave-B defaults: silicone=5.0, printShell=8.0.
    expect(val('siliconeThickness')).toBe('5.0');
    expect(val('printShellThickness')).toBe('8.0');

    // Post-#82 Wave-D defaults.
    expect(val('baseSlabThickness')).toBe('8.0');
    expect(val('baseSlabOverhang')).toBe('5.0');

    // Post-#84 Wave-E+F defaults.
    expect(val('brimWidth')).toBe('10.0');
    // Issue #87 dogfood fix: default bumped 3 → 8 to match the
    // default print-shell thickness.
    expect(val('brimThickness')).toBe('8.0');

    // Angle (1 decimal).
    expect(val('draftAngle')).toBe('0.0');

    // Enum select: stringified sideCount.
    expect(val('sideCount')).toBe('4');
  });

  test('tab order follows DOM order (keyboard reachability)', () => {
    const { container } = mount();
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '[data-testid^="param-input-"]',
      ),
    );
    const expected = [
      'siliconeThickness',
      'printShellThickness',
      'baseSlabThickness',
      'baseSlabOverhang',
      'brimWidth',
      'brimThickness',
      'sideCount',
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

    store.update({ siliconeThickness_mm: 12 });
    expect(reset.disabled).toBe(false);

    store.reset();
    expect(reset.disabled).toBe(true);
  });

  test('clicking reset restores every input value to the default', () => {
    const { container, store } = mount();
    store.update({
      siliconeThickness_mm: 12,
      printShellThickness_mm: 20,
      sideCount: 2,
    });

    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="param-reset"]',
    )!;
    reset.click();

    expect(store.get()).toEqual(DEFAULT_PARAMETERS);
    const silicone = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    );
    expect(silicone?.value).toBe('5.0');
  });
});

describe('parameter panel — validation + clamp-on-blur', () => {
  test('typing out-of-range value surfaces the error message', () => {
    const { container } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    input.value = '99';
    input.dispatchEvent(new Event('input'));

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-siliconeThickness"]',
    )!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBeTruthy();
    // Interpolated with the mm range (post-#69: min=1, max=15).
    expect(err.textContent).toMatch(/1/);
    expect(err.textContent).toMatch(/15/);

    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('blur clamps out-of-range value AND clears the error', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    input.value = '100';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));

    // Clamped to max (15 mm post-#69).
    expect(input.value).toBe('15.0');
    expect(store.get().siliconeThickness_mm).toBe(15);

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-siliconeThickness"]',
    )!;
    expect(err.hidden).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('blur with an in-range value commits without error', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    input.value = '7';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));

    expect(input.value).toBe('7.0');
    expect(store.get().siliconeThickness_mm).toBe(7);
  });

  test('blur on empty input clamps to min (sensible fallback)', () => {
    const { container, store } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    input.value = '';
    input.dispatchEvent(new Event('blur'));

    // NaN → clamped to min (1 mm post-#69).
    expect(input.value).toBe('1.0');
    expect(store.get().siliconeThickness_mm).toBe(1);
  });
});

describe('parameter panel — units flip', () => {
  test('flipping to inches redisplays length fields without losing precision', () => {
    const { container, store } = mount();
    const silicone = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    // Default siliconeThickness_mm = 5 mm post-#69.
    expect(silicone.value).toBe('5.0');

    setUnitSystem('in');

    // 5 mm / 25.4 mm·in⁻¹ ≈ 0.1969, rendered with 3 decimals.
    expect(silicone.value).toBe('0.197');

    // Internal mm value is unchanged.
    expect(store.get().siliconeThickness_mm).toBe(5);

    setUnitSystem('mm');
    expect(silicone.value).toBe('5.0');
    expect(store.get().siliconeThickness_mm).toBe(5);
  });

  test('typing an inches value commits the correct mm to the store', () => {
    const { container, store } = mount();

    setUnitSystem('in');
    const silicone = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;

    // User types 0.25 inches → 6.35 mm internal.
    silicone.value = '0.25';
    silicone.dispatchEvent(new Event('blur'));

    expect(store.get().siliconeThickness_mm).toBeCloseTo(6.35, 3);
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

    expect(
      container.querySelector('.sidebar__title')?.textContent,
    ).toBe(i18next.t('parameters.title'));
    expect(
      container.querySelector('[data-testid="param-reset"]')?.textContent,
    ).toBe(i18next.t('parameters.reset'));

    // Per-field label pairs. If an English string is hardcoded somewhere
    // these diverge.
    const pairs: Array<[string, string]> = [
      ['siliconeThickness', i18next.t('parameters.siliconeThickness')],
      ['printShellThickness', i18next.t('parameters.printShell')],
      ['baseSlabThickness', i18next.t('parameters.baseSlabThickness')],
      ['baseSlabOverhang', i18next.t('parameters.baseSlabOverhang')],
      ['sideCount', i18next.t('parameters.sideCount')],
      ['draftAngle', i18next.t('parameters.draft')],
    ];
    for (const [id, expected] of pairs) {
      const label = container.querySelector(
        `[data-testid="param-field-${id}"] label`,
      );
      expect(label?.textContent).toBe(expected);
    }
  });

  test('error message uses i18n key + interpolation (no literal "Out of range")', () => {
    const { container } = mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="param-input-siliconeThickness"]',
    )!;
    input.value = '99';
    input.dispatchEvent(new Event('input'));

    const err = container.querySelector<HTMLElement>(
      '[data-testid="param-error-siliconeThickness"]',
    )!;
    // Post-#69 silicone range is 1–15.
    expect(err.textContent).toBe(
      i18next.t('parameters.invalid', { min: '1.0', max: '15.0' }),
    );
  });
});
