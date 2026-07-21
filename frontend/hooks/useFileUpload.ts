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

// Magic byte signatures for file type validation
// WASM files start with \0asm (0x00, 0x61, 0x73, 0x6d)
const WASM_MAGIC_BYTES = [0x00, 0x61, 0x73, 0x6d];

// Rust source file keywords to check in the first non-whitespace line
const RUST_KEYWORDS = ['use ', '//!', '#! ', '#![', 'pub ', 'mod ', 'fn ', 'impl ', 'trait ', 'struct ', 'enum ', 'const ', 'static ', 'crate '];

// Default max file sizes per type (in MB)
const DEFAULT_MAX_SIZES: Record<string, number> = {
  '.wasm': 10,
  '.rs': 5,
  '.toml': 2,
  '.txt': 2,
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Read the first N bytes of a file as a Uint8Array.
 * Uses FileReader.readAsArrayBuffer() to read file content client-side.
 */
function readFileBytes(file: File, numBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      resolve(new Uint8Array(buffer.slice(0, numBytes)));
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file.slice(0, numBytes));
  });
}

/**
 * Read the first non-whitespace line of a text file.
 * Used for Rust source file validation.
 */
async function readFirstLine(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n');
      // Find first non-whitespace line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          resolve(trimmed);
          return;
        }
      }
      resolve('');
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    // Read first 1KB for text validation
    reader.readAsText(file.slice(0, 1024));
  });
}

/**
 * Validate file magic bytes (content-based validation, not extension-based).
 * This prevents users from uploading renamed files (e.g., malware.exe → contract.wasm).
 *
 * @param file The file to validate
 * @returns null if valid, error message string if invalid
 */
async function validateMagicBytes(file: File): Promise<string | null> {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  if (ext === '.wasm') {
    // WASM files must start with \0asm magic bytes
    try {
      const bytes = await readFileBytes(file, 4);
      for (let i = 0; i < 4; i++) {
        if (bytes[i] !== WASM_MAGIC_BYTES[i]) {
          return 'This file does not appear to be a valid WASM binary (magic bytes mismatch)';
        }
      }
    } catch {
      return 'Unable to read file content for validation';
    }
  } else if (ext === '.rs') {
    // Rust source files should start with a recognized Rust keyword
    try {
      const firstLine = await readFirstLine(file);
      if (firstLine.length === 0) {
        return 'File appears to be empty';
      }
      const isValidRust = RUST_KEYWORDS.some(kw => firstLine.startsWith(kw));
      if (!isValidRust) {
        return 'This file does not appear to be a valid Rust source file';
      }
    } catch {
      return 'Unable to read file content for validation';
    }
  }

  return null; // File is valid
}

/**
 * Get the max file size for a given file extension.
 * Falls back to the default maxSizeMB if no specific limit is set.
 */
function getMaxSizeForType(ext: string, defaultMaxMB: number): number {
  return DEFAULT_MAX_SIZES[ext] ?? defaultMaxMB;
}

function validateFile(file: File, options: Required<FileValidationOptions>): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  const maxBytes = getMaxSizeForType(ext, options.maxSizeMB) * 1024 * 1024;

  if (file.size > maxBytes) {
    const limitMB = getMaxSizeForType(ext, options.maxSizeMB);
    return `File exceeds the ${limitMB}MB size limit`;
  }

  if (file.size === 0) {
    return 'File is empty';
  }

  const mime = file.type;
  const isAllowedExt = options.allowedTypes.some(t => (t.startsWith('.') ? t === ext : t === mime));
  if (!isAllowedExt) {
    return `File type "${ext}" is not allowed. Accepted: ${options.allowedTypes.join(', ')}`;
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

        // Step 1: Basic validation (extension, size)
        const basicError = validateFile(entry.file, opts);
        if (basicError) {
          updateFile(entry.id, { status: 'error', error: basicError });
          continue;
        }

        // Step 2: Magic byte validation (content-based, prevents renamed files)
        const magicError = await validateMagicBytes(entry.file);
        if (magicError) {
          updateFile(entry.id, { status: 'error', error: magicError });
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

  const cancelUpload = useCallback((id: string) => {
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    updateFile(id, { status: 'error' as FileStatus, error: 'Upload cancelled', progress: 0 });
  }, [updateFile]);

  const clearAll = useCallback(() => {
    const controllers = Object.keys(abortRefs.current).map(k => abortRefs.current[k]);
    controllers.forEach((c: AbortController) => c.abort());
    abortRefs.current = {};
    setFiles((prev: UploadedFile[]) => {
      prev.forEach((f: UploadedFile) => f.preview && URL.revokeObjectURL(f.preview));
      return [];
    });
  }, []);

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
