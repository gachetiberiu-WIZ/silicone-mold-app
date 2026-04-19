/**
 * electron-builder configuration.
 *
 * - Windows-only target (v1 scope is Windows per ADR-001).
 * - NSIS installer, per-user one-click (no UAC prompt for a single-user tool).
 * - Icon placeholder: electron-builder will fall back to its default if
 *   `build/icon.ico` is missing.
 */
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.tiberiugache.silicone-mold-app',
  productName: 'Silicone Mold App',
  copyright: `Copyright (C) ${new Date().getFullYear()} Tiberiu Gache`,

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  files: [
    'dist/**/*',
    'package.json',
    '!**/{.DS_Store,Thumbs.db,*.map}',
  ],

  asar: true,

  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    // icon: 'build/icon.ico', // optional; electron-builder uses default when absent
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Silicone Mold App',
  },

  // Publish is left empty — no auto-updater in this PR.
  publish: null,
};
