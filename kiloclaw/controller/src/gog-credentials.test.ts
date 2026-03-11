import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// We'll import from gog-credentials once it exists.
// For now, these tests define the expected behavior.

// No child_process mock needed — gog-credentials doesn't shell out

function mockDeps() {
  return {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
}

// Credentials JSON that includes email (new requirement for gog)
const CLIENT_SECRET_JSON = JSON.stringify({
  installed: {
    client_id: 'test-client-id.apps.googleusercontent.com',
    client_secret: 'GOCSPX-test-secret',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
});

const CREDENTIALS_JSON = JSON.stringify({
  type: 'authorized_user',
  client_id: 'test-client-id.apps.googleusercontent.com',
  client_secret: 'GOCSPX-test-secret',
  refresh_token: '1//0test-refresh-token',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  email: 'user@gmail.com',
});

describe('writeGogCredentials', () => {
  let writeGogCredentials: typeof import('./gog-credentials').writeGogCredentials;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./gog-credentials');
    writeGogCredentials = mod.writeGogCredentials;
  });

  it('writes client credentials and keyring when both env vars are set', async () => {
    const deps = mockDeps();
    const dir = '/tmp/gogcli-test';
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON,
      GOOGLE_CREDENTIALS_JSON: CREDENTIALS_JSON,
    };
    const result = await writeGogCredentials(env, dir, deps);

    expect(result).toBe(true);
    expect(deps.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    expect(deps.mkdirSync).toHaveBeenCalledWith(path.join(dir, 'keyring'), { recursive: true });

    // Should write credentials.json with just client_id + client_secret
    const credentialsCall = deps.writeFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === path.join(dir, 'credentials.json')
    );
    expect(credentialsCall).toBeDefined();
    const writtenCreds = JSON.parse(credentialsCall![1] as string);
    expect(writtenCreds).toEqual({
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'GOCSPX-test-secret',
    });

    // Should write a keyring file with percent-encoded name
    const keyringCall = deps.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('keyring/')
    );
    expect(keyringCall).toBeDefined();
    const keyringPath = keyringCall![0] as string;
    expect(keyringPath).toContain('token%3Adefault%3Auser%40gmail.com');

    // Keyring file should be a JWE string (starts with eyJ)
    const keyringContent = keyringCall![1] as string;
    expect(keyringContent).toMatch(/^eyJ/);
  });

  it('sets GOG env vars when credentials are written', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON,
      GOOGLE_CREDENTIALS_JSON: CREDENTIALS_JSON,
    };
    await writeGogCredentials(env, '/tmp/gogcli-test', deps);

    expect(env.GOG_KEYRING_BACKEND).toBe('file');
    expect(env.GOG_KEYRING_PASSWORD).toBe('');
    expect(env.GOG_ACCOUNT).toBe('user@gmail.com');
  });

  it('does NOT set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON,
      GOOGLE_CREDENTIALS_JSON: CREDENTIALS_JSON,
    };
    await writeGogCredentials(env, '/tmp/gogcli-test', deps);

    expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
  });

  it('skips when GOOGLE_CLIENT_SECRET_JSON is missing', async () => {
    const deps = mockDeps();
    const result = await writeGogCredentials(
      { GOOGLE_CREDENTIALS_JSON: CREDENTIALS_JSON },
      '/tmp/gogcli-test',
      deps
    );
    expect(result).toBe(false);
    expect(deps.mkdirSync).not.toHaveBeenCalled();
  });

  it('skips when GOOGLE_CREDENTIALS_JSON is missing', async () => {
    const deps = mockDeps();
    const result = await writeGogCredentials(
      { GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON },
      '/tmp/gogcli-test',
      deps
    );
    expect(result).toBe(false);
  });

  it('removes stale credential files when env vars are absent', async () => {
    const deps = mockDeps();
    const dir = '/tmp/gogcli-test';
    await writeGogCredentials({}, dir, deps);

    expect(deps.unlinkSync).toHaveBeenCalledWith(path.join(dir, 'credentials.json'));
  });

  it('ignores missing files during cleanup', async () => {
    const deps = mockDeps();
    deps.unlinkSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await writeGogCredentials({}, '/tmp/gogcli-test', deps);
    expect(result).toBe(false);
  });

  it('handles "web" client config wrapper', async () => {
    const deps = mockDeps();
    const webClientSecret = JSON.stringify({
      web: {
        client_id: 'web-client-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-web-secret',
      },
    });
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: webClientSecret,
      GOOGLE_CREDENTIALS_JSON: CREDENTIALS_JSON,
    };
    await writeGogCredentials(env, '/tmp/gogcli-test', deps);

    const credentialsCall = deps.writeFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === path.join('/tmp/gogcli-test', 'credentials.json')
    );
    const writtenCreds = JSON.parse(credentialsCall![1] as string);
    expect(writtenCreds.client_id).toBe('web-client-id.apps.googleusercontent.com');
    expect(writtenCreds.client_secret).toBe('GOCSPX-web-secret');
  });

  it('percent-encodes special characters in email for keyring filename', async () => {
    const deps = mockDeps();
    const credsWithPlus = JSON.stringify({
      type: 'authorized_user',
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'GOCSPX-test-secret',
      refresh_token: '1//0test-refresh-token',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      email: 'user+tag@gmail.com',
    });
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON,
      GOOGLE_CREDENTIALS_JSON: credsWithPlus,
    };
    await writeGogCredentials(env, '/tmp/gogcli-test', deps);

    const keyringCall = deps.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('keyring/')
    );
    const keyringPath = keyringCall![0] as string;
    // + must be percent-encoded as %2B
    expect(keyringPath).toContain('user%2Btag%40gmail.com');
  });

  it('handles credentials without email gracefully', async () => {
    const deps = mockDeps();
    const credsNoEmail = JSON.stringify({
      type: 'authorized_user',
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'GOCSPX-test-secret',
      refresh_token: '1//0test-refresh-token',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_SECRET_JSON: CLIENT_SECRET_JSON,
      GOOGLE_CREDENTIALS_JSON: credsNoEmail,
    };

    // Should still write client credentials but skip keyring (no email = can't create key name)
    const result = await writeGogCredentials(env, '/tmp/gogcli-test', deps);
    expect(result).toBe(true);

    // Client credentials should still be written
    const credentialsCall = deps.writeFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === path.join('/tmp/gogcli-test', 'credentials.json')
    );
    expect(credentialsCall).toBeDefined();

    // Keyring file should NOT be written (no email)
    const keyringCall = deps.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('keyring/')
    );
    expect(keyringCall).toBeUndefined();

    // GOG_ACCOUNT should not be set
    expect(env.GOG_ACCOUNT).toBeUndefined();
  });
});
