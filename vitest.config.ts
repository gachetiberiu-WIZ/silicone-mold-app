// vitest.config.ts
//
// Unit-test configuration. Scopes Vitest to `tests/**/*.test.ts` and wires in
// the global setup file that registers `toEqualWithTolerance`.
//
// Coverage provider is v8. Per ADR-003 §E the 70% line threshold on the
// geometry module is flagged but *not* enforced until any `src/geometry/`
// code actually lands — enforcing now would hard-fail CI on an empty target.
// The `include` glob pins the scope so we'll enforce the moment files land.

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./src'),
      '@fixtures': r('./tests/fixtures'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Playwright specs live under tests/visual/**/*.spec.ts; keep them out of Vitest.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/visual/**',
      'tests/e2e/**',
    ],
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    globals: false,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/geometry/**'],
      // Enforced from issue #9 onward per ADR-003 §E and the issue's AC.
      // The test-only `__resetManifoldForTests` escape hatch is excluded so
      // it doesn't suppress the real threshold.
      exclude: ['src/geometry/**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,
      },
      reportOnFailure: true,
    },
  },
});
