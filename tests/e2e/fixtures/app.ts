import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Launch helper for Playwright Electron tests.
 *
 * Assumes `pnpm build` (or at minimum `vite build`) has produced `dist/main/`,
 * `dist/preload/`, and `dist/renderer/` beforehand. The Playwright config is
 * intentionally non-opinionated about triggering the build — the CI job and
 * developer scripts both run `pnpm build` before `pnpm test:e2e`.
 */
export async function launchApp(): Promise<ElectronApplication> {
  // Launch from the project root so Electron picks up the root package.json
  // (for `app.getVersion()` and the `main` entry).
  const projectRoot = resolve(__dirname, '..', '..', '..');
  // Strip ELECTRON_RUN_AS_NODE if it leaked in from the parent shell
  // (VS Code sets this and it forces Electron into pure-Node mode).
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env['NODE_ENV'] = 'test';
  delete env['ELECTRON_RUN_AS_NODE'];
  return electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env,
  });
}
