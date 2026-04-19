/**
 * Renderer entry point.
 *
 * Hydrates the version string via the typed IPC bridge and mounts the
 * Three.js viewport into `#viewport`. The `window.api` surface is declared
 * in ./types.d.ts (picked up via the tsconfig include).
 *
 * No STL loading, no parting-plane widget, no mesh-bvh wiring — those land
 * in later PRs. This file is deliberately thin.
 */

import { mount } from './scene/viewport';

async function hydrateVersion(): Promise<void> {
  const el = document.querySelector<HTMLSpanElement>('[data-testid="app-version"]');
  if (!el) return;
  try {
    const version = await window.api.getVersion();
    el.textContent = `v${version}`;
  } catch (err) {
    console.error('Failed to fetch app version', err);
    el.textContent = 'v?';
  }
}

function mountViewport(): void {
  const container = document.getElementById('viewport');
  if (!container) {
    console.error('Missing #viewport container — renderer HTML is out of date.');
    return;
  }
  mount(container);
}

document.addEventListener('DOMContentLoaded', () => {
  mountViewport();
  void hydrateVersion();
});
