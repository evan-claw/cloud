#!/usr/bin/env node

/**
 * KiloClaw Google Account Setup
 *
 * Docker-based tool that:
 * 1. Validates the user's KiloCode API key against the kiloclaw worker
 * 2. Fetches the worker's RSA public key for credential encryption
 * 3. Signs into gcloud, creates/selects a GCP project, enables APIs
 * 4. Prompts user to create a Desktop OAuth client in Cloud Console
 * 5. Runs our own OAuth flow (localhost callback) to get a refresh token
 * 6. Fetches the user's email address
 * 7. Encrypts the client_secret + credentials with the worker's public key
 * 8. POSTs the encrypted bundle to the kiloclaw worker
 *
 * Usage:
 *   docker run -it --network host kilocode/google-setup --api-key=kilo_abc123
 */

import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';

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

// Validate worker URL scheme — reject non-HTTPS except for localhost dev.
try {
  const parsed = new URL(workerUrl);
  const isLocalhost =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    console.error(
      `Error: --worker-url must use HTTPS (got ${parsed.protocol}). HTTP is only allowed for localhost.`
    );
    process.exit(1);
  }
  if (workerUrl !== 'https://claw.kilo.ai') {
    console.warn(`Warning: using non-default worker URL: ${workerUrl}`);
  }
} catch {
  console.error(`Error: invalid --worker-url: ${workerUrl}`);
  process.exit(1);
}

const authHeaders = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};

// ---------------------------------------------------------------------------
// Scopes — all gog user services + pubsub
// ---------------------------------------------------------------------------

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.memberships',
  'https://www.googleapis.com/auth/classroom.courses',
  'https://www.googleapis.com/auth/classroom.rosters',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/keep',
  'https://www.googleapis.com/auth/pubsub',
];

// APIs to enable in the GCP project
const GCP_APIS = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
  'drive.googleapis.com',
  'docs.googleapis.com',
  'slides.googleapis.com',
  'sheets.googleapis.com',
  'tasks.googleapis.com',
  'people.googleapis.com',
  'forms.googleapis.com',
  'chat.googleapis.com',
  'classroom.googleapis.com',
  'script.googleapis.com',
  'keep.googleapis.com',
  'pubsub.googleapis.com',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.on('error', reject);
  });
}

function runCommandOutput(cmd, args) {
  return execSync([cmd, ...args].join(' '), { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ---------------------------------------------------------------------------
// Step 1: Validate API key
// ---------------------------------------------------------------------------

console.log('Validating API key...');

const validateRes = await fetch(`${workerUrl}/health`);
if (!validateRes.ok) {
  console.error('Cannot reach kiloclaw worker at', workerUrl);
  process.exit(1);
}

const authCheckRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  headers: authHeaders,
});

if (authCheckRes.status === 401 || authCheckRes.status === 403) {
  console.error('Invalid API key. Check your key and try again.');
  process.exit(1);
}

console.log('API key verified.\n');

// ---------------------------------------------------------------------------
// Step 2: Fetch public key for encryption
// ---------------------------------------------------------------------------

console.log('Fetching encryption public key...');

const pubKeyRes = await fetch(`${workerUrl}/api/admin/public-key`, { headers: authHeaders });
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
// Step 3: Sign into gcloud and set up GCP project + APIs
// ---------------------------------------------------------------------------

console.log('Signing into Google Cloud...');
console.log('A browser window will open for you to sign in.\n');

await runCommand('gcloud', ['auth', 'login', '--brief']);

const gcloudAccount = runCommandOutput('gcloud', ['config', 'get-value', 'account']);
console.log(`\nSigned in as: ${gcloudAccount}\n`);

// Project selection: create new or use existing
console.log('Google Cloud project setup:');
console.log('  1. Create a new project (recommended)');
console.log('  2. Use an existing project\n');

const projectChoice = await ask('Choose (1 or 2): ');
let projectId;

if (projectChoice === '2') {
  // List existing projects
  console.log('\nFetching your projects...');
  try {
    await runCommand('gcloud', ['projects', 'list', '--format=table(projectId,name)']);
  } catch {
    console.warn('Could not list projects. You can still enter a project ID manually.');
  }
  projectId = await ask('\nEnter your project ID: ');
} else {
  // Generate a project ID based on date
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const defaultId = `kiloclaw-${dateStr}`;
  const inputId = await ask(`Project ID [${defaultId}]: `);
  projectId = inputId || defaultId;

  console.log(`\nCreating project "${projectId}"...`);
  try {
    await runCommand('gcloud', ['projects', 'create', projectId, '--set-as-default']);
    console.log('Project created.\n');
  } catch {
    console.error(`Failed to create project "${projectId}". It may already exist.`);
    console.error('Try a different name, or choose option 2 to use an existing project.');
    process.exit(1);
  }
}

// Set as active project
await runCommand('gcloud', ['config', 'set', 'project', projectId]);
console.log(`\nUsing project: ${projectId}`);

// Enable APIs
console.log('\nEnabling Google APIs (this may take a minute)...');
await runCommand('gcloud', ['services', 'enable', ...GCP_APIS, `--project=${projectId}`]);
console.log('APIs enabled.\n');

// Configure OAuth consent screen via REST API
console.log('Configuring OAuth consent screen...');
const accessToken = runCommandOutput('gcloud', ['auth', 'print-access-token']);

// Check if brand already exists
const brandsRes = await fetch(
  `https://iap.googleapis.com/v1/projects/${projectId}/brands`,
  { headers: { authorization: `Bearer ${accessToken}` } }
);
const brandsData = await brandsRes.json();

if (!brandsData.brands?.length) {
  const createBrandRes = await fetch(
    `https://iap.googleapis.com/v1/projects/${projectId}/brands`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        applicationTitle: 'KiloClaw',
        supportEmail: gcloudAccount,
      }),
    }
  );
  if (!createBrandRes.ok) {
    console.warn('Could not auto-configure consent screen. You may need to set it up manually.');
    console.warn(`Visit: https://console.cloud.google.com/apis/credentials/consent?project=${projectId}\n`);
  } else {
    console.log('OAuth consent screen configured.\n');
  }
} else {
  console.log('OAuth consent screen already configured.\n');
}

// ---------------------------------------------------------------------------
// Step 4: Manual OAuth client creation
// ---------------------------------------------------------------------------

const credentialsUrl = `https://console.cloud.google.com/apis/credentials?project=${projectId}`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Create an OAuth client');
console.log('');
console.log(`  1. Open: ${credentialsUrl}`);
console.log('  2. Click "Create Credentials" → "OAuth client ID"');
console.log('  3. Application type: "Desktop app"');
console.log('  4. Click "Create"');
console.log('  5. Copy the Client ID and Client Secret below');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const clientId = await ask('Client ID: ');
const clientSecret = await ask('Client Secret: ');

if (!clientId || !clientSecret) {
  console.error('Client ID and Client Secret are required.');
  process.exit(1);
}

// Build client_secret.json in the standard Google format
const clientSecretObj = {
  installed: {
    client_id: clientId,
    project_id: projectId,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: clientSecret,
    redirect_uris: ['http://localhost'],
  },
};
const clientSecretJson = JSON.stringify(clientSecretObj);

// ---------------------------------------------------------------------------
// Step 5: Custom OAuth flow to get refresh token
// ---------------------------------------------------------------------------

console.log('\nStarting OAuth authorization...');

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
    authUrl.searchParams.set('client_id', clientId);
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
    client_id: clientId,
    client_secret: clientSecret,
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
console.log('OAuth tokens obtained.');

// ---------------------------------------------------------------------------
// Step 6: Fetch user email
// ---------------------------------------------------------------------------

console.log('Fetching account info...');

const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
  headers: { authorization: `Bearer ${tokens.access_token}` },
});

let userEmail;
if (userinfoRes.ok) {
  const userinfo = await userinfoRes.json();
  userEmail = userinfo.email;
  console.log(`Account: ${userEmail}`);
} else {
  console.warn('Could not fetch user email. gog account auto-selection will not work.');
}

// Build credentials object — includes email for gog keyring key naming
const credentialsObj = {
  type: 'authorized_user',
  ...tokens,
  scopes: SCOPES,
  ...(userEmail && { email: userEmail }),
};
const credentialsJson = JSON.stringify(credentialsObj);

// ---------------------------------------------------------------------------
// Step 7: Encrypt credentials with worker's public key
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
// Step 8: POST to worker
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
if (userEmail) {
  console.log(`Connected account: ${userEmail}`);
}
console.log('\nYour bot can now use Gmail, Calendar, Drive, Docs, Sheets, and more.');
console.log('Redeploy your kiloclaw instance to activate.');
