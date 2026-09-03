'use client';

import {
  createBrowserEncryption,
  decryptJson,
  encryptJson,
  isEncryptionMetadata,
  unlockBrowserEncryption,
  type BrowserEncryptionContext,
  type EncryptedPayload,
  type EncryptionMetadata,
} from './encryption';
import type { HealthExportDocument } from './types';

/**
 * Encrypted storage for the imported record, on the host origin.
 *
 * Adapted from yesyouhealth's `lib/browser-storage.ts` rather than copied. That
 * file is 778 lines because it streams a live FHIR import into IndexedDB page by
 * page, stages attachments, and carries the longitudinal-study tables — a
 * pipeline this host does not have and two features that are out of scope. What
 * is kept is the part that matters: Argon2id key derivation and AES-GCM at rest,
 * with the key held only in memory.
 *
 * Storing this on the host origin rather than in the guest is not incidental.
 * The WebContainer preview gets a fresh origin on every boot, so a record kept
 * guest-side would be silently destroyed each restart — and the guest is the
 * code an agent may rewrite.
 */

const DATABASE_NAME = 'webally-health';
const DATABASE_VERSION = 1;
const STORE = 'records';
const RECORD_KEY = 'active';
/**
 * Additional authenticated data. Binds the ciphertext to this purpose, so a
 * payload cannot be lifted from one store and decrypted as another.
 */
const RECORD_AAD = 'webally-health/record/v1';

interface StoredRecord {
  metadata: EncryptionMetadata;
  payload: EncryptedPayload;
  provider: string;
  savedAt: string;
}

/** The derived key, in memory only. Never persisted, never sent over the bridge. */
let unlocked: BrowserEncryptionContext | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
    });
  } finally {
    database.close();
  }
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isEncryptionMetadata(record.metadata) && typeof record.payload === 'object';
}

async function readStored(): Promise<StoredRecord | undefined> {
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get(RECORD_KEY));
    return isStoredRecord(value) ? value : undefined;
  } catch {
    // A blocked or unavailable IndexedDB means "no stored record", not a crash.
    return undefined;
  }
}

export type RecordState = 'empty' | 'locked' | 'unlocked';

export async function recordState(): Promise<RecordState> {
  const stored = await readStored();
  if (!stored) return 'empty';
  return unlocked ? 'unlocked' : 'locked';
}

export async function storedProvider(): Promise<string | null> {
  return (await readStored())?.provider ?? null;
}

/** Derives a fresh key and encrypts the record under it. Used after an import. */
export async function saveRecord(
  record: HealthExportDocument,
  passphrase: string,
  provider: string,
): Promise<void> {
  const encryption = await createBrowserEncryption(passphrase);
  const payload = await encryptJson(record, encryption, RECORD_AAD);
  const stored: StoredRecord = {
    metadata: encryption.metadata,
    payload,
    provider,
    savedAt: new Date().toISOString(),
  };
  await withStore('readwrite', (store) => store.put(stored, RECORD_KEY));
  unlocked = encryption;
}

/** Re-derives the key from a passphrase. Throws if the passphrase is wrong. */
export async function unlockRecord(passphrase: string): Promise<HealthExportDocument> {
  const stored = await readStored();
  if (!stored) throw new Error('There is no stored record in this browser.');
  const encryption = await unlockBrowserEncryption(passphrase, stored.metadata);
  // A wrong passphrase surfaces as an AES-GCM tag failure, which is the only
  // check there is — the key itself is never stored to compare against.
  let record: HealthExportDocument;
  try {
    record = await decryptJson<HealthExportDocument>(stored.payload, encryption, RECORD_AAD);
  } catch {
    throw new Error('That passphrase did not unlock the record.');
  }
  unlocked = encryption;
  return record;
}

/** The decrypted record, or undefined when there is none or it is locked. */
export async function loadRecord(): Promise<HealthExportDocument | undefined> {
  if (!unlocked) return undefined;
  const stored = await readStored();
  if (!stored) return undefined;
  try {
    return await decryptJson<HealthExportDocument>(stored.payload, unlocked, RECORD_AAD);
  } catch {
    return undefined;
  }
}

/** Drops the key from memory. The ciphertext stays on disk. */
export function lockRecord(): void {
  unlocked = null;
}

export async function clearRecord(): Promise<void> {
  unlocked = null;
  try {
    await withStore('readwrite', (store) => store.delete(RECORD_KEY));
  } catch {
    // Nothing stored, or storage unavailable. Either way there is nothing left.
  }
}
