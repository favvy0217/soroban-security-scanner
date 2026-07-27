'use client';

import { useState, useCallback, useRef, DragEvent, ChangeEvent } from 'react';

export type FileStatus = 'pending' | 'validating' | 'uploading' | 'complete' | 'error';

export interface UploadedFile {
  id: string;
  file: File;
  status: FileStatus;
  progress: number;
  error?: string;
  preview?: string;
}

export interface FileValidationOptions {
  maxSizeMB?: number;
  allowedTypes?: string[];
  maxFiles?: number;
}

const DEFAULT_OPTIONS: Required<FileValidationOptions> = {
  maxSizeMB: 10,
  allowedTypes: ['.rs', '.wasm', '.toml', '.txt'],
  maxFiles: 5,
};

// ── Issue #432: Client-side magic byte detection ──────────────────────────────
// WASM files start with the magic bytes \0asm (0x00, 0x61, 0x73, 0x6d)
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

// Rust source files typically start with these keywords on the first non-whitespace line
const RUST_PREFIXES = ['use', '//!', '#!', 'pub', 'mod', 'fn', 'impl', 'trait', 'struct', 'enum', 'const', 'static', 'macro'];

// Per-extension max file sizes (Issue #432)
const EXT_MAX_SIZE_MB: Record<string, number> = {
  '.wasm': 10,
  '.rs': 5,
  '.toml': 1,
  '.txt': 1,
};

/**
 * Read the first N bytes of a file as an array buffer.
 */
function readFileHeader(file: File, bytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result as ArrayBuffer;
      if (!buf) { resolve(new Uint8Array(0)); return; }
      resolve(new Uint8Array(buf.slice(0, bytes)));
    };
    reader.onerror = () => reject(new Error('Failed to read file header'));
    reader.readAsArrayBuffer(file.slice(0, bytes));
  });
}

/**
 * Validate file magic bytes against known signatures (Issue #432).
 * Returns null if valid, or an error message if the content doesn't match the extension.
 */
async function validateMagicBytes(file: File): Promise<string | null> {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  if (ext === '.wasm') {
    // WASM files must start with \0asm magic bytes
    const header = await readFileHeader(file, 4);
    if (header.length < 4) {
      return 'This file is too small to be a valid WASM binary';
    }
    const isWasm = WASM_MAGIC.every((byte, i) => header[i] === byte);
    if (!isWasm) {
      return 'This file does not appear to be a valid WASM binary (missing \\0asm magic header)';
    }
  } else if (ext === '.rs') {
    // Rust source files should start with a known Rust keyword or comment
    const header = await readFileHeader(file, 512);
    if (header.length === 0) {
      return 'This file is empty and does not appear to be valid Rust source code';
    }
    const text = new TextDecoder().decode(header).trimStart();
    if (text.length === 0) {
      return 'This file contains only whitespace and does not appear to be valid Rust source code';
    }
    const firstLine = text.split('\n')[0].trim();
    const isRust = RUST_PREFIXES.some(prefix => firstLine.startsWith(prefix));
    if (!isRust) {
      return 'This file does not appear to be valid Rust source code (unexpected first line)';
    }
  }

  return null;
}

/**
 * Get the max file size for a given extension (Issue #432).
 */
function getMaxSizeForExt(ext: string): number {
  return EXT_MAX_SIZE_MB[ext] ?? 10;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function validateFile(file: File, options: Required<FileValidationOptions>): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  const mime = file.type;

  // Check extension/MIME first (quick check)
  const isAllowedExt = options.allowedTypes.some(t => (t.startsWith('.') ? t === ext : t === mime));
  if (!isAllowedExt) {
    return `File type "${ext}" is not allowed. Accepted: ${options.allowedTypes.join(', ')}`;
  }

  // Per-extension size limit (Issue #432)
  const maxSizeMB = getMaxSizeForExt(ext);
  const maxBytes = maxSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return `File exceeds the ${maxSizeMB}MB size limit for ${ext} files`;
  }

  return null;
}

async function generatePreview(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target?.result as string);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

export function useFileUpload(options: FileValidationOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const abortRefs = useRef<Record<string, AbortController>>({});

  const updateFile = useCallback((id: string, patch: Partial<UploadedFile>) => {
    setFiles((prev: UploadedFile[]) =>
      prev.map((f: UploadedFile) => (f.id === id ? { ...f, ...patch } : f))
    );
  }, []);

  const simulateUpload = useCallback(
    async (id: string, controller: AbortController) => {
      const intervals = [15, 30, 45, 60, 75, 88, 95, 100];
      for (const pct of intervals) {
        if (controller.signal.aborted) return;
        await new Promise(r => setTimeout(r, 250 + Math.random() * 200));
        if (controller.signal.aborted) return;
        updateFile(id, { progress: pct });
      }
      if (!controller.signal.aborted) {
        updateFile(id, { status: 'complete', progress: 100 });
      }
    },
    [updateFile]
  );

  const processFiles = useCallback(
    async (incoming: File[]) => {
      const available = opts.maxFiles - files.length;
      if (available <= 0) return;

      const toProcess = incoming.slice(0, available);

      const newEntries: UploadedFile[] = await Promise.all(
        toProcess.map(async (file: File) => {
          const preview = await generatePreview(file);
          return {
            id: generateId(),
            file,
            status: 'pending' as FileStatus,
            progress: 0,
            preview,
          };
        })
      );

      setFiles((prev: UploadedFile[]) => [...prev, ...newEntries]);

      for (const entry of newEntries) {
        updateFile(entry.id, { status: 'validating' });
        await new Promise(r => setTimeout(r, 150));

        const error = validateFile(entry.file, opts);
        if (error) {
          updateFile(entry.id, { status: 'error', error });
          continue;
        }

        const controller = new AbortController();
        abortRefs.current[entry.id] = controller;
        updateFile(entry.id, { status: 'uploading', progress: 0 });
        simulateUpload(entry.id, controller);
      }
    },
    [files.length, opts, updateFile, simulateUpload]
  );

  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setIsDragActive(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);
      const dropped = Array.from(e.dataTransfer.files);
      if (dropped.length) processFiles(dropped);
    },
    [processFiles]
  );

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      if (selected.length) processFiles(selected);
      e.target.value = '';
    },
    [processFiles]
  );

  const removeFile = useCallback((id: string) => {
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    setFiles((prev: UploadedFile[]) => {
      const target = prev.find((f: UploadedFile) => f.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((f: UploadedFile) => f.id !== id);
    });
  }, []);

  const retryFile = useCallback(
    (id: string) => {
      setFiles((prev: UploadedFile[]) => {
        const target = prev.find((f: UploadedFile) => f.id === id);
        if (!target) return prev;
        const error = validateFile(target.file, opts);
        if (error) return prev;
        return prev.map((f: UploadedFile) =>
          f.id === id
            ? { ...f, status: 'uploading' as FileStatus, progress: 0, error: undefined }
            : f
        );
      });
      const controller = new AbortController();
      abortRefs.current[id] = controller;
      simulateUpload(id, controller);
    },
    [opts, simulateUpload]
  );

  const clearAll = useCallback(() => {
    const controllers = Object.keys(abortRefs.current).map(k => abortRefs.current[k]);
    controllers.forEach((c: AbortController) => c.abort());
    abortRefs.current = {};
    setFiles((prev: UploadedFile[]) => {
      prev.forEach((f: UploadedFile) => f.preview && URL.revokeObjectURL(f.preview));
      return [];
    });
  }, []);

  // Issue #432: Cancel an in-flight upload
  const cancelUpload = useCallback((id: string) => {
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    updateFile(id, { status: 'error', progress: 0, error: 'Upload cancelled by user' });
  }, [updateFile]);

  const canAddMore = files.length < opts.maxFiles;
  const allComplete = files.length > 0 && files.every((f: UploadedFile) => f.status === 'complete');

  return {
    files,
    isDragActive,
    canAddMore,
    allComplete,
    maxFiles: opts.maxFiles,
    allowedTypes: opts.allowedTypes,
    maxSizeMB: opts.maxSizeMB,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onInputChange,
    removeFile,
    retryFile,
    cancelUpload,
    clearAll,
  };
}
