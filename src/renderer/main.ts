/**
 * Renderer entry point. Placeholder only — no Three.js scene in this PR.
 * Populates the version string via the typed IPC bridge.
 *
 * The `window.api` surface is declared in ./types.d.ts (picked up via the
 * tsconfig include).
 */

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

document.addEventListener('DOMContentLoaded', () => {
  void hydrateVersion();
});
