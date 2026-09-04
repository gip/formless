import type { FileMap } from './canvas-types';
import { extractOverlay, overlayHash } from './project-policy';

const DB_NAME = 'webmcp-canvas';
const STORE_NAME = 'project-snapshots';
const SNAPSHOT_KEY = 'active';
const SCHEMA_VERSION = 1;

export interface ProjectSnapshot {
  schemaVersion: number;
  revision: number;
  files: FileMap;
  savedAt: string;
  /**
   * The published version this working copy started from, or null for the
   * starter. Optional so snapshots written before versions existed stay valid.
   */
  versionId?: string | null;
  /**
   * `overlayHash(starterOverlay())` of the build that wrote this snapshot.
   * Optional so snapshots written before the stamp existed stay valid; see
   * `restorableFiles()` for what it is read back for.
   */
  starterOverlayHash?: string;
}

/**
 * The files a stored snapshot should actually bring back, or undefined for
 * "start from the starter this build ships".
 *
 * A snapshot pins the whole editable surface: `mergeSnapshot()` restores every
 * editable path from it and drops the ones it does not carry. That is right for
 * a draft and wrong for a snapshot holding no draft at all — switching to the
 * default app or reverting writes one too, and from then on the guest source is
 * frozen at the deploy that wrote it. The default app stops picking up
 * releases, and the version switcher reads "edited" for edits nobody made.
 *
 * The stamp tells the two apart: a snapshot whose overlay still hashes to the
 * starter recorded alongside it was a clean checkout, so nothing is lost by
 * re-basing it on the current starter. A snapshot based on a published version
 * is a checkout of that version rather than of the starter, and is restored
 * whatever the starter has since done.
 *
 * Snapshots written before the stamp existed carry none and are restored as
 * drafts. Some of them are stale clean checkouts, but the two are
 * indistinguishable from here and discarding on a guess would throw away real
 * work; publishing, reverting, or any agent edit re-stamps them.
 */
export async function restorableFiles(snapshot: ProjectSnapshot | null): Promise<FileMap | undefined> {
  if (!snapshot) return undefined;
  if (snapshot.versionId || !snapshot.starterOverlayHash) return snapshot.files;
  const clean = (await overlayHash(extractOverlay(snapshot.files))) === snapshot.starterOverlayHash;
  return clean ? undefined : snapshot.files;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadSnapshot(): Promise<ProjectSnapshot | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => {
      const value = request.result as ProjectSnapshot | undefined;
      const valid = value?.schemaVersion === SCHEMA_VERSION && Number.isInteger(value.revision) && value.files && typeof value.files === 'object';
      resolve(valid ? value : null);
    };
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => database.close();
  });
}

export async function saveSnapshot(
  revision: number,
  files: FileMap,
  versionId: string | null,
  starterOverlayHash: string,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      schemaVersion: SCHEMA_VERSION,
      revision,
      files,
      savedAt: new Date().toISOString(),
      versionId,
      starterOverlayHash,
    } satisfies ProjectSnapshot, SNAPSHOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

