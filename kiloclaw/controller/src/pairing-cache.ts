import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export type ChannelPairingRequest = {
  code: string;
  id: string;
  channel: string;
  meta?: unknown;
  createdAt?: string;
};

export type DevicePairingRequest = {
  requestId: string;
  deviceId: string;
  role?: string;
  platform?: string;
  clientId?: string;
  ts?: number;
};

export type CacheEntry<T> = {
  readonly requests: readonly T[];
  readonly lastUpdated: string;
};

export type ApproveResult =
  | { success: true; message: string; statusHint: 200 }
  | { success: false; message: string; statusHint: 400 | 500 };

export type PairingCache = {
  getChannelPairing: () => CacheEntry<ChannelPairingRequest>;
  getDevicePairing: () => CacheEntry<DevicePairingRequest>;
  refreshChannelPairing: () => Promise<void>;
  refreshDevicePairing: () => Promise<void>;
  approveChannel: (channel: string, code: string) => Promise<ApproveResult>;
  approveDevice: (requestId: string) => Promise<ApproveResult>;
  onPairingLogLine: (line: string) => void;
  start: () => void;
  cleanup: () => void;
};

type ExecImpl = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type ReadChannelPairingImpl = (channel: string) => Promise<unknown>;
export type ReadDevicePairingImpl = () => Promise<unknown>;

type PairingCacheOptions = {
  execImpl?: ExecImpl;
  readConfigImpl?: () => unknown;
  nowImpl?: () => string;
  readChannelPairingImpl?: ReadChannelPairingImpl;
  readDevicePairingImpl?: ReadDevicePairingImpl;
  nowMsImpl?: () => number;
};

export const PERIODIC_INTERVAL_MS = 60_000;
export const DEBOUNCE_DELAY_MS = 2_000;
export const CONFIG_PATH = '/root/.openclaw/openclaw.json';

// TTL constants — exact matches to openclaw source
export const CHANNEL_PAIRING_TTL_MS = 60 * 60 * 1000; // pairing-store.ts:15 PAIRING_PENDING_TTL_MS
export const DEVICE_PAIRING_TTL_MS = 5 * 60 * 1000; // device-pairing.ts:98 PENDING_TTL_MS

const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAIRING_KEYWORDS = ['pairing', 'pair request', 'device request', 'approve', 'paired'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function approveOk(message: string): ApproveResult {
  return { success: true, message, statusHint: 200 };
}

function approveFail(message: string, statusHint: 400 | 500): ApproveResult {
  return { success: false, message, statusHint };
}

export const OPENCLAW_BIN = '/usr/local/bin/openclaw';

// Mirrors resolveStateDir() / resolveOAuthDir() in openclaw/src/config/paths.ts
// Includes legacy CLAWDBOT_STATE_DIR fallback (openclaw paths.ts:65)
// Note: openclaw's full resolveStateDir() also does filesystem-existence checks for
// legacy .clawdbot dirs — those are omitted here because the container Dockerfile
// always creates /root/.openclaw, making the existence check unreachable in practice.
export function resolveOpenClawStateDir(): string {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    '/root/.openclaw'
  );
}

export function resolveCredentialsDir(): string {
  return (
    process.env.OPENCLAW_OAUTH_DIR?.trim() || path.join(resolveOpenClawStateDir(), 'credentials')
  );
}

export function resolveDevicePendingPath(): string {
  return path.join(resolveOpenClawStateDir(), 'devices', 'pending.json');
}

function defaultExecImpl(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/root' },
  });
}

function defaultReadConfigImpl(): unknown {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] {
  const val = obj[key];
  return Array.isArray(val) ? val : [];
}

function detectChannels(config: unknown): string[] {
  if (!isRecord(config)) return [];
  const ch = isRecord(config.channels) ? config.channels : {};
  const tg = isRecord(ch.telegram) ? ch.telegram : {};
  const dc = isRecord(ch.discord) ? ch.discord : {};
  const sl = isRecord(ch.slack) ? ch.slack : {};
  const channels: string[] = [];
  if (tg.enabled && tg.botToken) channels.push('telegram');
  if (dc.enabled && dc.token) channels.push('discord');
  if (sl.enabled && (sl.botToken || sl.appToken)) channels.push('slack');
  return channels;
}

export function createPairingCache(options?: PairingCacheOptions): PairingCache {
  const {
    execImpl = defaultExecImpl,
    readConfigImpl = defaultReadConfigImpl,
    nowImpl = () => new Date().toISOString(),
    readChannelPairingImpl = async (channel: string) => {
      // Path resolved at call time for testability
      const filePath = path.join(resolveCredentialsDir(), `${channel}-pairing.json`);
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
    },
    readDevicePairingImpl = async () => {
      // Path resolved at call time for testability
      const filePath = resolveDevicePendingPath();
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
    },
    nowMsImpl = () => Date.now(),
  } = options ?? {};

  let channelCache: CacheEntry<ChannelPairingRequest> = { requests: [], lastUpdated: '' };
  let deviceCache: CacheEntry<DevicePairingRequest> = { requests: [], lastUpdated: '' };

  let started = false;
  let stopped = false;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Generation counters prevent stale concurrent refreshes from overwriting
  // newer data.  Each refresh captures the counter at start; if another
  // refresh bumps it before this one finishes, the stale result is discarded.
  let channelGeneration = 0;
  let deviceGeneration = 0;

  const refreshChannelPairing = async (): Promise<void> => {
    if (stopped) return;
    const gen = ++channelGeneration;
    let channels: string[];
    try {
      const config = readConfigImpl();
      channels = detectChannels(config);
    } catch (err) {
      console.warn(`[pairing-cache] could not read config: ${errorMessage(err)}`);
      return;
    }

    if (channels.length === 0) {
      if (gen === channelGeneration) {
        channelCache = { requests: [], lastUpdated: nowImpl() };
      }
      return;
    }

    const nowMs = nowMsImpl();
    const results = await Promise.allSettled(
      channels.map(async channel => {
        const parsed: unknown = await readChannelPairingImpl(channel);
        const data = isRecord(parsed) ? parsed : {};
        const requests = getArray(data, 'requests');
        return requests
          .map((req): ChannelPairingRequest => {
            const r = isRecord(req) ? req : {};
            return {
              code: String(r.code ?? ''),
              id: String(r.id ?? ''),
              channel,
              ...('meta' in r ? { meta: r.meta } : {}),
              ...('createdAt' in r ? { createdAt: String(r.createdAt) } : {}),
            };
          })
          .filter(req => req.code !== '' && req.id !== '')
          .filter(req => {
            // Mirrors pairing-store.ts isExpired() — PAIRING_PENDING_TTL_MS = 60 * 60 * 1000
            // ~/Developer/OpenSource/openclaw/src/pairing/pairing-store.ts:171
            if (!req.createdAt) return false; // falsy (undefined, empty string) → expired
            const createdAtMs = Date.parse(req.createdAt);
            if (!Number.isFinite(createdAtMs)) return false; // garbage timestamp → expired
            return nowMs - createdAtMs <= CHANNEL_PAIRING_TTL_MS;
          });
      })
    );

    const allRequests: ChannelPairingRequest[] = [];
    let anySuccess = false;
    let anyHadPriorData = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allRequests.push(...result.value);
        anySuccess = true;
      } else {
        const err = result.reason;
        const msg = errorMessage(err);
        const priorRequests = channelCache.requests.filter(r => r.channel === channels[i]);
        if (priorRequests.length > 0) {
          anyHadPriorData = true;
          console.warn(`[pairing-cache] WARNING: keeping stale data for ${channels[i]}: ${msg}`);
          allRequests.push(...priorRequests);
        }
        // No log when no prior data — ENOENT is expected when no pairing is in progress
      }
    }

    if (anySuccess) {
      if (gen === channelGeneration) {
        channelCache = { requests: allRequests, lastUpdated: nowImpl() };
      }
    } else if (anyHadPriorData) {
      // All channels failed but some had prior data — already warned per-channel above
      console.warn('[pairing-cache] channel refresh: all channels failed, cache not updated');
    }
    // else: all failures had no prior data (e.g. cold-start ENOENT) — stay silent
  };

  const refreshDevicePairing = async (): Promise<void> => {
    if (stopped) return;
    const gen = ++deviceGeneration;
    try {
      const parsed: unknown = await readDevicePairingImpl();
      const pendingById = isRecord(parsed) ? parsed : {};
      const nowMs = nowMsImpl();

      const requests: DevicePairingRequest[] = Object.values(pendingById)
        .filter(isRecord)
        .filter(entry => {
          // Mirrors pairing-files.ts pruneExpiredPending() — PENDING_TTL_MS = 5 * 60 * 1000
          // ~/Developer/OpenSource/openclaw/src/infra/device-pairing.ts:98
          // No typeof guard: if ts is missing, nowMs - undefined = NaN, NaN > TTL is false → preserved
          return !(nowMs - (entry.ts as number) > DEVICE_PAIRING_TTL_MS);
        })
        .map(entry => ({
          requestId: String(entry.requestId ?? ''),
          deviceId: String(entry.deviceId ?? ''),
          ...(entry.role !== undefined ? { role: String(entry.role) } : {}),
          ...(entry.platform !== undefined ? { platform: String(entry.platform) } : {}),
          ...(entry.clientId !== undefined ? { clientId: String(entry.clientId) } : {}),
          ...(typeof entry.ts === 'number' ? { ts: entry.ts } : {}),
        }))
        .filter(req => req.requestId !== '' && req.deviceId !== '');

      if (gen === deviceGeneration) {
        deviceCache = { requests, lastUpdated: nowImpl() };
      }
    } catch (err) {
      console.warn(`[pairing-cache] device refresh failed: ${errorMessage(err)}`);
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.allSettled([refreshChannelPairing(), refreshDevicePairing()]);
  };

  const approveChannel = async (channel: string, code: string): Promise<ApproveResult> => {
    if (stopped) return approveFail('Cache is shutting down', 500);
    if (!CHANNEL_RE.test(channel)) return approveFail('Invalid channel name', 400);
    if (!CODE_RE.test(code)) return approveFail('Invalid pairing code', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['pairing', 'approve', channel, code, '--notify']);
    } catch (err) {
      console.error('[pairing-cache] channel approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    await refreshChannelPairing();
    return approveOk('Pairing approved');
  };

  const approveDevice = async (requestId: string): Promise<ApproveResult> => {
    if (stopped) return approveFail('Cache is shutting down', 500);
    if (!UUID_RE.test(requestId)) return approveFail('Invalid request ID', 400);

    try {
      await execImpl(OPENCLAW_BIN, ['devices', 'approve', requestId]);
    } catch (err) {
      console.error('[pairing-cache] device approve failed:', err);
      return approveFail(errorMessage(err), 500);
    }

    await refreshDevicePairing();
    return approveOk('Device approved');
  };

  const onPairingLogLine = (line: string): void => {
    if (stopped) return;
    const lower = line.toLowerCase();
    const isPairingLine = PAIRING_KEYWORDS.some(kw => lower.includes(kw));
    if (!isPairingLine) return;

    if (debounceTimer !== null) return;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refreshAll();
    }, DEBOUNCE_DELAY_MS);
  };

  const start = (): void => {
    if (started) return;
    started = true;

    // Fire-and-forget: do not await the initial refresh.  Awaiting here blocks
    // server.listen() and delays the health endpoint past the DO's 60s startup probe.
    // An empty cache during the brief warmup window is acceptable — the DO-side
    // fallback chain (controller → KV → fly exec) handles it, and the cache
    // self-heals within seconds via the periodic timer and log-triggered debounce.
    void refreshAll();

    periodicTimer = setInterval(() => {
      void refreshAll();
    }, PERIODIC_INTERVAL_MS);
  };

  const cleanup = (): void => {
    stopped = true;
    if (periodicTimer !== null) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  return {
    getChannelPairing: () => channelCache,
    getDevicePairing: () => deviceCache,
    refreshChannelPairing,
    refreshDevicePairing,
    approveChannel,
    approveDevice,
    onPairingLogLine,
    start,
    cleanup,
  };
}
