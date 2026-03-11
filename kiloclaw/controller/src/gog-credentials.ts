/**
 * Writes gogcli credential files to disk so the gog CLI picks them up
 * automatically at runtime.
 *
 * When the container starts with GOOGLE_CLIENT_SECRET_JSON and
 * GOOGLE_CREDENTIALS_JSON env vars, this module:
 * 1. Writes client credentials to ~/.config/gogcli/credentials.json
 * 2. Writes a JWE-encrypted keyring file with the refresh token
 * 3. Sets GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, GOG_ACCOUNT env vars
 */
import { CompactEncrypt } from 'jose';
import path from 'node:path';

// Use /root explicitly — OpenClaw changes HOME to the workspace dir at runtime,
// but we need credentials at a stable, absolute path that gog can always find.
const GOG_CONFIG_DIR = '/root/.config/gogcli';
const CREDENTIALS_FILE = 'credentials.json';
const KEYRING_DIR = 'keyring';

export type GogCredentialsDeps = {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string, opts: { mode: number }) => void;
  unlinkSync: (path: string) => void;
};

/**
 * Percent-encode a string for use as a keyring filename.
 * gog uses Go's url.PathEscape which encodes everything except unreserved chars.
 */
function percentEncode(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map(b => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c)) return c;
      return '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
}

/**
 * Create a JWE-encrypted keyring file matching the 99designs/keyring file backend.
 * Uses PBES2-HS256+A128KW for key wrapping and A256GCM for content encryption.
 */
async function createKeyringEntry(
  keyName: string,
  refreshToken: string,
  scopes: string[],
  password: string
): Promise<string> {
  // Map OAuth scopes to gog service names for the Services field
  const services = mapScopesToServices(scopes);

  // The token data that gog reads from Item.Data
  const tokenData = JSON.stringify({
    refresh_token: refreshToken,
    services: services,
    // gog stores only full OAuth scopes, not OIDC shorthand like 'openid'/'email'
    scopes: scopes.filter(s => s.startsWith('https://')),
    created_at: new Date().toISOString(),
  });

  // 99designs/keyring file backend wraps data in an Item struct.
  // Item.Data is []byte, which Go's json.Marshal encodes as base64.
  const item = JSON.stringify({
    Key: keyName,
    Data: Buffer.from(tokenData).toString('base64'),
    Label: '',
    Description: '',
  });

  const encoder = new TextEncoder();
  const jwe = await new CompactEncrypt(encoder.encode(item))
    .setProtectedHeader({ alg: 'PBES2-HS256+A128KW', enc: 'A256GCM' })
    .encrypt(encoder.encode(password));

  return jwe;
}

/** Map Google OAuth scopes to gog service names. */
function mapScopesToServices(scopes: string[]): string[] {
  const scopeToService: Record<string, string> = {
    'gmail.modify': 'gmail',
    'gmail.settings.basic': 'gmail',
    'gmail.settings.sharing': 'gmail',
    'gmail.readonly': 'gmail',
    calendar: 'calendar',
    'calendar.readonly': 'calendar',
    drive: 'drive',
    'drive.readonly': 'drive',
    'drive.file': 'drive',
    documents: 'docs',
    'documents.readonly': 'docs',
    presentations: 'slides',
    'presentations.readonly': 'slides',
    spreadsheets: 'sheets',
    'spreadsheets.readonly': 'sheets',
    tasks: 'tasks',
    'tasks.readonly': 'tasks',
    contacts: 'contacts',
    'contacts.readonly': 'contacts',
    'contacts.other.readonly': 'contacts',
    'directory.readonly': 'contacts',
    'forms.body': 'forms',
    'forms.body.readonly': 'forms',
    'forms.responses.readonly': 'forms',
    'chat.spaces': 'chat',
    'chat.messages': 'chat',
    'chat.memberships': 'chat',
    'chat.spaces.readonly': 'chat',
    'chat.messages.readonly': 'chat',
    'chat.memberships.readonly': 'chat',
    'classroom.courses': 'classroom',
    'classroom.rosters': 'classroom',
    'script.projects': 'appscript',
    'script.deployments': 'appscript',
    keep: 'keep',
    pubsub: 'pubsub',
  };

  const prefix = 'https://www.googleapis.com/auth/';
  const services = new Set<string>();
  for (const scope of scopes) {
    const short = scope.startsWith(prefix) ? scope.slice(prefix.length) : scope;
    const service = scopeToService[short];
    if (service) services.add(service);
  }
  return [...services].sort();
}

/**
 * Write gog credential files if the corresponding env vars are set.
 * Returns true if credentials were written, false if skipped.
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
  const d: GogCredentialsDeps = {
    mkdirSync: deps?.mkdirSync ?? ((dir, opts) => fs.default.mkdirSync(dir, opts)),
    writeFileSync:
      deps?.writeFileSync ?? ((p, data, opts) => fs.default.writeFileSync(p, data, opts)),
    unlinkSync: deps?.unlinkSync ?? (p => fs.default.unlinkSync(p)),
  };

  const clientSecretRaw = env.GOOGLE_CLIENT_SECRET_JSON;
  const credentialsRaw = env.GOOGLE_CREDENTIALS_JSON;

  if (!clientSecretRaw || !credentialsRaw) {
    // Clean up stale credential files from a previous run (e.g. after disconnect)
    for (const file of [CREDENTIALS_FILE]) {
      const filePath = path.join(configDir, file);
      try {
        d.unlinkSync(filePath);
        console.log(`[gog] Removed stale ${filePath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return false;
  }

  d.mkdirSync(configDir, { recursive: true });

  // Parse client_secret.json — extract client_id + client_secret from the
  // "installed" or "web" wrapper, or use top-level fields if already flat.
  const clientConfig = JSON.parse(clientSecretRaw);
  const clientFields = clientConfig.installed ?? clientConfig.web ?? clientConfig;
  const clientId = clientFields.client_id;
  const clientSecret = clientFields.client_secret;

  // Write gogcli credentials.json (just client_id + client_secret)
  d.writeFileSync(
    path.join(configDir, CREDENTIALS_FILE),
    JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    { mode: 0o600 }
  );

  console.log(`[gog] Wrote client credentials to ${configDir}/${CREDENTIALS_FILE}`);

  // Parse credentials to get refresh_token, email, scopes
  const credentials = JSON.parse(credentialsRaw);
  const email: string | undefined = credentials.email;
  const refreshToken: string | undefined = credentials.refresh_token;
  const scopes: string[] = credentials.scopes ?? [];

  // Write keyring entry if we have email + refresh_token
  if (email && refreshToken) {
    const keyringDir = path.join(configDir, KEYRING_DIR);
    d.mkdirSync(keyringDir, { recursive: true });

    const keyName = `token:default:${email}`;
    const fileName = percentEncode(keyName);
    const password = ''; // Empty password is supported by gog

    const jwe = await createKeyringEntry(keyName, refreshToken, scopes, password);
    d.writeFileSync(path.join(keyringDir, fileName), jwe, { mode: 0o600 });

    console.log(`[gog] Wrote keyring entry for ${email}`);

    // Set env vars for gog discovery
    env.GOG_KEYRING_BACKEND = 'file';
    env.GOG_KEYRING_PASSWORD = '';
    env.GOG_ACCOUNT = email;
  } else {
    if (!email)
      console.warn('[gog] No email in credentials — keyring entry skipped, gog may not work');
    if (!refreshToken)
      console.warn('[gog] No refresh_token in credentials — keyring entry skipped');
  }

  return true;
}
