import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { isOpenCodeBasedClient, isRooCodeBasedClient, stripRequiredPrefix } from '@/lib/utils';
import { generateProviderSpecificHash } from '@/lib/providerHash';
import {
  extractPromptInfo,
  extractResponsesPromptInfo,
  type MicrodollarUsageContext,
  type PromptInfo,
} from '@/lib/processUsage';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import type {
  OpenRouterChatCompletionRequest,
  GatewayResponsesRequest,
  ParsedProxyRequest,
} from '@/lib/providers/openrouter/types';
import { applyProviderSpecificLogic, getProvider, openRouterRequest } from '@/lib/providers';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user.server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  isFreeModel,
  isDataCollectionRequiredOnKiloCodeOnly,
  isDeadFreeModel,
  isKiloFreeModel,
} from '@/lib/models';
import {
  accountForMicrodollarUsage,
  alphaPeriodEndedResponse,
  captureProxyError,
  checkOrganizationModelRestrictions,
  dataCollectionRequiredResponse,
  extractFraudAndProjectHeaders,
  invalidPathResponse,
  invalidRequestResponse,
  makeErrorReadable,
  modelDoesNotExistResponse,
  extractHeaderAndLimitLength,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
} from '@/lib/llm-proxy-helpers';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { ENABLE_TOOL_REPAIR, repairTools } from '@/lib/tool-calling';
import { isFreePromptTrainingAllowed } from '@/lib/providers/openrouter/types';
import { rewriteFreeModelResponse } from '@/lib/rewriteModelResponse';
import {
  createAnonymousContext,
  isAnonymousContext,
  type AnonymousUserContext,
} from '@/lib/anonymous';
import {
  checkFreeModelRateLimit,
  logFreeModelRequest,
  checkPromotionLimit,
} from '@/lib/free-model-rate-limiter';
import { PROMOTION_MAX_REQUESTS, PROMOTION_WINDOW_HOURS } from '@/lib/constants';
import { classifyAbuse } from '@/lib/abuse-service';
import {
  emitApiMetricsForResponse,
  getToolsAvailable,
  getToolsUsed,
} from '@/lib/o11y/api-metrics.server';
import { handleRequestLogging } from '@/lib/handleRequestLogging';
import { customLlmRequest } from '@/lib/custom-llm/customLlmRequest';
import { normalizeModelId } from '@/lib/model-utils';
import { isRateLimitedToDeath } from '@/lib/rate-limited-models';
import { isActiveReviewPromo } from '@/lib/code-reviews/core/constants';
import { isKiloAutoModel, resolveAutoModel } from '@/lib/kilo-auto-model';
import { fixOpenCodeDuplicateReasoning } from '@/lib/providers/fixOpenCodeDuplicateReasoning';
import type OpenAI from 'openai';

export const maxDuration = 800;

const MAX_TOKENS_LIMIT = 99999999999; // GPT4.1 default is ~32k

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';
const PROMOTION_MODEL_LIMIT_REACHED = 'PROMOTION_MODEL_LIMIT_REACHED';

type ApiPath = '/chat/completions' | '/responses';

function validatePath(
  url: URL
): { path: ApiPath } | { errorResponse: ReturnType<typeof invalidPathResponse> } {
  const pathSuffix =
    stripRequiredPrefix(url.pathname, '/api/gateway') ??
    stripRequiredPrefix(url.pathname, '/api/openrouter');

  if (pathSuffix === '/chat/completions' || pathSuffix === '/responses') {
    return { path: pathSuffix };
  }
  return { errorResponse: invalidPathResponse() };
}

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  const url = new URL(request.url);

  const pathResult = validatePath(url);
  if ('errorResponse' in pathResult) return pathResult.errorResponse;
  const { path } = pathResult;

  // Parse body first to check model before auth (needed for anonymous access)
  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  let parsedRequest: ParsedProxyRequest;
  try {
    if (path === '/chat/completions') {
      const body: OpenRouterChatCompletionRequest = JSON.parse(requestBodyText);
      // Inject or merge stream_options.include_usage = true
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      parsedRequest = { kind: 'chat_completions', body };
    } else {
      const body: GatewayResponsesRequest = JSON.parse(requestBodyText);
      parsedRequest = { kind: 'responses', body };
    }
  } catch (e) {
    captureException(e, {
      extra: { requestBodyText },
      tags: { source: 'openrouter-proxy' },
    });
    return invalidRequestResponse();
  }

  delete parsedRequest.body.models; // OpenRouter specific field we do not support
  if (
    typeof parsedRequest.body.model !== 'string' ||
    parsedRequest.body.model.trim().length === 0
  ) {
    return modelDoesNotExistResponse();
  }

  const requestedModel = parsedRequest.body.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

  const modeHeader = extractHeaderAndLimitLength(request, 'x-kilocode-mode');
  let autoModel: string | null = null;
  if (isKiloAutoModel(requestedModelLowerCased)) {
    autoModel = requestedModelLowerCased;
    const resolved = resolveAutoModel(requestedModelLowerCased, modeHeader);
    parsedRequest.body.model = resolved.model;
    if (resolved.reasoning) parsedRequest.body.reasoning = resolved.reasoning;
    if (resolved.verbosity) {
      if (parsedRequest.kind === 'chat_completions') {
        parsedRequest.body.verbosity =
          resolved.verbosity as OpenRouterChatCompletionRequest['verbosity'];
      } else {
        parsedRequest.body.text = {
          ...parsedRequest.body.text,
          verbosity: resolved.verbosity as OpenAI.Responses.ResponseTextConfig['verbosity'],
        };
      }
    }
  }

  const originalModelIdLowerCased = parsedRequest.body.model.toLowerCase();

  // Extract IP for all requests (needed for free model rate limiting)
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ipAddress) {
    return NextResponse.json({ error: 'Unable to determine client IP' }, { status: 400 });
  }

  // For FREE models: check IP rate limit BEFORE auth, log at start
  // Slackbot-only models are exempt from free model rate limits since they're
  // already gated behind the Slack integration (internalApiUse auth).
  if (isKiloFreeModel(originalModelIdLowerCased)) {
    const rateLimitResult = await checkFreeModelRateLimit(ipAddress);
    if (!rateLimitResult.allowed) {
      console.warn(
        `Free model rate limit exceeded, ip address: ${ipAddress}, model: ${originalModelIdLowerCased}, request count: ${rateLimitResult.requestCount}`
      );
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          message:
            'Free model usage limit reached. Please try again later or upgrade to a paid model.',
        },
        { status: 429 }
      );
    }
  }

  // Now check auth
  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId: authOrganizationId,
    botId: authBotId,
    tokenSource: authTokenSource,
  } = await getUserFromAuth({ adminOnly: false });
  authSpan.end();

  let user: typeof maybeUser | AnonymousUserContext;
  let organizationId: string | undefined = authOrganizationId;
  let botId: string | undefined = authBotId;
  let tokenSource: string | undefined = authTokenSource;

  if (authFailedResponse) {
    // No valid auth
    if (!isFreeModel(originalModelIdLowerCased)) {
      // Paid model requires authentication
      return NextResponse.json(
        {
          error: {
            code: PAID_MODEL_AUTH_REQUIRED,
            message: 'You need to sign in to use this model.',
          },
        },
        { status: 401 }
      );
    }

    const promotionLimit = await checkPromotionLimit(ipAddress);

    if (!promotionLimit.allowed) {
      console.warn(
        `Promotion model limit exceeded, ip: ${ipAddress}, ` +
          `model: ${originalModelIdLowerCased}, ` +
          `requests: ${promotionLimit.requestCount}/${PROMOTION_MAX_REQUESTS} ` +
          `in ${PROMOTION_WINDOW_HOURS}h window`
      );

      return NextResponse.json(
        {
          error: {
            code: PROMOTION_MODEL_LIMIT_REACHED,
            message:
              'Sign up for free to continue and explore 500 other models. ' +
              'Takes 2 minutes, no credit card required. Or come back later.',
          },
        },
        { status: 401 } // TODO: Change to 429 once the extension supports it (see kilocode errorUtils.ts)
      );
    }

    // Anonymous access for free model (already rate-limited above)
    user = createAnonymousContext(ipAddress);
    organizationId = undefined;
    botId = undefined;
    tokenSource = undefined;
  } else {
    user = maybeUser;
  }

  if (parsedRequest.kind === 'responses' && !user.is_admin) {
    return NextResponse.json(
      {
        error: {
          message: 'The Responses API is experimental and not yet available to all users.',
        },
      },
      { status: 403 }
    );
  }

  // Log to free_model_usage for rate limiting (at request start, before processing)
  if (isKiloFreeModel(originalModelIdLowerCased)) {
    await logFreeModelRequest(
      ipAddress,
      originalModelIdLowerCased,
      isAnonymousContext(user) ? undefined : user.id
    );
  }

  // Use new shared helper for fraud & project headers
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;
  const { provider, userByok, customLlm } = await getProvider(
    originalModelIdLowerCased,
    parsedRequest.body,
    user,
    organizationId,
    taskId
  );

  console.debug(`Routing request to ${provider.id}`);

  const isLegacyOpenRouterPath = url.pathname.includes('/openrouter');
  const feature = validateFeatureHeader(
    request.headers.get(FEATURE_HEADER) || (isLegacyOpenRouterPath ? '' : 'direct-gateway')
  );

  // Start abuse classification early (non-blocking) - we'll await it before creating usage context
  // TODO: abuse classification for Responses API
  const classifyPromise =
    parsedRequest.kind === 'chat_completions'
      ? classifyAbuse(request, parsedRequest.body, {
          kiloUserId: user.id,
          organizationId,
          projectId,
          provider: provider.id,
          isByok: !!userByok,
          feature,
        })
      : Promise.resolve(null);

  // Large responses may run longer than the 800s serverless function timeout.
  const requestMaxTokens =
    parsedRequest.kind === 'chat_completions'
      ? parsedRequest.body.max_tokens
      : parsedRequest.body.max_output_tokens;
  if (requestMaxTokens && requestMaxTokens > MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Max tokens limit exceeded: ${user.id}`, {
      maxTokens: requestMaxTokens,
      bodyText: requestBodyText,
    });
    return temporarilyUnavailableResponse();
  }

  if (isDeadFreeModel(originalModelIdLowerCased)) {
    console.warn(`User requested discontinued free model ${originalModelIdLowerCased}; rejecting.`);
    return alphaPeriodEndedResponse();
  }

  if (isRateLimitedToDeath(originalModelIdLowerCased)) {
    return modelDoesNotExistResponse();
  }

  // Extract properties for usage context
  const promptInfo: PromptInfo =
    parsedRequest.kind === 'chat_completions'
      ? extractPromptInfo(parsedRequest.body)
      : extractResponsesPromptInfo(parsedRequest.body);

  const usageContext: MicrodollarUsageContext = {
    kiloUserId: user.id,
    provider: provider.id,
    requested_model: originalModelIdLowerCased,
    promptInfo,
    max_tokens:
      parsedRequest.kind === 'chat_completions'
        ? (parsedRequest.body.max_tokens ?? null)
        : (parsedRequest.body.max_output_tokens ?? null),
    has_middle_out_transform:
      parsedRequest.kind === 'chat_completions'
        ? (parsedRequest.body.transforms?.includes('middle-out') ?? false)
        : false,
    fraudHeaders,
    isStreaming: parsedRequest.body.stream === true,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    user_byok: !!userByok,
    has_tools: (parsedRequest.body.tools?.length ?? 0) > 0,
    botId,
    tokenSource,
    feature,
    session_id: taskId ?? null,
    mode: modeHeader,
    auto_model: autoModel,
  };

  setTag('ui.ai_model', parsedRequest.body.model);

  // Skip balance/org checks for anonymous users - they can only use free models
  const bypassAccessCheckForCustomLlm =
    !!customLlm && !!organizationId && customLlm.organization_ids.includes(organizationId);
  if (!isAnonymousContext(user) && !bypassAccessCheckForCustomLlm) {
    const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user);

    if (
      balance <= 0 &&
      !isFreeModel(originalModelIdLowerCased) &&
      !userByok &&
      !isActiveReviewPromo(botId, originalModelIdLowerCased)
    ) {
      return await usageLimitExceededResponse(user, balance);
    }

    // Organization model/provider restrictions check
    // Model allow list only applies to Enterprise plans
    // Provider allow list applies to Enterprise plans; data collection applies to all plans
    const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
      modelId: originalModelIdLowerCased,
      settings,
      organizationPlan: plan,
    });
    if (modelRestrictionError) return modelRestrictionError;

    if (providerConfig) {
      parsedRequest.body.provider = providerConfig;
    }
  }

  sentryRootSpan()?.setAttribute(
    'openrouter.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const openrouterRequestSpan = startInactiveSpan({
    name: 'openrouter-request-start',
    op: 'http.client',
  });

  if (
    isDataCollectionRequiredOnKiloCodeOnly(originalModelIdLowerCased) &&
    !isFreePromptTrainingAllowed(parsedRequest.body.provider)
  ) {
    return dataCollectionRequiredResponse();
  }

  if (taskId) {
    parsedRequest.body.prompt_cache_key = generateProviderSpecificHash(user.id + taskId, provider);
  }
  parsedRequest.body.safety_identifier = generateProviderSpecificHash(user.id, provider);
  parsedRequest.body.user = parsedRequest.body.safety_identifier; // deprecated, but this is what OpenRouter uses

  if (parsedRequest.kind === 'chat_completions') {
    if (ENABLE_TOOL_REPAIR) {
      repairTools(parsedRequest.body);
    }

    if (isOpenCodeBasedClient(fraudHeaders)) {
      fixOpenCodeDuplicateReasoning(originalModelIdLowerCased, parsedRequest.body, taskId);
    }
  }

  // TODO Responses API
  const toolsAvailable =
    parsedRequest.kind === 'chat_completions' ? getToolsAvailable(parsedRequest.body.tools) : [];
  const toolsUsed =
    parsedRequest.kind === 'chat_completions' ? getToolsUsed(parsedRequest.body.messages) : [];

  const extraHeaders: Record<string, string> = {};
  applyProviderSpecificLogic(
    provider,
    originalModelIdLowerCased,
    parsedRequest,
    extraHeaders,
    userByok
  );

  let response: Response;
  if (customLlm) {
    if (parsedRequest.kind === 'responses') {
      return NextResponse.json(
        { error: 'This model is not yet available on the Responses API' },
        { status: 404 }
      );
    }
    response = await customLlmRequest(
      customLlm,
      parsedRequest.body,
      isRooCodeBasedClient(fraudHeaders)
    );
  } else {
    response = await openRouterRequest({
      path,
      search: url.search,
      method: request.method,
      body: parsedRequest.body,
      extraHeaders,
      provider,
      signal: request.signal,
    });
  }
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: parsedRequest.body.stream === true,
      userByok: !!userByok,
      mode: modeHeader || undefined,
      provider: provider.id,
      requestedModel: requestedModelLowerCased,
      resolvedModel: normalizeModelId(originalModelIdLowerCased),
      toolsAvailable,
      toolsUsed,
      ttfbMs,
      statusCode: response.status,
    },
    response.clone(),
    requestStartedAt
  );
  usageContext.status_code = response.status;

  // Handle OpenRouter 402 errors - don't pass them through to the client. We need to pay, not them.
  // Skip this conversion when user BYOK is used - the 402 is about their account, not ours.
  if (response.status === 402 && !userByok) {
    await captureProxyError({
      user,
      request: parsedRequest.body,
      response,
      organizationId,
      model: originalModelIdLowerCased,
      errorMessage: `${provider.id} returned 402 Payment Required`,
      trackInSentry: true,
    });

    // Return a service unavailable error instead of the 402
    return temporarilyUnavailableResponse();
  }

  if (response.status >= 400) {
    await captureProxyError({
      user,
      request: parsedRequest.body,
      response,
      organizationId,
      model: originalModelIdLowerCased,
      errorMessage: `${provider.id} returned error ${response.status}`,
      trackInSentry: response.status >= 500,
    });
  }

  const clonedReponse = response.clone(); // reading from body is side-effectful

  // Await abuse classification (with timeout) to get request_id for cost tracking correlation
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const classifyResult = await Promise.race([
    classifyPromise.finally(() => timeoutId && clearTimeout(timeoutId)),
    new Promise<null>(resolve => {
      timeoutId = setTimeout(() => resolve(null), 2000);
    }),
  ]);
  if (classifyResult) {
    console.log('Abuse classification result:', {
      verdict: classifyResult.verdict,
      risk_score: classifyResult.risk_score,
      signals: classifyResult.signals,
      identity_key: classifyResult.context.identity_key,
      kilo_user_id: user.id,
      requested_model: originalModelIdLowerCased,
      rps: classifyResult.context.requests_per_second,
      request_id: classifyResult.request_id,
    });
    usageContext.abuse_request_id = classifyResult.request_id;
  }

  accountForMicrodollarUsage(clonedReponse, usageContext, openrouterRequestSpan);

  handleRequestLogging({
    clonedResponse: response.clone(),
    user: maybeUser,
    organization_id: organizationId || null,
    provider: provider.id,
    model: originalModelIdLowerCased,
    request: parsedRequest,
  });

  {
    const errorResponse = await makeErrorReadable({
      requestedModel: originalModelIdLowerCased,
      request: parsedRequest,
      response,
      isUserByok: !!userByok,
    });
    if (errorResponse) {
      return errorResponse;
    }
  }

  // rewriteFreeModelResponse only handles Chat Completions format responses.
  if (
    parsedRequest.kind === 'chat_completions' &&
    provider.id !== 'custom' &&
    (isKiloFreeModel(originalModelIdLowerCased) ||
      isActiveReviewPromo(botId, originalModelIdLowerCased))
  ) {
    return rewriteFreeModelResponse(response, originalModelIdLowerCased);
  }

  return wrapInSafeNextResponse(response);
}
