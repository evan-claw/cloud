import { describe, test, expect, beforeAll } from '@jest/globals';
import { generateKeyPairSync } from 'crypto';
import {
  encryptWithPublicKey,
  decryptWithPrivateKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
  type EncryptedEnvelope,
} from './encryption';

describe('encryption', () => {
  let publicKey: string;
  let privateKey: string;
  let wrongPrivateKey: string;

  beforeAll(() => {
    // Generate RSA key pair for testing
    const { publicKey: pubKey, privateKey: privKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    publicKey = pubKey;
    privateKey = privKey;

    // Generate another key pair for testing mismatched keys
    const { privateKey: wrongPrivKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    wrongPrivateKey = wrongPrivKey;
  });

  test('encrypts successfully with correct envelope structure and decrypts correctly', () => {
    const testValue = 'test secret value';

    // Test encryption produces correct structure
    const envelope = encryptWithPublicKey(testValue, publicKey);

    expect(envelope).toHaveProperty('encryptedData');
    expect(envelope).toHaveProperty('encryptedDEK');
    expect(envelope).toHaveProperty('algorithm');
    expect(envelope).toHaveProperty('version');
    expect(envelope.algorithm).toBe('rsa-aes-256-gcm');
    expect(envelope.version).toBe(1);
    expect(typeof envelope.encryptedData).toBe('string');
    expect(typeof envelope.encryptedDEK).toBe('string');
    expect(envelope.encryptedData.length).toBeGreaterThan(0);
    expect(envelope.encryptedDEK.length).toBeGreaterThan(0);

    // Test basic round-trip decryption
    const decrypted = decryptWithPrivateKey(envelope, privateKey);
    expect(decrypted).toBe(testValue);
  });

  test('handles edge cases: empty strings, long strings, unicode, and multiple values', () => {
    // Empty string
    const emptyEnvelope = encryptWithPublicKey('', publicKey);
    expect(decryptWithPrivateKey(emptyEnvelope, privateKey)).toBe('');

    // Long string (~30KB)
    const longValue = 'Lorem ipsum dolor sit amet. '.repeat(1000);
    const longEnvelope = encryptWithPublicKey(longValue, publicKey);
    const longDecrypted = decryptWithPrivateKey(longEnvelope, privateKey);
    expect(longDecrypted).toBe(longValue);
    expect(longDecrypted.length).toBe(longValue.length);

    // Unicode and special characters
    const testValues = [
      'Hello 世界! 🌍',
      '¡Hola! ¿Cómo estás?',
      'Привет мир',
      'こんにちは',
      '你好世界',
      'Emoji test 🚀 🎉 🔐',
      'Special chars: !@#$%^&*(){}[]|\\:";\'<>?,./~`',
      'Newlines\nand\ttabs',
    ];

    for (const testValue of testValues) {
      const envelope = encryptWithPublicKey(testValue, publicKey);
      const decrypted = decryptWithPrivateKey(envelope, privateKey);
      expect(decrypted).toBe(testValue);
    }

    // Multiple values
    const values = ['value1', 'value2', 'value3', 'value4', 'value5'];
    const envelopes = values.map(value => encryptWithPublicKey(value, publicKey));
    const decrypted = envelopes.map(envelope => decryptWithPrivateKey(envelope, privateKey));
    expect(decrypted).toEqual(values);
  });

  test('produces non-deterministic encrypted output for security', () => {
    const testValue = 'same input value';

    const envelope1 = encryptWithPublicKey(testValue, publicKey);
    const envelope2 = encryptWithPublicKey(testValue, publicKey);

    // Different random IV and DEK should result in different encrypted outputs
    expect(envelope1.encryptedData).not.toBe(envelope2.encryptedData);
    expect(envelope1.encryptedDEK).not.toBe(envelope2.encryptedDEK);

    // But both should decrypt to the same value
    expect(decryptWithPrivateKey(envelope1, privateKey)).toBe(testValue);
    expect(decryptWithPrivateKey(envelope2, privateKey)).toBe(testValue);
  });

  test('throws EncryptionConfigurationError for invalid public keys', () => {
    // Missing public key
    expect(() => {
      encryptWithPublicKey('test value', '');
    }).toThrow(EncryptionConfigurationError);

    expect(() => {
      encryptWithPublicKey('test value', '');
    }).toThrow('Public key parameter is required');

    // Invalid public key format
    expect(() => {
      encryptWithPublicKey('test value', 'not a valid public key');
    }).toThrow(EncryptionConfigurationError);

    expect(() => {
      encryptWithPublicKey('test value', 'not a valid public key');
    }).toThrow('Encryption failed');
  });

  test('throws EncryptionConfigurationError for invalid private keys', () => {
    const envelope = encryptWithPublicKey('test value', publicKey);

    // Missing private key
    expect(() => {
      decryptWithPrivateKey(envelope, '');
    }).toThrow(EncryptionConfigurationError);

    expect(() => {
      decryptWithPrivateKey(envelope, '');
    }).toThrow('Private key parameter is required');

    // Mismatched private key
    expect(() => {
      decryptWithPrivateKey(envelope, wrongPrivateKey);
    }).toThrow(EncryptionConfigurationError);

    expect(() => {
      decryptWithPrivateKey(envelope, wrongPrivateKey);
    }).toThrow('Decryption failed');
  });

  test('throws EncryptionFormatError for invalid envelope structure', () => {
    // Null envelope
    expect(() => {
      decryptWithPrivateKey(null as unknown as EncryptedEnvelope, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(null as unknown as EncryptedEnvelope, privateKey);
    }).toThrow('Invalid envelope: must be an object');

    // Not an object
    expect(() => {
      decryptWithPrivateKey('not an object' as unknown as EncryptedEnvelope, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey('not an object' as unknown as EncryptedEnvelope, privateKey);
    }).toThrow('Invalid envelope: must be an object');

    // Missing encryptedData
    const missingData = {
      encryptedDEK: 'test',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    } as unknown as EncryptedEnvelope;

    expect(() => {
      decryptWithPrivateKey(missingData, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(missingData, privateKey);
    }).toThrow('missing encryptedData or encryptedDEK');

    // Missing encryptedDEK
    const missingDEK = {
      encryptedData: 'test',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    } as unknown as EncryptedEnvelope;

    expect(() => {
      decryptWithPrivateKey(missingDEK, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(missingDEK, privateKey);
    }).toThrow('missing encryptedData or encryptedDEK');

    // Unsupported algorithm
    const badAlgorithm: EncryptedEnvelope = {
      encryptedData: 'test',
      encryptedDEK: 'test',
      algorithm: 'aes-128-cbc' as unknown as 'rsa-aes-256-gcm',
      version: 1,
    };

    expect(() => {
      decryptWithPrivateKey(badAlgorithm, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(badAlgorithm, privateKey);
    }).toThrow('Unsupported algorithm');

    // Unsupported version
    const badVersion: EncryptedEnvelope = {
      encryptedData: 'test',
      encryptedDEK: 'test',
      algorithm: 'rsa-aes-256-gcm',
      version: 2 as unknown as 1,
    };

    expect(() => {
      decryptWithPrivateKey(badVersion, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(badVersion, privateKey);
    }).toThrow('Unsupported version');

    // Encrypted data too short
    const validEnvelope = encryptWithPublicKey('test', publicKey);
    const tooShort: EncryptedEnvelope = {
      ...validEnvelope,
      encryptedData: Buffer.from('short').toString('base64'), // Less than 32 bytes
    };

    expect(() => {
      decryptWithPrivateKey(tooShort, privateKey);
    }).toThrow(EncryptionFormatError);

    expect(() => {
      decryptWithPrivateKey(tooShort, privateKey);
    }).toThrow('Invalid encrypted data: too short');
  });

  test('throws EncryptionConfigurationError for corrupted data (auth tag validation)', () => {
    const envelope = encryptWithPublicKey('test value', publicKey);

    // Corrupt the encrypted data by changing bytes
    const corruptedData = Buffer.from(envelope.encryptedData, 'base64');
    corruptedData[20] ^= 0xff; // Flip some bits in the middle
    const corruptedEnvelope: EncryptedEnvelope = {
      ...envelope,
      encryptedData: corruptedData.toString('base64'),
    };

    expect(() => {
      decryptWithPrivateKey(corruptedEnvelope, privateKey);
    }).toThrow(EncryptionConfigurationError);

    expect(() => {
      decryptWithPrivateKey(corruptedEnvelope, privateKey);
    }).toThrow('Decryption failed');
  });
});
