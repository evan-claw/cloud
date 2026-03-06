import 'server-only';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { bot_requests, type BotRequestStatus, type BotRequestStep } from '@kilocode/db/schema';

type CreateBotRequestParams = {
  createdBy: string;
  organizationId: string | null;
  platformIntegrationId: string;
  platform: string;
  platformThreadId: string;
  platformMessageId: string | undefined;
  userMessage: string;
  modelUsed: string | undefined;
};

/**
 * Insert a pending bot_requests row at the start of message handling.
 * Returns the row ID on success, or undefined if the insert fails
 * (logging should never break the main flow).
 */
export async function createBotRequest(
  params: CreateBotRequestParams
): Promise<string | undefined> {
  try {
    const [row] = await db
      .insert(bot_requests)
      .values({
        created_by: params.createdBy,
        organization_id: params.organizationId,
        platform_integration_id: params.platformIntegrationId,
        platform: params.platform,
        platform_thread_id: params.platformThreadId,
        platform_message_id: params.platformMessageId ?? null,
        user_message: params.userMessage,
        model_used: params.modelUsed ?? null,
        status: 'pending',
      })
      .returning({ id: bot_requests.id });

    return row?.id;
  } catch (error) {
    console.error('[Bot:RequestLog] Failed to create request log:', error);
    return undefined;
  }
}

type UpdateBotRequestParams = {
  status?: BotRequestStatus;
  errorMessage?: string;
  modelUsed?: string;
  steps?: BotRequestStep[];
  cloudAgentSessionId?: string;
  responseTimeMs?: number;
};

/**
 * Update an existing bot_requests row. Called as processing progresses
 * and on completion/error. Silently catches errors to avoid disrupting
 * the main flow.
 */
export async function updateBotRequest(id: string, params: UpdateBotRequestParams): Promise<void> {
  try {
    await db
      .update(bot_requests)
      .set({
        ...(params.status !== undefined && { status: params.status }),
        ...(params.errorMessage !== undefined && { error_message: params.errorMessage }),
        ...(params.modelUsed !== undefined && { model_used: params.modelUsed }),
        ...(params.steps !== undefined && { steps: params.steps }),
        ...(params.cloudAgentSessionId !== undefined && {
          cloud_agent_session_id: params.cloudAgentSessionId,
        }),
        ...(params.responseTimeMs !== undefined && { response_time_ms: params.responseTimeMs }),
      })
      .where(eq(bot_requests.id, id));
  } catch (error) {
    console.error('[Bot:RequestLog] Failed to update request log:', error);
  }
}
