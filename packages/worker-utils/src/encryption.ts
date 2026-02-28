/**
 * Envelope encryption using Web Crypto API (works in Workers, Node.js 15+, and browsers).
 *
 * Encryption format: RSA-OAEP (SHA-256) wraps an AES-256-GCM DEK.
 * The encrypted data concatenates IV (16 bytes) + ciphertext + authTag (16 bytes),
 * all base64-encoded.
 */

export class EncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigurationError';
  }
}

export class EncryptionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionFormatError';
  }
}

export type EncryptedEnvelope = {
  encryptedData: string; // AES-encrypted value (base64)
  encryptedDEK: string; // RSA-encrypted DEK (base64)
  algorithm: 'rsa-aes-256-gcm';
  version: 1;
};

// ---- helpers ----

/** Narrow generateKey result — symmetric algorithms always return CryptoKey, never CryptoKeyPair. */
function isCryptoKey(key: CryptoKey | CryptoKeyPair): key is CryptoKey {
  return 'type' in key && typeof (key as CryptoKey).type === 'string';
}

/** Narrow exportKey result — 'raw' format always returns ArrayBuffer, never JsonWebKey. */
function isArrayBuffer(val: ArrayBuffer | JsonWebKey): val is ArrayBuffer {
  return val instanceof ArrayBuffer;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Strip PEM armour and decode the DER bytes.
 * Handles both PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1 ("BEGIN RSA PRIVATE KEY").
 * Returns `{ der, format }`.
 */
function parsePemPrivateKey(pem: string): { der: ArrayBuffer; format: 'pkcs8' } {
  const lines = pem.split('\n');
  const body = lines.filter(l => !l.startsWith('-----')).join('');
  if (!body) throw new EncryptionConfigurationError('PEM body is empty');

  // We only support PKCS#8 for Web Crypto importKey.
  // PKCS#1 keys (BEGIN RSA PRIVATE KEY) are not directly supported.
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new EncryptionConfigurationError(
      'PKCS#1 private keys are not supported. Convert to PKCS#8 with: ' +
        'openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt'
    );
  }

  const bytes = base64ToBytes(body);
  return {
    der: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    format: 'pkcs8',
  };
}

/** Strip PEM armour from an SPKI public key and decode the DER bytes. */
function parsePemPublicKey(pem: string): ArrayBuffer {
  const lines = pem.split('\n');
  const body = lines.filter(l => !l.startsWith('-----')).join('');
  if (!body) throw new EncryptionConfigurationError('PEM body is empty');
  const bytes = base64ToBytes(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ---- public API ----

/**
 * Encrypt a value using envelope encryption (AES-256-GCM + RSA-OAEP).
 *
 * 1. Generate random AES-256 DEK
 * 2. Encrypt the value with AES-256-GCM (output = base64(iv + ciphertext + authTag))
 * 3. Wrap the DEK with RSA-OAEP (SHA-256)
 */
export async function encryptWithPublicKey(
  value: string,
  publicKeyPem: string
): Promise<EncryptedEnvelope> {
  if (!publicKeyPem) {
    throw new EncryptionConfigurationError('Public key parameter is required');
  }

  try {
    const spkiDer = parsePemPublicKey(publicKeyPem);

    // Import RSA public key
    const rsaKey = await crypto.subtle.importKey(
      'spki',
      spkiDer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );

    // Generate random AES-256 DEK
    const aesKeyResult = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
    ]);
    if (!isCryptoKey(aesKeyResult)) throw new EncryptionConfigurationError('Expected CryptoKey');
    const aesKey = aesKeyResult;

    // Encrypt value with AES-256-GCM
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encoded = new TextEncoder().encode(value);
    // Web Crypto AES-GCM encrypt returns ciphertext + authTag concatenated
    const ciphertextWithTag = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aesKey, encoded)
    );

    // Format: iv (16) + ciphertext + authTag (16) — same as old Node.js format
    const encryptedDataBytes = new Uint8Array(iv.length + ciphertextWithTag.length);
    encryptedDataBytes.set(iv, 0);
    encryptedDataBytes.set(ciphertextWithTag, iv.length);
    const encryptedData = bytesToBase64(encryptedDataBytes);

    // Export raw DEK bytes and wrap with RSA-OAEP
    const rawDekResult = await crypto.subtle.exportKey('raw', aesKey);
    if (!isArrayBuffer(rawDekResult))
      throw new EncryptionConfigurationError('Expected ArrayBuffer');
    const encryptedDEKBytes = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, rawDekResult)
    );
    const encryptedDEK = bytesToBase64(encryptedDEKBytes);

    return { encryptedData, encryptedDEK, algorithm: 'rsa-aes-256-gcm', version: 1 };
  } catch (error) {
    if (error instanceof EncryptionConfigurationError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new EncryptionConfigurationError(`Encryption failed: ${msg}`);
  }
}

/**
 * Decrypt an envelope-encrypted value.
 *
 * 1. RSA-OAEP decrypt the DEK with the private key
 * 2. AES-256-GCM decrypt the data with the DEK
 */
export async function decryptWithPrivateKey(
  envelope: EncryptedEnvelope,
  privateKeyPem: string
): Promise<string> {
  if (!privateKeyPem) {
    throw new EncryptionConfigurationError('Private key parameter is required');
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new EncryptionFormatError('Invalid envelope: must be an object');
  }
  if (envelope.algorithm !== 'rsa-aes-256-gcm') {
    throw new EncryptionFormatError(
      `Unsupported algorithm: ${String(envelope.algorithm)}. Expected: rsa-aes-256-gcm`
    );
  }
  if (envelope.version !== 1) {
    throw new EncryptionFormatError(
      `Unsupported version: ${String(envelope.version)}. Expected: 1`
    );
  }
  if (!envelope.encryptedData || !envelope.encryptedDEK) {
    throw new EncryptionFormatError('Invalid envelope: missing encryptedData or encryptedDEK');
  }

  try {
    const { der, format } = parsePemPrivateKey(privateKeyPem);

    // Import RSA private key
    const rsaKey = await crypto.subtle.importKey(
      format,
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );

    // Decrypt DEK
    const encryptedDEK = base64ToBytes(envelope.encryptedDEK);
    const dekBuffer = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsaKey, encryptedDEK);

    // Import AES key
    const aesKey = await crypto.subtle.importKey('raw', dekBuffer, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);

    // Decode data: first 16 bytes = IV, rest = ciphertext + authTag (GCM appends tag)
    const dataBytes = base64ToBytes(envelope.encryptedData);
    if (dataBytes.length < 32) {
      throw new EncryptionFormatError('Invalid encrypted data: too short');
    }
    const iv = dataBytes.slice(0, 16);
    const ciphertextWithTag = dataBytes.slice(16); // includes 16-byte auth tag at end

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      ciphertextWithTag
    );

    return new TextDecoder().decode(plainBuf);
  } catch (error) {
    if (error instanceof EncryptionFormatError) throw error;
    if (error instanceof EncryptionConfigurationError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new EncryptionConfigurationError(`Decryption failed: ${msg}`);
  }
}

/**
 * Decrypt all encrypted secrets and return them as a plain Record<string, string>.
 */
export async function decryptSecrets(
  encryptedSecrets: Record<string, EncryptedEnvelope>,
  privateKeyPem: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, envelope] of Object.entries(encryptedSecrets)) {
    result[key] = await decryptWithPrivateKey(envelope, privateKeyPem);
  }
  return result;
}

/**
 * Merge plaintext env vars with decrypted secrets.
 * Decrypted secrets override plaintext env vars if there are conflicts.
 */
export async function mergeEnvVarsWithSecrets(
  envVars: Record<string, string> | undefined,
  encryptedSecrets: Record<string, EncryptedEnvelope> | undefined,
  privateKeyPem: string | undefined
): Promise<Record<string, string>> {
  const result: Record<string, string> = { ...(envVars ?? {}) };

  if (encryptedSecrets && Object.keys(encryptedSecrets).length > 0) {
    if (!privateKeyPem) {
      throw new EncryptionConfigurationError(
        'AGENT_ENV_VARS_PRIVATE_KEY is required to decrypt encrypted secrets'
      );
    }
    const decrypted = await decryptSecrets(encryptedSecrets, privateKeyPem);
    for (const [key, value] of Object.entries(decrypted)) {
      result[key] = value;
    }
  }

  return result;
}
