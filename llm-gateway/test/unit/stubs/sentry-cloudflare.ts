// Minimal stub for @sentry/cloudflare in unit tests.
// Provides no-op implementations of the Sentry APIs used in src/.

export function captureException(_err: unknown, _opts?: unknown): void {}

export function withSentry(
  _optsOrFn: unknown,
  handler: { fetch: (...args: unknown[]) => unknown }
): { fetch: (...args: unknown[]) => unknown } {
  return handler;
}
