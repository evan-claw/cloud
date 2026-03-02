import type { User } from '@kilocode/db';
import type { Env } from '../env';
import type { AnonymousUserContext } from '../lib/anonymous';
import type { FeatureValue } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from './request';

// Hono app context — bindings + all middleware variables.
export type HonoContext = {
  Bindings: Env;
  Variables: Variables;
};

// Values set via c.set() / c.get() across the middleware chain.
// Each key is populated by the middleware named in the comment.
export type Variables = {
  // request-timing.ts
  requestStartedAt: number;

  // parse-body.ts
  requestBody: OpenRouterChatCompletionRequest;
  resolvedModel: string; // lowercased, after auto-resolution
  feature: FeatureValue | null;

  // extract-ip.ts
  clientIp: string;
  modeHeader: string | null;

  // resolve-auto-model.ts
  autoModel: string | null; // original kilo/auto* id, null when not an auto model

  // auth.ts — set on successful JWT verification + DB lookup; undefined if auth failed/absent.
  // anonymous-gate.ts reads authUser to decide whether to allow anonymous access or return 401.
  authUser?: User;
  organizationId?: string;
  botId?: string;
  tokenSource?: string;

  // anonymous-gate.ts — always set once this middleware runs
  user: User | AnonymousUserContext;
};
