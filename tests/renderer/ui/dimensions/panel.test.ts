// tests/renderer/ui/dimensions/panel.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the right-sidebar Dimensions panel (issue #79).
// Focus areas:
//   1. Static rendering — title, three axis rows, percent row, constrain
//      checkbox, reset button, with the expected testids.
//   2. Initial values reflect the nativeBbox × scale[axis] contract.
//   3. mm / in flip re-renders the inputs + "Current size" readout
//      without losing the internal mm value.
//   4. Editing the Scale % field pushes a uniform scale to the store.
//   5. Editing an axis field with constrain ON propagates the ratio.
//   6. Reset button restores defaults.
//   7. With no master loaded, inputs disable and "Current size" renders
//      the i18n `dimensions.noMaster` placeholder.

import { Box3, Vector3 } from 'three';
import i18next from 'i18next';
import { beforeEach, describe, expect, test } from 'vitest';

import { initI18n, setUnitSystem } from '@/renderer/i18n';
import { createDimensionsStore } from '@/renderer/state/dimensions';
import { mountDimensionsPanel } from '@/renderer/ui/dimensions/panel';

/** Canonical fixture bbox: 100×50×25 mm, centered on origin. */
function nativeBbox(): Box3 {
  return new Box3(
    new Vector3(-50, -25, -12.5),
    new Vector3(50, 25, 12.5),
  );
}

function mount(opts?: {
  nativeBbox?: () => Box3 | null;
}): {
  container: HTMLElement;
  store: ReturnType<typeof createDimensionsStore>;
  panel: ReturnType<typeof mountDimensionsPanel>;
} {
  const container = document.createElement('aside');
  container.id = 'sidebar';
  document.body.appendChild(container);
  const store = createDimensionsStore();
  const panel = mountDimensionsPanel(container, store, {
    getNativeBbox: opts?.nativeBbox ?? nativeBbox,
  });
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

describe('dimensions panel — rendering', () => {
  test('mounts section + title + all rows + reset button', () => {
    const { container } = mount();

    const section = container.querySelector('[data-testid="dimensions-panel"]');
    expect(section).toBeTruthy();

    const title = section!.querySelector('.sidebar__title');
    expect(title?.textContent).toBe(i18next.t('dimensions.title'));

    for (const id of [
      'dimensions-current',
      'dimensions-percent-input',
      'dimensions-width-input',
      'dimensions-height-input',
      'dimensions-depth-input',
      'dimensions-constrain',
      'dimensions-reset',
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeTruthy();
    }
  });

  test('default percent is 100.0 and axis fields show the native bbox in mm', () => {
    const { container } = mount();
    const percent = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-percent-input"]',
    )!;
    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    const height = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-height-input"]',
    )!;
    const depth = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-depth-input"]',
    )!;

    expect(percent.value).toBe('100.0');
    // Canonical bbox: 100 × 50 × 25 mm.
    expect(width.value).toBe('100.0');
    expect(height.value).toBe('50.0');
    expect(depth.value).toBe('25.0');
  });

  test('current-size readout matches native bbox × identity scale', () => {
    const { container } = mount();
    const readout = container.querySelector<HTMLElement>(
      '[data-testid="dimensions-current"]',
    )!;
    expect(readout.textContent).toContain('100.0');
    expect(readout.textContent).toContain('50.0');
    expect(readout.textContent).toContain('25.0');
    expect(readout.textContent).toContain(i18next.t('units.mm'));
  });

  test('reset button disabled when at defaults', () => {
    const { container } = mount();
    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="dimensions-reset"]',
    )!;
    expect(reset.disabled).toBe(true);
  });

  test('constrain checkbox checked by default', () => {
    const { container } = mount();
    const constrain = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-constrain"]',
    )!;
    expect(constrain.checked).toBe(true);
  });
});

describe('dimensions panel — scale % edit', () => {
  test('editing percent to 200 pushes uniform 2× scale into the store', () => {
    const { container, store } = mount();
    const percent = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-percent-input"]',
    )!;

    percent.value = '200';
    percent.dispatchEvent(new Event('change'));

    const d = store.get();
    expect(d.scaleX).toBeCloseTo(2, 10);
    expect(d.scaleY).toBeCloseTo(2, 10);
    expect(d.scaleZ).toBeCloseTo(2, 10);
  });

  test('editing percent updates axis readouts live via store subscription', () => {
    const { container, store } = mount();
    const percent = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-percent-input"]',
    )!;
    percent.value = '200';
    percent.dispatchEvent(new Event('change'));

    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    expect(width.value).toBe('200.0');
    expect(store.get().scaleX).toBeCloseTo(2, 10);
  });

  test('percent clamps to [10, 1000]', () => {
    const { container, store } = mount();
    const percent = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-percent-input"]',
    )!;

    percent.value = '5000';
    percent.dispatchEvent(new Event('change'));
    expect(store.get().scaleX).toBeCloseTo(10, 10);

    percent.value = '1';
    percent.dispatchEvent(new Event('change'));
    expect(store.get().scaleX).toBeCloseTo(0.1, 10);
  });
});

describe('dimensions panel — axis edit with constrain ON', () => {
  test('editing width 100 → 200 mm applies ratio 2 to all axes', () => {
    const { container, store } = mount();
    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    width.value = '200';
    width.dispatchEvent(new Event('change'));

    const d = store.get();
    expect(d.scaleX).toBeCloseTo(2, 10);
    expect(d.scaleY).toBeCloseTo(2, 10);
    expect(d.scaleZ).toBeCloseTo(2, 10);
  });

  test('height and depth inputs re-render to the scaled values', () => {
    const { container } = mount();
    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    const height = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-height-input"]',
    )!;
    const depth = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-depth-input"]',
    )!;

    width.value = '200';
    width.dispatchEvent(new Event('change'));

    // 50 × 2 = 100, 25 × 2 = 50.
    expect(height.value).toBe('100.0');
    expect(depth.value).toBe('50.0');
  });
});

describe('dimensions panel — axis edit with constrain OFF', () => {
  test('only the edited axis scale changes', () => {
    const { container, store } = mount();
    const constrain = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-constrain"]',
    )!;
    constrain.checked = false;
    constrain.dispatchEvent(new Event('change'));

    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    width.value = '200';
    width.dispatchEvent(new Event('change'));

    const d = store.get();
    expect(d.scaleX).toBeCloseTo(2, 10);
    expect(d.scaleY).toBeCloseTo(1, 10);
    expect(d.scaleZ).toBeCloseTo(1, 10);
  });
});

describe('dimensions panel — units flip', () => {
  test('flipping to inches redisplays axis inputs in inches', () => {
    const { container } = mount();
    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;

    // 100 mm by default.
    expect(width.value).toBe('100.0');

    setUnitSystem('in');
    // 100 mm / 25.4 = 3.937 in (3 decimal places, per formatLength).
    expect(width.value).toBe('3.937');
  });

  test('typing an inches value commits correct mm ratio (constrain ON)', () => {
    const { container, store } = mount();
    setUnitSystem('in');

    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    // 2 inches = 50.8 mm. Native width = 100 mm → ratio 0.508 → all three axes get that ratio.
    width.value = '2';
    width.dispatchEvent(new Event('change'));

    const d = store.get();
    expect(d.scaleX).toBeCloseTo(0.508, 4);
    expect(d.scaleY).toBeCloseTo(0.508, 4);
    expect(d.scaleZ).toBeCloseTo(0.508, 4);
  });

  test('current-size readout swaps to inches label', () => {
    const { container } = mount();
    setUnitSystem('in');
    const readout = container.querySelector<HTMLElement>(
      '[data-testid="dimensions-current"]',
    )!;
    expect(readout.textContent).toContain(i18next.t('units.in'));
  });
});

describe('dimensions panel — reset button', () => {
  test('click restores scale to (1,1,1) and disables again', () => {
    const { container, store } = mount();
    store.update({ scaleX: 2, scaleY: 2, scaleZ: 2 });
    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="dimensions-reset"]',
    )!;
    expect(reset.disabled).toBe(false);

    reset.click();

    const d = store.get();
    expect(d.scaleX).toBe(1);
    expect(d.scaleY).toBe(1);
    expect(d.scaleZ).toBe(1);
    expect(reset.disabled).toBe(true);
  });
});

describe('dimensions panel — no master loaded', () => {
  test('inputs disabled and readout shows placeholder', () => {
    const { container } = mount({ nativeBbox: () => null });

    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    expect(width.disabled).toBe(true);

    const constrain = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-constrain"]',
    )!;
    expect(constrain.disabled).toBe(true);

    const readout = container.querySelector<HTMLElement>(
      '[data-testid="dimensions-current"]',
    )!;
    expect(readout.textContent).toBe(i18next.t('dimensions.noMaster'));
  });

  test('refresh() after a master loads enables inputs + populates mm readouts', () => {
    let bbox: Box3 | null = null;
    const { container, panel } = mount({ nativeBbox: () => bbox });

    const width = container.querySelector<HTMLInputElement>(
      '[data-testid="dimensions-width-input"]',
    )!;
    expect(width.disabled).toBe(true);

    // Simulate a master load.
    bbox = new Box3(new Vector3(0, 0, 0), new Vector3(40, 20, 10));
    panel.refresh();

    expect(width.disabled).toBe(false);
    expect(width.value).toBe('40.0');
  });
});

describe('dimensions panel — i18n', () => {
  test('labels resolve through i18next (no hardcoded English)', () => {
    const { container } = mount();

    expect(
      container.querySelector('.sidebar__title')?.textContent,
    ).toBe(i18next.t('dimensions.title'));

    const resetBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="dimensions-reset"]',
    );
    expect(resetBtn?.textContent).toBe(i18next.t('dimensions.resetSize'));

    // Constrain label text.
    const constrainWrap = container.querySelector('.dimensions-panel__constrain');
    expect(constrainWrap?.textContent).toContain(
      i18next.t('dimensions.constrainProportions'),
    );
  });
});
