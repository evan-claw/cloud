#!/usr/bin/env node

/**
 * KiloClaw Google Account Setup
 *
 * Docker-based tool that:
 * 1. Validates the user's KiloCode API key
 * 2. Runs `gws auth setup` to create an OAuth client in the user's Google Cloud project
 * 3. Runs `gws auth login` to complete the OAuth flow via localhost:8080 callback
 * 4. Reads the resulting credentials from ~/.config/gws/
 * 5. Encrypts them with the kiloclaw public key
 * 6. POSTs the encrypted bundle to the kilo.ai platform API
 *
 * Usage:
 *   docker run -it -p 8080:8080 kilocode/google-setup --api-key=kilo_abc123
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const apiKeyArg = args.find(a => a.startsWith('--api-key='));
const apiKey = apiKeyArg?.split('=')[1];

const platformUrl = args.find(a => a.startsWith('--platform-url='))?.split('=')[1]
  ?? 'https://api.kilo.ai';

if (!apiKey) {
  console.error('Usage: docker run -it -p 8080:8080 kilocode/google-setup --api-key=<your-api-key>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Hardcoded scopes
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

const validateRes = await fetch(`${platformUrl}/api/platform/status`, {
  headers: {
    'x-internal-api-key': apiKey,
  },
});

if (!validateRes.ok) {
  console.error('Invalid API key or cannot reach platform.');
  process.exit(1);
}

console.log('API key verified.');

// ---------------------------------------------------------------------------
// Step 2: Fetch public key for encryption
// ---------------------------------------------------------------------------

console.log('Fetching encryption public key...');

const pubKeyRes = await fetch(`${platformUrl}/api/platform/public-key`, {
  headers: { 'x-internal-api-key': apiKey },
});

if (!pubKeyRes.ok) {
  console.error('Failed to fetch public key from platform.');
  process.exit(1);
}

const { publicKey: publicKeyPem } = await pubKeyRes.json();

// ---------------------------------------------------------------------------
// Step 3: Run gws auth setup
// ---------------------------------------------------------------------------

console.log('Setting up Google OAuth client...');
console.log('Follow the prompts to create an OAuth client in your Google Cloud project.\n');

try {
  execFileSync('gws', ['auth', 'setup'], { stdio: 'inherit' });
} catch {
  console.error('\nFailed to set up OAuth client. Please try again.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 4: Run gws auth login
// ---------------------------------------------------------------------------

console.log('\nStarting OAuth login flow...');
console.log('Your browser will open for Google sign-in.\n');

try {
  execFileSync('gws', ['auth', 'login', '--scopes', SCOPES.join(',')], {
    stdio: 'inherit',
  });
} catch {
  console.error('\nOAuth login failed. Please try again.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 5: Read credentials from ~/.config/gws/
// ---------------------------------------------------------------------------

const gwsDir = path.join(process.env.HOME ?? '/root', '.config', 'gws');
const clientSecretPath = path.join(gwsDir, 'client_secret.json');
const credentialsPath = path.join(gwsDir, 'credentials.json');

if (!fs.existsSync(clientSecretPath) || !fs.existsSync(credentialsPath)) {
  console.error('Credential files not found. The OAuth flow may not have completed.');
  process.exit(1);
}

const clientSecret = fs.readFileSync(clientSecretPath, 'utf8');
const credentials = fs.readFileSync(credentialsPath, 'utf8');

// ---------------------------------------------------------------------------
// Step 6: Encrypt credentials
// ---------------------------------------------------------------------------

/**
 * Encrypt a value using RSA+AES-256-GCM envelope encryption.
 * Matches the EncryptedEnvelope schema used by kiloclaw.
 */
function encryptEnvelope(plaintext, publicKeyPem) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedData = Buffer.concat([iv, encrypted, authTag]);
  const encryptedDEK = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
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
  clientSecret: encryptEnvelope(clientSecret, publicKeyPem),
  credentials: encryptEnvelope(credentials, publicKeyPem),
};

// ---------------------------------------------------------------------------
// Step 7: POST to platform API
// ---------------------------------------------------------------------------

console.log('Sending credentials to your kiloclaw instance...');

const postRes = await fetch(`${platformUrl}/api/platform/google-credentials`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-internal-api-key': apiKey,
  },
  body: JSON.stringify({
    userId: 'self', // The platform resolves the userId from the API key
    googleCredentials: encryptedBundle,
  }),
});

if (!postRes.ok) {
  const body = await postRes.text();
  console.error('Failed to store credentials:', body);
  process.exit(1);
}

console.log('\nGoogle account connected!');
console.log('Credentials sent to your kiloclaw instance.');
console.log('\nYour bot can now use Gmail, Calendar, and Docs.');
console.log('Restart your instance to activate.');
