import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import { resolve } from 'node:path';

/**
 * Vite config for the renderer + vite-plugin-electron for the main / preload
 * bundles. `simple` flavour wires up the dev-server lifecycle for both the
 * renderer and the Electron processes.
 *
 * Output layout (under `dist/`):
 *   dist/main/index.cjs       — main process bundle (referenced by pkg.main)
 *   dist/preload/index.cjs    — preload bundle (loaded via webPreferences.preload)
 *   dist/renderer/index.html  — renderer bundle (loaded via loadFile in prod)
 *
 * Modes:
 *   - default (`vite build`)          → NODE_ENV = 'production'
 *   - test    (`vite build --mode test`) → NODE_ENV = 'test', enables the
 *     `window.__testHooks` exposure in the renderer for Playwright visual
 *     specs. Prod builds tree-shake that block.
 */
export default defineConfig(({ mode }) => ({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  define: {
    // Force-replace `process.env.NODE_ENV` when building in test mode so
    // build-time branches (`if (process.env.NODE_ENV === 'test') { ... }`)
    // light up for the visual-regression bundle. Vite's default replaces
    // `NODE_ENV` with `"production"` for any `vite build` regardless of
    // mode, so we override explicitly.
    ...(mode === 'test'
      ? { 'process.env.NODE_ENV': JSON.stringify('test') }
      : {}),
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    electron({
      main: {
        entry: resolve(__dirname, 'src/main/index.ts'),
        vite: {
          build: {
            outDir: resolve(__dirname, 'dist/main'),
            sourcemap: true,
            minify: false,
            rollupOptions: {
              output: {
                entryFileNames: 'index.cjs',
                format: 'cjs',
              },
              external: ['electron'],
            },
          },
        },
      },
      preload: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        vite: {
          build: {
            outDir: resolve(__dirname, 'dist/preload'),
            sourcemap: 'inline',
            minify: false,
            rollupOptions: {
              output: {
                entryFileNames: 'index.cjs',
                format: 'cjs',
              },
              external: ['electron'],
            },
          },
        },
      },
      // Renderer is a stock Vite SPA; no Node integration here, so the
      // vite-plugin-electron-renderer is intentionally omitted.
    }),
  ],
}));
