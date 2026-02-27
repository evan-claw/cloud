import * as z from 'zod';

// Base s for common data structures
export type OpenRouterIcon = z.infer<typeof OpenRouterIcon>;
export const OpenRouterIcon = z.object({
  url: z.string(),
  className: z.string().optional(),
});

export type OpenRouterDataPolicy = z.infer<typeof OpenRouterDataPolicy>;
export const OpenRouterDataPolicy = z.object({
  training: z.boolean(),
  retainsPrompts: z.boolean(),
  canPublish: z.boolean(),
  termsOfServiceURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  requiresUserIDs: z.boolean().optional(),
});

export type OpenRouterReasoningConfig = z.infer<typeof OpenRouterReasoningConfig>;
export const OpenRouterReasoningConfig = z.object({
  start_token: z.string().nullish(),
  end_token: z.string().nullish(),
  system_prompt: z.string().nullish(),
});

export type OpenRouterToolChoiceSupport = z.infer<typeof OpenRouterToolChoiceSupport>;
export const OpenRouterToolChoiceSupport = z.object({
  literal_none: z.boolean(),
  literal_auto: z.boolean(),
  literal_required: z.boolean(),
  type_function: z.boolean(),
});

export type OpenRouterSupportedParameters = z.infer<typeof OpenRouterSupportedParameters>;
export const OpenRouterSupportedParameters = z
  .object({
    response_format: z.boolean().optional(),
    structured_outputs: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type OpenRouterFeatures = z.infer<typeof OpenRouterFeatures>;
export const OpenRouterFeatures = z
  .object({
    reasoning_config: OpenRouterReasoningConfig.optional(),
    supports_implicit_caching: z.boolean().optional(),
    supports_file_urls: z.boolean().optional(),
    supports_input_audio: z.boolean().optional(),
    supports_tool_choice: OpenRouterToolChoiceSupport.optional(),
    supported_parameters: OpenRouterSupportedParameters.optional(),
  })
  .catchall(z.unknown());

export type OpenRouterPricing = z.infer<typeof OpenRouterPricing>;
export const OpenRouterPricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  image: z.string().optional(),
  request: z.string().optional(),
  web_search: z.string().optional(),
  internal_reasoning: z.string().optional(),
  image_output: z.string().optional(),
  discount: z.number(),
  input_cache_read: z.string().optional(),
});

export type OpenRouterProviderInfo = z.infer<typeof OpenRouterProviderInfo>;
export const OpenRouterProviderInfo = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string(),
  dataPolicy: OpenRouterDataPolicy,
  headquarters: z.string().optional(),
  hasChatCompletions: z.boolean(),
  hasCompletions: z.boolean(),
  isAbortable: z.boolean(),
  moderationRequired: z.boolean(),
  editors: z.array(z.string()),
  owners: z.array(z.string()),
  adapterName: z.string(),
  isMultipartSupported: z.boolean(),
  statusPageUrl: z.string().nullable(),
  byokEnabled: z.boolean(),
  icon: OpenRouterIcon.optional(),
  ignoredProviderModels: z.array(z.string()),
});

// Core model  (used both at top level and nested in endpoint)
export type OpenRouterBaseModel = z.infer<typeof OpenRouterBaseModel>;
export const OpenRouterBaseModel = z.object({
  slug: z.string(),
  hf_slug: z
    .string()
    .nullable()
    .transform(val => (val === '' ? null : val)),
  updated_at: z.string(),
  created_at: z.string(),
  hf_updated_at: z.string().nullable(),
  name: z.string(),
  short_name: z.string(),
  author: z.string(),
  description: z.string(),
  model_version_group_id: z.string().nullable(),
  context_length: z.number(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  has_text_output: z.boolean(),
  group: z.string(),
  instruct_type: z.string().nullable(),
  default_system: z.string().nullable(),
  default_stops: z.array(z.string()),
  hidden: z.boolean(),
  router: z.string().nullable(),
  warning_message: z
    .string()
    .nullable()
    .transform(val => (val === '' ? null : val)),
  permaslug: z.string(),
  reasoning_config: OpenRouterReasoningConfig.nullable(),
  features: OpenRouterFeatures.nullable(),
  default_parameters: z.record(z.string(), z.unknown()).nullable(),
});

export type OpenRouterEndpoint = z.infer<typeof OpenRouterEndpoint>;
export const OpenRouterEndpoint = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number(),
  model: OpenRouterBaseModel,
  model_variant_slug: z.string(),
  model_variant_permaslug: z.string(),
  adapter_name: z.string(),
  provider_name: z.string(),
  provider_info: OpenRouterProviderInfo,
  provider_display_name: z.string(),
  provider_slug: z.string(),
  provider_model_id: z.string(),
  quantization: z.string().nullable(),
  variant: z.string(),
  is_free: z.boolean(),
  can_abort: z.boolean(),
  max_prompt_tokens: z.number().nullable(),
  max_completion_tokens: z.number().nullable(),
  max_tokens_per_image: z.number().nullable(),
  supported_parameters: z.array(z.string()),
  is_byok: z.boolean(),
  moderation_required: z.boolean(),
  data_policy: OpenRouterDataPolicy,
  pricing: OpenRouterPricing,
  variable_pricings: z.array(z.unknown()),
  is_hidden: z.boolean(),
  is_deranked: z.boolean(),
  is_disabled: z.boolean(),
  supports_tool_parameters: z.boolean(),
  supports_reasoning: z.boolean(),
  supports_multipart: z.boolean(),
  limit_rpm: z.number().nullable(),
  limit_rpd: z.number().nullable(),
  limit_rpm_cf: z.number().nullable(),
  has_completions: z.boolean(),
  has_chat_completions: z.boolean(),
  features: OpenRouterFeatures.nullable(),
  provider_region: z.string().nullable(),
});

// Model  extends base model with endpoint
export type OpenRouterModel = z.infer<typeof OpenRouterModel>;
export const OpenRouterModel = OpenRouterBaseModel.extend({
  endpoint: OpenRouterEndpoint.nullable(),
});

// Analytics
export type OpenRouterAnalyticsEntry = z.infer<typeof OpenRouterAnalyticsEntry>;
export const OpenRouterAnalyticsEntry = z.object({
  date: z.string(),
  model_permaslug: z.string(),
  variant: z.string(),
  variant_permaslug: z.string(),
  count: z.number(),
  total_completion_tokens: z.number(),
  total_prompt_tokens: z.number(),
  total_native_tokens_reasoning: z.number(),
  num_media_prompt: z.number(),
  num_media_completion: z.number(),
  total_native_tokens_cached: z.number(),
  total_tool_calls: z.number(),
});

export type OpenRouterAnalytics = z.infer<typeof OpenRouterAnalytics>;
export const OpenRouterAnalytics = z.record(z.string(), OpenRouterAnalyticsEntry);

// Categories
export type OpenRouterCategoryEntry = z.infer<typeof OpenRouterCategoryEntry>;
export const OpenRouterCategoryEntry = z.object({
  id: z.number().optional(),
  date: z.string(),
  model: z.string(),
  category: z.string(),
  count: z.number(),
  total_prompt_tokens: z.number(),
  total_completion_tokens: z.number(),
  volume: z.number(),
  rank: z.number(),
});

export type OpenRouterCategories = z.infer<typeof OpenRouterCategories>;
export const OpenRouterCategories = z.record(z.string(), z.array(OpenRouterCategoryEntry));

// Main response
export type OpenRouterSearchResponse = z.infer<typeof OpenRouterSearchResponse>;
export const OpenRouterSearchResponse = z.object({
  data: z.object({
    models: z.array(OpenRouterModel),
    analytics: OpenRouterAnalytics,
    categories: OpenRouterCategories,
  }),
});

// Types for the new frontend providers endpoint
export type OpenRouterProvider = z.infer<typeof OpenRouterProvider>;
export const OpenRouterProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    trainingOpenRouter: z.boolean().optional(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
    termsOfServiceURL: z.string().optional(),
    privacyPolicyURL: z.string().optional(),
    requiresUserIDs: z.boolean().optional(),
    retentionDays: z.number().optional(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  hasChatCompletions: z.boolean(),
  hasCompletions: z.boolean(),
  isAbortable: z.boolean(),
  moderationRequired: z.boolean(),
  editors: z.array(z.string()),
  owners: z.array(z.string()),
  adapterName: z.string(),
  isMultipartSupported: z.boolean(),
  statusPageUrl: z.string().nullable(),
  byokEnabled: z.boolean(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  ignoredProviderModels: z.array(z.string()),
});

export type OpenRouterProvidersResponse = z.infer<typeof OpenRouterProvidersResponse>;
export const OpenRouterProvidersResponse = z.union([
  z.object({
    data: z.array(OpenRouterProvider),
  }),
  z.array(OpenRouterProvider), // Handle direct array response
]);

// Types for normalized output format - simplified structure with providers containing models directly
export type NormalizedProvider = z.infer<typeof NormalizedProvider>;
export const NormalizedProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  models: z.array(OpenRouterModel),
});

export type NormalizedOpenRouterResponse = z.infer<typeof NormalizedOpenRouterResponse>;
export const NormalizedOpenRouterResponse = z.object({
  providers: z.array(NormalizedProvider),
  total_providers: z.number(),
  total_models: z.number(),
  generated_at: z.string(),
});
