// tests/fixtures/meshes/regen.mjs
//
// Thin cross-platform launcher for `pnpm test:fixtures-regen`. Sets
// REGEN_FIXTURES=1 and invokes the regeneration Vitest target. Lives here
// (rather than package.json inline) because Windows cmd and POSIX shells
// disagree on inline-env syntax — this keeps the contract identical on
// both and avoids pulling in `cross-env` as a new runtime dep (issue #8
// hard constraint).
//
// Exit code is propagated so CI treats failures correctly.

/* global process */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');
const testFile = 'tests/fixtures/meshes/regen.test.ts';

// Resolve vitest's CLI entrypoint via Node's resolver so we don't depend on
// PATH or pnpm shell integration.
const vitestBin = (await import('node:module'))
  .createRequire(import.meta.url)
  .resolve('vitest/vitest.mjs');

const child = spawn(
  process.execPath,
  [vitestBin, 'run', testFile],
  {
    cwd: repoRoot,
    env: { ...process.env, REGEN_FIXTURES: '1' },
    stdio: 'inherit',
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
