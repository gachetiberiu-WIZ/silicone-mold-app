#!/usr/bin/env node
/**
 * Wrapper for `pnpm dev` that deletes ELECTRON_RUN_AS_NODE from the
 * inherited environment before spawning Vite.
 *
 * Why: VS Code's own Electron host (and any shell spawned from inside it,
 * including Claude Code's Bash tool) inherits ELECTRON_RUN_AS_NODE=1. If that
 * leaks into `electron .`, Electron runs the main script as plain Node,
 * `require('electron')` returns a path string, and the main process crashes
 * on `app.whenReady()`.
 *
 * We cannot use `cross-env ELECTRON_RUN_AS_NODE= vite` for this — `cross-env`
 * (v7 and v10, verified 2026-04-19) passes an empty string through rather
 * than unsetting, and Electron treats any *defined* value of
 * ELECTRON_RUN_AS_NODE (including '') as "run as Node". Only `delete` works.
 * See issue #28 for full diagnosis.
 *
 * Do not remove this wrapper without replacing it with an equivalent unset.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

// Resolve Vite's CLI entry point from the local install so we can invoke it
// directly with Node (no shell, no PATH lookup, no .cmd shim quirks).
const require = createRequire(import.meta.url);
const vitePkgPath = require.resolve('vite/package.json');
const vitePkg = require('vite/package.json');
const viteBin = typeof vitePkg.bin === 'string' ? vitePkg.bin : vitePkg.bin.vite;
const viteEntry = path.resolve(path.dirname(vitePkgPath), viteBin);

const forwardedArgs = process.argv.slice(2);
const child = spawn(process.execPath, [viteEntry, ...forwardedArgs], {
  stdio: 'inherit',
  env: process.env,
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('exit', (code, signal) => {
  if (code !== null) {
    process.exit(code);
  } else if (signal === 'SIGINT') {
    process.exit(0);
  } else {
    process.exit(1);
  }
});
