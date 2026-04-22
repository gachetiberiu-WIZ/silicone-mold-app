// tests/main/ipc-exportMoldParts.test.ts
//
// Unit tests for the main-process `file:export-mold-parts` handler's
// validation + write plumbing (issue #91). Primary focus:
//
//   - `isValidExportFilename` rejects every unsafe shape we can think of
//     (path separators, absolute paths, `..`, reserved Windows names,
//     wrong extensions, Unicode, controls).
//   - `EXPORT_FILENAME_PATTERN` accepts the deterministic renderer-side
//     names (`base-slab.stl`, `shell-piece-0.stl`, …).
//
// We don't exercise the electron side here (dialog + write-file); that's
// integration territory and lives in the E2E round-trip spec. The
// validator itself is plain JS — no electron import needed at runtime,
// but ipc.ts DOES import `electron` statically, so we mock it at
// module-scope so the Vitest Node environment doesn't blow up.

import { describe, expect, test, vi } from 'vitest';

// Mock `electron` so ipc.ts's top-level imports resolve in Node. We
// never call any of these in this spec — the validator path is
// pure-JS — but static analysis still reaches for them.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
}));

// Mock the dialogs module for the same reason — it imports electron
// statically.
vi.mock('@/main/dialogs', () => ({
  showOpenStl: vi.fn(),
  showSaveStl: vi.fn(),
  showOpenFolder: vi.fn(),
}));

import {
  EXPORT_FILENAME_PATTERN,
  isValidExportFilename,
} from '@/main/ipc';

describe('EXPORT_FILENAME_PATTERN', () => {
  test('accepts the deterministic renderer-side filenames', () => {
    expect(EXPORT_FILENAME_PATTERN.test('base-slab.stl')).toBe(true);
    expect(EXPORT_FILENAME_PATTERN.test('shell-piece-0.stl')).toBe(true);
    expect(EXPORT_FILENAME_PATTERN.test('shell-piece-10.stl')).toBe(true);
    expect(EXPORT_FILENAME_PATTERN.test('My_File.123.stl')).toBe(true);
  });

  test('is case-insensitive on the extension', () => {
    expect(EXPORT_FILENAME_PATTERN.test('part.STL')).toBe(true);
    expect(EXPORT_FILENAME_PATTERN.test('part.Stl')).toBe(true);
  });
});

describe('isValidExportFilename — acceptance', () => {
  test.each([
    'base-slab.stl',
    'shell-piece-0.stl',
    'shell-piece-7.stl',
    'a.stl',
    'A_B-C.123.stl',
  ])('accepts %s', (name) => {
    expect(isValidExportFilename(name)).toBe(true);
  });
});

describe('isValidExportFilename — rejection', () => {
  test.each([
    ['forward slash path', '../escape.stl'],
    ['bare traversal', '..'],
    ['dot only', '.'],
    ['forward slash', 'subdir/file.stl'],
    ['backslash', 'subdir\\file.stl'],
    ['absolute posix', '/etc/passwd.stl'],
    ['absolute windows', 'C:/Windows/evil.stl'],
    ['windows drive', 'C:evil.stl'],
    ['UNC path', '\\\\server\\share.stl'],
    ['space', 'my file.stl'],
    ['unicode', 'café.stl'],
    ['newline', 'file\n.stl'],
    ['null byte', 'file\0.stl'],
    ['tab', 'file\t.stl'],
    ['empty string', ''],
    ['wrong extension', 'file.obj'],
    ['no extension', 'file'],
    ['control char', 'file\x01.stl'],
    ['tilde', 'file~.stl'],
    ['percent', 'file%.stl'],
    ['question mark', 'file?.stl'],
    ['star', 'file*.stl'],
  ])('rejects %s (%s)', (_desc, name) => {
    expect(isValidExportFilename(name)).toBe(false);
  });

  test.each([
    ['CON.stl'],
    ['con.stl'],
    ['Con.STL'],
    ['PRN.stl'],
    ['AUX.stl'],
    ['NUL.stl'],
    ['COM1.stl'],
    ['COM9.stl'],
    ['LPT1.stl'],
    ['LPT9.stl'],
  ])('rejects reserved Windows name %s', (name) => {
    expect(isValidExportFilename(name)).toBe(false);
  });

  test('rejects non-string inputs defensively', () => {
    expect(isValidExportFilename(undefined as unknown as string)).toBe(false);
    expect(isValidExportFilename(null as unknown as string)).toBe(false);
    expect(isValidExportFilename(42 as unknown as string)).toBe(false);
  });
});
