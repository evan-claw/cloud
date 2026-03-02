/* eslint-disable */
// Stub — replace by running `wrangler types` once Hyperdrive IDs are provisioned.
// This file will be overwritten with accurate bindings and full runtime type declarations.
declare namespace Cloudflare {
  interface GlobalProps {}
  interface Env {
    // Hyperdrive bindings
    HYPERDRIVE: Hyperdrive;
    HYPERDRIVE_READ: Hyperdrive;
    // KV namespaces
    RATE_LIMIT_KV: KVNamespace;
    USER_CACHE_KV: KVNamespace;
    // Service binding
    O11Y: Fetcher;
    // Secrets Store (async .get())
    NEXTAUTH_SECRET: SecretsStoreSecret;
    OPENROUTER_API_KEY: SecretsStoreSecret;
    BYOK_ENCRYPTION_KEY: SecretsStoreSecret;
    ABUSE_CF_ACCESS_CLIENT_ID: SecretsStoreSecret;
    ABUSE_CF_ACCESS_CLIENT_SECRET: SecretsStoreSecret;
    GIGAPOTATO_API_KEY: SecretsStoreSecret;
    CORETHINK_API_KEY: SecretsStoreSecret;
    MARTIAN_API_KEY: SecretsStoreSecret;
    MISTRAL_API_KEY: SecretsStoreSecret;
    VERCEL_AI_GATEWAY_API_KEY: SecretsStoreSecret;
    OPENAI_API_KEY: SecretsStoreSecret;
    // Vars
    ENVIRONMENT: string;
    ABUSE_SERVICE_URL: string;
    GIGAPOTATO_API_URL: string;
    OPENROUTER_ORG_ID: string;
  }
}
interface Env extends Cloudflare.Env {}
// Minimal Workers runtime stubs (replaced by full declarations from `wrangler types`)
type SecretsStoreSecret = { get(): Promise<string> };
interface Hyperdrive { readonly connectionString: string }
interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
