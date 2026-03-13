# Gmail Push Queue Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Google Pub/Sub acceptance from downstream delivery by inserting a Cloudflare Queue into the gmail-push worker.

**Architecture:** Single worker acts as both queue producer (HTTP handler validates auth, enqueues) and consumer (delivers to Fly controller with per-message ack/retry). 60s retry delay, 10 max retries.

**Tech Stack:** Cloudflare Workers, Cloudflare Queues, Hono, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-12-gmail-push-queue-design.md`

---

## File Map

| File                                            | Action | Responsibility                                                                  |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `cloudflare-gmail-push/src/types.ts`            | Modify | Add `GmailPushQueueMessage` interface, add `GMAIL_PUSH_QUEUE` to `Env`          |
| `cloudflare-gmail-push/src/routes/push.ts`      | Modify | Strip delivery logic, read body as string, enqueue, return 200                  |
| `cloudflare-gmail-push/src/routes/push.test.ts` | Modify | Add queue mock to env, update assertions for enqueue behavior                   |
| `cloudflare-gmail-push/src/consumer.ts`         | Create | Queue consumer: iterate batch, lookup machine, forward to controller, ack/retry |
| `cloudflare-gmail-push/src/consumer.test.ts`    | Create | Test consumer: ack/retry per scenario                                           |
| `cloudflare-gmail-push/src/index.ts`            | Modify | Export `{ fetch, queue }` instead of Hono app default                           |
| `cloudflare-gmail-push/wrangler.jsonc`          | Modify | Add queue producer + consumer config for prod and dev                           |

---

## Chunk 1: Types and Wrangler Config

### Task 1: Update types and wrangler config

**Files:**

- Modify: `cloudflare-gmail-push/src/types.ts`
- Modify: `cloudflare-gmail-push/wrangler.jsonc`

- [ ] **Step 1: Add queue message type and binding to `src/types.ts`**

Replace the entire file with:

```typescript
export interface GmailPushQueueMessage {
  userId: string;
  pubSubBody: string;
}

export type Env = {
  KILOCLAW: Fetcher;
  OIDC_AUDIENCE: string;
  INTERNAL_API_SECRET: string;
  GMAIL_PUSH_QUEUE: Queue<GmailPushQueueMessage>;
};

export type HonoContext = {
  Bindings: Env;
};
```

- [ ] **Step 2: Add queue config to `wrangler.jsonc`**

Add to the top-level config (after `secrets_store_secrets`):

```jsonc
"queues": {
  "producers": [{ "binding": "GMAIL_PUSH_QUEUE", "queue": "gmail-push-notifications" }],
  "consumers": [{ "queue": "gmail-push-notifications", "max_retries": 10, "retry_delay": 60 }]
}
```

Add inside `env.dev` (after `secrets_store_secrets`):

```jsonc
"queues": {
  "producers": [{ "binding": "GMAIL_PUSH_QUEUE", "queue": "gmail-push-notifications-dev" }],
  "consumers": [{ "queue": "gmail-push-notifications-dev", "max_retries": 10, "retry_delay": 60 }]
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd cloudflare-gmail-push && pnpm run typecheck`

Expected: Type errors in `push.test.ts` (missing `GMAIL_PUSH_QUEUE` in env mock) and possibly `index.ts`. These are expected and will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
pnpm run format:changed
git add cloudflare-gmail-push/src/types.ts cloudflare-gmail-push/wrangler.jsonc
git commit -m "feat(gmail-push): add queue message type and wrangler queue config"
```

---

## Chunk 2: Refactor Producer (Push Route)

### Task 2: Write failing tests for producer enqueue behavior

**Files:**

- Modify: `cloudflare-gmail-push/src/routes/push.test.ts`

- [ ] **Step 1: Update `createApp()` helper to include queue mock**

In `push.test.ts`, update the `createApp()` function. Add a `mockQueue` with a `send` spy and include it in `c.env`:

```typescript
function createApp() {
  const app = new Hono<HonoContext>();
  const mockKiloclaw = {
    fetch: vi.fn(),
  };
  const mockQueue = {
    send: vi.fn(),
  };

  app.use('*', async (c, next) => {
    c.env = {
      KILOCLAW: mockKiloclaw as unknown as Fetcher,
      OIDC_AUDIENCE: 'https://test-audience.example.com',
      INTERNAL_API_SECRET: 'test-internal-secret',
      GMAIL_PUSH_QUEUE: mockQueue as unknown as Queue,
    };
    await next();
  });

  app.route('/push', pushRoute);
  return { app, mockKiloclaw, mockQueue };
}
```

- [ ] **Step 2: Replace the "machine not running" and "forwards push" tests**

Remove:

- `it('returns 200 when machine is not running', ...)` — queue consumer handles this now
- `it('forwards push to controller and returns 200 on success', ...)` — delivery is consumer's job

Replace with this new test:

```typescript
it('enqueues message and returns 200 for valid auth (with OIDC)', async () => {
  mockValidateOidc.mockResolvedValue({
    valid: true,
    email: 'gmail-api-push@system.gserviceaccount.com',
  });
  const { app, mockQueue } = createApp();
  const pubSubBody = JSON.stringify({ message: { data: 'dGVzdA==', messageId: '123' } });

  const res = await app.request(`/push/user/${TEST_USER}/${validToken}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
    },
    body: pubSubBody,
  });

  expect(res.status).toBe(200);
  expect(mockQueue.send).toHaveBeenCalledOnce();
  expect(mockQueue.send).toHaveBeenCalledWith({
    userId: TEST_USER,
    pubSubBody,
  });
});
```

Keep the auth rejection tests (`rejects invalid push token`, `rejects invalid OIDC token`).

**Replace** the existing `proceeds without OIDC auth header` test with this version (removes kiloclaw mock setup, adds queue.send assertion):

```typescript
it('proceeds without OIDC auth header (warns but does not reject)', async () => {
  const { app, mockQueue } = createApp();
  const pubSubBody = JSON.stringify({ message: { data: 'dGVzdA==' } });

  const res = await app.request(`/push/user/${TEST_USER}/${validToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pubSubBody,
  });

  expect(res.status).toBe(200);
  expect(mockValidateOidc).not.toHaveBeenCalled();
  expect(mockQueue.send).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd cloudflare-gmail-push && pnpm test`

Expected: New enqueue tests FAIL (push.ts still does delivery, doesn't call queue.send). Auth tests may still pass.

### Task 3: Implement producer — slim down push route to auth + enqueue

**Files:**

- Modify: `cloudflare-gmail-push/src/routes/push.ts`

- [ ] **Step 1: Replace push route with auth + enqueue**

Replace the entire contents of `src/routes/push.ts` with:

```typescript
import { Hono } from 'hono';
import type { HonoContext } from '../types';
import { validateOidcToken } from '../auth/oidc';
import { verifyPushToken } from '../auth/push-token';

export const pushRoute = new Hono<HonoContext>();

pushRoute.post('/user/:userId/:token', async c => {
  const userId = c.req.param('userId');
  const token = c.req.param('token');

  // Verify URL-embedded HMAC token (prevents unauthenticated push to arbitrary userIds)
  const tokenValid = await verifyPushToken(token, userId, c.env.INTERNAL_API_SECRET);
  if (!tokenValid) {
    console.warn(`[gmail-push] Invalid push token for user ${userId}`);
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Optional defense-in-depth: validate Google OIDC token if present.
  // Primary auth is the HMAC URL token above. OIDC can be enabled by
  // configuring --push-auth-service-account on the Pub/Sub subscription.
  // Invalid tokens are still rejected; missing tokens are allowed.
  const authHeader = c.req.header('authorization');
  if (authHeader) {
    const oidcResult = await validateOidcToken(authHeader, c.env.OIDC_AUDIENCE);
    if (!oidcResult.valid) {
      console.warn(`[gmail-push] OIDC validation failed for user ${userId}: ${oidcResult.error}`);
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } else {
    console.warn(`[gmail-push] No OIDC token for user ${userId} push — proceeding without auth`);
  }

  const pubSubBody = await c.req.text();
  await c.env.GMAIL_PUSH_QUEUE.send({ userId, pubSubBody });

  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd cloudflare-gmail-push && pnpm test`

Expected: All push route tests PASS. No consumer tests yet.

- [ ] **Step 3: Commit**

```bash
pnpm run format:changed
git add cloudflare-gmail-push/src/routes/push.ts cloudflare-gmail-push/src/routes/push.test.ts
git commit -m "feat(gmail-push): refactor push route to auth + enqueue (producer)"
```

---

## Chunk 3: Queue Consumer

### Task 4: Write failing tests for queue consumer

**Files:**

- Create: `cloudflare-gmail-push/src/consumer.test.ts`

- [ ] **Step 1: Create consumer test file**

Create `cloudflare-gmail-push/src/consumer.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from './consumer';
import type { Env, GmailPushQueueMessage } from './types';

const TEST_USER = 'user123';
const TEST_PUBSUB_BODY = JSON.stringify({ message: { data: 'dGVzdA==' } });

function createMockMessage(body: GmailPushQueueMessage): {
  body: GmailPushQueueMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
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
    const kiloclawFetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
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
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
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
              JSON.stringify({
                flyAppName: 'app-ok',
                flyMachineId: 'machine-ok',
                status: 'running',
              })
            )
          );
        }
        // user-stopped has no machine
        return Promise.resolve(
          new Response(JSON.stringify({ flyAppName: null, flyMachineId: null, status: 'stopped' }))
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloudflare-gmail-push && pnpm test`

Expected: All consumer tests FAIL with "Cannot find module './consumer'" or similar import error.

### Task 5: Implement queue consumer

**Files:**

- Create: `cloudflare-gmail-push/src/consumer.ts`

- [ ] **Step 1: Create `src/consumer.ts`**

```typescript
import type { Env, GmailPushQueueMessage } from './types';

export async function handleQueue(
  batch: MessageBatch<GmailPushQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    await processMessage(message, env);
  }
}

async function processMessage(message: Message<GmailPushQueueMessage>, env: Env): Promise<void> {
  const { userId, pubSubBody } = message.body;

  try {
    // Look up machine status via service binding
    const statusRes = await env.KILOCLAW.fetch(
      new Request(`https://kiloclaw/api/platform/status?userId=${encodeURIComponent(userId)}`, {
        headers: { 'x-internal-api-key': env.INTERNAL_API_SECRET },
      })
    );

    if (!statusRes.ok) {
      console.warn(`[gmail-push] Status lookup failed for user ${userId}: ${statusRes.status}`);
      message.retry();
      return;
    }

    const status: {
      flyAppName: string | null;
      flyMachineId: string | null;
      sandboxId: string | null;
      status: string | null;
    } = await statusRes.json();

    if (!status.flyAppName || !status.flyMachineId || status.status !== 'running') {
      console.warn(`[gmail-push] Machine not running for user ${userId}, retrying`);
      message.retry();
      return;
    }

    // Get gateway token
    const tokenRes = await env.KILOCLAW.fetch(
      new Request(
        `https://kiloclaw/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': env.INTERNAL_API_SECRET } }
      )
    );

    if (!tokenRes.ok) {
      console.error(
        `[gmail-push] Gateway token lookup failed for user ${userId}: ${tokenRes.status}`
      );
      message.retry();
      return;
    }

    const { gatewayToken }: { gatewayToken: string } = await tokenRes.json();

    // Forward push body to controller
    const machineUrl = `https://${status.flyAppName}.fly.dev`;
    const controllerRes = await fetch(`${machineUrl}/_kilo/gmail-pubsub`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayToken}`,
        'fly-force-instance-id': status.flyMachineId,
      },
      body: pubSubBody,
    });

    if (controllerRes.ok || (controllerRes.status >= 400 && controllerRes.status < 500)) {
      message.ack();
      return;
    }

    console.error(`[gmail-push] Controller returned ${controllerRes.status} for user ${userId}`);
    message.retry();
  } catch (err) {
    console.error(`[gmail-push] Error delivering to user ${userId}:`, err);
    message.retry();
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd cloudflare-gmail-push && pnpm test`

Expected: All consumer tests PASS. All push route tests PASS.

- [ ] **Step 3: Commit**

```bash
pnpm run format:changed
git add cloudflare-gmail-push/src/consumer.ts cloudflare-gmail-push/src/consumer.test.ts
git commit -m "feat(gmail-push): add queue consumer with per-message ack/retry"
```

---

## Chunk 4: Wire Up Entry Point

### Task 6: Update worker entry point to export queue handler

**Files:**

- Modify: `cloudflare-gmail-push/src/index.ts`

- [ ] **Step 1: Update `src/index.ts` to export fetch + queue**

Replace the entire file with:

```typescript
import { Hono } from 'hono';
import type { HonoContext } from './types';
import { pushRoute } from './routes/push';
import { handleQueue } from './consumer';

const app = new Hono<HonoContext>();

app.get('/health', c => c.json({ ok: true }));
app.route('/push', pushRoute);

export default {
  fetch: app.fetch,
  queue: handleQueue,
};
```

- [ ] **Step 2: Run all tests**

Run: `cd cloudflare-gmail-push && pnpm test`

Expected: All tests PASS.

- [ ] **Step 3: Run typecheck**

Run: `cd cloudflare-gmail-push && pnpm run typecheck`

Expected: PASS, no type errors.

- [ ] **Step 4: Run lint**

Run: `cd cloudflare-gmail-push && pnpm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run format:changed
git add cloudflare-gmail-push/src/index.ts
git commit -m "feat(gmail-push): wire up queue handler in worker entry point"
```
