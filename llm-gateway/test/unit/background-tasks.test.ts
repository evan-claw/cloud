// Test: background task params — particularly requestedModel for auto-models (B3).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Capture what runApiMetrics receives ──────────────────────────────────────

const apiMetricsCalls: unknown[] = [];

vi.mock('../../src/background/api-metrics', () => ({
  runApiMetrics: async (_o11y: unknown, params: unknown) => {
    apiMetricsCalls.push(params);
  },
  getToolsAvailable: () => [],
  getToolsUsed: () => [],
}));

vi.mock('../../src/background/usage-accounting', () => ({
  runUsageAccounting: async () => null,
}));

vi.mock('../../src/background/request-logging', () => ({
  runRequestLogging: async () => {},
}));

vi.mock('../../src/lib/abuse-service', () => ({
  reportAbuseCost: async () => {},
}));

vi.mock('../../src/lib/prompt-info', () => ({
  extractPromptInfo: () => ({}),
  estimateChatTokens: () => ({ estimatedInputTokens: 0, estimatedOutputTokens: 0 }),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({}),
}));

beforeEach(() => {
  apiMetricsCalls.length = 0;

  // scheduler.wait is a Workers-only global — stub it for Node tests.
  if (typeof globalThis.scheduler === 'undefined') {
    (globalThis as Record<string, unknown>).scheduler = {
      wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    };
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(): ReadableStream {
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('{}'));
      ctrl.close();
    },
  });
}

function baseParams() {
  return {
    upstreamStatusCode: 200,
    abuseServiceUrl: '',
    abuseSecrets: undefined,
    abuseRequestId: undefined,
    isStreaming: false,
    requestStartedAt: performance.now(),
    provider: 'openrouter',
    providerApiUrl: 'https://openrouter.example.com/v1',
    providerApiKey: 'key',
    providerHasGenerationEndpoint: true,
    requestBody: {
      model: 'anthropic/claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
    },
    user: { id: 'user-1' },
    organizationId: undefined,
    modeHeader: null,
    fraudHeaders: { cf_connecting_ip: '1.2.3.4' },
    projectId: null,
    editorName: null,
    machineId: null,
    feature: null,
    botId: undefined,
    tokenSource: undefined,
    userByok: false,
    isAnon: false,
    sessionId: null,
    ttfbMs: 100,
    toolsUsed: [],
    posthogApiKey: undefined,
    connectionString: 'postgres://localhost:5432/test',
    o11y: { ingestApiMetrics: async () => {} },
  } as const;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('scheduleBackgroundTasks – requestedModel (B3)', () => {
  it('uses autoModel as requestedModel when set (kilo/auto)', async () => {
    const { scheduleBackgroundTasks } = await import('../../src/handler/background-tasks');
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) };

    scheduleBackgroundTasks(ctx, {
      ...baseParams(),
      resolvedModel: 'anthropic/claude-sonnet-4-20250514',
      autoModel: 'kilo/auto',
      accountingStream: null,
      metricsStream: makeStream(),
      loggingStream: null,
    } as never);

    // Wait for all background tasks to complete
    await Promise.all(waitUntilPromises);

    expect(apiMetricsCalls).toHaveLength(1);
    const params = apiMetricsCalls[0] as Record<string, unknown>;
    expect(params.requestedModel).toBe('kilo/auto');
    expect(params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('uses resolvedModel as requestedModel when autoModel is null', async () => {
    const { scheduleBackgroundTasks } = await import('../../src/handler/background-tasks');
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) };

    scheduleBackgroundTasks(ctx, {
      ...baseParams(),
      resolvedModel: 'anthropic/claude-sonnet-4-20250514',
      autoModel: null,
      accountingStream: null,
      metricsStream: makeStream(),
      loggingStream: null,
    } as never);

    await Promise.all(waitUntilPromises);

    expect(apiMetricsCalls).toHaveLength(1);
    const params = apiMetricsCalls[0] as Record<string, unknown>;
    expect(params.requestedModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
  });
});

describe('scheduleBackgroundTasks – resolvedModel normalization (B4)', () => {
  it('strips :free suffix from resolvedModel in metrics', async () => {
    const { scheduleBackgroundTasks } = await import('../../src/handler/background-tasks');
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) };

    scheduleBackgroundTasks(ctx, {
      ...baseParams(),
      resolvedModel: 'corethink:free',
      autoModel: null,
      accountingStream: null,
      metricsStream: makeStream(),
      loggingStream: null,
    } as never);

    await Promise.all(waitUntilPromises);

    expect(apiMetricsCalls).toHaveLength(1);
    const params = apiMetricsCalls[0] as Record<string, unknown>;
    // B4: resolvedModel must be normalized — :free stripped
    expect(params.resolvedModel).toBe('corethink');
    // requestedModel is NOT normalized (preserves original for tracking)
    expect(params.requestedModel).toBe('corethink:free');
  });

  it('strips :exacto suffix from resolvedModel in metrics', async () => {
    const { scheduleBackgroundTasks } = await import('../../src/handler/background-tasks');
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) };

    scheduleBackgroundTasks(ctx, {
      ...baseParams(),
      resolvedModel: 'some-model:exacto',
      autoModel: null,
      accountingStream: null,
      metricsStream: makeStream(),
      loggingStream: null,
    } as never);

    await Promise.all(waitUntilPromises);

    expect(apiMetricsCalls).toHaveLength(1);
    const params = apiMetricsCalls[0] as Record<string, unknown>;
    expect(params.resolvedModel).toBe('some-model');
  });

  it('leaves models without colon suffix unchanged', async () => {
    const { scheduleBackgroundTasks } = await import('../../src/handler/background-tasks');
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) };

    scheduleBackgroundTasks(ctx, {
      ...baseParams(),
      resolvedModel: 'anthropic/claude-sonnet-4-20250514',
      autoModel: null,
      accountingStream: null,
      metricsStream: makeStream(),
      loggingStream: null,
    } as never);

    await Promise.all(waitUntilPromises);

    expect(apiMetricsCalls).toHaveLength(1);
    const params = apiMetricsCalls[0] as Record<string, unknown>;
    expect(params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
  });
});
