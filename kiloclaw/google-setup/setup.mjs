#!/usr/bin/env node

/**
 * KiloClaw Google Account Setup
 *
 * Docker-based tool that:
 * 1. Validates the user's session token (JWT) against the kiloclaw worker
 * 2. Fetches the worker's RSA public key for credential encryption
 * 3. Signs into gcloud, creates/selects a GCP project, enables APIs
 * 4. Prompts user to create a Desktop OAuth client in Cloud Console
 * 5. Runs gog auth (credentials set + add) to authorize all services
 * 6. Tarballs the gog config, encrypts, and POSTs to the worker
 *
 * Usage:
 *   docker run -it --network host kilocode/google-setup --token=<jwt>
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const tokenArg = args.find(a => a.startsWith('--token='));
const token = tokenArg?.substring(tokenArg.indexOf('=') + 1);

const workerUrlArg = args.find(a => a.startsWith('--worker-url='));
const workerUrl = workerUrlArg
  ? workerUrlArg.substring(workerUrlArg.indexOf('=') + 1)
  : 'https://claw.kilo.ai';

if (!token) {
  console.error('Usage: docker run -it --network host kilocode/google-setup --token=<session-jwt>');
  process.exit(1);
}

// Validate worker URL scheme — reject non-HTTPS except for localhost dev.
try {
  const parsed = new URL(workerUrl);
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
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
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

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
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
    child.on('error', reject);
  });
}

function runCommandOutput(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ---------------------------------------------------------------------------
// Step 1: Validate session token
// ---------------------------------------------------------------------------

console.log('Validating session token...');

const validateRes = await fetch(`${workerUrl}/health`);
if (!validateRes.ok) {
  console.error('Cannot reach kiloclaw worker at', workerUrl);
  process.exit(1);
}

const authCheckRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  headers: authHeaders,
});

if (!authCheckRes.ok) {
  if (authCheckRes.status === 401 || authCheckRes.status === 403) {
    console.error('Invalid or expired session token. Log in to kilo.ai and copy a fresh token.');
  } else {
    console.error(`Worker returned unexpected status ${authCheckRes.status} during auth check.`);
  }
  process.exit(1);
}

console.log('Session token verified.\n');

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
  // List existing projects as a numbered menu
  console.log('\nFetching your projects...');
  let projects = [];
  try {
    const projectsJson = runCommandOutput('gcloud', [
      'projects',
      'list',
      '--format=json(projectId,name)',
      '--sort-by=name',
    ]);
    projects = JSON.parse(projectsJson);
  } catch {
    // fall through — empty list triggers manual entry
  }

  if (projects.length > 0) {
    console.log('');
    projects.forEach((p, i) => {
      const label = p.name ? `${p.projectId} (${p.name})` : p.projectId;
      console.log(`  ${i + 1}. ${label}`);
    });
    console.log('');
    const pick = await ask('Enter number (or project ID): ');
    const idx = parseInt(pick, 10);
    if (idx >= 1 && idx <= projects.length) {
      projectId = projects[idx - 1].projectId;
    } else {
      projectId = pick;
    }
  } else {
    console.warn('Could not list projects. You can still enter a project ID manually.');
    projectId = await ask('\nEnter your project ID: ');
  }
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

// ---------------------------------------------------------------------------
// Step 4: Configure OAuth consent screen + create OAuth client
// ---------------------------------------------------------------------------

const consentUrl = `https://console.cloud.google.com/auth/overview?project=${projectId}`;
const credentialsUrl = `https://console.cloud.google.com/apis/credentials?project=${projectId}`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Configure OAuth consent screen');
console.log('');
console.log(`  1. Open: ${consentUrl}`);
console.log('  2. Click "Get started"');
console.log('  3. App name: "KiloClaw", User support email: your email');
console.log('  4. Audience: select "External"');
console.log('  5. Contact email: your email');
console.log('  6. Finish and click "Create"');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

await ask('Press Enter when done...');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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

// ---------------------------------------------------------------------------
// Step 5: Run gog auth to set credentials and authorize account
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';

// plaintext is base64-encoded binary data, but cipher.update('utf8') is fine
// because base64 is a strict ASCII subset — no encoding ambiguity.
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

const gogHome = '/tmp/gogcli-home';
// NOTE: GOG_KEYRING_PASSWORD must match in all three locations:
//   - here (google-setup/setup.mjs)
//   - controller/src/gog-credentials.ts
//   - start-openclaw.sh
const gogEnv = {
  ...process.env,
  HOME: gogHome,
  GOG_KEYRING_BACKEND: 'file',
  GOG_KEYRING_PASSWORD: 'kiloclaw',
};

// Build client_secret.json in Google's standard format and feed it to gog
const clientSecretJson = JSON.stringify({
  installed: {
    client_id: clientId,
    project_id: projectId,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: clientSecret,
    redirect_uris: ['http://localhost'],
  },
});

// Write to temp file so gog can read it
const clientSecretPath = '/tmp/client_secret.json';
writeFileSync(clientSecretPath, clientSecretJson);

console.log('\nSetting up gog credentials...');

try {
  await runCommand('gog', ['auth', 'credentials', 'set', clientSecretPath], {
    env: gogEnv,
  });
} catch (err) {
  console.error('gog auth credentials set failed:', err.message);
  process.exit(1);
}

// Use the gcloud account email for gog auth add
const userEmail = gcloudAccount;
console.log(`\nAuthorizing ${userEmail} with gog...`);
console.log('A browser window will open for you to authorize Google Workspace access.\n');

try {
  await runCommand('gog', [
    'auth', 'add', userEmail,
    '--services=all',
    '--force-consent',
  ], {
    env: gogEnv,
  });
} catch (err) {
  console.error('gog auth add failed:', err.message);
  process.exit(1);
}

console.log(`\nAuthenticated as: ${userEmail}`);

// ---------------------------------------------------------------------------
// Step 6: Create config tarball, encrypt, and POST
// ---------------------------------------------------------------------------

console.log('Creating config tarball...');
const tarballBuffer = execSync(`tar czf - -C ${gogHome}/.config gogcli`, {
  maxBuffer: 1024 * 1024,
});
const tarballBase64 = tarballBuffer.toString('base64');

console.log(`Config tarball size: ${tarballBuffer.length} bytes`);

console.log('Encrypting config tarball...');

const encryptedBundle = {
  gogConfigTarball: encryptEnvelope(tarballBase64, publicKeyPem),
  email: userEmail,
};

// ---------------------------------------------------------------------------
// POST encrypted credentials to worker
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
