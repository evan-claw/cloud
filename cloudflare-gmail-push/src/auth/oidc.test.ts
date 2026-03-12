import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock jose before importing oidc
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

import { validateOidcToken, _resetJwks } from './oidc';
import * as jose from 'jose';

const mockJwtVerify = vi.mocked(jose.jwtVerify);

describe('validateOidcToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetJwks();
  });

  it('rejects missing authorization header', async () => {
    const result = await validateOidcToken(null, 'https://audience.example.com');
    expect(result.valid).toBe(false);
  });

  it('rejects non-Bearer scheme', async () => {
    const result = await validateOidcToken('Basic abc123', 'https://audience.example.com');
    expect(result.valid).toBe(false);
  });

  it('rejects empty token', async () => {
    const result = await validateOidcToken('Bearer ', 'https://audience.example.com');
    expect(result.valid).toBe(false);
  });

  it('accepts valid token with correct email', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        email: 'gmail-api-push@system.gserviceaccount.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const result = await validateOidcToken('Bearer valid-token', 'https://audience.example.com');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.email).toBe('gmail-api-push@system.gserviceaccount.com');
    }
  });

  it('rejects token with email_verified=false', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        email: 'gmail-api-push@system.gserviceaccount.com',
        email_verified: false,
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const result = await validateOidcToken('Bearer valid-token', 'https://audience.example.com');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not verified');
    }
  });

  it('rejects valid token with wrong email', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { email: 'attacker@evil-project.iam.gserviceaccount.com' },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const result = await validateOidcToken('Bearer valid-token', 'https://audience.example.com');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Unexpected email');
    }
  });

  it('rejects token with missing email claim', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://accounts.google.com' },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const result = await validateOidcToken('Bearer valid-token', 'https://audience.example.com');
    expect(result.valid).toBe(false);
  });

  it('rejects expired or invalid token', async () => {
    mockJwtVerify.mockRejectedValue(new Error('"exp" claim timestamp check failed'));

    const result = await validateOidcToken('Bearer expired-token', 'https://audience.example.com');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('exp');
    }
  });

  it('passes correct audience to jwtVerify', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { email: 'gmail-api-push@system.gserviceaccount.com', email_verified: true },
      protectedHeader: { alg: 'RS256' },
    } as any);

    await validateOidcToken('Bearer some-token', 'https://my-audience.example.com');

    expect(mockJwtVerify).toHaveBeenCalledWith(
      'some-token',
      expect.any(Function),
      expect.objectContaining({
        issuer: 'https://accounts.google.com',
        audience: 'https://my-audience.example.com',
      })
    );
  });
});
