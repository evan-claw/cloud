import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateKiloToken } from './jwt';
import { KILO_TOKEN_VERSION } from '../config';
import { UserNotFoundError, TokenRevokedError, JwtVerificationError } from '@kilocode/worker-utils';
import type { WorkerDb } from '@kilocode/db/client';
import type * as WorkerUtilsModule from '@kilocode/worker-utils';

vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<typeof WorkerUtilsModule>();
  return { ...actual, verifyKiloToken: vi.fn() };
});

import { verifyKiloToken } from '@kilocode/worker-utils';

const TEST_SECRET = 'test-secret-for-jwt-verification';
const fakeDb = {} as WorkerDb;

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    version: KILO_TOKEN_VERSION as 3,
    kiloUserId: 'user_123',
    apiTokenPepper: 'pepper_abc',
    env: 'development',
    ...overrides,
  };
}

describe('validateKiloToken', () => {
  beforeEach(() => {
    vi.mocked(verifyKiloToken).mockReset();
  });

  it('validates a well-formed token', async () => {
    vi.mocked(verifyKiloToken).mockResolvedValueOnce(makePayload());

    const result = await validateKiloToken('some-token', TEST_SECRET, 'development', fakeDb);
    expect(result).toEqual({
      success: true,
      userId: 'user_123',
      token: 'some-token',
    });
  });

  it('rejects wrong token version (verifyKiloToken throws)', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('invalid version'))
    );

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
  });

  it('rejects env mismatch', async () => {
    vi.mocked(verifyKiloToken).mockResolvedValueOnce(makePayload({ env: 'production' }));

    const result = await validateKiloToken('some-token', TEST_SECRET, 'development', fakeDb);
    expect(result).toEqual({
      success: false,
      error: 'Invalid token',
    });
  });

  it('allows missing env in token when expectedEnv is set', async () => {
    vi.mocked(verifyKiloToken).mockResolvedValueOnce(makePayload({ env: undefined }));

    const result = await validateKiloToken('some-token', TEST_SECRET, 'production', fakeDb);
    expect(result.success).toBe(true);
  });

  it('allows missing expectedEnv when token has env', async () => {
    vi.mocked(verifyKiloToken).mockResolvedValueOnce(makePayload({ env: 'production' }));

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(true);
  });

  it('rejects expired token (verifyKiloToken throws)', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('"exp" claim timestamp check failed'))
    );

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
  });

  it('rejects tokens signed with wrong secret (verifyKiloToken throws)', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('signature verification failed'))
    );

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('signature');
    }
  });

  it('maps UserNotFoundError to success: false', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new UserNotFoundError('user_123'));

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
  });

  it('maps TokenRevokedError to success: false', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new TokenRevokedError('user_123'));

    const result = await validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
  });

  it('propagates DB connectivity errors', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new Error('connection refused'));

    await expect(validateKiloToken('some-token', TEST_SECRET, undefined, fakeDb)).rejects.toThrow(
      'connection refused'
    );
  });

  it('rejects malformed tokens (verifyKiloToken throws)', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('not a JWT'))
    );

    const result = await validateKiloToken('not-a-jwt', TEST_SECRET, undefined, fakeDb);
    expect(result.success).toBe(false);
  });
});
