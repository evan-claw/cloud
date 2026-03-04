import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { getProvider } from '../lib/providers';
import type { SecretsBundle } from '../lib/providers';
import { getWorkerDb } from '@kilocode/db/client';
import { extractHeaderAndLimitLength } from '../lib/extract-headers';

// Resolves API keys from Secrets Store, then determines which provider to route to.
// Sets provider, userByok, and customLlm on the Hono context.
export const providerResolutionMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  // Pre-fetch all secrets in parallel to avoid serial Secrets Store round-trips
  const [
    openrouterApiKey,
    gigapotatoApiKey,
    corethinkApiKey,
    martianApiKey,
    mistralApiKey,
    vercelAiGatewayApiKey,
    byokEncryptionKey,
    gigapotatoApiUrl,
  ] = await Promise.all([
    c.env.OPENROUTER_API_KEY.get(),
    c.env.GIGAPOTATO_API_KEY.get(),
    c.env.CORETHINK_API_KEY.get(),
    c.env.MARTIAN_API_KEY.get(),
    c.env.MISTRAL_API_KEY.get(),
    c.env.VERCEL_AI_GATEWAY_API_KEY.get(),
    c.env.BYOK_ENCRYPTION_KEY.get(),
    c.env.GIGAPOTATO_API_URL.get(),
  ]);

  const secrets: SecretsBundle = {
    openrouterApiKey,
    gigapotatoApiKey,
    gigapotatoApiUrl,
    corethinkApiKey,
    martianApiKey,
    mistralApiKey,
    vercelAiGatewayApiKey,
    byokEncryptionKey,
  };

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  // Random seed for Vercel A/B routing — same as reference: taskId || user.id
  // Apply the same 500-char truncation as the reference (extractHeaderAndLimitLength).
  const taskId = extractHeaderAndLimitLength(c.req.raw.headers, 'x-kilocode-taskid') ?? undefined;
  const user = c.get('user');
  const randomSeed = taskId ?? user.id;

  const { provider, userByok, customLlm } = await getProvider(
    db,
    c.get('resolvedModel'),
    c.get('requestBody'),
    user,
    c.get('organizationId'),
    secrets,
    randomSeed
  );

  c.set('provider', provider);
  c.set('userByok', userByok);
  c.set('customLlm', customLlm);
  c.set('secrets', secrets);

  return next();
});
