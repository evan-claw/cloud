// Per-key Durable Object for queue message idempotency.
// Each idempotency key gets its own DO instance (via idFromName(key)),
// ensuring at-most-once processing even across queue retries.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STALE_CLAIM_MS = 60 * 1000; // 60 seconds

export type ClaimResult = {
  claimed: boolean;
  status: 'claimed' | 'processing' | 'completed';
};

export class IdempotencyDO extends DurableObject<Env> {
  async claim(): Promise<ClaimResult> {
    const state = await this.ctx.storage.get<string>('state');
    if (state === 'completed') return { claimed: false, status: 'completed' };
    if (state === 'processing') return { claimed: false, status: 'processing' };
    await this.ctx.storage.put('state', 'processing');
    await this.ctx.storage.setAlarm(Date.now() + STALE_CLAIM_MS);
    return { claimed: true, status: 'claimed' };
  }

  async complete(): Promise<void> {
    await this.ctx.storage.put('state', 'completed');
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export function getIdempotencyDO(
  env: { IDEMPOTENCY_DO: DurableObjectNamespace<IdempotencyDO> },
  key: string
): DurableObjectStub<IdempotencyDO> {
  return env.IDEMPOTENCY_DO.get(env.IDEMPOTENCY_DO.idFromName(key));
}
