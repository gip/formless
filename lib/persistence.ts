import type { FileMap } from './canvas-types';

const DB_NAME = 'webmcp-canvas';
const STORE_NAME = 'project-snapshots';
const SNAPSHOT_KEY = 'active';
const SCHEMA_VERSION = 1;

export interface ProjectSnapshot {
  schemaVersion: number;
  revision: number;
  files: FileMap;
  savedAt: string;
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

export async function saveSnapshot(revision: number, files: FileMap): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      schemaVersion: SCHEMA_VERSION,
      revision,
      files,
      savedAt: new Date().toISOString(),
    } satisfies ProjectSnapshot, SNAPSHOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

