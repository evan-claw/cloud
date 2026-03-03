// Request transformation — the final mutation pass before the upstream fetch.
//
// Sets:
//   1. requestBody.safety_identifier + requestBody.user (provider-specific SHA-256 hash)
//   2. requestBody.prompt_cache_key (if taskId header present)
//   3. Repairs malformed tool schemas (ENABLE_TOOL_REPAIR flag)
//   4. Applies provider-specific mutations (Anthropic, xAI, Mistral, etc.)
//
// Also extracts per-request header values and stores them on context for
// background tasks in Phase 6 (fraudHeaders, projectId, taskId, etc.).

import type { MiddlewareHandler } from 'hono';
import type { HonoContext } from '../types/hono';
import { generateProviderSpecificHash } from '../lib/provider-hash';
import { ENABLE_TOOL_REPAIR, repairTools } from '../lib/tool-calling';
import { applyProviderSpecificLogic } from '../lib/provider-specific';
import { extractProjectHeaders } from '../lib/extract-headers';

export const requestTransformMiddleware: MiddlewareHandler<HonoContext> = async (c, next) => {
  const requestBody = c.get('requestBody');
  const provider = c.get('provider');
  const user = c.get('user');
  const userByok = c.get('userByok');

  // Extract per-request headers (stored for Phase 6 background tasks)
  const projectHeaders = extractProjectHeaders(c.req.raw.headers);
  c.set('fraudHeaders', projectHeaders.fraudHeaders);
  c.set('projectId', projectHeaders.projectId);
  c.set('taskId', projectHeaders.taskId);
  c.set('editorName', projectHeaders.editorName);
  c.set('machineId', projectHeaders.machineId);
  c.set('xKiloCodeVersion', projectHeaders.xKiloCodeVersion);
  c.set('numericKiloCodeVersion', projectHeaders.numericKiloCodeVersion);

  // safety_identifier — hash of userId, provider-specific salt
  const safetyIdentifier = await generateProviderSpecificHash(user.id, provider);
  requestBody.safety_identifier = safetyIdentifier;
  // Deprecated field still expected by OpenRouter
  requestBody.user = safetyIdentifier;

  // prompt_cache_key — hash of userId+taskId when a task session is present
  if (projectHeaders.taskId) {
    requestBody.prompt_cache_key = await generateProviderSpecificHash(
      user.id + projectHeaders.taskId,
      provider
    );
  }

  // Tool repair — fix malformed tool schemas before sending upstream
  if (ENABLE_TOOL_REPAIR) {
    repairTools(requestBody);
  }

  // Provider-specific mutations (Anthropic beta header, Mistral tool normalization, etc.)
  const extraHeaders: Record<string, string> = {};
  await applyProviderSpecificLogic(
    provider,
    c.get('resolvedModel'),
    requestBody,
    extraHeaders,
    userByok
  );
  c.set('extraHeaders', extraHeaders);

  await next();
};
