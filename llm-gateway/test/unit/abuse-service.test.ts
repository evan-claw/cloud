// Tests for abuse-service: classifyAbuse, reportAbuseCost, classifyRequest, reportCost.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyAbuse,
  reportAbuseCost,
  reportCost,
  classifyRequest,
} from '../../src/lib/abuse-service';
import type { AbuseServiceSecrets, AbuseClassificationResponse } from '../../src/lib/abuse-service';
import type { FraudDetectionHeaders } from '../../src/lib/extract-headers';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const secrets: AbuseServiceSecrets = {
  cfAccessClientId: 'test-id',
  cfAccessClientSecret: 'test-secret',
};

const emptyFraudHeaders: FraudDetectionHeaders = {
  http_x_forwarded_for: '1.2.3.4',
  geo_city: null,
  geo_country: null,
  geo_latitude: null,
  geo_longitude: null,
  ja3_hash: null,
  http_user_agent: null,
};

describe('classifyRequest', () => {
  it('returns null for empty serviceUrl', async () => {
    const result = await classifyRequest('', secrets, {});
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends POST to /api/classify with CF Access headers', async () => {
    const mockResponse: AbuseClassificationResponse = {
      verdict: 'ALLOW',
      risk_score: 0.1,
      signals: [],
      action_metadata: {},
      context: {
        identity_key: 'test',
        current_spend_1h: 0,
        is_new_user: false,
        requests_per_second: 1,
      },
      request_id: 42,
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const result = await classifyRequest('https://abuse.example.com', secrets, {
      kilo_user_id: 'user-1',
    });
    expect(result).toEqual(mockResponse);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('https://abuse.example.com/api/classify');
    expect((init?.headers as Record<string, string>)['CF-Access-Client-Id']).toBe('test-id');
    expect((init?.headers as Record<string, string>)['CF-Access-Client-Secret']).toBe(
      'test-secret'
    );
  });

  it('returns null on fetch failure', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network error'));
    const result = await classifyRequest('https://abuse.example.com', secrets, {});
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));
    const result = await classifyRequest('https://abuse.example.com', secrets, {});
    expect(result).toBeNull();
  });
});

describe('classifyAbuse', () => {
  it('extracts prompts from messages and sends classification', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: 'ALLOW',
          risk_score: 0,
          signals: [],
          action_metadata: {},
          context: {
            identity_key: 'test',
            current_spend_1h: 0,
            is_new_user: false,
            requests_per_second: 0,
          },
          request_id: 1,
        }),
        { status: 200 }
      )
    );

    await classifyAbuse(
      'https://abuse.example.com',
      secrets,
      emptyFraudHeaders,
      'vscode',
      {
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello world' },
        ],
      },
      { kiloUserId: 'user-1', organizationId: 'org-1' }
    );

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.system_prompt).toBe('You are helpful.');
    expect(body.user_prompt).toBe('Hello world');
    expect(body.kilo_user_id).toBe('user-1');
    expect(body.editor_name).toBe('vscode');
  });
});

describe('reportCost', () => {
  it('returns null for empty serviceUrl', async () => {
    const result = await reportCost('', secrets, {
      request_id: 1,
      message_id: 'msg-1',
      cost: 100,
    });
    expect(result).toBeNull();
  });

  it('sends POST to /api/usage/cost', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    await reportCost('https://abuse.example.com', secrets, {
      request_id: 42,
      message_id: 'msg-1',
      cost: 500,
    });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('https://abuse.example.com/api/usage/cost');
  });
});

describe('reportAbuseCost', () => {
  it('returns null when abuseRequestId is missing', async () => {
    const result = await reportAbuseCost(
      'https://abuse.example.com',
      secrets,
      {
        kiloUserId: 'user-1',
        fraudHeaders: emptyFraudHeaders,
        requested_model: 'test',
        abuse_request_id: undefined,
      },
      {
        messageId: 'msg-1',
        cost_mUsd: 100,
        inputTokens: 10,
        outputTokens: 20,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      }
    );
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns null when messageId is null', async () => {
    const result = await reportAbuseCost(
      'https://abuse.example.com',
      secrets,
      {
        kiloUserId: 'user-1',
        fraudHeaders: emptyFraudHeaders,
        requested_model: 'test',
        abuse_request_id: 42,
      },
      {
        messageId: null,
        cost_mUsd: 100,
        inputTokens: 10,
        outputTokens: 20,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      }
    );
    expect(result).toBeNull();
  });
});
