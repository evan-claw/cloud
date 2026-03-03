// Core proxy handler — the final step in the middleware chain.
//
// Responsibilities:
//   1. Make upstream request (custom LLM or provider API)
//   2. Start abuse classification early (non-blocking)
//   3. Handle 402 → 503 conversion for non-BYOK cases
//   4. Log proxy errors for 4xx/5xx responses
//   5. Await abuse classification result (2s timeout)
//   6. Apply makeErrorReadable for BYOK/context-length errors
//   7. Rewrite free model response (SSE or JSON)
//   8. Schedule background tasks via ctx.waitUntil()

import type { Handler } from 'hono';
import type { HonoContext } from '../types/hono';
import { isAnonymousContext } from '../lib/anonymous';
import { isKiloFreeModel } from '../lib/models';
import { customLlmRequest } from '../lib/custom-llm/index';
import { getOutputHeaders, wrapResponse, makeErrorReadable } from '../lib/response-helpers';
import { rewriteFreeModelResponse } from '../lib/rewrite-free-model-response';
import { classifyAbuse, type AbuseServiceSecrets } from '../lib/abuse-service';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../lib/promotions';
import { getWorkerDb } from '@kilocode/db/client';
import { scheduleBackgroundTasks } from './background-tasks';

const TEN_MINUTES_MS = 10 * 60 * 1000;

// Build the upstream fetch URL — always /chat/completions on the provider base URL.
function buildUpstreamUrl(providerApiUrl: string): string {
  return `${providerApiUrl}/chat/completions`;
}

// Send request to the provider API (non-custom-LLM path).
async function openRouterRequest(
  providerApiUrl: string,
  apiKey: string,
  body: unknown,
  extraHeaders: Record<string, string>
): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://kilocode.ai',
    'X-Title': 'Kilo Code',
    'Content-Type': 'application/json',
  });
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  return fetch(buildUpstreamUrl(providerApiUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TEN_MINUTES_MS),
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const proxyHandler: Handler<HonoContext> = async c => {
  const requestBody = c.get('requestBody');
  const resolvedModel = c.get('resolvedModel');
  const provider = c.get('provider');
  const userByok = c.get('userByok');
  const customLlm = c.get('customLlm');
  const user = c.get('user');
  const organizationId = c.get('organizationId');
  const projectId = c.get('projectId');
  const extraHeaders = c.get('extraHeaders');
  const fraudHeaders = c.get('fraudHeaders');
  const editorName = c.get('editorName');
  const machineId = c.get('machineId');
  const taskId = c.get('taskId');
  const botId = c.get('botId');
  const tokenSource = c.get('tokenSource');
  const feature = c.get('feature');
  const autoModel = c.get('autoModel');
  const requestStartedAt = c.get('requestStartedAt');
  const modeHeader = c.get('modeHeader');
  const isAnon = isAnonymousContext(user);

  // Abuse classification starts non-blocking — we hold a promise and
  // await it (with a 2s timeout) after the upstream response arrives.
  const abuseServiceUrl = await c.env.ABUSE_SERVICE_URL.get();
  let abuseSecrets: AbuseServiceSecrets | undefined;
  const abuseSecretsPromise = Promise.all([
    c.env.ABUSE_CF_ACCESS_CLIENT_ID.get(),
    c.env.ABUSE_CF_ACCESS_CLIENT_SECRET.get(),
  ])
    .then(([id, secret]) => {
      abuseSecrets = { cfAccessClientId: id, cfAccessClientSecret: secret };
    })
    .catch(() => {
      /* fail-open */
    });

  // Start classification in parallel with the upstream request.
  const classifyPromise = abuseSecretsPromise.then(() =>
    classifyAbuse(abuseServiceUrl, abuseSecrets, fraudHeaders, editorName, requestBody, {
      kiloUserId: user.id,
      organizationId,
      projectId,
      provider: provider.id,
      isByok: !!userByok,
    })
  );

  // ── Upstream request ────────────────────────────────────────────────────────
  let response: Response;
  if (customLlm) {
    const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
    const isLegacyExtension = !!fraudHeaders.http_user_agent?.startsWith('Kilo-Code/');
    response = await customLlmRequest(
      customLlm,
      requestBody,
      user.id,
      taskId ?? undefined,
      isLegacyExtension,
      db
    );
  } else {
    response = await openRouterRequest(provider.apiUrl, provider.apiKey, requestBody, extraHeaders);
  }

  console.debug(`Upstream ${provider.id} responded with ${response.status}`);

  // ── 402 → 503 conversion (non-BYOK) ─────────────────────────────────────────
  if (response.status === 402 && !userByok) {
    console.error(`${provider.id} returned 402 Payment Required`, {
      kiloUserId: user.id,
      model: requestBody.model,
      organizationId,
    });
    return c.json(
      {
        error: 'Service Unavailable',
        message: 'The service is temporarily unavailable. Please try again later.',
      },
      503
    );
  }

  // ── Error logging ────────────────────────────────────────────────────────────
  if (response.status >= 400) {
    const responseClone = response.clone();
    const logLevel = response.status >= 500 ? 'error' : 'warn';
    c.executionCtx.waitUntil(
      responseClone
        .text()
        .then(body => {
          console[logLevel](`${provider.id} returned error ${response.status}`, {
            kiloUserId: user.id,
            model: requestBody.model,
            organizationId,
            status: response.status,
            first4k: body.slice(0, 4096),
          });
        })
        .catch(() => {
          /* ignore */
        })
    );
  }

  // ── Await abuse classification (2s timeout) ───────────────────────────────────
  let classifyResult: Awaited<typeof classifyPromise> | null = null;
  try {
    classifyResult = await Promise.race([classifyPromise, scheduler.wait(2000).then(() => null)]);
  } catch {
    // ignore — abuse service is fail-open
  }

  if (classifyResult) {
    console.log('Abuse classification result', {
      verdict: classifyResult.verdict,
      risk_score: classifyResult.risk_score,
      signals: classifyResult.signals,
      identity_key: classifyResult.context.identity_key,
      kilo_user_id: user.id,
      requested_model: resolvedModel,
      rps: classifyResult.context.requests_per_second,
      request_id: classifyResult.request_id,
    });
  }

  // ── BYOK / context-length error messages ─────────────────────────────────────
  const errorResponse = await makeErrorReadable({
    requestedModel: resolvedModel,
    request: requestBody,
    response,
    isUserByok: !!userByok,
  });
  if (errorResponse) return errorResponse;

  const abuseRequestId = classifyResult?.request_id ?? undefined;
  const bgCommon = {
    upstreamStatusCode: response.status,
    abuseServiceUrl,
    abuseSecrets,
    abuseRequestId,
    isStreaming: requestBody.stream === true,
    requestStartedAt,
    provider: provider.id,
    resolvedModel,
    requestBody,
    user,
    organizationId,
    modeHeader,
    fraudHeaders,
    projectId,
    editorName,
    machineId,
    feature,
    autoModel,
    botId,
    tokenSource,
    userByok: !!userByok,
    isAnon,
    sessionId: taskId,
    connectionString: c.env.HYPERDRIVE.connectionString,
    o11y: c.env.O11Y,
  } as const;

  // ── Free model response rewrite ───────────────────────────────────────────────
  const shouldRewrite =
    provider.id !== 'custom' &&
    (isKiloFreeModel(resolvedModel) ||
      isActiveReviewPromo(botId, resolvedModel) ||
      isActiveCloudAgentPromo(tokenSource, resolvedModel));

  if (shouldRewrite) {
    if (response.body) {
      const [metricsStream, clientStream] = response.body.tee();

      scheduleBackgroundTasks(c.executionCtx, {
        ...bgCommon,
        accountingStream: null, // free model — no cost accounting
        metricsStream,
        loggingStream: null,
      });
      return rewriteFreeModelResponse(new Response(clientStream, response), resolvedModel);
    }
    return rewriteFreeModelResponse(response, resolvedModel);
  }

  // ── Pass-through with background tasks (buffer-based, no .tee()) ────────────
  if (response.body) {
    // Instead of .tee() (which couples consumer speeds via backpressure and stalls
    // the client when background consumers are slow), pipe the upstream body through
    // a TransformStream that forwards every chunk to the client immediately while
    // accumulating a copy. After the stream completes, background tasks replay the
    // buffered data without any coupling to client delivery speed.
    const responseBody = response.body;
    const chunks: Uint8Array[] = [];
    const { readable: clientStream, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const pipePromise = (async () => {
      const reader = responseBody.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          chunks.push(result.value);
          await writer.write(result.value);
        }
        await writer.close();
      } catch (err) {
        await reader.cancel().catch(() => {});
        await writer.abort(err).catch(() => {});
        throw err;
      }
    })();

    // Build a ReadableStream from the buffered chunks (usable after pipePromise resolves).
    function replayStream(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    }

    // Background tasks run after the stream completes (all chunks buffered).
    c.executionCtx.waitUntil(
      pipePromise
        .then(() => {
          scheduleBackgroundTasks(c.executionCtx, {
            ...bgCommon,
            accountingStream: !isAnon ? replayStream() : null,
            metricsStream: replayStream(),
            loggingStream: !isAnon ? replayStream() : null,
          });
        })
        .catch(err => {
          console.error('[proxy] Stream pipe error', err);
        })
    );

    return wrapResponse(new Response(clientStream, response));
  }

  return wrapResponse(response);
};

// Re-export output headers helper for tests.
export { getOutputHeaders };
