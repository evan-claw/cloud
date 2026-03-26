import type { CodingPlanProvider } from '@/lib/providers/coding-plans/types';

export default [
  {
    id: 'bytelabs-coding',
    name: 'ByteLabs Coding Plan',
    base_url: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    ai_sdk_provider: 'openai-compatible',
    models: [
      {
        id: 'bytedance-seed-code',
        name: 'Seed Code',
        description:
          "ByteDance's latest code model has been deeply optimized for agentic programming tasks.",
        context_length: 262144,
        max_completion_tokens: 32768,
        extra_body: {
          thinking: { type: 'enabled' },
        },
      },
    ],
  },
  {
    id: 'zai-coding',
    name: 'Z.ai Coding Plan',
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    ai_sdk_provider: 'openai-compatible',
    models: [
      {
        id: 'glm-5',
        name: 'GLM-5',
        description:
          'GLM-5 is Z.ai’s flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading closed-source models. With advanced agentic planning, deep backend reasoning, and iterative self-correction, GLM-5 moves beyond code generation to full-system construction and autonomous execution.',
        context_length: 202752,
        max_completion_tokens: 131072,
        extra_body: {
          thinking: { type: 'enabled' },
        },
      },
    ],
  },
] satisfies ReadonlyArray<CodingPlanProvider>;
