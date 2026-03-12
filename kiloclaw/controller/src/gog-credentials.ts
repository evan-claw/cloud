/**
 * Sets up gogcli credentials by extracting a pre-built config tarball.
 *
 * When the container starts with GOOGLE_GOG_CONFIG_TARBALL env var, this module:
 * 1. Base64-decodes the tarball to a temp file
 * 2. Extracts it to /root/.config/ (produces /root/.config/gogcli/)
 * 3. Sets GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, GOG_ACCOUNT env vars
 */
import path from 'node:path';

const GOG_CONFIG_DIR = '/root/.config/gogcli';

export type GogCredentialsDeps = {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: Buffer) => void;
  unlinkSync: (path: string) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  execFileSync: (file: string, args: string[]) => void;
};

/**
 * Extract gog config tarball if the corresponding env var is set.
 * Returns true if credentials were extracted, false if skipped.
 *
 * Side effect: mutates the passed `env` record by setting
 * GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, and GOG_ACCOUNT.
 */
export async function writeGogCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  configDir = GOG_CONFIG_DIR,
  deps?: Partial<GogCredentialsDeps>
): Promise<boolean> {
  const fs = await import('node:fs');
  const cp = await import('node:child_process');
  const d: GogCredentialsDeps = {
    mkdirSync: deps?.mkdirSync ?? ((dir, opts) => fs.default.mkdirSync(dir, opts)),
    writeFileSync: deps?.writeFileSync ?? ((p, data) => fs.default.writeFileSync(p, data)),
    unlinkSync: deps?.unlinkSync ?? (p => fs.default.unlinkSync(p)),
    rmSync: deps?.rmSync ?? ((p, opts) => fs.default.rmSync(p, opts)),
    execFileSync:
      deps?.execFileSync ??
      ((file, args) =>
        cp.default.execFileSync(file, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        })),
  };

  const tarballBase64 = env.GOOGLE_GOG_CONFIG_TARBALL;

  if (!tarballBase64) {
    // Clean up stale config from a previous run (e.g. after disconnect)
    d.rmSync(configDir, { recursive: true, force: true });
    delete env.GOG_KEYRING_BACKEND;
    delete env.GOG_KEYRING_PASSWORD;
    delete env.GOG_ACCOUNT;
    return false;
  }

  // Remove stale config from a previous connection before extracting the new bundle.
  // Without this, files present in the old tarball but absent from the new one linger.
  d.rmSync(configDir, { recursive: true, force: true });

  // Decode tarball and extract to /root/.config/
  const parentDir = path.dirname(configDir);
  d.mkdirSync(parentDir, { recursive: true });

  const tarballBuffer = Buffer.from(tarballBase64, 'base64');

  const tmpTarball = path.join(parentDir, 'gogcli-config.tar.gz');
  d.writeFileSync(tmpTarball, tarballBuffer);

  try {
    d.execFileSync('tar', ['xzf', tmpTarball, '-C', parentDir]);
    console.log(`[gog] Extracted config tarball to ${configDir}`);
  } finally {
    try {
      d.unlinkSync(tmpTarball);
    } catch {
      // ignore cleanup errors
    }
  }

  // Set env vars for gog runtime.
  // GOG_KEYRING_PASSWORD is NOT a secret. The 99designs/keyring file backend
  // requires a password to operate, but gog runs inside a single-tenant VM
  // with no shared access. The value is arbitrary — it just needs to be
  // consistent across setup (google-setup/setup.mjs), container startup
  // (start-openclaw.sh), and here.
  env.GOG_KEYRING_BACKEND = 'file';
  env.GOG_KEYRING_PASSWORD = 'kiloclaw';
  if (env.GOOGLE_ACCOUNT_EMAIL) {
    env.GOG_ACCOUNT = env.GOOGLE_ACCOUNT_EMAIL;
  }

  return true;
}
