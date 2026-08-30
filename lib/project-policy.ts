import type { FileMap, ProjectChange } from './canvas-types';

export const MAX_CHANGE_COUNT = 20;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_BATCH_BYTES = 1024 * 1024;

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
  return changes.map((change) => {
    const path = normalizeProjectPath(change.path);
    if (!isEditablePath(path)) throw new Error(`Protected project path: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate project path: ${path}`);
    seen.add(path);

    if (change.operation !== 'write' && change.operation !== 'delete') {
      throw new Error(`Unsupported operation for ${path}.`);
    }
    if (change.operation === 'write') {
      if (typeof change.content !== 'string') {
        throw new Error(`Write operation for ${path} requires content.`);
      }
      if (change.content.includes('\0')) throw new Error(`Binary content is not allowed: ${path}`);
      const bytes = new TextEncoder().encode(change.content).byteLength;
      if (bytes > MAX_FILE_BYTES) throw new Error(`File is too large: ${path}`);
      totalBytes += bytes;
    }
    return { path, operation: change.operation, ...(change.operation === 'write' ? { content: change.content } : {}) };
  });

  if (totalBytes > MAX_BATCH_BYTES) throw new Error('Change batch is too large.');
  return changes;
}

