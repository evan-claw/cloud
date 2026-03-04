// Shared test helpers for mocking Cloudflare bindings and building requests.

import { SignJWT } from 'jose';
import type { Env } from '../../src/env';

const TEST_SECRET = 'test-secret-at-least-32-characters-long';

function encode(s: string) {
  return new TextEncoder().encode(s);
}

// Sign a v3 JWT matching verifyGatewayJwt expectations.
export async function signToken(
  payload: Record<string, unknown> = {},
  secret = TEST_SECRET,
  expiresIn = '1h'
) {
  return new SignJWT({ version: 3, kiloUserId: 'user-1', ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encode(secret));
}

// Build a minimal mock Env matching worker-configuration.d.ts.
export function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  function makeSecret(value: string): SecretsStoreSecret {
    return { get: async () => value };
  }

  // Fake DO namespace that creates stubs returning a fixed result.
  function makeFakeDONamespace(): Env['RATE_LIMIT_DO'] {
    const stub = {
      checkFreeModel: async () => ({ allowed: true, requestCount: 0 }),
      checkPromotion: async () => ({ allowed: true, requestCount: 0 }),
      incrementFreeModel: async () => {},
      incrementPromotion: async () => {},
    };
    return {
      idFromName() {
        return {} as DurableObjectId;
      },
      newUniqueId() {
        return {} as DurableObjectId;
      },
      idFromString() {
        return {} as DurableObjectId;
      },
      getByName() {
        return stub as unknown as DurableObjectStub;
      },
      get() {
        return stub as unknown as DurableObjectStub;
      },
      jurisdiction() {
        return this;
      },
    } as unknown as Env['RATE_LIMIT_DO'];
  }

  return {
    HYPERDRIVE: { connectionString: 'postgres://localhost:5432/test' } as Hyperdrive,
    RATE_LIMIT_DO: makeFakeDONamespace(),
    LLM_GATEWAY_BG_TASKS_QUEUE: {
      send: async () => {},
      sendBatch: async () => {},
    } as unknown as Queue,
    O11Y: {
      fetch: async () => new Response(JSON.stringify({ success: true })),
      ingestApiMetrics: async () => {},
    } as unknown as Env['O11Y'],
    NEXTAUTH_SECRET_PROD: makeSecret(TEST_SECRET),
    OPENROUTER_API_KEY: makeSecret('or-key'),
    GIGAPOTATO_API_KEY: makeSecret('gp-key'),
    CORETHINK_API_KEY: makeSecret('ct-key'),
    MARTIAN_API_KEY: makeSecret('mt-key'),
    MISTRAL_API_KEY: makeSecret('ms-key'),
    VERCEL_AI_GATEWAY_API_KEY: makeSecret('vc-key'),
    BYOK_ENCRYPTION_KEY: makeSecret('byok-key-32-chars-exactly-here!'),
    ABUSE_CF_ACCESS_CLIENT_ID: makeSecret('abuse-id'),
    ABUSE_CF_ACCESS_CLIENT_SECRET: makeSecret('abuse-secret'),
    GIGAPOTATO_API_URL: makeSecret('https://gigapotato.example.com'),
    ABUSE_SERVICE_URL: makeSecret('https://abuse.example.com'),
    POSTHOG_API_KEY: makeSecret('phk-test'),
    ...overrides,
  } as Env;
}

export { TEST_SECRET };

export function fakeExecutionCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

// Build a POST request for /api/gateway/chat/completions.
export function chatRequest(
  body: Record<string, unknown>,
  opts: {
    headers?: Record<string, string>;
    token?: string;
    path?: string;
  } = {}
) {
  const path = opts.path ?? '/api/gateway/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '1.2.3.4',
    ...opts.headers,
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// SSE helpers.
export function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

export function sseChunk(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

// Read an SSE response body into parsed event data objects.
export async function readSSEEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}
