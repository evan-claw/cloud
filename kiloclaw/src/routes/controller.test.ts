import { describe, expect, it, vi, type Mock } from 'vitest';
import { controller } from './controller';
import { deriveGatewayToken } from '../auth/gateway-token';

const sandboxId = 'dXNlci0x';

function makeEnv(options?: {
  gatewayTokenSecret?: string;
  kilocodeApiKey?: string;
  writeDataPoint?: (payload: unknown) => void;
  tryMarkInstanceReady?: Mock;
  internalApiSecret?: string;
}) {
  const getConfig = vi.fn().mockResolvedValue({
    kilocodeApiKey: options?.kilocodeApiKey ?? 'kilo-key-1',
  });
  const tryMarkInstanceReady =
    options?.tryMarkInstanceReady ??
    vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });

  return {
    GATEWAY_TOKEN_SECRET: options?.gatewayTokenSecret ?? 'gateway-secret',
    INTERNAL_API_SECRET: options?.internalApiSecret,
    KILOCLAW_INSTANCE: {
      idFromName: (userId: string) => userId,
      get: () => ({ getConfig, tryMarkInstanceReady }),
    },
    KILOCLAW_CONTROLLER_AE: options?.writeDataPoint
      ? {
          writeDataPoint: options.writeDataPoint,
        }
      : undefined,
  } as never;
}

function makeBody(overrides?: Record<string, unknown>) {
  return {
    sandboxId,
    machineId: 'machine-1',
    controllerVersion: '2026.3.22',
    controllerCommit: 'abc1234',
    openclawVersion: '2026.3.13',
    openclawCommit: 'def5678',
    supervisorState: 'running',
    totalRestarts: 2,
    restartsSinceLastCheckin: 1,
    uptimeSeconds: 3600,
    loadAvg5m: 0.42,
    bandwidthBytesIn: 1024,
    bandwidthBytesOut: 2048,
    ...overrides,
  };
}

describe('POST /checkin', () => {
  it('returns 401 when required auth headers are missing', async () => {
    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeBody()),
      },
      makeEnv()
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when gateway token is invalid', async () => {
    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': 'wrong-token',
        },
        body: JSON.stringify(makeBody()),
      },
      makeEnv()
    );

    expect(response.status).toBe(403);
  });

  it('returns 204 and writes AE datapoint when both tokens are valid', async () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    const gatewayToken = await deriveGatewayToken(sandboxId, 'gateway-secret');

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': gatewayToken,
          'fly-region': 'dfw',
        },
        body: JSON.stringify(makeBody()),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('calls tryMarkInstanceReady when loadAvg5m is below threshold', async () => {
    const tryMarkInstanceReady = vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });
    const env = makeEnv({ tryMarkInstanceReady });
    const gatewayToken = await deriveGatewayToken(sandboxId, 'gateway-secret');

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': gatewayToken,
        },
        body: JSON.stringify(makeBody({ loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(tryMarkInstanceReady).toHaveBeenCalledTimes(1);
  });

  it('does not call tryMarkInstanceReady when loadAvg5m is above threshold', async () => {
    const tryMarkInstanceReady = vi.fn();
    const env = makeEnv({ tryMarkInstanceReady });
    const gatewayToken = await deriveGatewayToken(sandboxId, 'gateway-secret');

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': gatewayToken,
        },
        body: JSON.stringify(makeBody({ loadAvg5m: 0.5 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(tryMarkInstanceReady).not.toHaveBeenCalled();
  });

  it('does not fail checkin when tryMarkInstanceReady throws', async () => {
    const tryMarkInstanceReady = vi.fn().mockRejectedValue(new Error('DO error'));
    const env = makeEnv({ tryMarkInstanceReady });
    const gatewayToken = await deriveGatewayToken(sandboxId, 'gateway-secret');

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': gatewayToken,
        },
        body: JSON.stringify(makeBody({ loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
  });
});
