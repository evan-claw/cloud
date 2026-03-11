#!/usr/bin/env node
/**
 * End-to-end test for the Google Setup Docker flow.
 *
 * Requires:
 *   1. Local Postgres running (postgres://postgres:postgres@localhost:5432/postgres)
 *   2. kiloclaw worker running locally (pnpm start → localhost:8795)
 *   3. Docker running
 *
 * The test:
 *   1. Creates a temporary user in the DB
 *   2. Provisions a kiloclaw instance for that user
 *   3. Builds the google-setup Docker image
 *   4. Runs it interactively (you complete the OAuth flow in your browser)
 *   5. Verifies googleConnected=true after the container exits
 *   6. Cleans up
 *
 * Usage:
 *   node kiloclaw/test/google-setup-e2e.mjs
 */

import { SignJWT } from 'jose';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8795';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? 'dev-internal-secret';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const USER_ID = `test-google-setup-${Date.now()}`;
const DOCKER_IMAGE = 'kilocode/google-setup';
const DOCKER_CONTEXT = path.resolve(__dirname, '../google-setup');

// We use --network host so the gws CLI's random OAuth callback port is reachable
// from the browser. This also means localhost in the container reaches the host,
// so we don't need host.docker.internal.
const DOCKER_WORKER_URL = WORKER_URL;

const cleanupFns = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function green(msg) { console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`); }
function red(msg) { console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`); }
function bold(msg) { console.log(`\n\x1b[1m${msg}\x1b[0m`); }

function sql(query) {
  return execSync(`psql "${DATABASE_URL}" -tAc "${query.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
}

async function internalGet(urlPath) {
  const res = await fetch(`${WORKER_URL}${urlPath}`, {
    headers: { 'x-internal-api-key': INTERNAL_SECRET },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function internalPost(urlPath, body) {
  const res = await fetch(`${WORKER_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'x-internal-api-key': INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function internalDelete(urlPath) {
  const res = await fetch(`${WORKER_URL}${urlPath}`, {
    method: 'DELETE',
    headers: { 'x-internal-api-key': INTERNAL_SECRET },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

function cleanup() {
  bold('Cleanup');
  for (const fn of cleanupFns) {
    try { fn(); } catch {}
  }
  green('Done');
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

bold('Preflight');

try {
  const health = await fetch(`${WORKER_URL}/health`);
  if (!health.ok) throw new Error(`status ${health.status}`);
  green('Worker reachable at ' + WORKER_URL);
} catch (e) {
  red(`Worker not reachable at ${WORKER_URL}: ${e.message}`);
  console.log('   Is it running? (cd kiloclaw && pnpm start)');
  process.exit(1);
}

try {
  sql('SELECT 1');
  green('DB reachable');
} catch {
  red('DB not reachable at ' + DATABASE_URL);
  process.exit(1);
}

try {
  execSync('docker info', { stdio: 'ignore' });
  green('Docker is running');
} catch {
  red('Docker is not running');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Setup: create user, provision instance, generate JWT
// ---------------------------------------------------------------------------

bold('Setup');

sql(`INSERT INTO kilocode_users (id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, api_token_pepper) VALUES ('${USER_ID}', '${USER_ID}@test.local', 'Test User', '', 'cus_test_${USER_ID}', NULL) ON CONFLICT (id) DO NOTHING`);
cleanupFns.push(() => { try { sql(`DELETE FROM kilocode_users WHERE id = '${USER_ID}'`); } catch {} });
green('Test user created (id=' + USER_ID + ')');

const provisionRes = await internalPost('/api/platform/provision', { userId: USER_ID });
if (provisionRes.status < 200 || provisionRes.status >= 300) {
  red(`Provision failed with status ${provisionRes.status}: ${JSON.stringify(provisionRes.json)}`);
  cleanup();
  process.exit(1);
}
cleanupFns.push(() => { internalPost('/api/platform/destroy', { userId: USER_ID }).catch(() => {}); });
green('Instance provisioned');

// Verify googleConnected is false before we start
const { json: statusBefore } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
if (statusBefore?.googleConnected !== false) {
  red('Expected googleConnected=false before test, got: ' + statusBefore?.googleConnected);
  cleanup();
  process.exit(1);
}
green('googleConnected=false (baseline)');

const jwt = await new SignJWT({
  kiloUserId: USER_ID,
  apiTokenPepper: null,
  version: 3,
  env: 'development',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('30m')
  .setIssuedAt()
  .sign(new TextEncoder().encode(NEXTAUTH_SECRET));
green('JWT generated');

// ---------------------------------------------------------------------------
// Build Docker image
// ---------------------------------------------------------------------------

bold('Building Docker image');

try {
  execSync(`docker build -t ${DOCKER_IMAGE} ${DOCKER_CONTEXT}`, { stdio: 'inherit' });
  green('Image built');
} catch {
  red('Docker build failed');
  cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run Docker container (interactive — user completes OAuth flow)
// ---------------------------------------------------------------------------

bold('Running Google Setup');
console.log('  Complete the OAuth flow in your browser.');
console.log('  The container will exit when done.\n');

const dockerArgs = [
  'run', '--rm', '-it',
  '--network', 'host',
  DOCKER_IMAGE,
  `--api-key=${jwt}`,
  `--worker-url=${DOCKER_WORKER_URL}`,
];

const exitCode = await new Promise((resolve) => {
  const child = spawn('docker', dockerArgs, { stdio: 'inherit' });
  child.on('close', resolve);
  child.on('error', (err) => {
    red('Failed to start Docker: ' + err.message);
    resolve(1);
  });
});

if (exitCode !== 0) {
  red(`Docker container exited with code ${exitCode}`);
  cleanup();
  process.exit(1);
}

green('Container exited successfully');

// ---------------------------------------------------------------------------
// Verify: googleConnected should now be true
// ---------------------------------------------------------------------------

bold('Verification');

const { json: statusAfter } = await internalGet(`/api/platform/status?userId=${USER_ID}`);

if (statusAfter?.googleConnected === true) {
  green('googleConnected=true — Google credentials stored successfully!');
} else {
  red('Expected googleConnected=true, got: ' + statusAfter?.googleConnected);
  cleanup();
  process.exit(1);
}

// Also verify via debug-status
const { json: debugAfter } = await internalGet(`/api/platform/debug-status?userId=${USER_ID}`);
if (debugAfter?.googleConnected === true) {
  green('debug-status confirms googleConnected=true');
} else {
  red('debug-status shows googleConnected=' + debugAfter?.googleConnected);
}

// ---------------------------------------------------------------------------
// Optional: clear credentials to leave clean state
// ---------------------------------------------------------------------------

await internalDelete(`/api/platform/google-credentials?userId=${USER_ID}`);
green('Credentials cleared (clean state)');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

cleanup();

bold('Result: All checks passed!');
