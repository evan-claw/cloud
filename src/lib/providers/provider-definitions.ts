import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/providers/types';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    hasGenerationEndpoint: true,
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
    hasGenerationEndpoint: false,
  },
  GIGAPOTATO: {
    id: 'gigapotato',
    apiUrl: getEnvVariable('GIGAPOTATO_API_URL'),
    apiKey: getEnvVariable('GIGAPOTATO_API_KEY'),
    hasGenerationEndpoint: false,
  },
  CORETHINK: {
    id: 'corethink',
    apiUrl: 'https://api.corethink.ai/v1/code',
    apiKey: getEnvVariable('CORETHINK_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MORPH: {
    id: 'morph',
    apiUrl: 'https://api.morphllm.com/v1',
    apiKey: getEnvVariable('MORPH_API_KEY'),
    hasGenerationEndpoint: false,
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    hasGenerationEndpoint: true,
  },
} as const satisfies Record<string, Provider>;
