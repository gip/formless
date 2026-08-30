import { describe, expect, it } from 'vitest';
import { isEditablePath, normalizeProjectPath, validateChanges } from '../lib/project-policy';

describe('project path policy', () => {
  it('allows only the intended editable surfaces', () => {
    expect(isEditablePath('src/App.tsx')).toBe(true);
    expect(isEditablePath('src/components/Card.tsx')).toBe(true);
    expect(isEditablePath('src/styles/theme.css')).toBe(true);
    expect(isEditablePath('public/example.txt')).toBe(true);
    expect(isEditablePath('src/agent/bridge.tsx')).toBe(false);
    expect(isEditablePath('package.json')).toBe(false);
  });

  it('rejects traversal and excluded directories', () => {
    expect(() => normalizeProjectPath('../src/App.tsx')).toThrow(/Unsafe/);
    expect(() => normalizeProjectPath('node_modules/react/index.js')).toThrow(/Excluded/);
  });

  it('rejects duplicate, binary, and protected updates', () => {
    expect(() => validateChanges([
      { path: 'src/App.tsx', operation: 'write', content: 'a' },
      { path: 'src/App.tsx', operation: 'write', content: 'b' },
    ])).toThrow(/Duplicate/);
    expect(() => validateChanges([{ path: 'src/App.tsx', operation: 'write', content: '\0' }])).toThrow(/Binary/);
    expect(() => validateChanges([{ path: 'src/agent/bridge.tsx', operation: 'delete' }])).toThrow(/Protected/);
  });
});

