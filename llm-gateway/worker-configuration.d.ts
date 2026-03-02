/* eslint-disable */
// Stub — replace by running `wrangler types` once bindings are provisioned.
declare namespace Cloudflare {
  interface GlobalProps {}
  interface Env {
    HYPERDRIVE: Hyperdrive;
    USER_EXISTS_CACHE: KVNamespace;
    RATE_LIMIT_KV: KVNamespace;
    // Secrets Store
    NEXTAUTH_SECRET_PROD: SecretsStoreSecret;
    OPENROUTER_API_KEY: SecretsStoreSecret;
    GIGAPOTATO_API_KEY: SecretsStoreSecret;
    CORETHINK_API_KEY: SecretsStoreSecret;
    MARTIAN_API_KEY: SecretsStoreSecret;
    MISTRAL_API_KEY: SecretsStoreSecret;
    VERCEL_AI_GATEWAY_API_KEY: SecretsStoreSecret;
    BYOK_ENCRYPTION_KEY: SecretsStoreSecret;
    // Abuse service secrets
    ABUSE_CF_ACCESS_CLIENT_ID: SecretsStoreSecret;
    ABUSE_CF_ACCESS_CLIENT_SECRET: SecretsStoreSecret;
    // Vars
    GIGAPOTATO_API_URL: string;
    OPENROUTER_ORG_ID: string;
    ABUSE_SERVICE_URL: string;
  }
}
interface Env extends Cloudflare.Env {}
// Minimal Workers runtime stubs (replaced by full declarations from `wrangler types`)
type SecretsStoreSecret = { get(): Promise<string> };
interface Hyperdrive {
  readonly connectionString: string;
}
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
