import { z } from 'zod';

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

const SecuritySyncOwnerSchema = z
  .object({
    owner: z
      .object({
        organizationId: z.string().uuid().optional(),
        userId: z.string().uuid().optional(),
      })
      .refine(value => Boolean(value.organizationId || value.userId), {
        message: 'owner.organizationId or owner.userId is required',
      }),
    ownerKey: z.string().min(1),
  })
  .refine(value => value.ownerKey.startsWith('org:') || value.ownerKey.startsWith('user:'), {
    message: 'ownerKey must be org:<id> or user:<id>',
  });

const DispatchRequestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  dispatchedAt: z.string().datetime(),
  owners: z.array(SecuritySyncOwnerSchema),
});

const SecuritySyncMessageSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  messageId: z.string().min(1),
  owner: z
    .object({
      organizationId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
    })
    .refine(value => Boolean(value.organizationId || value.userId), {
      message: 'owner.organizationId or owner.userId is required',
    }),
  ownerKey: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  dispatchedAt: z.string().datetime(),
});

type DispatchRequest = z.infer<typeof DispatchRequestSchema>;
export type SecuritySyncMessage = z.infer<typeof SecuritySyncMessageSchema>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

async function computeSignature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  return `sha256=${hex}`;
}

function validateBearerAuth(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization) return false;
  const expected = `Bearer ${expectedToken}`;
  if (authorization.length !== expected.length) return false;
  return timingSafeEqual(authorization, expected);
}

async function validateSignedDispatchRequest(
  request: Request,
  rawBody: string,
  hmacSecret: string
): Promise<boolean> {
  const timestampHeader = request.headers.get('x-security-sync-timestamp');
  const signatureHeader = request.headers.get('x-security-sync-signature');

  if (!timestampHeader || !signatureHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_SIGNATURE_AGE_SECONDS) {
    return false;
  }

  const payloadToSign = `${timestampHeader}.${rawBody}`;
  const expectedSignature = await computeSignature(hmacSecret, payloadToSign);
  return timingSafeEqual(expectedSignature, signatureHeader);
}

// Cloudflare Queues sendBatch limit
const QUEUE_SEND_BATCH_LIMIT = 100;

async function enqueueDispatchMessages(
  queue: Queue<SecuritySyncMessage>,
  requestBody: DispatchRequest
): Promise<number> {
  if (requestBody.owners.length === 0) {
    return 0;
  }

  const messages: MessageSendRequest<SecuritySyncMessage>[] = requestBody.owners.map(owner => ({
    body: {
      schemaVersion: 1,
      runId: requestBody.runId,
      messageId: `${requestBody.runId}:${owner.ownerKey}:0`,
      owner: owner.owner,
      ownerKey: owner.ownerKey,
      chunkIndex: 0,
      chunkCount: 1,
      dispatchedAt: requestBody.dispatchedAt,
    },
    contentType: 'json',
  }));

  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
  }

  return messages.length;
}

async function handleDispatch(request: Request, env: CloudflareEnv): Promise<Response> {
  const authToken = await env.SECURITY_SYNC_WORKER_AUTH_TOKEN.get();
  if (!validateBearerAuth(request, authToken)) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const rawBody = await request.text();
  const hmacSecret = await env.SECURITY_SYNC_WORKER_HMAC_SECRET.get();
  const signatureValid = await validateSignedDispatchRequest(request, rawBody, hmacSecret);
  if (!signatureValid) {
    return jsonResponse({ success: false, error: 'Invalid request signature' }, 401);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON payload' }, 400);
  }
  const parsedRequest = DispatchRequestSchema.safeParse(parsedJson);
  if (!parsedRequest.success) {
    return jsonResponse(
      {
        success: false,
        error: 'Invalid dispatch payload',
      },
      400
    );
  }

  const enqueuedMessages = await enqueueDispatchMessages(env.SYNC_QUEUE, parsedRequest.data);

  return jsonResponse({
    success: true,
    runId: parsedRequest.data.runId,
    ownerCount: parsedRequest.data.owners.length,
    enqueuedMessages,
  });
}

async function processSecuritySyncMessage(message: Message<SecuritySyncMessage>): Promise<void> {
  const parsedMessage = SecuritySyncMessageSchema.safeParse(message.body);
  if (!parsedMessage.success) {
    console.error('Invalid security sync queue message', {
      errors: parsedMessage.error.issues,
    });
    message.ack();
    return;
  }

  const body = parsedMessage.data;

  console.info('Security sync queue message received', {
    runId: body.runId,
    ownerKey: body.ownerKey,
    messageId: body.messageId,
    chunkIndex: body.chunkIndex,
    chunkCount: body.chunkCount,
    dispatchTime: body.dispatchedAt,
  });

  // Queue wiring + auth are live. Worker-native sync execution is implemented in the next phase.
  message.ack();
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'cloudflare-security-sync',
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/dispatch') {
      try {
        return await handleDispatch(request, env);
      } catch (error) {
        return jsonResponse(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown dispatch error',
          },
          500
        );
      }
    }

    return jsonResponse({ success: false, error: 'Not found' }, 404);
  },

  async queue(batch: MessageBatch<SecuritySyncMessage>): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processSecuritySyncMessage(message);
      } catch (error) {
        console.error('Security sync queue processing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};
