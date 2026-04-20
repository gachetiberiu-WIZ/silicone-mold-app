// tests/renderer/ui/dropZone.test.ts
//
// @vitest-environment happy-dom
//
// Unit-level coverage for the drag-and-drop STL handler (issue #27).
//
// What this covers that the E2E spec does not:
//   - The `dragenter` counter: the `.dropzone--active` class survives
//     nested child enter/leave events (bug if the outline flickers off
//     when the cursor crosses the WebGL canvas boundary).
//   - Every validation rule (wrong extension, multi-file, too-large,
//     zero-file) maps to the right error code + localised message.
//   - The file is read via `File.arrayBuffer()` — i.e. the renderer-safe
//     path, not `file.path`. A synthetic `File` with the host-forbidden
//     `.path` property would *not* be consulted by production code.
//   - `destroy()` removes listeners and clears the active-state class.

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { attachDropZone } from '@/renderer/ui/dropZone';
import { OPEN_STL_MAX_BYTES } from '@shared/ipc-contracts';

/**
 * Build a DragEvent with a synthetic DataTransfer. happy-dom doesn't ship
 * a full DataTransfer implementation, so we fake only the two fields the
 * handler reads: `types` and `files`. `dropEffect` is writable per the
 * HTML spec and our handler sets it during dragover.
 */
function makeDragEvent(
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  files: File[],
  includeFilesType = true,
): DragEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  const fileList = {
    length: files.length,
    item: (i: number): File | null => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f;
    },
  } as unknown as FileList;
  // Copy index accessors onto the FileList — downstream code indexes it.
  for (let i = 0; i < files.length; i++) {
    (fileList as unknown as Record<number, File>)[i] = files[i] as File;
  }
  const dataTransfer = {
    types: includeFilesType ? ['Files'] : [],
    files: fileList,
    dropEffect: 'none',
  } as unknown as DataTransfer;
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    writable: false,
  });
  return event;
}

/**
 * Build a File whose `arrayBuffer()` returns a fresh buffer of the given
 * byte length. Bytes are zeroed; the dropZone doesn't parse STL content.
 */
function makeFile(name: string, sizeBytes: number): File {
  const bytes = new Uint8Array(Math.max(1, Math.min(sizeBytes, 1024)));
  // Spoof `size` to allow "pretend to be huge" cases without allocating
  // a gigabyte. Real File objects derive size from their body; happy-dom
  // copies this flag through.
  const file = new File([bytes], name, { type: 'model/stl' });
  Object.defineProperty(file, 'size', { value: sizeBytes, writable: false });
  return file;
}

let target: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = '';
  target = document.createElement('div');
  document.body.appendChild(target);
  initI18n();
});

describe('dropZone — dragenter/dragleave highlight', () => {
  test('adds .dropzone--active on first dragenter carrying files', () => {
    attachDropZone(target, {
      onDrop: vi.fn(),
      onError: vi.fn(),
    });
    target.dispatchEvent(makeDragEvent('dragenter', [makeFile('x.stl', 10)]));
    expect(target.classList.contains('dropzone--active')).toBe(true);
  });

  test('ignores drags without a Files type (pure text drag)', () => {
    attachDropZone(target, {
      onDrop: vi.fn(),
      onError: vi.fn(),
    });
    target.dispatchEvent(
      makeDragEvent('dragenter', [makeFile('x.stl', 10)], false),
    );
    expect(target.classList.contains('dropzone--active')).toBe(false);
  });

  test('nested enter/leave keeps outline on until depth returns to 0', () => {
    attachDropZone(target, {
      onDrop: vi.fn(),
      onError: vi.fn(),
    });
    const f = [makeFile('x.stl', 10)];
    // Three enters, two leaves — depth is still 1 → class stays on.
    target.dispatchEvent(makeDragEvent('dragenter', f));
    target.dispatchEvent(makeDragEvent('dragenter', f));
    target.dispatchEvent(makeDragEvent('dragenter', f));
    target.dispatchEvent(makeDragEvent('dragleave', f));
    target.dispatchEvent(makeDragEvent('dragleave', f));
    expect(target.classList.contains('dropzone--active')).toBe(true);
    // Final leave drops depth to 0 → class removed.
    target.dispatchEvent(makeDragEvent('dragleave', f));
    expect(target.classList.contains('dropzone--active')).toBe(false);
  });

  test('drop removes the active class regardless of prior depth', async () => {
    const onDrop = vi.fn();
    attachDropZone(target, { onDrop, onError: vi.fn() });
    const f = [makeFile('cube.stl', 64)];
    target.dispatchEvent(makeDragEvent('dragenter', f));
    target.dispatchEvent(makeDragEvent('dragenter', f));
    target.dispatchEvent(makeDragEvent('drop', f));
    // Yield to the async file.arrayBuffer() handler.
    await Promise.resolve();
    expect(target.classList.contains('dropzone--active')).toBe(false);
  });
});

describe('dropZone — drop validation', () => {
  test('single valid .stl resolves onDrop with an ArrayBuffer', async () => {
    const onDrop = vi.fn();
    attachDropZone(target, { onDrop, onError: vi.fn() });
    const file = makeFile('cube.stl', 84);
    target.dispatchEvent(makeDragEvent('drop', [file]));
    // `file.arrayBuffer()` is a microtask; flush.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).toHaveBeenCalledTimes(1);
    const [buffer, name] = onDrop.mock.calls[0] ?? [];
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(name).toBe('cube.stl');
  });

  test('case-insensitive .STL extension is accepted', async () => {
    const onDrop = vi.fn();
    attachDropZone(target, { onDrop, onError: vi.fn() });
    target.dispatchEvent(
      makeDragEvent('drop', [makeFile('Cube.STL', 84)]),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  test('non-stl extension → wrong-extension error, no onDrop', async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    attachDropZone(target, { onDrop, onError });
    target.dispatchEvent(makeDragEvent('drop', [makeFile('doc.txt', 10)]));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'wrong-extension',
      'Only .stl files are supported',
    );
  });

  test('multi-file drop → multiple-files error, no onDrop', async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    attachDropZone(target, { onDrop, onError });
    target.dispatchEvent(
      makeDragEvent('drop', [
        makeFile('a.stl', 10),
        makeFile('b.stl', 10),
      ]),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'multiple-files',
      'Drop one file at a time',
    );
  });

  test('oversized file → file-too-large, buffer not read', async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    attachDropZone(target, { onDrop, onError });
    const huge = makeFile('huge.stl', OPEN_STL_MAX_BYTES + 1);
    // Spy on arrayBuffer() to prove we never allocate a 500 MB buffer.
    const spy = vi.spyOn(huge, 'arrayBuffer');
    target.dispatchEvent(makeDragEvent('drop', [huge]));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('file-too-large', 'File too large');
    expect(spy).not.toHaveBeenCalled();
  });

  test('file exactly at the size cap is accepted', async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    attachDropZone(target, { onDrop, onError });
    target.dispatchEvent(
      makeDragEvent('drop', [makeFile('edge.stl', OPEN_STL_MAX_BYTES)]),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('empty drop (0 files) is a silent no-op', async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    attachDropZone(target, { onDrop, onError });
    target.dispatchEvent(makeDragEvent('drop', []));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('security: does NOT consult file.path', async () => {
    // Guard against a regression where someone reaches for `file.path`
    // to shortcut the buffer read (would violate contextIsolation). We
    // install a getter on `file.path` and assert it is never triggered
    // during a successful drop flow.
    const onDrop = vi.fn();
    attachDropZone(target, { onDrop, onError: vi.fn() });
    const file = makeFile('cube.stl', 84);
    const pathSpy = vi.fn(() => '/tmp/cube.stl');
    Object.defineProperty(file, 'path', {
      configurable: true,
      get: pathSpy,
    });
    target.dispatchEvent(makeDragEvent('drop', [file]));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pathSpy).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe('dropZone — lifecycle', () => {
  test('destroy() detaches listeners + clears active class', () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    const api = attachDropZone(target, { onDrop, onError });
    const f = [makeFile('x.stl', 10)];
    target.dispatchEvent(makeDragEvent('dragenter', f));
    expect(target.classList.contains('dropzone--active')).toBe(true);

    api.destroy();
    expect(target.classList.contains('dropzone--active')).toBe(false);

    // No further events should reach the callbacks.
    target.dispatchEvent(makeDragEvent('drop', f));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
