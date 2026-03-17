import { api_request_log, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { after } from 'next/server';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import { isKiloAffiliatedUser } from '@/lib/isKiloAffiliatedUser';

export function handleRequestLogging(params: {
  clonedResponse: Response;
  user: User | null;
  organization_id: string | null;
  provider: string;
  model: string;
  request: GatewayRequest;
}) {
  const { clonedResponse, user, organization_id, provider, model, request } = params;
  if (!isKiloAffiliatedUser(user, organization_id)) {
    return;
  }
  after(async () => {
    try {
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id: organization_id,
          status_code: clonedResponse.status,
          model,
          provider,
          request: request.body,
          response: await clonedResponse.text(),
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[handleRequestLogging] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      logExceptInTest('[handleRequestLogging] Failed to insert api_request_log', e);
    }
  });
}
