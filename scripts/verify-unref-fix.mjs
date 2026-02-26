#!/usr/bin/env node
/**
 * Verifies that unrefIdleHttpSockets() allows the process to exit when
 * TLS keep-alive sockets are holding the event loop open.
 *
 * Usage:
 *   node scripts/verify-unref-fix.mjs          # WITH fix  — exits in <1s
 *   node scripts/verify-unref-fix.mjs --no-fix # WITHOUT fix — hangs for 5s
 *
 * On Vercel, hundreds of fetch() calls to GitHub's API via Octokit leave
 * idle TLS sockets in undici's connection pool. These ref'd sockets prevent
 * the serverless function from suspending. This script reproduces that
 * condition by creating a TLS socket that stays open, then verifies the fix.
 */

import { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

const applyFix = !process.argv.includes('--no-fix');

function unrefIdleHttpSockets() {
  const handles = process._getActiveHandles?.() ?? [];
  let count = 0;
  for (const handle of handles) {
    if (handle instanceof TLSSocket) {
      handle.unref();
      count++;
    }
  }
  return count;
}

function countTlsSockets() {
  return (process._getActiveHandles?.() ?? []).filter(h => h instanceof TLSSocket).length;
}

// Watchdog (unref'd — won't itself keep event loop alive)
const watchdog = setTimeout(() => {
  console.log(`\n  STILL ALIVE after 6s — TLS sockets: ${countTlsSockets()}`);
  console.log('  This confirms keep-alive sockets block exit without the fix.');
  process.exit(1);
}, 6000);
watchdog.unref();

// --- main ---
const t0 = performance.now();
console.log(`[verify-unref-fix] applyFix=${applyFix}\n`);

// Step 1: create a long-lived TLS connection (simulates undici keep-alive socket)
console.log('Creating idle TLS socket to api.github.com:443...');
const socket = await new Promise((resolve, reject) => {
  const s = connect({ host: 'api.github.com', port: 443 }, () => resolve(s));
  s.on('error', reject);
});
console.log(`  Socket connected. Active TLS sockets: ${countTlsSockets()}`);

// Step 2: also make a real fetch to show both patterns
console.log('Making a fetch() call (creates undici keep-alive socket)...');
const r = await fetch('https://api.github.com/zen', {
  headers: { 'User-Agent': 'verify-unref-fix' },
  signal: AbortSignal.timeout(5000),
});
await r.text();
console.log(`  Done. Active TLS sockets: ${countTlsSockets()}`);

// Step 3: apply (or skip) the fix
if (applyFix) {
  console.log('\nApplying fix: unrefIdleHttpSockets()');
  const n = unrefIdleHttpSockets();
  console.log(`  unref'd ${n} TLS socket(s)`);
} else {
  console.log('\nSkipping fix (--no-fix). Process should hang for ~5s.');
}

const elapsed = Math.round(performance.now() - t0);
console.log(`\nAll work done in ${elapsed}ms. Waiting for event loop to drain...`);

process.on('beforeExit', () => {
  const total = Math.round(performance.now() - t0);
  console.log(`  Process exited cleanly in ${total}ms.`);
});
