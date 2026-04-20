// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat ESLint config (ESLint 9+).
 *
 * - Typed TS rules via typescript-eslint.
 * - Three environments: main (Node), preload (Node + partial DOM), renderer (DOM).
 * - Forbid `fs` / `child_process` / raw `ipcRenderer` in renderer code via a
 *   no-restricted-imports rule scoped to src/renderer/**.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'tests/__screenshots__/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports' },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Hard security boundary: renderer code can never pull these in.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message: 'Renderer code must not access fs directly. Route through window.api (IPC).',
            },
            {
              name: 'node:fs',
              message: 'Renderer code must not access fs directly. Route through window.api (IPC).',
            },
            {
              name: 'child_process',
              message: 'Renderer code must not spawn processes. Route through window.api (IPC).',
            },
            {
              name: 'node:child_process',
              message: 'Renderer code must not spawn processes. Route through window.api (IPC).',
            },
            {
              name: 'electron',
              importNames: ['ipcRenderer'],
              message: 'Never import ipcRenderer in renderer code. Use window.api from the typed preload bridge.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'playwright.config.ts', 'vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
