import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearRecord,
  loadRecord,
  lockRecord,
  recordState,
  saveRecord,
  storedProvider,
  unlockRecord,
} from '../lib/health/storage';
import type { HealthExportDocument } from '../lib/health/types';

/**
 * The record is the most sensitive thing this app touches, so these cover the
 * properties that actually matter: it is unreadable without the passphrase, a
 * wrong passphrase fails closed, and locking really drops the key rather than
 * just hiding the UI.
 */

const PASSPHRASE = 'correct horse battery staple';

function record(): HealthExportDocument {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    exportedBy: 'Formless Health',
    source: { provider: 'UCSF Health', fhirBase: 'https://example.invalid/fhir', patientId: 'p1' },
    purpose: 'Testing.',
    limitations: [],
    data: { Patient: [{ resourceType: 'Patient', id: 'p1', name: [{ text: 'Ada Lovelace' }] }] },
    errors: {},
    priorAuthorizations: [],
  };
}

beforeEach(async () => {
  await clearRecord();
});

describe('encrypted record storage', () => {
  it('starts empty', async () => {
    expect(await recordState()).toBe('empty');
    expect(await loadRecord()).toBeUndefined();
  });

  it('round-trips a saved record while unlocked', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    expect(await recordState()).toBe('unlocked');
    expect(await storedProvider()).toBe('UCSF Health');
    expect(await loadRecord()).toEqual(record());
  });

  it('locking drops the key, not just the view', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    lockRecord();
    expect(await recordState()).toBe('locked');
    // The ciphertext is still there; without the key it is unreadable.
    expect(await loadRecord()).toBeUndefined();
  });

  it('unlocks again with the right passphrase', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    lockRecord();
    expect(await unlockRecord(PASSPHRASE)).toEqual(record());
    expect(await recordState()).toBe('unlocked');
  });

  it('fails closed on a wrong passphrase and stays locked', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    lockRecord();
    await expect(unlockRecord('not the passphrase')).rejects.toThrow(/did not unlock/);
    expect(await recordState()).toBe('locked');
    expect(await loadRecord()).toBeUndefined();
  });

  it('refuses to unlock when nothing is stored', async () => {
    await expect(unlockRecord(PASSPHRASE)).rejects.toThrow(/no stored record/);
  });

  it('clearing removes the ciphertext outright', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    await clearRecord();
    expect(await recordState()).toBe('empty');
    await expect(unlockRecord(PASSPHRASE)).rejects.toThrow(/no stored record/);
  });

  it('does not persist the record in plaintext', async () => {
    await saveRecord(record(), PASSPHRASE, 'UCSF Health');
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('webally-health', 1);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction('records', 'readonly').objectStore('records').get('active');
        request.onsuccess = () => { resolve(request.result); database.close(); };
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(JSON.stringify(raw)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(raw)).not.toContain(PASSPHRASE);
  });
});
