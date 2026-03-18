import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

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

type PairingCacheOptions = {
  execImpl?: ExecImpl;
  readConfigImpl?: () => unknown;
  nowImpl?: () => string;
};

export const PERIODIC_INTERVAL_MS = 120_000;
export const DEBOUNCE_DELAY_MS = 2_000;
export const INITIAL_REFRESH_DELAY_MS = 120_000;
export const FAILURE_RETRY_BASE_MS = 30_000;
export const FAILURE_RETRY_MAX_MS = 300_000;
export const CLI_TIMEOUT_MS = 45_000;
export const CONFIG_PATH = '/root/.openclaw/openclaw.json';

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

function defaultExecImpl(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
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
  } = options ?? {};

  let channelCache: CacheEntry<ChannelPairingRequest> = { requests: [], lastUpdated: '' };
  let deviceCache: CacheEntry<DevicePairingRequest> = { requests: [], lastUpdated: '' };

  let started = false;
  let stopped = false;
  let periodicTimer: ReturnType<typeof setTimeout> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let nextAllowedRefreshAt = 0;
  let hasCompletedInitialRefresh = false;
  let consecutiveFailureCount = 0;

  // Generation counters prevent stale concurrent refreshes from overwriting
  // newer data.  Each refresh captures the counter at start; if another
  // refresh bumps it before this one finishes, the stale result is discarded.
  let channelGeneration = 0;
  let deviceGeneration = 0;

  const refreshChannelPairingInternal = async (): Promise<boolean> => {
    if (stopped) return false;
    const gen = ++channelGeneration;
    let channels: string[];
    try {
      const config = readConfigImpl();
      channels = detectChannels(config);
    } catch (err) {
      console.warn(`[pairing-cache] could not read config: ${errorMessage(err)}`);
      return false;
    }

    if (channels.length === 0) {
      if (gen === channelGeneration) {
        channelCache = { requests: [], lastUpdated: nowImpl() };
      }
      return true;
    }

    const results = await Promise.allSettled(
      channels.map(async channel => {
        const { stdout } = await execImpl(OPENCLAW_BIN, ['pairing', 'list', channel, '--json']);
        const parsed: unknown = JSON.parse(stdout.trim());
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
          .filter(req => req.code !== '' && req.id !== '');
      })
    );

    const allRequests: ChannelPairingRequest[] = [];
    let anySuccess = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allRequests.push(...result.value);
        anySuccess = true;
      } else {
        const err = result.reason;
        const msg =
          err && typeof err === 'object' && 'stderr' in err
            ? String(err.stderr).trim()
            : String(err);
        const priorRequests = channelCache.requests.filter(r => r.channel === channels[i]);
        if (priorRequests.length > 0) {
          console.error(`[pairing-cache] WARNING: keeping stale data for ${channels[i]}: ${msg}`);
          allRequests.push(...priorRequests);
        } else {
          console.error(`[pairing-cache] ${channels[i]}: ${msg}`);
        }
      }
    }

    if (anySuccess) {
      if (gen === channelGeneration) {
        channelCache = { requests: allRequests, lastUpdated: nowImpl() };
      }
      return true;
    } else {
      console.warn('[pairing-cache] channel refresh: all channels failed, cache not updated');
      return false;
    }
  };

  const refreshDevicePairingInternal = async (): Promise<boolean> => {
    if (stopped) return false;
    const gen = ++deviceGeneration;
    try {
      const { stdout } = await execImpl(OPENCLAW_BIN, ['devices', 'list', '--json']);
      const parsed: unknown = JSON.parse(stdout.trim());
      const data = isRecord(parsed) ? parsed : {};
      const pending = getArray(data, 'pending');

      const requests: DevicePairingRequest[] = pending
        .map((req: unknown) => {
          const r = isRecord(req) ? req : {};
          return {
            requestId: String(r.requestId ?? ''),
            deviceId: String(r.deviceId ?? ''),
            ...(r.role !== undefined ? { role: String(r.role) } : {}),
            ...(r.platform !== undefined ? { platform: String(r.platform) } : {}),
            ...(r.clientId !== undefined ? { clientId: String(r.clientId) } : {}),
            ...(typeof r.ts === 'number' ? { ts: r.ts } : {}),
          };
        })
        .filter(req => req.requestId !== '' && req.deviceId !== '');

      if (gen === deviceGeneration) {
        deviceCache = { requests, lastUpdated: nowImpl() };
      }
      return true;
    } catch (err) {
      console.error(`[pairing-cache] device refresh failed: ${errorMessage(err)}`);
      return false;
    }
  };

  const refreshAll = async (): Promise<boolean> => {
    if (stopped) return false;
    const [channelOk, deviceOk] = await Promise.all([
      refreshChannelPairingInternal(),
      refreshDevicePairingInternal(),
    ]);
    const ok = channelOk && deviceOk;
    if (ok) {
      consecutiveFailureCount = 0;
      nextAllowedRefreshAt = 0;
    } else {
      consecutiveFailureCount += 1;
      const failureDelayMs = Math.min(
        FAILURE_RETRY_BASE_MS * 2 ** (consecutiveFailureCount - 1),
        FAILURE_RETRY_MAX_MS
      );
      nextAllowedRefreshAt = Date.now() + failureDelayMs;
    }
    return ok;
  };

  const scheduleNextPeriodicRefresh = (delayMs: number): void => {
    if (stopped) return;
    if (periodicTimer !== null) {
      clearTimeout(periodicTimer);
    }
    periodicTimer = setTimeout(() => {
      void runPeriodicRefresh();
    }, delayMs);
  };

  const runPeriodicRefresh = async (): Promise<void> => {
    if (stopped) return;
    const ok = await refreshAll();
    hasCompletedInitialRefresh = true;
    const now = Date.now();
    const delayMs = ok ? PERIODIC_INTERVAL_MS : Math.max(0, nextAllowedRefreshAt - now);
    scheduleNextPeriodicRefresh(delayMs);
  };

  const runDebouncedRefresh = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() < nextAllowedRefreshAt) return;
    const ok = await refreshAll();
    const now = Date.now();
    const delayMs = ok ? PERIODIC_INTERVAL_MS : Math.max(0, nextAllowedRefreshAt - now);
    scheduleNextPeriodicRefresh(delayMs);
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

    await refreshChannelPairingInternal();
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

    await refreshDevicePairingInternal();
    return approveOk('Device approved');
  };

  const onPairingLogLine = (line: string): void => {
    if (stopped) return;
    if (started && !hasCompletedInitialRefresh) return;
    const lower = line.toLowerCase();
    const isPairingLine = PAIRING_KEYWORDS.some(kw => lower.includes(kw));
    if (!isPairingLine) return;

    if (debounceTimer !== null) return;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runDebouncedRefresh();
    }, DEBOUNCE_DELAY_MS);
  };

  const refreshChannelPairing = async (): Promise<void> => {
    await refreshChannelPairingInternal();
  };

  const refreshDevicePairing = async (): Promise<void> => {
    await refreshDevicePairingInternal();
  };

  const start = (): void => {
    if (started) return;
    started = true;

    initialTimer = setTimeout(() => {
      initialTimer = null;
      void runPeriodicRefresh();
    }, INITIAL_REFRESH_DELAY_MS);
  };

  const cleanup = (): void => {
    stopped = true;
    if (periodicTimer !== null) {
      clearTimeout(periodicTimer);
      periodicTimer = null;
    }
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
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
