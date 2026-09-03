import { argon2idAsync } from '@noble/hashes/argon2.js';

export const MIN_STORAGE_PASSPHRASE_LENGTH = 12;
export const MAX_STORAGE_PASSPHRASE_LENGTH = 1_024;

const ARGON2ID_MEMORY_KIB = 19 * 1_024;
const ARGON2ID_ITERATIONS = 2;
const ARGON2ID_PARALLELISM = 1;
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;
const AES_GCM_IV_LENGTH_BYTES = 12;
const ENCRYPTION_VERSION = 1;

export interface EncryptionMetadata {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "argon2id";
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface EncryptedPayload {
  version: 1;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface BrowserEncryptionContext {
  key: CryptoKey;
  metadata: EncryptionMetadata;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function requireWebCrypto(): Crypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("This browser does not support the encryption required for local storage.");
  }
  return crypto;
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_STORAGE_PASSPHRASE_LENGTH) {
    throw new Error(
      `Use a passphrase with at least ${MIN_STORAGE_PASSPHRASE_LENGTH} characters.`,
    );
  }
  if (passphrase.length > MAX_STORAGE_PASSPHRASE_LENGTH) {
    throw new Error(
      `Use a passphrase with no more than ${MAX_STORAGE_PASSPHRASE_LENGTH.toLocaleString()} characters.`,
    );
  }
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

export function isEncryptionMetadata(value: unknown): value is EncryptionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.version === ENCRYPTION_VERSION &&
    metadata.algorithm === "AES-GCM" &&
    metadata.kdf === "argon2id" &&
    metadata.salt instanceof Uint8Array &&
    metadata.salt.byteLength === SALT_LENGTH_BYTES &&
    metadata.memoryKiB === ARGON2ID_MEMORY_KIB &&
    metadata.iterations === ARGON2ID_ITERATIONS &&
    metadata.parallelism === ARGON2ID_PARALLELISM
  );
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.version === ENCRYPTION_VERSION &&
    payload.iv instanceof Uint8Array &&
    payload.iv.byteLength === AES_GCM_IV_LENGTH_BYTES &&
    payload.ciphertext instanceof ArrayBuffer
  );
}

async function importEncryptionKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return requireWebCrypto().subtle.importKey(
    "raw",
    copyBytes(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveKey(
  passphrase: string,
  metadata: EncryptionMetadata,
): Promise<CryptoKey> {
  validatePassphrase(passphrase);
  if (!isEncryptionMetadata(metadata)) {
    throw new Error("The local record uses an unsupported encryption format.");
  }

  const passwordBytes = encoder.encode(passphrase.normalize("NFKC"));
  let keyBytes: Uint8Array | undefined;
  try {
    keyBytes = await argon2idAsync(passwordBytes, metadata.salt, {
      m: metadata.memoryKiB,
      t: metadata.iterations,
      p: metadata.parallelism,
      dkLen: KEY_LENGTH_BYTES,
      asyncTick: 8,
    });
    return await importEncryptionKey(keyBytes);
  } finally {
    passwordBytes.fill(0);
    keyBytes?.fill(0);
  }
}

export async function createBrowserEncryption(
  passphrase: string,
): Promise<BrowserEncryptionContext> {
  const webCrypto = requireWebCrypto();
  const metadata: EncryptionMetadata = {
    version: ENCRYPTION_VERSION,
    algorithm: "AES-GCM",
    kdf: "argon2id",
    salt: webCrypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES)),
    memoryKiB: ARGON2ID_MEMORY_KIB,
    iterations: ARGON2ID_ITERATIONS,
    parallelism: ARGON2ID_PARALLELISM,
  };
  return { key: await deriveKey(passphrase, metadata), metadata };
}

export async function unlockBrowserEncryption(
  passphrase: string,
  metadata: EncryptionMetadata,
): Promise<BrowserEncryptionContext> {
  return { key: await deriveKey(passphrase, metadata), metadata };
}

export async function encryptBytes(
  value: Uint8Array | ArrayBuffer,
  context: BrowserEncryptionContext,
  additionalData: string,
): Promise<EncryptedPayload> {
  const webCrypto = requireWebCrypto();
  const iv = webCrypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH_BYTES));
  const bytes = value instanceof Uint8Array ? copyBytes(value) : value.slice(0);
  const ciphertext = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(additionalData),
      tagLength: 128,
    },
    context.key,
    bytes,
  );
  return { version: ENCRYPTION_VERSION, iv, ciphertext };
}

export async function decryptBytes(
  payload: EncryptedPayload,
  context: BrowserEncryptionContext,
  additionalData: string,
): Promise<ArrayBuffer> {
  if (!isEncryptedPayload(payload)) {
    throw new Error("The encrypted local record is damaged or unsupported.");
  }
  try {
    return await requireWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: copyBytes(payload.iv),
        additionalData: encoder.encode(additionalData),
        tagLength: 128,
      },
      context.key,
      payload.ciphertext,
    );
  } catch {
    throw new Error("The passphrase is incorrect or the encrypted local record is damaged.");
  }
}

export async function encryptJson(
  value: unknown,
  context: BrowserEncryptionContext,
  additionalData: string,
): Promise<EncryptedPayload> {
  return encryptBytes(encoder.encode(JSON.stringify(value)), context, additionalData);
}

export async function decryptJson<T>(
  payload: EncryptedPayload,
  context: BrowserEncryptionContext,
  additionalData: string,
): Promise<T> {
  const plaintext = await decryptBytes(payload, context, additionalData);
  try {
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error("The encrypted local record is damaged.");
  }
}
