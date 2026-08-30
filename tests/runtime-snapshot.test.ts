import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRuntimeManifest, RUNTIME_SNAPSHOT_SCHEMA, starterPackageHash } from '../lib/runtime-snapshot';

const MANIFEST_PATH = 'public/guest-runtime/manifest.json';
const SNAPSHOT_PATH = 'public/guest-runtime/runtime.gz';

describe('prebuilt guest runtime', () => {
  it('ships a manifest built from the current starter package.json', async () => {
    const manifest: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(isRuntimeManifest(manifest)).toBe(true);
    if (!isRuntimeManifest(manifest)) return;

    expect(manifest.schemaVersion).toBe(RUNTIME_SNAPSHOT_SCHEMA);
    // A mismatch means the guest dependency set moved. Regenerate the snapshot
    // at /dev/snapshot, or the canvas silently falls back to a 14s npm install.
    expect(manifest.packageHash).toBe(await starterPackageHash());
    expect(statSync(SNAPSHOT_PATH).size).toBe(manifest.gzipBytes);
  });

  it('rejects manifests from an unsupported schema', () => {
    const valid = { schemaVersion: RUNTIME_SNAPSHOT_SCHEMA, packageHash: 'a', rawBytes: 1, gzipBytes: 1, generatedAt: 'now' };
    expect(isRuntimeManifest(valid)).toBe(true);
    expect(isRuntimeManifest({ ...valid, schemaVersion: RUNTIME_SNAPSHOT_SCHEMA + 1 })).toBe(false);
    expect(isRuntimeManifest({ ...valid, rawBytes: '1' })).toBe(false);
    expect(isRuntimeManifest(null)).toBe(false);
  });
});
