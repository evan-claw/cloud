#!/usr/bin/env node

/**
 * KiloClaw Google Account Setup
 *
 * Docker-based tool that:
 * 1. Validates the user's KiloCode API key against the kiloclaw worker
 * 2. Fetches the worker's RSA public key for credential encryption
 * 3. Runs `gws auth setup` to create an OAuth client in the user's Google Cloud project
 * 4. Runs our own OAuth flow (localhost callback) to get a refresh token
 * 5. Encrypts the client_secret + credentials with the worker's public key
 * 6. POSTs the encrypted bundle to the kiloclaw worker (user-facing JWT auth)
 *
 * Usage:
 *   docker run -it --network host kilocode/google-setup --api-key=kilo_abc123
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const apiKeyArg = args.find(a => a.startsWith('--api-key='));
const apiKey = apiKeyArg?.substring(apiKeyArg.indexOf('=') + 1);

const workerUrlArg = args.find(a => a.startsWith('--worker-url='));
const workerUrl = workerUrlArg
  ? workerUrlArg.substring(workerUrlArg.indexOf('=') + 1)
  : 'https://claw.kilo.ai';

if (!apiKey) {
  console.error(
    'Usage: docker run -it --network host kilocode/google-setup --api-key=<your-api-key>'
  );
  process.exit(1);
}

const authHeaders = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
];

// ---------------------------------------------------------------------------
// Step 1: Validate API key
// ---------------------------------------------------------------------------

console.log('Validating API key...');

const validateRes = await fetch(`${workerUrl}/health`);
if (!validateRes.ok) {
  console.error('Cannot reach kiloclaw worker at', workerUrl);
  process.exit(1);
}

// Validate auth by checking Google credentials status — returns 200 if auth passes,
// or 401/403 if the key is invalid.
const authCheckRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  headers: authHeaders,
});

if (authCheckRes.status === 401 || authCheckRes.status === 403) {
  console.error('Invalid API key. Check your key and try again.');
  process.exit(1);
}

console.log('API key verified.');

// ---------------------------------------------------------------------------
// Step 2: Fetch public key for encryption
// ---------------------------------------------------------------------------

console.log('Fetching encryption public key...');

const pubKeyRes = await fetch(`${workerUrl}/public-key`);
if (!pubKeyRes.ok) {
  console.error('Failed to fetch public key from worker.');
  process.exit(1);
}

const { publicKey: publicKeyPem } = await pubKeyRes.json();

if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
  console.error('Invalid public key received from worker.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Run gws auth setup (project + OAuth client only, no login)
// ---------------------------------------------------------------------------

console.log('Setting up Google OAuth client...');
console.log('Follow the prompts to create an OAuth client in your Google Cloud project.\n');

// Use `expect` to wrap `gws auth setup` in a real PTY so all interactive prompts
// work normally, while auto-answering "n" to the final "Run gws auth login now?" prompt.
// The "Y/n" pattern matches gws CLI's confirmation prompt. If gws changes this prompt
// text in a future version, this interaction will need updating.
// Tested with @googleworkspace/cli (gws) as of 2026-03.
// Write expect script to a temp file to avoid JS→shell→Tcl escaping issues.
const expectScriptPath = '/tmp/gws-setup.exp';
fs.writeFileSync(expectScriptPath, [
  '#!/usr/bin/expect -f',
  'set timeout -1',
  'spawn gws auth setup',
  'interact -o "Y/n" {',
  '  send "n\\r"',
  '}',
  'catch wait result',
  'exit [lindex $result 3]',
  '',
].join('\n'));

const setupExitCode = await new Promise((resolve) => {
  const child = spawn('expect', [expectScriptPath], {
    stdio: 'inherit',
  });
  child.on('close', (code) => resolve(code));
  child.on('error', () => resolve(1));
});

if (setupExitCode !== 0) {
  console.error('\nFailed to set up OAuth client. Please try again.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 4: Read client_secret.json and run our own OAuth flow
// ---------------------------------------------------------------------------

const gwsDir = path.join(process.env.HOME ?? '/root', '.config', 'gws');
const clientSecretPath = path.join(gwsDir, 'client_secret.json');

if (!fs.existsSync(clientSecretPath)) {
  console.error('client_secret.json not found. The setup step may not have completed.');
  process.exit(1);
}

const clientSecretJson = fs.readFileSync(clientSecretPath, 'utf8');
const clientConfig = JSON.parse(clientSecretJson);
const { client_id, client_secret } = clientConfig.installed || clientConfig.web || {};

if (!client_id || !client_secret) {
  console.error('Invalid client_secret.json format.');
  process.exit(1);
}

// Start a local HTTP server for the OAuth callback
const { code, redirectUri } = await new Promise((resolve, reject) => {
  let callbackPort;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      clearTimeout(timer);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }

    if (code) {
      clearTimeout(timer);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
      server.close();
      resolve({ code, redirectUri: `http://localhost:${callbackPort}` });
      return;
    }

    // Ignore non-OAuth requests (e.g. browser favicon)
    res.writeHead(404);
    res.end();
  });

  let timer;

  server.on('error', (err) => {
    clearTimeout(timer);
    reject(new Error(`OAuth callback server failed: ${err.message}`));
  });

  server.listen(0, '127.0.0.1', () => {
    callbackPort = server.address().port;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', client_id);
    authUrl.searchParams.set('redirect_uri', `http://localhost:${callbackPort}`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    console.log('\nOpen this URL in your browser to authorize:\n');
    console.log(`  ${authUrl.toString()}\n`);
    console.log(`Waiting for OAuth callback on port ${callbackPort}...`);
  });

  timer = setTimeout(() => {
    server.close();
    reject(new Error('OAuth flow timed out (5 minutes)'));
  }, 5 * 60 * 1000);
  timer.unref();
});

// Exchange authorization code for tokens
console.log('Exchanging authorization code for tokens...');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }),
});

if (!tokenRes.ok) {
  const err = await tokenRes.text();
  console.error('Token exchange failed:', err);
  process.exit(1);
}

const tokens = await tokenRes.json();
// Build a credentials object similar to what gws stores
// Omit client_id/client_secret from the credentials envelope to avoid
// duplicating the OAuth client secret across both envelopes.
// The worker merges them from the clientSecret envelope at decryption time.
const credentialsObj = {
  type: 'authorized_user',
  ...tokens,
  scopes: SCOPES,
};
const credentialsJson = JSON.stringify(credentialsObj);

console.log('OAuth tokens obtained.');

// ---------------------------------------------------------------------------
// Step 5: Encrypt credentials with worker's public key
// ---------------------------------------------------------------------------

function encryptEnvelope(plaintext, pemKey) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedData = Buffer.concat([iv, encrypted, tag]);
  const encryptedDEK = crypto.publicEncrypt(
    { key: pemKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dek
  );
  return {
    encryptedData: encryptedData.toString('base64'),
    encryptedDEK: encryptedDEK.toString('base64'),
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  };
}

console.log('Encrypting credentials...');

const encryptedBundle = {
  clientSecret: encryptEnvelope(clientSecretJson, publicKeyPem),
  credentials: encryptEnvelope(credentialsJson, publicKeyPem),
};

// ---------------------------------------------------------------------------
// Step 6: POST to worker
// ---------------------------------------------------------------------------

console.log('Sending credentials to your kiloclaw instance...');

const postRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ googleCredentials: encryptedBundle }),
});

if (!postRes.ok) {
  const body = await postRes.text();
  console.error('Failed to store credentials:', body);
  process.exit(1);
}

console.log('\nGoogle account connected!');
console.log('Credentials sent to your kiloclaw instance.');
console.log('\nYour bot can now use Gmail, Calendar, and Docs.');
console.log('Redeploy your kiloclaw instance to activate.');
