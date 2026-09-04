import { describe, expect, it } from 'vitest';
import { restorableFiles, type ProjectSnapshot } from '../lib/persistence';
import { overlayHash } from '../lib/project-policy';

const STARTER = { 'src/App.tsx': 'starter', 'src/styles/app.css': 'body {}' };
const DRAFT = { 'src/App.tsx': 'edited by an agent', 'src/styles/app.css': 'body {}' };

async function snapshot(files: Record<string, string>, patch: Partial<ProjectSnapshot> = {}): Promise<ProjectSnapshot> {
  return {
    schemaVersion: 1,
    revision: 3,
    files,
    savedAt: new Date().toISOString(),
    versionId: null,
    starterOverlayHash: await overlayHash(STARTER),
    ...patch,
  };
}

describe('snapshot restoration', () => {
  it('re-bases a clean checkout so a new starter reaches returning visitors', async () => {
    expect(await restorableFiles(await snapshot(STARTER))).toBeUndefined();
  });

  it('restores a draft, whatever the starter has since done', async () => {
    expect(await restorableFiles(await snapshot(DRAFT))).toEqual(DRAFT);
  });

  it('restores a checkout of a published version, which the starter does not baseline', async () => {
    const stored = await snapshot(STARTER, { versionId: 'v1' });
    expect(await restorableFiles(stored)).toEqual(STARTER);
  });

  it('restores unstamped snapshots rather than guessing away real work', async () => {
    const stored = await snapshot(DRAFT, { starterOverlayHash: undefined });
    expect(await restorableFiles(stored)).toEqual(DRAFT);
  });

  it('starts from the starter when nothing is stored', async () => {
    expect(await restorableFiles(null)).toBeUndefined();
  });

  it('ignores protected files, which mergeSnapshot re-derives from the starter', async () => {
    const stored = await snapshot({ ...STARTER, 'package.json': '{"name":"stale"}' });
    expect(await restorableFiles(stored)).toBeUndefined();
  });
});
