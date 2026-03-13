/**
 * Periodically renews the Gmail watch subscription so notifications never silently expire.
 *
 * Gmail watches expire after ~7 days. `gog gmail watch serve` does NOT auto-renew,
 * so we run `gog gmail watch renew --account <email>` on a timer:
 *   - First renewal: 1 hour after start
 *   - Subsequent renewals: every 24 hours
 */
import { execFileSync } from 'node:child_process';

export type SpawnFn = (args: string[]) => void;

let initialTimeout: ReturnType<typeof setTimeout> | null = null;
let renewalInterval: ReturnType<typeof setInterval> | null = null;

function defaultSpawn(args: string[]): void {
  execFileSync('gog', args, { stdio: 'pipe' });
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function startWatchRenewal(account: string, spawn: SpawnFn = defaultSpawn): void {
  const args = ['gmail', 'watch', 'renew', '--account', account];

  function renew(): void {
    try {
      spawn(args);
      console.log(`[gmail-watch-renewal] Renewed watch for ${account}`);
    } catch (err) {
      console.error(`[gmail-watch-renewal] Failed to renew watch for ${account}:`, err);
    }
  }

  initialTimeout = setTimeout(() => {
    renew();
    renewalInterval = setInterval(renew, TWENTY_FOUR_HOURS_MS);
  }, ONE_HOUR_MS);
}

export function stopWatchRenewal(): void {
  if (initialTimeout !== null) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (renewalInterval !== null) {
    clearInterval(renewalInterval);
    renewalInterval = null;
  }
}
