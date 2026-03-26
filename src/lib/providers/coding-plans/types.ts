import type { DirectUserByokInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';
import type { SharedGatewayRequestProperties } from '@/lib/providers/openrouter/types';
import type { CustomLlmProvider } from '@kilocode/db';

export type CodingPlanModelFlag = 'recommended' | 'vision';

export type CodingPlanModel = {
  id: string;
  name: string;
  flags: ReadonlyArray<CodingPlanModelFlag>;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  extra_body: Partial<SharedGatewayRequestProperties>;
};

export type CodingPlanProvider = {
  id: DirectUserByokInferenceProviderId;
  name: string;
  base_url: string;
  models: ReadonlyArray<CodingPlanModel>;
  ai_sdk_provider: CustomLlmProvider;
};
