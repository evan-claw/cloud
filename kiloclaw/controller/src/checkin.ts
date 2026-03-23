import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { z } from 'zod';
import type { OpenclawVersionInfo } from './openclaw-version';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from './version';
import type { SupervisorStats } from './supervisor';

const CHECKIN_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

export type NetStats = { bytesIn: number; bytesOut: number };

const NetStatsSchema = z.object({
  bytesIn: z.number().int().min(0),
  bytesOut: z.number().int().min(0),
});

function normalizeNetStats(value: unknown): NetStats {
  const parsed = NetStatsSchema.safeParse(value);
  if (!parsed.success) {
    return { bytesIn: 0, bytesOut: 0 };
  }
  return parsed.data;
}

export type CheckinDeps = {
  getApiKey: () => string;
  getGatewayToken: () => string;
  getSandboxId: () => string;
  getCheckinUrl: () => string;
  getSupervisorStats: () => SupervisorStats;
  getOpenclawVersion: () => Promise<OpenclawVersionInfo>;
  getMachineId?: () => string;
};

export function parseNetLine(line: string): NetStats {
  const parts = line.trim().split(/\s+/);
  return normalizeNetStats({
    bytesIn: Number.parseInt(parts[1] ?? '', 10) || 0,
    bytesOut: Number.parseInt(parts[9] ?? '', 10) || 0,
  });
}

export function parseNetDevText(raw: string): NetStats {
  const lines = raw.split('\n');

  const eth0Line = lines.find(line => line.trim().startsWith('eth0:'));
  if (eth0Line) {
    return parseNetLine(eth0Line);
  }

  let bytesIn = 0;
  let bytesOut = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('|') || !trimmed.includes(':') || trimmed.startsWith('lo:')) {
      continue;
    }
    const stats = parseNetLine(trimmed);
    bytesIn += stats.bytesIn;
    bytesOut += stats.bytesOut;
  }

  return normalizeNetStats({ bytesIn, bytesOut });
}

export async function readNetStats(): Promise<NetStats> {
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    return parseNetDevText(raw);
  } catch {
    return { bytesIn: 0, bytesOut: 0 };
  }
}

export function startCheckin(deps: CheckinDeps): () => void {
  const checkinUrl = deps.getCheckinUrl();
  if (!checkinUrl) {
    return () => {};
  }

  let previousRestarts = deps.getSupervisorStats().restarts;
  let previousNetStats: NetStats = { bytesIn: 0, bytesOut: 0 };

  void readNetStats().then(stats => {
    previousNetStats = stats;
  });

  const doCheckin = async (): Promise<void> => {
    try {
      const apiKey = deps.getApiKey();
      const gatewayToken = deps.getGatewayToken();
      const sandboxId = deps.getSandboxId();
      if (!apiKey || !gatewayToken || !sandboxId) {
        return;
      }

      const stats = deps.getSupervisorStats();
      const openclawVersion = await deps.getOpenclawVersion();
      const currentNetStats = await readNetStats();

      const restartsSinceLastCheckin = Math.max(0, stats.restarts - previousRestarts);
      previousRestarts = stats.restarts;

      const bandwidthBytesIn = Math.max(0, currentNetStats.bytesIn - previousNetStats.bytesIn);
      const bandwidthBytesOut = Math.max(0, currentNetStats.bytesOut - previousNetStats.bytesOut);
      previousNetStats = currentNetStats;

      const lastExitReason = stats.lastExit
        ? stats.lastExit.signal
          ? `signal:${stats.lastExit.signal}`
          : stats.lastExit.code !== null
            ? `code:${stats.lastExit.code}`
            : ''
        : '';

      const response = await fetch(checkinUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-kiloclaw-gateway-token': gatewayToken,
        },
        body: JSON.stringify({
          sandboxId,
          machineId: deps.getMachineId?.() ?? process.env.FLY_MACHINE_ID ?? '',
          controllerVersion: CONTROLLER_VERSION,
          controllerCommit: CONTROLLER_COMMIT,
          openclawVersion: openclawVersion.version,
          openclawCommit: openclawVersion.commit,
          supervisorState: stats.state,
          totalRestarts: stats.restarts,
          restartsSinceLastCheckin,
          uptimeSeconds: stats.uptime,
          loadAvg5m: loadavg()[1] ?? 0,
          bandwidthBytesIn,
          bandwidthBytesOut,
          lastExitReason,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[checkin] HTTP ${response.status}: ${errorText}`);
      }
    } catch (err) {
      console.error('[checkin] failed:', err);
    }
  };

  let interval: ReturnType<typeof setInterval> | undefined;

  const initialTimeout = setTimeout(() => {
    void doCheckin();
    interval = setInterval(() => {
      void doCheckin();
    }, CHECKIN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  return () => {
    clearTimeout(initialTimeout);
    if (interval) {
      clearInterval(interval);
    }
  };
}
