// tests/renderer/ui/exportStl.test.ts
//
// @vitest-environment happy-dom
//
// Unit coverage for `mountExportStlButton` (issue #91). The module
// owns:
//   - button lifecycle (enabled / label / tooltip)
//   - click-time geometry conversion (Manifold → STL ArrayBuffer)
//   - IPC call fan-out + toast handling
//
// Geometry isn't exercised for real — we mock `manifoldToBufferGeometry`
// so the test doesn't need the manifold-3d WASM kernel or three.js
// STLExporter to run. The focus is the wiring: did we build the right
// `files` array, in the right order, did we show the right toast on
// each branch?

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import type { Manifold } from 'manifold-3d';

import { initI18n } from '@/renderer/i18n';
import {
  __resetForTests as resetToast,
  currentMessage,
} from '@/renderer/ui/errorToast';
import { mountExportStlButton } from '@/renderer/ui/exportStl';

// Mock the geometry adapter. Each call returns a tiny BufferGeometry
// with a single triangle (9 floats). That gives `STLExporter` a real
// mesh to serialise and lets us assert the resulting binary STL shape
// at the IPC boundary.
vi.mock('@/geometry/adapters', () => {
  return {
    manifoldToBufferGeometry: vi.fn(async () => {
      const bg = new BufferGeometry();
      const positions = new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
      ]);
      bg.setAttribute('position', new BufferAttribute(positions, 3));
      bg.computeVertexNormals();
      return bg;
    }),
  };
});

function fakeManifold(): Manifold {
  return { delete: vi.fn<() => void>() } as unknown as Manifold;
}

function getBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="export-stl-btn"]',
  );
  if (!btn) throw new Error('export-stl-btn missing');
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetToast();
  initI18n();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mountExportStlButton — initial state', () => {
  test('renders disabled by default with the disabled tooltip', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountExportStlButton(host, {
      getExportables: () => null,
    });
    const btn = getBtn();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Export STL');
    expect(btn.title).toBe('Generate a mold first to export');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  test('setEnabled(true) enables the button; setEnabled(false) disables it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountExportStlButton(host, {
      getExportables: () => null,
    });
    api.setEnabled(true);
    expect(getBtn().disabled).toBe(false);
    expect(getBtn().getAttribute('aria-disabled')).toBe('false');

    api.setEnabled(false);
    expect(getBtn().disabled).toBe(true);
    expect(getBtn().getAttribute('aria-disabled')).toBe('true');
  });

  test('setTooltip swaps between disabled / stale / none', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountExportStlButton(host, {
      getExportables: () => null,
    });
    api.setTooltip('stale');
    expect(getBtn().title).toBe('Regenerate before exporting (parameters changed)');
    api.setTooltip('disabled');
    expect(getBtn().title).toBe('Generate a mold first to export');
    api.setTooltip('none');
    expect(getBtn().title).toBe('');
  });
});

describe('mountExportStlButton — click handler', () => {
  test('click with null exportables shows error toast and does NOT call IPC', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const ipc = vi.fn();
    const api = mountExportStlButton(host, {
      getExportables: () => null,
      exportMoldParts: ipc,
    });
    api.setEnabled(true);
    getBtn().click();
    // Allow the click-handler microtasks to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc).not.toHaveBeenCalled();
    expect(currentMessage()).toBe('Generate a mold first to export');
  });

  test('click with valid exportables calls IPC with the deterministic file list', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const basePart = fakeManifold();
    const shellPieces = [fakeManifold(), fakeManifold(), fakeManifold()];
    const ipc = vi
      .fn<
        (req: {
          files: Array<{ data: ArrayBuffer; filename: string }>;
        }) => Promise<{ canceled: false; folder: string; written: string[] }>
      >()
      .mockImplementation(async (req) => ({
        canceled: false,
        folder: '/tmp/out',
        written: req.files.map((f) => f.filename),
      }));
    const api = mountExportStlButton(host, {
      getExportables: () => ({ basePart, shellPieces }),
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    // Exporting… label should appear while IPC is in flight.
    await new Promise((r) => setTimeout(r, 0));
    // Wait for the click handler's async chain.
    await vi.waitFor(() => expect(ipc).toHaveBeenCalledTimes(1));

    const req = ipc.mock.calls[0]![0];
    expect(req.files).toHaveLength(4); // basePart + 3 shell pieces
    expect(req.files[0]!.filename).toBe('base-slab.stl');
    expect(req.files[1]!.filename).toBe('shell-piece-0.stl');
    expect(req.files[2]!.filename).toBe('shell-piece-1.stl');
    expect(req.files[3]!.filename).toBe('shell-piece-2.stl');
    // Each data field is an ArrayBuffer of non-trivial length.
    for (const f of req.files) {
      expect(f.data).toBeInstanceOf(ArrayBuffer);
      expect(f.data.byteLength).toBeGreaterThan(80); // STL header min size
    }
    // Manifolds must NOT be deleted — ownership belongs to the scene.
    expect(basePart.delete).not.toHaveBeenCalled();
    for (const p of shellPieces) expect(p.delete).not.toHaveBeenCalled();
  });

  test('successful IPC response shows success toast with count + folder', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parts = { basePart: fakeManifold(), shellPieces: [fakeManifold()] };
    const ipc = vi.fn().mockResolvedValue({
      canceled: false,
      folder: '/Users/dev/mold',
      written: ['base-slab.stl', 'shell-piece-0.stl'],
    });
    const api = mountExportStlButton(host, {
      getExportables: () => parts,
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    await vi.waitFor(() =>
      expect(currentMessage()).toBe(
        'Exported 2 files to /Users/dev/mold',
      ),
    );
  });

  test('canceled IPC response shows NO toast', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parts = { basePart: fakeManifold(), shellPieces: [fakeManifold()] };
    const ipc = vi.fn().mockResolvedValue({ canceled: true });
    const api = mountExportStlButton(host, {
      getExportables: () => parts,
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    // Wait for the full async chain to settle.
    await vi.waitFor(() => expect(ipc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(currentMessage()).toBe('');
  });

  test('partial-success response shows partial toast with counts', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parts = {
      basePart: fakeManifold(),
      shellPieces: [fakeManifold(), fakeManifold(), fakeManifold()],
    };
    const ipc = vi.fn().mockResolvedValue({
      canceled: false,
      error: 'write-failed',
      folder: '/tmp/out',
      written: ['base-slab.stl', 'shell-piece-0.stl'],
    });
    const api = mountExportStlButton(host, {
      getExportables: () => parts,
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    await vi.waitFor(() =>
      expect(currentMessage()).toBe(
        'Exported 2 of 4 files to /tmp/out before error',
      ),
    );
  });

  test('total-failure response (no folder, no written) shows generic error toast', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parts = { basePart: fakeManifold(), shellPieces: [fakeManifold()] };
    const ipc = vi.fn().mockResolvedValue({
      canceled: false,
      error: 'write-failed',
      written: [],
    });
    const api = mountExportStlButton(host, {
      getExportables: () => parts,
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    await vi.waitFor(() => expect(currentMessage()).toBe('Failed to export STL'));
  });

  test('IPC rejection shows error toast + re-enables the button', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parts = { basePart: fakeManifold(), shellPieces: [fakeManifold()] };
    const ipc = vi.fn().mockRejectedValue(new Error('ipc blew up'));
    // Silence the module's console.error for this case.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = mountExportStlButton(host, {
      getExportables: () => parts,
      exportMoldParts: ipc as unknown as (typeof window)['api']['exportMoldParts'],
    });
    api.setEnabled(true);
    getBtn().click();
    await vi.waitFor(() => expect(currentMessage()).toBe('Failed to export STL'));
    // Button should be re-enabled after the error.
    expect(getBtn().disabled).toBe(false);
    errorSpy.mockRestore();
  });
});

describe('mountExportStlButton — destroy', () => {
  test('removes the button from the DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountExportStlButton(host, {
      getExportables: () => null,
    });
    expect(
      document.querySelector('[data-testid="export-stl-btn"]'),
    ).not.toBeNull();
    api.destroy();
    expect(
      document.querySelector('[data-testid="export-stl-btn"]'),
    ).toBeNull();
  });
});
