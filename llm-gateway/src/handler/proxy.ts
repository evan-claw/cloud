// Core proxy handler — the final step in the middleware chain.
//
// Responsibilities:
//   1. Make upstream request (custom LLM or provider API)
//   2. Start abuse classification early (non-blocking)
//   3. Log proxy errors for 4xx/5xx responses
//   4. Await abuse classification result (2s timeout)
//   5. Schedule background tasks (always, even for error responses)
//   6. Handle 402 → 503 conversion for non-BYOK cases (after bg tasks)
//   7. Apply makeErrorReadable for BYOK/context-length errors
//   8. Rewrite free model response (SSE or JSON)

import type { Handler } from 'hono';
import type { HonoContext } from '../types/hono';
import { isAnonymousContext } from '../lib/anonymous';
import { isKiloFreeModel } from '../lib/models';
import { customLlmRequest } from '../lib/custom-llm/index';
import { getOutputHeaders, wrapResponse, makeErrorReadable } from '../lib/response-helpers';
import { rewriteFreeModelResponse } from '../lib/rewrite-free-model-response';
import { classifyAbuse, type AbuseServiceSecrets } from '../lib/abuse-service';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../lib/promotions';
import { scheduleBackgroundTasks, type BackgroundTaskParams } from './background-tasks';
import { getToolsUsed } from '../background/api-metrics';
import { captureException } from '../lib/sentry';

const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Pipe an upstream response body through a TransformStream, buffering every
 * chunk so that background tasks can replay the data after the stream completes
 * without coupling consumer speed to client delivery (no `.tee()` backpressure).
 *
 * Returns the client-facing stream immediately. Once the upstream is fully
 * consumed, `onBuffered` is called with a factory that creates replay streams.
 */
function bufferAndForward(
  body: ReadableStream,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  onBuffered: (replay: () => ReadableStream<Uint8Array>) => void,
  label: string
): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const { readable: clientStream, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pipePromise = (async () => {
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
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

  function replay(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  ctx.waitUntil(
    pipePromise
      .then(() => onBuffered(replay))
      .catch(err => {
        console.error(`[proxy] ${label} stream pipe error`, err);
      })
  );

  return clientStream;
}

// Build the upstream fetch URL — always /chat/completions on the provider base URL,
// preserving any query string from the original request.
function buildUpstreamUrl(providerApiUrl: string, search: string): string {
  return `${providerApiUrl}/chat/completions${search}`;
}

// Send request to the provider API (non-custom-LLM path).
async function openRouterRequest(
  providerApiUrl: string,
  apiKey: string,
  body: unknown,
  extraHeaders: Record<string, string>,
  search: string,
  clientSignal: AbortSignal
): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://kilocode.ai',
    'X-Title': 'Kilo Code',
    'Content-Type': 'application/json',
  });
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  // Abort on whichever comes first: client disconnect or 10-minute hard timeout.
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = AbortSignal.any([clientSignal, timeoutSignal]);

  return fetch(buildUpstreamUrl(providerApiUrl, search), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
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

  // Preserve query string so it is forwarded to the upstream provider.
  const { search } = new URL(c.req.url);

  // Fetch PostHog + abuse secrets in parallel — fail loudly if Secrets Store is down.
  const [abuseServiceUrl, posthogApiKey, cfAccessClientId, cfAccessClientSecret] =
    await Promise.all([
      c.env.ABUSE_SERVICE_URL.get(),
      c.env.POSTHOG_API_KEY.get(),
      c.env.ABUSE_CF_ACCESS_CLIENT_ID.get(),
      c.env.ABUSE_CF_ACCESS_CLIENT_SECRET.get(),
    ]);

  const abuseSecrets: AbuseServiceSecrets = { cfAccessClientId, cfAccessClientSecret };

  // Abuse classification starts non-blocking — we hold a promise and
  // await it (with a 2s timeout) after the upstream response arrives.
  const classifyPromise = classifyAbuse(
    abuseServiceUrl,
    abuseSecrets,
    fraudHeaders,
    editorName,
    requestBody,
    {
      kiloUserId: user.id,
      organizationId,
      projectId,
      provider: provider.id,
      isByok: !!userByok,
    }
  );

  // ── Upstream request ────────────────────────────────────────────────────────
  let response: Response;
  if (customLlm) {
    const db = c.get('db');
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
    response = await openRouterRequest(
      provider.apiUrl,
      provider.apiKey,
      requestBody,
      extraHeaders,
      search,
      c.req.raw.signal
    );
  }

  // Record time-to-first-byte (wall-clock from request start to upstream response).
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  console.debug(`Upstream ${provider.id} responded with ${response.status}`);

  // ── Error logging ────────────────────────────────────────────────────────────
  if (response.status >= 400) {
    const responseClone = response.clone();
    const logLevel = response.status >= 500 ? 'error' : 'warn';
    c.executionCtx.waitUntil(
      responseClone
        .text()
        .then(body => {
          const errorMessage = `${provider.id} returned error ${response.status}`;
          const extra = {
            kiloUserId: user.id,
            model: requestBody.model,
            organizationId,
            status: response.status,
            first4k: body.slice(0, 4096),
          };
          console[logLevel](errorMessage, extra);
          if (response.status >= 500) {
            captureException(new Error(errorMessage), extra);
          }
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

  const abuseRequestId = classifyResult?.request_id ?? undefined;

  // ── Shared background task context ──────────────────────────────────────────
  const bgCommon: Omit<
    BackgroundTaskParams,
    'accountingStream' | 'metricsStream' | 'loggingStream'
  > = {
    upstreamStatusCode: response.status,
    abuseServiceUrl,
    abuseSecrets,
    abuseRequestId,
    isStreaming: requestBody.stream === true,
    requestStartedAt,
    ttfbMs,
    provider: provider.id,
    providerApiUrl: provider.apiUrl,
    providerApiKey: provider.apiKey,
    providerHasGenerationEndpoint: provider.hasGenerationEndpoint,
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
    toolsUsed: getToolsUsed(requestBody.messages),
    posthogApiKey,
    connectionString: c.env.HYPERDRIVE.connectionString,
    o11y: c.env.O11Y,
    queue: c.env.LLM_GATEWAY_BG_TASKS_QUEUE,
  };

  // ── Error responses ──────────────────────────────────────────────────────────
  // 402 non-BYOK: only metrics (no accounting/logging), matching the reference.
  // All other errors: full background tasks (accounting + metrics + logging).
  if (response.status >= 400) {
    // Error bodies are small JSON — buffer synchronously so background tasks can
    // read the body independently of whatever response we send to the client.
    const errorBodyBytes = new Uint8Array(await response.arrayBuffer());

    function makeErrorStream(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(errorBodyBytes);
          ctrl.close();
        },
      });
    }

    // ── 402 → 503 conversion (non-BYOK) ───────────────────────────────────────
    // In the reference, 402 returns BEFORE accountForMicrodollarUsage and
    // handleRequestLogging — only emitApiMetricsForResponse runs for 402s.
    if (response.status === 402 && !userByok) {
      scheduleBackgroundTasks(c.executionCtx, {
        ...bgCommon,
        accountingStream: null,
        metricsStream: makeErrorStream(),
        loggingStream: null,
      });
      captureException(new Error(`${provider.id} returned 402 Payment Required`), {
        kiloUserId: user.id,
        model: requestBody.model,
        organizationId,
        first4k: new TextDecoder().decode(errorBodyBytes).slice(0, 4096),
      });
      return c.json(
        {
          error: 'Service Unavailable',
          message: 'The service is temporarily unavailable. Please try again later.',
        },
        503
      );
    }

    // All other errors: full background tasks (accounting + metrics + logging)
    scheduleBackgroundTasks(c.executionCtx, {
      ...bgCommon,
      accountingStream: !isAnon ? makeErrorStream() : null,
      metricsStream: makeErrorStream(),
      loggingStream: !isAnon ? makeErrorStream() : null,
    });

    // BYOK / context-length readable error — return a custom message instead of
    // the raw upstream body.
    const errorResponse = await makeErrorReadable({
      requestedModel: resolvedModel,
      request: requestBody,
      response: new Response(errorBodyBytes, response),
      isUserByok: !!userByok,
    });
    if (errorResponse) return errorResponse;

    return wrapResponse(new Response(errorBodyBytes, response));
  }

  // ── Free model response rewrite ───────────────────────────────────────────────
  const shouldRewrite =
    provider.id !== 'custom' &&
    (isKiloFreeModel(resolvedModel) ||
      isActiveReviewPromo(botId, resolvedModel) ||
      isActiveCloudAgentPromo(tokenSource, resolvedModel));

  // Helper: schedule background tasks from a replay factory (after buffering completes).
  function scheduleBgFromReplay(replay: () => ReadableStream<Uint8Array>) {
    scheduleBackgroundTasks(c.executionCtx, {
      ...bgCommon,
      accountingStream: !isAnon ? replay() : null,
      metricsStream: replay(),
      loggingStream: !isAnon ? replay() : null,
    });
  }

  // Helper: schedule background tasks without streams (bodyless or error responses).
  function scheduleBgWithoutStreams() {
    scheduleBackgroundTasks(c.executionCtx, {
      ...bgCommon,
      accountingStream: null,
      metricsStream: null,
      loggingStream: null,
    });
  }

  if (shouldRewrite) {
    if (response.body) {
      const clientStream = bufferAndForward(
        response.body,
        c.executionCtx,
        scheduleBgFromReplay,
        'Free model'
      );
      return rewriteFreeModelResponse(new Response(clientStream, response), resolvedModel);
    }
    scheduleBgWithoutStreams();
    return rewriteFreeModelResponse(response, resolvedModel);
  }

  // ── Pass-through with background tasks (buffer-based, no .tee()) ────────────
  if (response.body) {
    const clientStream = bufferAndForward(
      response.body,
      c.executionCtx,
      scheduleBgFromReplay,
      'Pass-through'
    );
    return wrapResponse(new Response(clientStream, response));
  }

  // Bodyless non-error response — still schedule background tasks so metrics
  // and accounting are recorded (e.g. 204 No Content from a provider).
  scheduleBgWithoutStreams();

  return wrapResponse(response);
};

// Re-export output headers helper for tests.
export { getOutputHeaders };
