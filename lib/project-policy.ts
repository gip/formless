import type { FileMap, ProjectChange } from './canvas-types';
import { hashText } from './hash';

export const MAX_CHANGE_COUNT = 20;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_OVERLAY_FILES = 60;

const EDITABLE_PATTERNS = [
  /^src\/App\.tsx$/,
  /^src\/components\/[A-Za-z0-9._/-]+$/,
  /^src\/styles\/[A-Za-z0-9._/-]+$/,
  /^public\/[A-Za-z0-9._/-]+$/,
];

const EXCLUDED_SEGMENTS = new Set(['node_modules', 'dist', '.git', '.cache']);

export function normalizeProjectPath(value: string): string {
  const path = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = path.split('/');
  if (!path || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe project path: ${value}`);
  }
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) {
    throw new Error(`Excluded project path: ${value}`);
  }
  return path;
}

export function isEditablePath(value: string): boolean {
  try {
    const path = normalizeProjectPath(value);
    return EDITABLE_PATTERNS.some((pattern) => pattern.test(path));
  } catch {
    return false;
  }
}

export function listVisiblePaths(files: FileMap): string[] {
  return Object.keys(files)
    .filter((path) => {
      try {
        normalizeProjectPath(path);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

export function validateChanges(changes: ProjectChange[]): ProjectChange[] {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('At least one project change is required.');
  }
  if (changes.length > MAX_CHANGE_COUNT) {
    throw new Error(`A maximum of ${MAX_CHANGE_COUNT} changes is allowed.`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = changes.map((change) => {
    const path = normalizeProjectPath(change.path);
    if (!isEditablePath(path)) throw new Error(`Protected project path: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate project path: ${path}`);
    seen.add(path);

    if (change.operation !== 'write' && change.operation !== 'delete') {
      throw new Error(`Unsupported operation for ${path}.`);
    }
    if (change.operation === 'write') {
      totalBytes += measureFile(path, change.content);
    }
    return { path, operation: change.operation, ...(change.operation === 'write' ? { content: change.content } : {}) };
  });

  if (totalBytes > MAX_BATCH_BYTES) throw new Error('Change batch is too large.');
  return normalized;
}

/** Byte length of one file's contents, rejecting binary and oversized payloads. */
function measureFile(path: string, content: unknown): number {
  if (typeof content !== 'string') throw new Error(`Write operation for ${path} requires content.`);
  if (content.includes('\0')) throw new Error(`Binary content is not allowed: ${path}`);
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > MAX_FILE_BYTES) throw new Error(`File is too large: ${path}`);
  return bytes;
}

/**
 * The editable subset of a project. This is the entire payload of a published
 * version: `mergeSnapshot()` re-derives every protected file from the starter,
 * so an overlay cannot smuggle in a modified bridge or build script.
 */
export function extractOverlay(files: FileMap): FileMap {
  const overlay: FileMap = {};
  for (const path of Object.keys(files).sort()) {
    if (isEditablePath(path) && typeof files[path] === 'string') overlay[path] = files[path];
  }
  return overlay;
}

/**
 * Validates an overlay arriving from the network — a published version being
 * loaded, or a publish request body. Applies the same path, size, and binary
 * rules as `validateChanges`, so the two entry points cannot drift apart.
 */
export function validateOverlay(input: unknown): FileMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('files must be an object of project paths to contents.');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_OVERLAY_FILES) {
    throw new Error(`A version may contain at most ${MAX_OVERLAY_FILES} files.`);
  }
  const overlay: FileMap = {};
  let totalBytes = 0;
  for (const [rawPath, content] of entries) {
    const path = normalizeProjectPath(rawPath);
    if (!isEditablePath(path)) throw new Error(`Protected project path: ${path}`);
    if (path in overlay) throw new Error(`Duplicate project path: ${path}`);
    totalBytes += measureFile(path, content);
    overlay[path] = content as string;
  }
  if (totalBytes > MAX_BATCH_BYTES) throw new Error('Version payload is too large.');
  return overlay;
}

/**
 * Fingerprint of an overlay's contents. Publishing records it, and the client
 * compares it against the working copy to tell a clean checkout from a draft
 * with unsaved edits.
 */
export function overlayHash(files: FileMap): Promise<string> {
  const canonical = JSON.stringify(Object.keys(files).sort().map((path) => [path, files[path]]));
  return hashText(canonical);
}
