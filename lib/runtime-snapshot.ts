import { hashText } from './hash';
import { STARTER_FILES } from './starter-project';

export const RUNTIME_SNAPSHOT_SCHEMA = 1;
export const RUNTIME_SNAPSHOT_URL = '/guest-runtime/runtime.gz';
export const RUNTIME_MANIFEST_URL = '/guest-runtime/manifest.json';

/**
 * Describes the prebuilt WebContainer filesystem committed under
 * `public/guest-runtime/`. `packageHash` pins the snapshot to the exact guest
 * `package.json` it was installed from — a mismatch means the dependency set
 * moved and the snapshot must be regenerated at `/dev/snapshot`.
 */
export interface RuntimeManifest {
  schemaVersion: number;
  packageHash: string;
  rawBytes: number;
  gzipBytes: number;
  generatedAt: string;
}

export type RuntimeSnapshotResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function starterPackageHash(): Promise<string> {
  return hashText(STARTER_FILES['package.json']);
}

export function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.schemaVersion === RUNTIME_SNAPSHOT_SCHEMA
    && typeof manifest.packageHash === 'string'
    && Number.isInteger(manifest.rawBytes)
    && Number.isInteger(manifest.gzipBytes)
    && typeof manifest.generatedAt === 'string'
  );
}

/**
 * Fetches and inflates the prebuilt runtime. Every failure is a soft failure:
 * the caller falls back to mounting the starter and running `npm install`.
 *
 * The returned buffer is single-use — `WebContainer.mount()` transfers it and
 * leaves the `ArrayBuffer` detached.
 */
export async function fetchRuntimeSnapshot(): Promise<RuntimeSnapshotResult> {
  try {
    const [manifestResponse, expectedHash] = await Promise.all([
      fetch(RUNTIME_MANIFEST_URL),
      starterPackageHash(),
    ]);
    if (!manifestResponse.ok) {
      return { ok: false, reason: `manifest request returned ${manifestResponse.status}` };
    }
    const manifest: unknown = await manifestResponse.json();
    if (!isRuntimeManifest(manifest)) {
      return { ok: false, reason: 'manifest is malformed or has an unsupported schema' };
    }
    if (manifest.packageHash !== expectedHash) {
      return {
        ok: false,
        reason: `manifest was built for package.json ${manifest.packageHash}, starter is ${expectedHash}`,
      };
    }

    const snapshotResponse = await fetch(RUNTIME_SNAPSHOT_URL);
    if (!snapshotResponse.ok) {
      return { ok: false, reason: `snapshot request returned ${snapshotResponse.status}` };
    }
    // Hosts that recognise the `.gz` extension answer with
    // `Content-Encoding: gzip` and the browser has already inflated the body.
    // Hosts that do not hand back the raw gzip stream, so inflate it here.
    let bytes = new Uint8Array(await snapshotResponse.arrayBuffer());
    if (isGzip(bytes)) {
      if (typeof DecompressionStream === 'undefined') {
        return { ok: false, reason: 'snapshot arrived compressed and DecompressionStream is unavailable' };
      }
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (bytes.byteLength !== manifest.rawBytes) {
      return {
        ok: false,
        reason: `snapshot is ${bytes.byteLength} bytes, manifest expects ${manifest.rawBytes}`,
      };
    }
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'snapshot fetch failed' };
  }
}
