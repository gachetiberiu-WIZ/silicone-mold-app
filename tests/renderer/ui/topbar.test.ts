// tests/renderer/ui/topbar.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the topbar component (Wave C extension, issue #72).
// Post-Wave-C the topbar has FOUR volume readouts (master / silicone /
// print shell / resin). Covers:
//
//   1. Four labelled volume readouts render with i18n labels and sane
//      test ids.
//   2. `setSiliconeVolume` / `setPrintShellVolume` / `setResinVolume`
//      push formatted numbers into their respective value spans.
//   3. `null` → formatter empty-state for every readout.
//   4. Unit flip (`setUnits('in')`) updates all four readouts in a single
//      pass — no stale mm-formatted text on any generated value.
//   5. Back-compat: `setVolume` is an alias for `setMasterVolume` and
//      does NOT touch silicone / print-shell / resin.
//   6. `setVolumesStale(true)` marks silicone + print-shell + resin
//      readouts stale; master stays bright.

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

describe('topbar — four volume readouts', () => {
  test('mounts master + silicone + print-shell + resin readouts with i18n labels', () => {
    const header = mount();
    mountTopbar(header);

    const masterLabel = header.querySelector<HTMLElement>(
      '[data-testid="volume-readout"] .topbar__volume-label',
    );
    const siliconeLabel = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"] .topbar__volume-label',
    );
    const printShellLabel = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-readout"] .topbar__volume-label',
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
    expect(printShellLabel?.textContent).toBe(
      `${i18next.t('topbar.volumePrintShell')}:`,
    );
    expect(resinLabel?.textContent).toBe(
      `${i18next.t('topbar.volumeResin')}:`,
    );
  });

  test('initial state: master shows "no master loaded"; silicone/print-shell/resin show "click generate"', () => {
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
    const printShell = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-value"]',
    );
    const resin = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    );
    expect(master?.textContent).toBe(noMaster);
    expect(silicone?.textContent).toBe(notGenerated);
    expect(printShell?.textContent).toBe(notGenerated);
    expect(resin?.textContent).toBe(notGenerated);
  });
});

describe('topbar — setSiliconeVolume / setPrintShellVolume / setResinVolume', () => {
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

  test('setPrintShellVolume(455_000) renders "455,000 mm³" in mm mode', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setPrintShellVolume(455_000);

    const printShell = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-value"]',
    );
    expect(printShell?.textContent).toBe('455,000 mm\u00B3');
  });

  test('setPrintShellVolume(null) reverts to "click generate" placeholder', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setPrintShellVolume(455_000);
    api.setPrintShellVolume(null);

    const printShell = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-value"]',
    );
    expect(printShell?.textContent).toBe(i18next.t('volume.notGenerated'));
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

  test('the four setters are independent (setting one does not clobber the others)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setMasterVolume(127_451.6);
    api.setSiliconeVolume(319_914);
    api.setPrintShellVolume(455_000);
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
      header.querySelector<HTMLElement>(
        '[data-testid="print-shell-volume-value"]',
      )?.textContent,
    ).toBe('455,000 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe('127,452 mm\u00B3');
  });
});

describe('topbar — units flip updates all readouts', () => {
  test('mm → in re-formats master, silicone, print-shell, and resin in a single pass', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setMasterVolume(127_451.6);
    api.setSiliconeVolume(319_914);
    api.setPrintShellVolume(455_000);
    api.setResinVolume(127_451.6);

    api.setUnits('in');

    // 1 in³ = 16 387.064 mm³. 127 451.6 / 16 387.064 ≈ 7.778 in³.
    const masterText = header.querySelector<HTMLElement>(
      '[data-testid="volume-value"]',
    )?.textContent;
    const resinText = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-value"]',
    )?.textContent;
    const siliconeText = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-value"]',
    )?.textContent;
    const printShellText = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-value"]',
    )?.textContent;

    expect(masterText).toMatch(/\d+\.\d{3} in\u00B3$/);
    expect(siliconeText).toMatch(/\d+\.\d{3} in\u00B3$/);
    expect(printShellText).toMatch(/\d+\.\d{3} in\u00B3$/);
    expect(resinText).toMatch(/\d+\.\d{3} in\u00B3$/);
    // master + resin share the same volume, so their textual
    // representations match exactly.
    expect(masterText).toBe(resinText);
  });

  test('units-changed DOM event also re-formats all four readouts', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setMasterVolume(16_387.064);
    api.setSiliconeVolume(16_387.064);
    api.setPrintShellVolume(16_387.064);
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
      header.querySelector<HTMLElement>(
        '[data-testid="print-shell-volume-value"]',
      )?.textContent,
    ).toBe(expectIn);
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe(expectIn);
  });
});

describe('topbar — stale indicator (issue #64, Option A)', () => {
  // `setVolumesStale(true)` marks silicone + print-shell + resin with
  // `is-stale`. Master is never stale.
  test('setVolumesStale(true) adds is-stale to silicone + print-shell + resin wraps, not master', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setMasterVolume(1000);
    api.setSiliconeVolume(2000);
    api.setPrintShellVolume(3000);
    api.setResinVolume(500);

    api.setVolumesStale(true);

    const masterWrap = header.querySelector<HTMLElement>(
      '[data-testid="volume-readout"]',
    );
    const siliconeWrap = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"]',
    );
    const printShellWrap = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-readout"]',
    );
    const resinWrap = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-readout"]',
    );

    expect(masterWrap?.classList.contains('is-stale')).toBe(false);
    expect(siliconeWrap?.classList.contains('is-stale')).toBe(true);
    expect(printShellWrap?.classList.contains('is-stale')).toBe(true);
    expect(resinWrap?.classList.contains('is-stale')).toBe(true);
    expect(api.isVolumesStale()).toBe(true);
  });

  test('setVolumesStale(false) clears is-stale from every generated readout', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setVolumesStale(true);
    api.setVolumesStale(false);

    const siliconeWrap = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"]',
    );
    const printShellWrap = header.querySelector<HTMLElement>(
      '[data-testid="print-shell-volume-readout"]',
    );
    const resinWrap = header.querySelector<HTMLElement>(
      '[data-testid="resin-volume-readout"]',
    );
    expect(siliconeWrap?.classList.contains('is-stale')).toBe(false);
    expect(printShellWrap?.classList.contains('is-stale')).toBe(false);
    expect(resinWrap?.classList.contains('is-stale')).toBe(false);
    expect(api.isVolumesStale()).toBe(false);
  });

  test('idempotent setVolumesStale (same value twice is a no-op)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setVolumesStale(true);
    api.setVolumesStale(true);
    const siliconeWrap = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"]',
    );
    expect(siliconeWrap?.className.match(/is-stale/g)?.length).toBe(1);
  });

  test('stale state survives a subsequent setSiliconeVolume call', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setSiliconeVolume(1000);
    api.setVolumesStale(true);
    api.setSiliconeVolume(2000);
    const siliconeWrap = header.querySelector<HTMLElement>(
      '[data-testid="silicone-volume-readout"]',
    );
    expect(siliconeWrap?.classList.contains('is-stale')).toBe(true);
  });
});

describe('topbar — back-compat setVolume alias', () => {
  test('setVolume updates only the master readout (silicone / print-shell / resin untouched)', () => {
    const header = mount();
    const api = mountTopbar(header);
    api.setUnits('mm');
    api.setSiliconeVolume(200);
    api.setPrintShellVolume(250);
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
      header.querySelector<HTMLElement>(
        '[data-testid="print-shell-volume-value"]',
      )?.textContent,
    ).toBe('250 mm\u00B3');
    expect(
      header.querySelector<HTMLElement>('[data-testid="resin-volume-value"]')
        ?.textContent,
    ).toBe('300 mm\u00B3');
  });
});
