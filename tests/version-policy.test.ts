import { describe, expect, it } from 'vitest';
import {
  extractOverlay,
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_OVERLAY_FILES,
  overlayHash,
  validateChanges,
  validateOverlay,
} from '../lib/project-policy';

describe('version overlays', () => {
  it('keeps only the editable surface', () => {
    expect(extractOverlay({
      'src/App.tsx': 'app',
      'src/components/Panel.tsx': 'panel',
      'src/styles/theme.css': 'css',
      'public/logo.svg': 'svg',
      'src/agent/bridge.tsx': 'protected',
      'package.json': '{}',
      'scripts/audit-ui.mjs': 'audit',
    })).toEqual({
      'public/logo.svg': 'svg',
      'src/App.tsx': 'app',
      'src/components/Panel.tsx': 'panel',
      'src/styles/theme.css': 'css',
    });
  });

  it('rejects protected, unsafe, and oversized paths on the way in', () => {
    expect(() => validateOverlay({ 'src/agent/bridge.tsx': 'x' })).toThrow(/Protected/);
    expect(() => validateOverlay({ 'package.json': '{}' })).toThrow(/Protected/);
    expect(() => validateOverlay({ '../src/App.tsx': 'x' })).toThrow(/Unsafe/);
    expect(() => validateOverlay({ 'src/components/../../etc/passwd': 'x' })).toThrow();
    expect(() => validateOverlay({ 'src/App.tsx': 42 })).toThrow(/requires content/);
    expect(() => validateOverlay({ 'src/App.tsx': 'a\0b' })).toThrow(/Binary/);
    expect(() => validateOverlay({ 'src/App.tsx': 'x'.repeat(MAX_FILE_BYTES + 1) })).toThrow(/too large/);
    expect(() => validateOverlay([])).toThrow();
    expect(() => validateOverlay(null)).toThrow();
  });

  it('caps the file count and the total payload', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index <= MAX_OVERLAY_FILES; index += 1) many[`src/components/C${index}.tsx`] = 'x';
    expect(() => validateOverlay(many)).toThrow(/at most/);

    const heavy: Record<string, string> = {};
    const chunk = 'x'.repeat(MAX_FILE_BYTES);
    for (let index = 0; index < Math.ceil(MAX_BATCH_BYTES / MAX_FILE_BYTES) + 1; index += 1) {
      heavy[`src/components/C${index}.tsx`] = chunk;
    }
    expect(() => validateOverlay(heavy)).toThrow(/too large/);
  });

  it('normalizes paths and returns a plain overlay', () => {
    expect(validateOverlay({ '/src/App.tsx': 'app' })).toEqual({ 'src/App.tsx': 'app' });
  });

  it('hashes overlays by content, independently of key order', async () => {
    const a = await overlayHash({ 'src/App.tsx': 'one', 'src/styles/theme.css': 'two' });
    const b = await overlayHash({ 'src/styles/theme.css': 'two', 'src/App.tsx': 'one' });
    const c = await overlayHash({ 'src/App.tsx': 'one', 'src/styles/theme.css': 'three' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('cannot be fooled by a separator inside a path or file body', async () => {
    const a = await overlayHash({ 'src/App.tsx': 'x', 'src/styles/a.css': 'y' });
    const b = await overlayHash({ 'src/App.tsx': 'x", "src/styles/a.css", "y' });
    expect(a).not.toBe(b);
  });
});

describe('change batches', () => {
  // The total-bytes cap used to sit after an unconditional return and never ran.
  it('enforces the batch byte cap', () => {
    const chunk = 'x'.repeat(MAX_FILE_BYTES);
    const changes = Array.from({ length: 5 }, (_, index) => ({
      path: `src/components/C${index}.tsx`,
      operation: 'write' as const,
      content: chunk,
    }));
    expect(() => validateChanges(changes)).toThrow(/batch is too large/);
  });

  it('still returns normalized changes under the cap', () => {
    expect(validateChanges([{ path: '/src/App.tsx', operation: 'write', content: 'ok' }])).toEqual([
      { path: 'src/App.tsx', operation: 'write', content: 'ok' },
    ]);
    expect(validateChanges([{ path: 'src/App.tsx', operation: 'delete' }])).toEqual([
      { path: 'src/App.tsx', operation: 'delete' },
    ]);
  });
});
