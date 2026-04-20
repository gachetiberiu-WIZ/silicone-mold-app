// tests/renderer/ui/topbar.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the topbar component (issue #40 extension of the
// existing topbar). Covers:
//
//   1. Three labelled volume readouts render with i18n labels and sane
//      test ids (master / silicone / resin).
//   2. `setSiliconeVolume` / `setResinVolume` push formatted numbers into
//      their respective value spans.
//   3. `null` → formatter empty-state for every readout.
//   4. Unit flip (`setUnits('in')`) updates all three readouts in a single
//      pass — no stale mm-formatted text on a silicone/resin value.
//   5. Back-compat: `setVolume` is an alias for `setMasterVolume` and
//      does NOT touch silicone / resin.
//
// The existing topbar-units visual spec (tests/visual/topbar-units.spec.ts)
// continues to own the accent-colour / layout snapshots.

import i18next from 'i18next';
import { beforeEach, describe, expect, test } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { mountTopbar } from '@/renderer/ui/topbar';

function mount(): HTMLElement {
  const header = document.createElement('header');
  header.dataset['testid'] = 'topbar';
  document.body.appendChild(header);
  return header;
}

beforeEach(() => {
  document.body.innerHTML = '';
  try {
    window.localStorage.removeItem('units');
  } catch {
    /* ignore */
  }
  initI18n();
});

describe('topbar — three volume readouts', () => {
  test('mounts master + silicone + resin readouts with i18n labels', () => {
    const header = mount();
    mountTopbar(header);

    const masterLabel = header.querySelector<HTMLElement>(
      '[data-testid="volume-readout"] .topbar__volume-label',
    );
    const siliconeLabel = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"] .topbar__volume-label',
    );
    const resinLabel = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-readout"] .topbar__volume-label',
    );

    expect(masterLabel?.textContent).toBe(
      `${i18next.t('topbar.volumeMaster')}:`,
    );
    expect(siliconeLabel?.textContent).toBe(
      `${i18next.t('topbar.volumeSilicone')}:`,
    );
    expect(resinLabel?.textContent).toBe(
      `${i18next.t('topbar.volumeResin')}:`,
    );
  });

  test('initial state: master shows "no master loaded"; silicone + resin show "click generate"', () => {
    // Silicone + resin use a different empty-state ("Click Generate") from
    // master because a null value means "master loaded but not generated
    // yet" — which is distinct from "no STL open".
    const header = mount();
    mountTopbar(header);

    const noMaster = i18next.t('volume.none');
    const notGenerated = i18next.t('volume.notGenerated');
    const master = header.querySelector<HTMLElement>(
      '[data-testid="volume-value"]',
    );
    const silicone = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-value"]',
    );
    const resin = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    );
    expect(master?.textContent).toBe(noMaster);
    expect(silicone?.textContent).toBe(notGenerated);
    expect(resin?.textContent).toBe(notGenerated);
  });
});

describe('topbar — setSiliconeVolume / setResinVolume', () => {
  test('setSiliconeVolume(100_000) renders "100,000 mm³" in mm mode', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setSiliconeVolume(100_000);

    const silicone = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-value"]',
    );
    expect(silicone?.textContent).toBe('100,000 mm\u00B3');
  });

  test('setSiliconeVolume(null) reverts to "click generate" placeholder', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setSiliconeVolume(100_000);
    api.setSiliconeVolume(null);

    const silicone = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-value"]',
    );
    expect(silicone?.textContent).toBe(i18next.t('volume.notGenerated'));
  });

  test('setResinVolume(127_451.6) renders "127,452 mm³" (rounded)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setResinVolume(127_451.6);

    const resin = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    );
    expect(resin?.textContent).toBe('127,452 mm\u00B3');
  });

  test('setResinVolume(null) reverts to "click generate" placeholder', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setResinVolume(5000);
    api.setResinVolume(null);

    const resin = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    );
    expect(resin?.textContent).toBe(i18next.t('volume.notGenerated'));
  });

  test('the three setters are independent (setting one does not clobber the others)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setMasterVolume(127_451.6);
    api.setSiliconeVolume(319_914);
    api.setResinVolume(127_451.6);

    expect(
      header.querySelector<HTMLElement>('[data-testid="volume-value"]')
        ?.textContent,
    ).toBe('127,452 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>(
        '[data-testid="silicone-volume-value"]',
      )?.textContent,
    ).toBe('319,914 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe('127,452 mm\u00B3');
  });
});

describe('topbar — units flip updates all readouts', () => {
  test('mm → in re-formats master, silicone, and resin in a single pass', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setMasterVolume(127_451.6);
    api.setSiliconeVolume(319_914);
    api.setResinVolume(127_451.6);

    api.setUnits('in');

    // 1 in³ = 16 387.064 mm³. 127 451.6 / 16 387.064 ≈ 7.778 in³.
    // The formatter fixes 3 decimals with en-US grouping (no grouping
    // under 10 000 in³).
    const masterText = header.querySelector<HTMLElement>(
      '[data-testid="volume-value"]',
    )?.textContent;
    const resinText = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    )?.textContent;
    const siliconeText = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-value"]',
    )?.textContent;

    expect(masterText).toMatch(/\d+\.\d{3} in\u00B3$/);
    expect(siliconeText).toMatch(/\d+\.\d{3} in\u00B3$/);
    expect(resinText).toMatch(/\d+\.\d{3} in\u00B3$/);
    // Specifically: master + resin happen to share the same volume, so
    // their textual representations should match exactly.
    expect(masterText).toBe(resinText);
  });

  test('units-changed DOM event also re-formats all three readouts', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setMasterVolume(16_387.064);
    api.setSiliconeVolume(16_387.064);
    api.setResinVolume(16_387.064);

    document.dispatchEvent(
      new CustomEvent('units-changed', { detail: 'in' }),
    );

    const expectIn = '1.000 in\u00B3';
    expect(
      header.querySelector<HTMLElement>('[data-testid="volume-value"]')
        ?.textContent,
    ).toBe(expectIn);
    expect(
      header.querySelector<HTMLElement>(
        '[data-testid="silicone-volume-value"]',
      )?.textContent,
    ).toBe(expectIn);
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe(expectIn);
  });
});

describe('topbar — back-compat setVolume alias', () => {
  test('setVolume updates only the master readout (silicone / resin untouched)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setSiliconeVolume(200);
    api.setResinVolume(300);
    api.setVolume(100);

    expect(
      header.querySelector<HTMLElement>('[data-testid="volume-value"]')
        ?.textContent,
    ).toBe('100 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>(
        '[data-testid="silicone-volume-value"]',
      )?.textContent,
    ).toBe('200 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe('300 mm\u00B3');
  });
});
