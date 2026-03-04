// Test: background task params — particularly requestedModel for auto-models (B3).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Capture what gets enqueued ────────────────────────────────────────────────

const queuedMessages: unknown[] = [];

vi.mock('../../src/background/api-metrics', () => ({
  drainResponseBodyForInferenceProvider: async () => undefined,
  getToolsAvailable: () => [],
  getToolsUsed: () => [],
}));

vi.mock('../../src/background/usage-accounting', () => ({
  parseMicrodollarUsageFromStream: async () => ({ messageId: null }),
  parseMicrodollarUsageFromString: () => ({ messageId: null }),
}));

vi.mock('../../src/background/request-logging', () => ({
  runRequestLogging: async () => {},
}));

vi.mock('../../src/lib/prompt-info', () => ({
  extractPromptInfo: () => ({}),
  estimateChatTokens: () => ({ estimatedInputTokens: 0, estimatedOutputTokens: 0 }),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({}),
}));

beforeEach(() => {
  queuedMessages.length = 0;

  // scheduler.wait is a Workers-only global — stub it for Node tests.
  const g = globalThis as Record<string, unknown>;
  if (g.scheduler === undefined) {
    g.scheduler = { wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) };
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

function makeQueue() {
  return {
    send: async (msg: unknown) => {
      queuedMessages.push(msg);
    },
    sendBatch: async () => {},
  };
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
    queue: makeQueue(),
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

    const metricsMsg = queuedMessages.find(
      (m: unknown) => (m as { type: string }).type === 'api-metrics'
    ) as { type: string; params: Record<string, unknown> };
    expect(metricsMsg).toBeDefined();
    expect(metricsMsg.params.requestedModel).toBe('kilo/auto');
    expect(metricsMsg.params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
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

    const metricsMsg = queuedMessages.find(
      (m: unknown) => (m as { type: string }).type === 'api-metrics'
    ) as { type: string; params: Record<string, unknown> };
    expect(metricsMsg).toBeDefined();
    expect(metricsMsg.params.requestedModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(metricsMsg.params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
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

    const metricsMsg = queuedMessages.find(
      (m: unknown) => (m as { type: string }).type === 'api-metrics'
    ) as { type: string; params: Record<string, unknown> };
    expect(metricsMsg).toBeDefined();
    // B4: resolvedModel must be normalized — :free stripped
    expect(metricsMsg.params.resolvedModel).toBe('corethink');
    // requestedModel is NOT normalized (preserves original for tracking)
    expect(metricsMsg.params.requestedModel).toBe('corethink:free');
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

    const metricsMsg = queuedMessages.find(
      (m: unknown) => (m as { type: string }).type === 'api-metrics'
    ) as { type: string; params: Record<string, unknown> };
    expect(metricsMsg).toBeDefined();
    expect(metricsMsg.params.resolvedModel).toBe('some-model');
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

    const metricsMsg = queuedMessages.find(
      (m: unknown) => (m as { type: string }).type === 'api-metrics'
    ) as { type: string; params: Record<string, unknown> };
    expect(metricsMsg).toBeDefined();
    expect(metricsMsg.params.resolvedModel).toBe('anthropic/claude-sonnet-4-20250514');
  });
});
