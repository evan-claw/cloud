// Provider routing — port of src/lib/providers/index.ts.
// API keys come from Secrets Store bindings (resolved asynchronously at request time).

import type { WorkerDb } from '@kilocode/db/client';
import { custom_llm, organization_memberships } from '@kilocode/db/schema';
import type { CustomLlm } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db';
import type { BYOKResult } from './byok';
import { getModelUserByokProviders, getBYOKforUser, getBYOKforOrganization } from './byok';
import type { OpenRouterChatCompletionRequest } from '../types/request';
import type { AnonymousUserContext } from './anonymous';
import { isAnonymousContext } from './anonymous';
import { isKiloFreeModel, kiloFreeModelMap, type KiloFreeModel } from './models';
import { shouldRouteToVercel } from './vercel-routing';

export type ProviderId =
  | 'openrouter'
  | 'gigapotato'
  | 'corethink'
  | 'martian'
  | 'mistral'
  | 'vercel'
  | 'custom';

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
  hasGenerationEndpoint: boolean;
};

// Resolved secrets bundle — fetched once per request via Promise.all()
export type SecretsBundle = {
  openrouterApiKey: string;
  gigapotatoApiKey: string;
  gigapotatoApiUrl: string;
  corethinkApiKey: string;
  martianApiKey: string;
  mistralApiKey: string;
  vercelAiGatewayApiKey: string;
  byokEncryptionKey: string;
};

export function buildProviders(secrets: SecretsBundle): Record<string, Provider> {
  return {
    OPENROUTER: {
      id: 'openrouter',
      apiUrl: 'https://openrouter.ai/api/v1',
      apiKey: secrets.openrouterApiKey,
      hasGenerationEndpoint: true,
    },
    GIGAPOTATO: {
      id: 'gigapotato',
      apiUrl: secrets.gigapotatoApiUrl,
      apiKey: secrets.gigapotatoApiKey,
      hasGenerationEndpoint: false,
    },
    CORETHINK: {
      id: 'corethink',
      apiUrl: 'https://api.corethink.ai/v1/code',
      apiKey: secrets.corethinkApiKey,
      hasGenerationEndpoint: false,
    },
    MARTIAN: {
      id: 'martian',
      apiUrl: 'https://api.withmartian.com/v1',
      apiKey: secrets.martianApiKey,
      hasGenerationEndpoint: false,
    },
    MISTRAL: {
      id: 'mistral',
      apiUrl: 'https://api.mistral.ai/v1',
      apiKey: secrets.mistralApiKey,
      hasGenerationEndpoint: false,
    },
    VERCEL_AI_GATEWAY: {
      id: 'vercel',
      apiUrl: 'https://ai-gateway.vercel.sh/v1',
      apiKey: secrets.vercelAiGatewayApiKey,
      hasGenerationEndpoint: true,
    },
  };
}

export function getKiloFreeModelWithGateway(publicId: string): KiloFreeModel | undefined {
  return kiloFreeModelMap.get(publicId);
}

export type ProviderResolutionResult = {
  provider: Provider;
  userByok: BYOKResult[] | null;
  customLlm: CustomLlm | null;
};

export async function getProvider(
  db: WorkerDb,
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  secrets: SecretsBundle,
  randomSeed: string
): Promise<ProviderResolutionResult> {
  const providers = buildProviders(secrets);

  // 1. BYOK check (authenticated users only)
  if (!isAnonymousContext(user)) {
    const modelProviders = await getModelUserByokProviders(db, requestedModel);
    if (modelProviders.length > 0) {
      const userByok = organizationId
        ? await getBYOKforOrganization(
            db,
            organizationId,
            modelProviders,
            secrets.byokEncryptionKey
          )
        : await getBYOKforUser(db, user.id, modelProviders, secrets.byokEncryptionKey);
      if (userByok) {
        return { provider: providers.VERCEL_AI_GATEWAY, userByok, customLlm: null };
      }
    }
  }

  // 2. Custom LLM check (kilo-internal/ prefix + organizationId + membership)
  if (requestedModel.startsWith('kilo-internal/') && organizationId && !isAnonymousContext(user)) {
    const [customLlmRow] = await db
      .select()
      .from(custom_llm)
      .where(eq(custom_llm.public_id, requestedModel));
    if (customLlmRow && customLlmRow.organization_ids.includes(organizationId)) {
      // Verify the user actually belongs to this organization — the organizationId
      // comes from a client-supplied header and is not otherwise validated.
      const [membership] = await db
        .select({ id: organization_memberships.id })
        .from(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, organizationId),
            eq(organization_memberships.kilo_user_id, user.id)
          )
        )
        .limit(1);
      if (membership) {
        return {
          provider: {
            id: 'custom',
            apiUrl: customLlmRow.base_url,
            apiKey: customLlmRow.api_key,
            hasGenerationEndpoint: false,
          },
          userByok: null,
          customLlm: customLlmRow,
        };
      }
    }
  }

  // 3. Vercel AI Gateway A/B routing (non-BYOK, non-custom-LLM)
  if (await shouldRouteToVercel(db, requestedModel, request, randomSeed)) {
    return { provider: providers.VERCEL_AI_GATEWAY, userByok: null, customLlm: null };
  }

  // 4. Kilo free model with Martian gateway → wrap as custom provider
  const kiloFreeModel = getKiloFreeModelWithGateway(requestedModel);
  if (kiloFreeModel?.is_enabled) {
    const gatewayProvider = providers[kiloFreeModel.gateway];
    if (gatewayProvider?.id === 'martian') {
      return {
        provider: { ...gatewayProvider, id: 'custom' },
        userByok: null,
        customLlm: {
          public_id: kiloFreeModel.public_id,
          internal_id: kiloFreeModel.internal_id,
          display_name: kiloFreeModel.display_name,
          context_length: kiloFreeModel.context_length,
          max_completion_tokens: kiloFreeModel.max_completion_tokens,
          provider: 'openai', // xai doesn't support preserved reasoning
          organization_ids: [],
          base_url: gatewayProvider.apiUrl,
          api_key: gatewayProvider.apiKey,
          included_tools: null,
          excluded_tools: null,
          supports_image_input: kiloFreeModel.flags.includes('vision'),
          force_reasoning: true,
          opencode_settings: null,
          extra_body: null,
        },
      };
    }

    if (gatewayProvider) {
      return { provider: gatewayProvider, userByok: null, customLlm: null };
    }
  }

  // 5. Default to OpenRouter
  return { provider: providers.OPENROUTER, userByok: null, customLlm: null };
}

// Preferred provider ordering for OpenRouter inference routing
export function getPreferredProviderOrder(requestedModel: string): string[] {
  if (requestedModel.startsWith('anthropic/')) {
    return ['amazon-bedrock', 'anthropic'];
  }
  if (requestedModel.startsWith('minimax/')) return ['minimax'];
  if (requestedModel.startsWith('mistralai/')) return ['mistral'];
  if (requestedModel.startsWith('moonshotai/')) return ['moonshotai'];
  if (requestedModel.startsWith('z-ai/')) return ['z-ai'];
  return [];
}

// Build a providerId → apiKey map once so callers don't need to rebuild the
// full providers object for each message in a queue batch.
export function buildProviderApiKeyMap(secrets: SecretsBundle): Map<string, string> {
  const providers = buildProviders(secrets);
  return new Map(Object.values(providers).map(p => [p.id, p.apiKey]));
}

export { isKiloFreeModel };
