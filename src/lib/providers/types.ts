export type ProviderId =
  | 'openrouter'
  | 'alibaba'
  | 'bytedance'
  | 'corethink'
  | 'martian'
  | 'mistral'
  | 'morph'
  | 'vercel'
  | 'custom'
  | 'dev-tools';

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
};
