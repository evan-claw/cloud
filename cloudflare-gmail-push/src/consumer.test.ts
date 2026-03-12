import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from './consumer';
import type { Env, GmailPushQueueMessage } from './types';

const TEST_USER = 'user123';
const TEST_PUBSUB_BODY = JSON.stringify({ message: { data: 'dGVzdA==' } });

function createMockMessage(
  body: GmailPushQueueMessage
): { body: GmailPushQueueMessage; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createMockEnv(kiloclawFetch: ReturnType<typeof vi.fn>) {
  return {
    KILOCLAW: { fetch: kiloclawFetch } as unknown as Fetcher,
    OIDC_AUDIENCE: 'https://test-audience.example.com',
    INTERNAL_API_SECRET: 'test-internal-secret',
    GMAIL_PUSH_QUEUE: {} as unknown as Queue<GmailPushQueueMessage>,
  } satisfies Env;
}

function createBatch(
  messages: ReturnType<typeof createMockMessage>[]
): MessageBatch<GmailPushQueueMessage> {
  return {
    messages,
    queue: 'gmail-push-notifications',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<GmailPushQueueMessage>;
}

function mockKiloclawResponses(
  status: { flyAppName: string | null; flyMachineId: string | null; status: string | null },
  gatewayToken?: string
) {
  return vi.fn((req: Request) => {
    const url = new URL(req.url);
    if (url.pathname.includes('status')) {
      return Promise.resolve(new Response(JSON.stringify(status)));
    }
    if (url.pathname.includes('gateway-token') && gatewayToken) {
      return Promise.resolve(new Response(JSON.stringify({ gatewayToken })));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('handleQueue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries when machine is not running', async () => {
    const kiloclawFetch = mockKiloclawResponses({
      flyAppName: null,
      flyMachineId: null,
      status: 'stopped',
    });
    const env = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries when kiloclaw status lookup fails', async () => {
    const kiloclawFetch = vi.fn().mockResolvedValue(
      new Response('error', { status: 500 })
    );
    const env = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries when gateway token lookup fails', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              flyAppName: 'test-app',
              flyMachineId: 'machine-abc',
              status: 'running',
            })
          )
        );
      }
      // gateway-token returns error
      return Promise.resolve(new Response('error', { status: 500 }));
    });
    const env = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks on successful controller delivery', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      { flyAppName: 'test-app', flyMachineId: 'machine-abc', status: 'running' },
      'gw-token-xyz'
    );
    const env = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    // Verify correct headers on controller request
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init]: [string, RequestInit] = fetchCalls[0];
    expect(url).toBe('https://test-app.fly.dev/_kilo/gmail-pubsub');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer gw-token-xyz');
    expect(headers['fly-force-instance-id']).toBe('machine-abc');
    expect(init.body).toBe(TEST_PUBSUB_BODY);
  });

  it('acks on controller 4xx (permanent error)', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      { flyAppName: 'test-app', flyMachineId: 'machine-abc', status: 'running' },
      'gw-token-xyz'
    );
    const env = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries on controller 5xx', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      { flyAppName: 'test-app', flyMachineId: 'machine-abc', status: 'running' },
      'gw-token-xyz'
    );
    const env = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('error', { status: 500 })
    );
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries on controller network error', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      { flyAppName: 'test-app', flyMachineId: 'machine-abc', status: 'running' },
      'gw-token-xyz'
    );
    const env = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    const msg = createMockMessage({ userId: TEST_USER, pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('handles multiple messages independently', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      const userId = url.searchParams.get('userId');
      if (url.pathname.includes('status')) {
        if (userId === 'user-ok') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ flyAppName: 'app-ok', flyMachineId: 'machine-ok', status: 'running' })
            )
          );
        }
        // user-stopped has no machine
        return Promise.resolve(
          new Response(
            JSON.stringify({ flyAppName: null, flyMachineId: null, status: 'stopped' })
          )
        );
      }
      if (url.pathname.includes('gateway-token')) {
        return Promise.resolve(new Response(JSON.stringify({ gatewayToken: 'gw-ok' })));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });

    const env = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const msgOk = createMockMessage({ userId: 'user-ok', pubSubBody: TEST_PUBSUB_BODY });
    const msgStopped = createMockMessage({ userId: 'user-stopped', pubSubBody: TEST_PUBSUB_BODY });
    const batch = createBatch([msgOk, msgStopped]);

    await handleQueue(batch, env);

    expect(msgOk.ack).toHaveBeenCalledOnce();
    expect(msgOk.retry).not.toHaveBeenCalled();
    expect(msgStopped.retry).toHaveBeenCalledOnce();
    expect(msgStopped.ack).not.toHaveBeenCalled();
  });
});
