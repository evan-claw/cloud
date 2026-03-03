import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatch,
  chatRequest,
  signToken,
  VALID_USER,
  VALID_USER_ZERO_BALANCE,
  getTableName,
  chainResult,
} from './_setup';

// ── Configurable DB ────────────────────────────────────────────────────────────

let _userRows: Record<string, unknown>[] = [];
let _creditCount = 0;
let _orgRow: Record<string, unknown> | null = null;

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === 'kilocode_users') return chainResult(_userRows);
        if (name === 'credit_transactions') return chainResult([{ count: _creditCount }]);
        if (name === 'organizations') return chainResult(_orgRow ? [_orgRow] : []);
        if (name === 'model_user_byok_providers') return chainResult([]);
        if (name === 'custom_llm') return chainResult([]);
        if (name === 'models_by_provider') return chainResult([]);
        return chainResult([]);
      },
    }),
    insert: () => chainResult([]),
    execute: () => Promise.resolve({ rows: [] }),
  }),
}));

vi.mock('@kilocode/worker-utils', () => ({
  userExistsWithCache: async () => true,
  extractBearerToken: (header: string | undefined) => {
    if (!header) return null;
    const parts = header.split(' ');
    return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
  },
  verifyKiloToken: async (token: string, secret: string) => {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload as Record<string, unknown>;
  },
}));

vi.mock('@kilocode/encryption', () => ({
  timingSafeEqual: (a: string, b: string) => a === b,
}));

vi.mock('../../src/lib/abuse-service', () => ({
  classifyAbuse: async () => null,
  reportAbuseCost: async () => null,
}));

const realFetch = globalThis.fetch;
beforeEach(() => {
  _userRows = [];
  _creditCount = 0;
  _orgRow = null;
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('balanceAndOrg', () => {
  it('returns 402 with Low Credit Warning for returning user with zero balance', async () => {
    _userRows = [{ ...VALID_USER_ZERO_BALANCE }];
    _creditCount = 1; // has paid topup → returning user

    const token = await signToken({ kiloUserId: 'user-zero' });
    const res = await dispatch(
      chatRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { token }
      )
    );
    expect(res.status).toBe(402);
    const body: { error: { title: string; balance: number } } = await res.json();
    expect(body.error.title).toBe('Low Credit Warning!');
    expect(body.error.balance).toBe(0);
  });

  it('returns 402 with Paid Model - Credits Required for new user with zero balance', async () => {
    _userRows = [{ ...VALID_USER_ZERO_BALANCE, id: 'user-new' }];
    _creditCount = 0; // no paid topup → new user

    const token = await signToken({ kiloUserId: 'user-new' });
    const res = await dispatch(
      chatRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { token }
      )
    );
    expect(res.status).toBe(402);
    const body: { error: { title: string; message: string } } = await res.json();
    expect(body.error.title).toBe('Paid Model - Credits Required');
    expect(body.error.message).toContain('$20 free');
  });

  it('returns 404 for org enterprise model not in allow list', async () => {
    _userRows = [{ ...VALID_USER }];
    _orgRow = {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
      settings: {
        model_allow_list: ['openai/gpt-4o'],
        provider_allow_list: [],
      },
      plan: 'enterprise',
      require_seats: false,
      microdollar_limit: null,
      microdollar_usage: null,
    };

    const token = await signToken({ kiloUserId: 'user-1' });
    const res = await dispatch(
      chatRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { token, headers: { 'x-kilocode-organizationid': 'org-1' } }
      )
    );
    expect(res.status).toBe(404);
    const body: { error: string } = await res.json();
    expect(body.error).toContain('not allowed');
  });

  it('returns 400 for Kilo free model with org data_collection=deny', async () => {
    _userRows = [{ ...VALID_USER }];
    _orgRow = {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
      settings: {
        model_allow_list: [],
        provider_allow_list: [],
        data_collection: 'deny',
      },
      plan: 'team',
      require_seats: false,
      microdollar_limit: null,
      microdollar_usage: null,
    };

    const token = await signToken({ kiloUserId: 'user-1' });
    const res = await dispatch(
      chatRequest(
        {
          model: 'corethink:free',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { token, headers: { 'x-kilocode-organizationid': 'org-1' } }
      )
    );
    expect(res.status).toBe(400);
    const body: { error: string } = await res.json();
    expect(body.error).toContain('Data collection');
  });
});
