import { describe, it, expect, vi, beforeEach } from 'vitest';

function mockDeps() {
  return {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    execFileSync: vi.fn(),
  };
}

// A tiny valid .tar.gz base64 — content doesn't matter for unit tests since execSync is mocked
const FAKE_TARBALL_BASE64 = Buffer.from('fake-tarball-data').toString('base64');

describe('writeGogCredentials', () => {
  let writeGogCredentials: typeof import('./gog-credentials').writeGogCredentials;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./gog-credentials');
    writeGogCredentials = mod.writeGogCredentials;
  });

  it('extracts tarball and sets env vars when GOOGLE_GOG_CONFIG_TARBALL is set', async () => {
    const deps = mockDeps();
    const dir = '/root/.config/gogcli';
    const env: Record<string, string | undefined> = {
      GOOGLE_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
      GOOGLE_ACCOUNT_EMAIL: 'user@gmail.com',
    };
    const result = await writeGogCredentials(env, dir, deps);

    expect(result).toBe(true);
    // Should remove stale config before extracting
    expect(deps.rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true });
    expect(deps.mkdirSync).toHaveBeenCalledWith('/root/.config', { recursive: true });

    // Should write temp tarball file
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      '/root/.config/gogcli-config.tar.gz',
      Buffer.from(FAKE_TARBALL_BASE64, 'base64')
    );

    expect(deps.execFileSync).toHaveBeenCalledWith('tar', [
      'xzf',
      '/root/.config/gogcli-config.tar.gz',
      '-C',
      '/root/.config',
    ]);

    // Should clean up temp tarball
    expect(deps.unlinkSync).toHaveBeenCalledWith('/root/.config/gogcli-config.tar.gz');

    // Should set gog env vars
    expect(env.GOG_KEYRING_BACKEND).toBe('file');
    expect(env.GOG_KEYRING_PASSWORD).toBe('kiloclaw');
    expect(env.GOG_ACCOUNT).toBe('user@gmail.com');
  });

  it('works without GOOGLE_ACCOUNT_EMAIL', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      GOOGLE_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };
    const result = await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(result).toBe(true);
    expect(env.GOG_KEYRING_BACKEND).toBe('file');
    expect(env.GOG_KEYRING_PASSWORD).toBe('kiloclaw');
    expect(env.GOG_ACCOUNT).toBeUndefined();
  });

  it('returns false and cleans up when tarball env var is absent', async () => {
    const deps = mockDeps();
    const dir = '/root/.config/gogcli';
    const result = await writeGogCredentials({}, dir, deps);

    expect(result).toBe(false);
    expect(deps.rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true });
    expect(deps.mkdirSync).not.toHaveBeenCalled();
  });

  it('clears gog env vars when tarball env var is absent', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_PASSWORD: 'kiloclaw',
      GOG_ACCOUNT: 'user@gmail.com',
    };
    await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(env.GOG_KEYRING_BACKEND).toBeUndefined();
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
    expect(env.GOG_ACCOUNT).toBeUndefined();
  });

  it('removes existing config dir before extracting new tarball', async () => {
    const deps = mockDeps();
    const callOrder: string[] = [];
    deps.rmSync.mockImplementation(() => callOrder.push('rmSync'));
    deps.mkdirSync.mockImplementation(() => callOrder.push('mkdirSync'));
    deps.execFileSync.mockImplementation(() => callOrder.push('execFileSync'));

    const env: Record<string, string | undefined> = {
      GOOGLE_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };
    await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(callOrder).toEqual(['rmSync', 'mkdirSync', 'execFileSync']);
  });

  it('cleans up temp tarball even if extraction fails', async () => {
    const deps = mockDeps();
    deps.execFileSync.mockImplementation(() => {
      throw new Error('tar failed');
    });

    const env: Record<string, string | undefined> = {
      GOOGLE_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };

    await expect(writeGogCredentials(env, '/root/.config/gogcli', deps)).rejects.toThrow(
      'tar failed'
    );
    expect(deps.unlinkSync).toHaveBeenCalledWith('/root/.config/gogcli-config.tar.gz');
  });
});
