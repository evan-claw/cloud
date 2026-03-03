// Thin wrapper around @sentry/cloudflare for use in middleware and handlers.
// The Sentry SDK is initialised by withSentry() in src/index.ts — captureException
// can be called freely from any code that runs after that wrapping.

import * as Sentry from '@sentry/cloudflare';

// Dedicated Sentry project for the llm-gateway worker.
// Sentry DSNs are intentionally public; they are embedded in client-side bundles.
export const SENTRY_DSN =
  'https://0f7c4afba6c991a1eb7efd413b3f4f5f@o4509356317474816.ingest.us.sentry.io/4510981962006528';

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  Sentry.captureException(err, extra ? { extra } : undefined);
}
