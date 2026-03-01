export {
  decryptWithPrivateKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
  encryptWithPublicKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
} from '@kilocode/worker-utils';
export type { EncryptedEnvelope } from '@kilocode/worker-utils';

// Local aliases for backward compatibility
export {
  EncryptionConfigurationError as DecryptionConfigurationError,
  EncryptionFormatError as DecryptionFormatError,
} from '@kilocode/worker-utils';
export type { EncryptedEnvelope as EncryptedSecretEnvelope } from '@kilocode/worker-utils';

// Local type alias
export type EncryptedSecrets = Record<string, import('@kilocode/worker-utils').EncryptedEnvelope>;
