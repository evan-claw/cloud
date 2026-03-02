/* eslint-disable */
// Stub — replace by running `wrangler types` once bindings are provisioned.
declare namespace Cloudflare {
  interface GlobalProps {}
  interface Env {
    HYPERDRIVE: Hyperdrive;
    USER_EXISTS_CACHE: KVNamespace;
    NEXTAUTH_SECRET_PROD: SecretsStoreSecret;
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
