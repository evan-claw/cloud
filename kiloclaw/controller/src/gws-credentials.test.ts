import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { writeGwsCredentials, installGwsSkills, type GwsCredentialsDeps } from './gws-credentials';

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

function mockDeps() {
  return {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  } satisfies GwsCredentialsDeps;
}

describe('writeGwsCredentials', () => {
  it('writes credential files when both env vars are set', () => {
    const deps = mockDeps();
    const dir = '/tmp/gws-test';
    const result = writeGwsCredentials(
      {
        GOOGLE_CLIENT_SECRET_JSON: '{"client_id":"test"}',
        GOOGLE_CREDENTIALS_JSON: '{"refresh_token":"rt"}',
      },
      dir,
      deps
    );

    expect(result).toBe(true);
    expect(deps.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      path.join(dir, 'client_secret.json'),
      '{"client_id":"test"}',
      { mode: 0o600 }
    );
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      path.join(dir, 'credentials.json'),
      '{"refresh_token":"rt"}',
      { mode: 0o600 }
    );
  });

  it('skips when GOOGLE_CLIENT_SECRET_JSON is missing', () => {
    const deps = mockDeps();
    const result = writeGwsCredentials(
      { GOOGLE_CREDENTIALS_JSON: '{"refresh_token":"rt"}' },
      '/tmp/gws-test',
      deps
    );

    expect(result).toBe(false);
    expect(deps.mkdirSync).not.toHaveBeenCalled();
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it('skips when GOOGLE_CREDENTIALS_JSON is missing', () => {
    const deps = mockDeps();
    const result = writeGwsCredentials(
      { GOOGLE_CLIENT_SECRET_JSON: '{"client_id":"test"}' },
      '/tmp/gws-test',
      deps
    );

    expect(result).toBe(false);
    expect(deps.mkdirSync).not.toHaveBeenCalled();
  });

  it('skips when both env vars are missing', () => {
    const deps = mockDeps();
    const result = writeGwsCredentials({}, '/tmp/gws-test', deps);

    expect(result).toBe(false);
  });

  it('removes stale credential files when env vars are absent', () => {
    const deps = mockDeps();
    const dir = '/tmp/gws-test';
    writeGwsCredentials({}, dir, deps);

    expect(deps.unlinkSync).toHaveBeenCalledWith(path.join(dir, 'client_secret.json'));
    expect(deps.unlinkSync).toHaveBeenCalledWith(path.join(dir, 'credentials.json'));
  });

  it('ignores missing files during cleanup', () => {
    const deps = mockDeps();
    deps.unlinkSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const dir = '/tmp/gws-test';

    // Should not throw
    const result = writeGwsCredentials({}, dir, deps);
    expect(result).toBe(false);
  });

  it('calls installGwsSkills when credentials are written', async () => {
    const { exec } = await import('node:child_process');
    const deps = mockDeps();
    (exec as ReturnType<typeof vi.fn>).mockClear();

    writeGwsCredentials(
      {
        GOOGLE_CLIENT_SECRET_JSON: '{"client_id":"test"}',
        GOOGLE_CREDENTIALS_JSON: '{"refresh_token":"rt"}',
      },
      '/tmp/gws-test',
      deps
    );

    expect(exec).toHaveBeenCalledWith(
      'npx -y skills add https://github.com/googleworkspace/cli --yes --global',
      expect.any(Function)
    );
  });

  it('does not call installGwsSkills when credentials are absent', async () => {
    const { exec } = await import('node:child_process');
    const deps = mockDeps();
    (exec as ReturnType<typeof vi.fn>).mockClear();

    writeGwsCredentials({}, '/tmp/gws-test', deps);

    expect(exec).not.toHaveBeenCalled();
  });
});

describe('installGwsSkills', () => {
  it('runs npx skills add command', async () => {
    const { exec } = await import('node:child_process');
    (exec as ReturnType<typeof vi.fn>).mockClear();

    installGwsSkills();

    expect(exec).toHaveBeenCalledWith(
      'npx -y skills add https://github.com/googleworkspace/cli --yes --global',
      expect.any(Function)
    );
  });
});
