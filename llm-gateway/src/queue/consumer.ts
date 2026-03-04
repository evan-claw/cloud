import { getWorkerDb } from '@kilocode/db/client';
import {
  processUsageAccountingAfterParse,
  type MicrodollarUsageContext,
} from '../background/usage-accounting';
import { sendApiMetrics } from '../background/api-metrics';
import { reportAbuseCost, type AbuseServiceSecrets } from '../lib/abuse-service';
import { buildProviders, type SecretsBundle } from '../lib/providers';
import { getIdempotencyDO } from '../dos/IdempotencyDO';
import type { BackgroundTaskMessage, UsageAccountingMessage } from './messages';
import type { Env } from '../env';

async function resolveAbuseSecrets(
  env: Env
): Promise<{ url: string; secrets: AbuseServiceSecrets | undefined }> {
  const [url, cfAccessClientId, cfAccessClientSecret] = await Promise.all([
    env.ABUSE_SERVICE_URL.get(),
    env.ABUSE_CF_ACCESS_CLIENT_ID.get(),
    env.ABUSE_CF_ACCESS_CLIENT_SECRET.get(),
  ]);
  return {
    url,
    secrets:
      cfAccessClientId && cfAccessClientSecret
        ? { cfAccessClientId, cfAccessClientSecret }
        : undefined,
  };
}

async function resolveSecrets(env: Env): Promise<SecretsBundle> {
  const [
    openrouterApiKey,
    gigapotatoApiKey,
    gigapotatoApiUrl,
    corethinkApiKey,
    martianApiKey,
    mistralApiKey,
    vercelAiGatewayApiKey,
    byokEncryptionKey,
  ] = await Promise.all([
    env.OPENROUTER_API_KEY.get(),
    env.GIGAPOTATO_API_KEY.get(),
    env.GIGAPOTATO_API_URL.get(),
    env.CORETHINK_API_KEY.get(),
    env.MARTIAN_API_KEY.get(),
    env.MISTRAL_API_KEY.get(),
    env.VERCEL_AI_GATEWAY_API_KEY.get(),
    env.BYOK_ENCRYPTION_KEY.get(),
  ]);
  return {
    openrouterApiKey,
    gigapotatoApiKey,
    gigapotatoApiUrl,
    corethinkApiKey,
    martianApiKey,
    mistralApiKey,
    vercelAiGatewayApiKey,
    byokEncryptionKey,
  };
}

function resolveProviderApiKey(secrets: SecretsBundle, providerId: string): string | undefined {
  const providers = buildProviders(secrets);
  for (const provider of Object.values(providers)) {
    if (provider.id === providerId) return provider.apiKey;
  }
  return undefined;
}

interface ResolvedSecrets {
  secrets: SecretsBundle;
  abuse: { url: string; secrets: AbuseServiceSecrets | undefined };
}

async function processUsageAccounting(
  msg: UsageAccountingMessage,
  env: Env,
  resolved: ResolvedSecrets
): Promise<void> {
  const providerApiKey = resolveProviderApiKey(resolved.secrets, msg.providerId);
  if (providerApiKey === undefined) {
    console.warn('[queue] No API key found for provider', { providerId: msg.providerId });
  }

  // Re-hydrate the full MicrodollarUsageContext with the provider API key
  const usageContext: MicrodollarUsageContext = {
    ...msg.usageContext,
    providerApiKey: providerApiKey ?? '',
  };

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);

  const usageStats = await processUsageAccountingAfterParse(msg.usageStats, usageContext, db);

  // Abuse cost reporting chains on the usage accounting result
  if (msg.abuseRequestId && usageStats.messageId) {
    try {
      await reportAbuseCost(
        resolved.abuse.url,
        resolved.abuse.secrets,
        {
          kiloUserId: msg.kiloUserId,
          fraudHeaders: msg.fraudHeaders,
          requested_model: msg.requested_model,
          abuse_request_id: msg.abuseRequestId,
        },
        {
          messageId: usageStats.messageId,
          cost_mUsd: usageStats.market_cost ?? usageStats.cost_mUsd,
          inputTokens: usageStats.inputTokens,
          outputTokens: usageStats.outputTokens,
          cacheWriteTokens: usageStats.cacheWriteTokens,
          cacheHitTokens: usageStats.cacheHitTokens,
        }
      );
    } catch (err) {
      console.error('[queue] Abuse cost report failed', err);
    }
  }
}

async function processApiMetrics(
  params: BackgroundTaskMessage & { type: 'api-metrics' },
  env: Env
): Promise<void> {
  await sendApiMetrics(env.O11Y, params.params);
}

export async function handleBackgroundTaskQueue(
  batch: MessageBatch<BackgroundTaskMessage>,
  env: Env
): Promise<void> {
  let resolved: ResolvedSecrets | undefined;

  for (const message of batch.messages) {
    try {
      const stub = getIdempotencyDO(env, message.body.idempotencyKey);
      const status = await stub.claim();
      if (status === 'completed') {
        message.ack();
        continue;
      }
      if (status === 'processing') {
        // Another worker is processing this message. Retry after the DO
        // stale-claim alarm fires (60s) so it can either complete or reset.
        message.retry({ delaySeconds: 60 });
        continue;
      }

      switch (message.body.type) {
        case 'usage-accounting':
          resolved ??= {
            secrets: await resolveSecrets(env),
            abuse: await resolveAbuseSecrets(env),
          };
          await processUsageAccounting(message.body, env, resolved);
          break;
        case 'api-metrics':
          await processApiMetrics(message.body, env);
          break;
      }

      await stub.complete();
      message.ack();
    } catch (err) {
      console.error(`[queue] Failed to process ${message.body.type}`, err);
      message.retry();
    }
  }
}
