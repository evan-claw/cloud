import { describe, it, expect } from 'vitest';
import { validateOidcToken } from './oidc';

describe('validateOidcToken', () => {
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

  // Full JWT validation requires network access to Google's JWKS.
  // Integration tests cover the happy path; unit tests cover input validation.
});
