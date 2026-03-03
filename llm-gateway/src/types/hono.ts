import type { User } from '@kilocode/db';
import type { CustomLlm } from '@kilocode/db/schema';
import type { Env } from '../env';
import type { AnonymousUserContext } from '../lib/anonymous';
import type { FeatureValue } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from './request';
import type { Provider, SecretsBundle } from '../lib/providers';
import type { BYOKResult } from '../lib/byok';
import type { FraudDetectionHeaders } from '../lib/extract-headers';

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

  // provider-resolution.ts — set after secrets are fetched and provider is chosen
  provider: Provider;
  userByok: BYOKResult[] | null;
  customLlm: CustomLlm | null;
  secrets: SecretsBundle;

  // request-transform.ts — extracted from request headers, stored for background tasks
  fraudHeaders: FraudDetectionHeaders;
  projectId: string | null;
  taskId: string | null;
  editorName: string | null;
  machineId: string | null;
  xKiloCodeVersion: string | null;
  numericKiloCodeVersion: number;

  // request-transform.ts — extra headers to forward to the upstream provider
  extraHeaders: Record<string, string>;
};
