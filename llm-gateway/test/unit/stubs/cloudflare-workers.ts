// Minimal stub for cloudflare:workers in unit tests.
// Only provides the DurableObject base class needed by RateLimitDO.

export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
