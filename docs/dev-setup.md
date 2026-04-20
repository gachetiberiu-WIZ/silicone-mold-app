# Dev setup notes

## `pnpm dev` and `ELECTRON_RUN_AS_NODE`

`pnpm dev` runs through `scripts/dev.mjs`, a tiny Node wrapper that `delete`s `process.env.ELECTRON_RUN_AS_NODE` before spawning Vite. This matters because VS Code's own Electron host (and any shell spawned from inside it, including the Bash tool used by Claude Code) inherits `ELECTRON_RUN_AS_NODE=1`. If that leaks into `electron .`, Electron runs the main script as plain Node, `require('electron')` returns a path string, and the main process crashes on `app.whenReady()`. `cross-env ELECTRON_RUN_AS_NODE= vite` does **not** work here: cross-env (verified v7 and v10) passes an empty string through rather than unsetting, and Electron treats any *defined* value of the var — including `""` — as "run as Node". Only `delete` works, hence the wrapper script. Do not remove it without replacing it with an equivalent unset.
