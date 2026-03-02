// Background task: insert api_request_log for Kilo employees.
// Port of src/lib/handleRequestLogging.ts — uses WorkerDb instead of the global db.

import type { WorkerDb } from '@kilocode/db/client';
import { api_request_log } from '@kilocode/db/schema';
import type { OpenRouterChatCompletionRequest } from '../types/request';

// Kilo organization ID — matches src/lib/organizations/constants.ts
const KILO_ORGANIZATION_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

type RequestLoggingUser = {
  id?: string;
  google_user_email?: string;
};

function isKiloEmployee(
  user: RequestLoggingUser | null | undefined,
  organizationId: string | null | undefined
): boolean {
  return (
    user?.google_user_email?.endsWith('@kilo.ai') === true ||
    user?.google_user_email?.endsWith('@kilocode.ai') === true ||
    organizationId === KILO_ORGANIZATION_ID
  );
}

export async function runRequestLogging(params: {
  db: WorkerDb;
  responseStream: ReadableStream;
  statusCode: number;
  user: RequestLoggingUser | null;
  organizationId: string | null | undefined;
  provider: string;
  model: string;
  request: OpenRouterChatCompletionRequest;
}): Promise<void> {
  const { db, responseStream, statusCode, user, organizationId, provider, model, request } = params;

  if (!isKiloEmployee(user, organizationId)) return;

  try {
    const responseText = await new Response(responseStream).text();
    const rows = await db
      .insert(api_request_log)
      .values({
        kilo_user_id: user?.id,
        organization_id: organizationId ?? null,
        status_code: statusCode,
        model,
        provider,
        request,
        response: responseText,
      })
      .returning({ id: api_request_log.id });
    console.log('[request-logging] Inserted api_request_log', rows[0]?.id);
  } catch (err) {
    console.error('[request-logging] Failed to insert api_request_log', err);
  }
}
