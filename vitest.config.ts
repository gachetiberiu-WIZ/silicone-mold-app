import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config. Picked up by `pnpm test`.
 *
 * - Uses the project root as test root so `tests/unit/**` is discovered.
 * - `passWithNoTests: true` so the app-shell skeleton passes before any
 *   geometry/UI unit tests exist. Flip to false once we have real coverage.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  test: {
    include: ['tests/unit/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'release/**'],
    passWithNoTests: true,
    environment: 'node',
  },
});
