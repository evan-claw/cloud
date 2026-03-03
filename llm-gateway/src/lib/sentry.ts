// Thin wrapper around @sentry/cloudflare for use in middleware and handlers.
// The Sentry SDK is initialised by withSentry() in src/index.ts — captureException
// can be called freely from any code that runs after that wrapping.

import * as Sentry from '@sentry/cloudflare';

// Same DSN as the Next.js reference (NEXT_PUBLIC_SENTRY_DSN).
// Sentry DSNs are intentionally public; they are embedded in client-side bundles.
export const SENTRY_DSN =
  'https://27ef80847dcd5e044283c8f88d95ffc9@o4509356317474816.ingest.us.sentry.io/4509565130637312';

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  Sentry.captureException(err, extra ? { extra } : undefined);
}
