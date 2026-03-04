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
import { isKiloFreeModel } from './models';
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

// Free model definitions — gateway field maps to a PROVIDERS key
type KiloFreeModelWithGateway = {
  public_id: string;
  internal_id: string;
  display_name: string;
  context_length: number;
  max_completion_tokens: number;
  is_enabled: boolean;
  flags: string[];
  gateway: string;
  inference_providers: string[];
};

const kiloFreeModelsWithGateway: KiloFreeModelWithGateway[] = [
  {
    public_id: 'corethink:free',
    internal_id: 'corethink',
    display_name: 'CoreThink (free)',
    context_length: 78_000,
    max_completion_tokens: 8192,
    is_enabled: true,
    flags: [],
    gateway: 'CORETHINK',
    inference_providers: ['corethink'],
  },
  {
    public_id: 'giga-potato',
    internal_id: 'ep-20260109111813-hztxv',
    display_name: 'Giga Potato (free)',
    context_length: 256_000,
    max_completion_tokens: 32_000,
    is_enabled: true,
    flags: ['prompt_cache', 'vision'],
    gateway: 'GIGAPOTATO',
    inference_providers: ['stealth'],
  },
  {
    public_id: 'giga-potato-thinking',
    internal_id: 'ep-20260109111813-hztxv',
    display_name: 'Giga Potato Thinking (free)',
    context_length: 256_000,
    max_completion_tokens: 32_000,
    is_enabled: true,
    flags: ['prompt_cache', 'vision', 'reasoning'],
    gateway: 'GIGAPOTATO',
    inference_providers: ['stealth'],
  },
  {
    public_id: 'moonshotai/kimi-k2.5:free',
    internal_id: 'moonshotai/kimi-k2.5',
    display_name: 'MoonshotAI: Kimi K2.5 (free)',
    context_length: 262144,
    max_completion_tokens: 65536,
    is_enabled: true,
    flags: ['reasoning', 'prompt_cache', 'vision'],
    gateway: 'OPENROUTER',
    inference_providers: [],
  },
  {
    public_id: 'minimax/minimax-m2.5:free',
    internal_id: 'minimax/minimax-m2.5',
    display_name: 'MiniMax M2.5 (free)',
    context_length: 204_800,
    max_completion_tokens: 40960,
    is_enabled: true,
    flags: ['reasoning', 'prompt_cache', 'vision'],
    gateway: 'OPENROUTER',
    inference_providers: [],
  },
  {
    public_id: 'x-ai/grok-code-fast-1:optimized:free',
    internal_id: 'x-ai/grok-code-fast-1:optimized',
    display_name: 'xAI: Grok Code Fast 1 Optimized (experimental, free)',
    context_length: 256_000,
    max_completion_tokens: 10_000,
    is_enabled: false,
    flags: ['reasoning', 'prompt_cache'],
    gateway: 'MARTIAN',
    inference_providers: ['stealth'],
  },
  {
    public_id: 'z-ai/glm-5:free',
    internal_id: 'z-ai/glm-5',
    display_name: 'Z.ai: GLM 5 (free)',
    context_length: 202800,
    max_completion_tokens: 131072,
    is_enabled: false,
    flags: ['reasoning', 'prompt_cache'],
    gateway: 'OPENROUTER',
    inference_providers: [],
  },
];

export function getKiloFreeModelWithGateway(
  publicId: string
): KiloFreeModelWithGateway | undefined {
  return kiloFreeModelsWithGateway.find(m => m.public_id === publicId);
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
            hasGenerationEndpoint: true,
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
          verbosity: null,
          provider: 'openai', // xai doesn't support preserved reasoning
          organization_ids: [],
          base_url: gatewayProvider.apiUrl,
          api_key: gatewayProvider.apiKey,
          reasoning_effort: null,
          included_tools: null,
          excluded_tools: null,
          supports_image_input: kiloFreeModel.flags.includes('vision'),
          force_reasoning: true,
          opencode_settings: null,
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

export { isKiloFreeModel };
