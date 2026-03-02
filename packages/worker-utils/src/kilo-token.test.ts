import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyKiloToken, UserNotFoundError, TokenRevokedError } from './kilo-token.js';
import type { WorkerDb } from '@kilocode/db/client';

const SECRET = 'test-secret-at-least-32-characters-long';

function encode(secret: string) {
  return new TextEncoder().encode(secret);
}

async function sign(payload: Record<string, unknown>, secret = SECRET, expiresIn = '1h') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encode(secret));
}

/**
 * Build a fake WorkerDb that responds to lookupPepper's drizzle query.
 * `result`: `{ api_token_pepper }` if the user exists, `null` if not found.
 */
function fakeDb(result: { api_token_pepper: string | null } | null): WorkerDb {
  const rows = result !== null ? [result] : [];
  // lookupPepper calls: db.select({...}).from(table).where(...).limit(1).then(fn)
  // We make the chain end in a resolved Promise so .then() on it returns the rows.
  const resolved = Promise.resolve(rows);
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => resolved,
  };
  return { select: () => chain } as unknown as WorkerDb;
}

describe('verifyKiloToken', () => {
  it('succeeds when JWT pepper matches DB pepper', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123', apiTokenPepper: 'abc' });
    const payload = await verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: 'abc' }));
    expect(payload.kiloUserId).toBe('user-123');
    expect(payload.version).toBe(3);
  });

  it('succeeds when both JWT pepper and DB pepper are null', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-nullpepper' });
    const payload = await verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: null }));
    expect(payload.kiloUserId).toBe('user-nullpepper');
  });

  it('preserves extra claims in payload', async () => {
    const token = await sign({
      version: 3,
      kiloUserId: 'user-456',
      apiTokenPepper: 'pepper-abc',
      organizationId: 'org-1',
    });
    const payload = await verifyKiloToken(
      token,
      SECRET,
      fakeDb({ api_token_pepper: 'pepper-abc' })
    );
    expect(payload.kiloUserId).toBe('user-456');
    expect(payload.apiTokenPepper).toBe('pepper-abc');
    expect(payload.organizationId).toBe('org-1');
  });

  it('throws TokenRevokedError when JWT pepper mismatches DB pepper', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123', apiTokenPepper: 'old' });
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: 'new' }))
    ).rejects.toThrow(TokenRevokedError);
  });

  it('throws TokenRevokedError when JWT pepper is null but DB has a pepper', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' });
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: 'rotated' }))
    ).rejects.toThrow(TokenRevokedError);
  });

  it('throws UserNotFoundError when user not found in DB', async () => {
    const token = await sign({ version: 3, kiloUserId: 'ghost-user' });
    await expect(verifyKiloToken(token, SECRET, fakeDb(null))).rejects.toThrow(UserNotFoundError);
  });

  it('rejects wrong version', async () => {
    const token = await sign({ version: 2, kiloUserId: 'user-123' });
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: null }))
    ).rejects.toThrow();
  });

  it('rejects token missing kiloUserId', async () => {
    const token = await sign({ version: 3 });
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: null }))
    ).rejects.toThrow();
  });

  it('rejects empty kiloUserId', async () => {
    const token = await sign({ version: 3, kiloUserId: '' });
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: null }))
    ).rejects.toThrow();
  });

  it('rejects wrong secret', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' });
    await expect(
      verifyKiloToken(
        token,
        'wrong-secret-that-is-at-least-32-chars',
        fakeDb({ api_token_pepper: null })
      )
    ).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' }, SECRET, '0s');
    await expect(
      verifyKiloToken(token, SECRET, fakeDb({ api_token_pepper: null }))
    ).rejects.toThrow();
  });

  it('rejects a non-JWT string', async () => {
    await expect(
      verifyKiloToken('not.a.token', SECRET, fakeDb({ api_token_pepper: null }))
    ).rejects.toThrow();
  });
});
