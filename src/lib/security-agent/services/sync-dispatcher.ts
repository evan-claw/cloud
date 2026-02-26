import 'server-only';

import { createHmac, randomUUID } from 'node:crypto';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { agent_configs } from '@/db/schema';
import { db } from '@/lib/drizzle';
import {
  SECURITY_SYNC_WORKER_AUTH_TOKEN,
  SECURITY_SYNC_WORKER_HMAC_SECRET,
  SECURITY_SYNC_WORKER_URL,
} from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('security-agent:sync-dispatcher', 'info');

export type SecuritySyncOwner = {
  owner: { organizationId?: string; userId?: string };
  ownerKey: string;
};

type WorkerDispatchResponse = {
  success: boolean;
  runId: string;
  ownerCount: number;
  enqueuedMessages: number;
};

export async function getEnabledSecuritySyncOwners(): Promise<SecuritySyncOwner[]> {
  const configs = await db
    .select({
      organizationId: agent_configs.owned_by_organization_id,
      userId: agent_configs.owned_by_user_id,
    })
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.is_enabled, true),
        or(
          isNotNull(agent_configs.owned_by_organization_id),
          isNotNull(agent_configs.owned_by_user_id)
        )
      )
    );

  const ownersByKey = new Map<string, SecuritySyncOwner>();

  for (const config of configs) {
    if (config.organizationId) {
      const ownerKey = `org:${config.organizationId}`;
      ownersByKey.set(ownerKey, {
        owner: { organizationId: config.organizationId },
        ownerKey,
      });
      continue;
    }

    if (config.userId) {
      const ownerKey = `user:${config.userId}`;
      ownersByKey.set(ownerKey, {
        owner: { userId: config.userId },
        ownerKey,
      });
    }
  }

  return Array.from(ownersByKey.values());
}

function buildDispatchSignature(timestamp: string, rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `sha256=${digest}`;
}

export async function dispatchSecuritySyncToWorker(params: {
  runId?: string;
  owners: SecuritySyncOwner[];
}): Promise<WorkerDispatchResponse> {
  if (
    !SECURITY_SYNC_WORKER_URL ||
    !SECURITY_SYNC_WORKER_AUTH_TOKEN ||
    !SECURITY_SYNC_WORKER_HMAC_SECRET
  ) {
    throw new Error(
      'SECURITY_SYNC_WORKER_URL, SECURITY_SYNC_WORKER_AUTH_TOKEN, or SECURITY_SYNC_WORKER_HMAC_SECRET not configured'
    );
  }

  const runId = params.runId ?? randomUUID();
  const dispatchedAt = new Date().toISOString();

  const payload = {
    schemaVersion: 1,
    runId,
    dispatchedAt,
    owners: params.owners,
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildDispatchSignature(timestamp, rawBody, SECURITY_SYNC_WORKER_HMAC_SECRET);

  const response = await fetch(`${SECURITY_SYNC_WORKER_URL.replace(/\/$/, '')}/dispatch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECURITY_SYNC_WORKER_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Security-Sync-Timestamp': timestamp,
      'X-Security-Sync-Signature': signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Security sync worker dispatch failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as WorkerDispatchResponse;

  log('Dispatched security sync owners to worker', {
    runId,
    ownerCount: result.ownerCount,
    enqueuedMessages: result.enqueuedMessages,
  });

  return result;
}
