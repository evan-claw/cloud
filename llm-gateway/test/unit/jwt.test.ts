import { describe, it, expect } from 'vitest';
import { verifyGatewayJwt, isPepperValid } from '../../src/lib/jwt';
import { SignJWT } from 'jose';

const SECRET = 'test-secret-at-least-32-characters-long';

function encode(s: string) {
  return new TextEncoder().encode(s);
}

async function sign(payload: Record<string, unknown>, secret = SECRET, expiresIn = '1h') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encode(secret));
}

describe('verifyGatewayJwt', () => {
  it('returns ok for a valid v3 token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-1' });
    const result = await verifyGatewayJwt(token, SECRET);
    expect(result).toMatchObject({ ok: true, payload: { kiloUserId: 'user-1', version: 3 } });
  });

  it('preserves extra payload fields', async () => {
    const token = await sign({
      version: 3,
      kiloUserId: 'user-2',
      apiTokenPepper: 'abc',
      botId: 'bot-x',
      tokenSource: 'cloud-agent',
      organizationId: 'org-1',
    });
    const result = await verifyGatewayJwt(token, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.apiTokenPepper).toBe('abc');
    expect(result.payload.botId).toBe('bot-x');
    expect(result.payload.tokenSource).toBe('cloud-agent');
    expect(result.payload.organizationId).toBe('org-1');
  });

  it('returns version reason for wrong version', async () => {
    const token = await sign({ version: 2, kiloUserId: 'user-1' });
    const result = await verifyGatewayJwt(token, SECRET);
    expect(result).toEqual({ ok: false, reason: 'version' });
  });

  it('returns expired reason for expired token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-1' }, SECRET, '0s');
    const result = await verifyGatewayJwt(token, SECRET);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('returns invalid reason for wrong secret', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-1' });
    const result = await verifyGatewayJwt(token, 'wrong-secret-at-least-32-chars!!');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns invalid reason for garbage token', async () => {
    const result = await verifyGatewayJwt('not.a.jwt', SECRET);
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('isPepperValid', () => {
  it('passes when DB has no pepper', () => {
    expect(isPepperValid('any', null)).toBe(true);
    expect(isPepperValid(undefined, null)).toBe(true);
  });

  it('passes when JWT and DB peppers match', () => {
    expect(isPepperValid('p1', 'p1')).toBe(true);
  });

  it('fails when peppers differ', () => {
    expect(isPepperValid('p1', 'p2')).toBe(false);
    expect(isPepperValid(undefined, 'p2')).toBe(false);
    expect(isPepperValid(null, 'p2')).toBe(false);
  });
});
