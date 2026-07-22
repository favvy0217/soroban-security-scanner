import { renderHook, act } from '@testing-library/react';
import { useFileUpload } from '../hooks/useFileUpload';

// Helper: create a File with specific content
function createFile(name: string, content: Uint8Array | string, type = ''): File {
  const bytes = typeof content === 'string'
    ? new Uint8Array(content.split('').map(c => c.charCodeAt(0)))
    : content;
  return new File([bytes], name, { type });
}

// WASM magic bytes: \0asm
const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe('useFileUpload — Magic Byte Validation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts a valid .wasm file with correct magic bytes', async () => {
    const { result } = renderHook(() => useFileUpload());
    const validWasm = createFile('contract.wasm', WASM_MAGIC, 'application/wasm');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [validWasm] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const file = result.current.files[0];
    expect(file).toBeDefined();
    expect(file.error).not.toContain('does not appear to be a valid WASM');
  });

  it('rejects a .wasm file with wrong magic bytes (renamed .exe)', async () => {
    const { result } = renderHook(() => useFileUpload());
    const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const fakeWasm = createFile('malware.wasm', exeBytes, 'application/wasm');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [fakeWasm] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const file = result.current.files[0];
    expect(file).toBeDefined();
    expect(file.status).toBe('error');
    expect(file.error).toContain('does not appear to be a valid WASM');
  });

  it('rejects an empty file', async () => {
    const { result } = renderHook(() => useFileUpload());
    const emptyFile = createFile('empty.rs', new Uint8Array(0), 'text/plain');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [emptyFile] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const file = result.current.files[0];
    expect(file).toBeDefined();
    expect(file.status).toBe('error');
  });

  it('accepts a valid .rs file with Rust keywords', async () => {
    const { result } = renderHook(() => useFileUpload());
    const rustCode = 'use soroban_sdk::{contract, contractimpl};\n\n#[contract]\npub struct HelloContract;\n';
    const rustFile = createFile('hello.rs', rustCode, 'text/plain');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [rustFile] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const file = result.current.files[0];
    expect(file).toBeDefined();
    expect(file.error).not.toContain('does not appear to be a valid Rust');
  });

  it('rejects a .rs file with non-Rust content', async () => {
    const { result } = renderHook(() => useFileUpload());
    const notRust = 'console.log("Hello World");\nconst x = 42;\n';
    const fakeRs = createFile('fake.rs', notRust, 'text/plain');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [fakeRs] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const file = result.current.files[0];
    expect(file).toBeDefined();
    expect(file.status).toBe('error');
    expect(file.error).toContain('does not appear to be a valid Rust');
  });

  it('supports cancelUpload to abort in-flight uploads', async () => {
    const { result } = renderHook(() => useFileUpload());
    const validWasm = createFile('contract.wasm', WASM_MAGIC, 'application/wasm');

    await act(async () => {
      result.current.onInputChange({
        target: { files: [validWasm] },
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    const fileId = result.current.files[0]?.id;
    expect(fileId).toBeDefined();

    await act(async () => {
      result.current.cancelUpload(fileId);
    });

    const file = result.current.files[0];
    expect(file.status).toBe('error');
    expect(file.error).toContain('cancelled');
  });
});
