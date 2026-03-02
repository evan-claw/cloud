// Tests for response-helpers: getOutputHeaders, wrapResponse, makeErrorReadable.

import { describe, it, expect } from 'vitest';
import { getOutputHeaders, wrapResponse, makeErrorReadable } from '../../src/lib/response-helpers';

describe('getOutputHeaders', () => {
  it('whitelists date, content-type, request-id', () => {
    const upstream = new Response('body', {
      headers: {
        date: 'Mon, 01 Jan 2026 00:00:00 GMT',
        'content-type': 'text/event-stream',
        'request-id': 'req-123',
        'x-secret-header': 'should-be-stripped',
        'set-cookie': 'should-be-stripped',
      },
    });
    const out = getOutputHeaders(upstream);
    expect(out.get('date')).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
    expect(out.get('content-type')).toBe('text/event-stream');
    expect(out.get('request-id')).toBe('req-123');
    expect(out.get('x-secret-header')).toBeNull();
    expect(out.get('set-cookie')).toBeNull();
  });

  it('sets Content-Encoding: identity', () => {
    const upstream = new Response('body');
    const out = getOutputHeaders(upstream);
    expect(out.get('Content-Encoding')).toBe('identity');
  });
});

describe('wrapResponse', () => {
  it('preserves status and body', async () => {
    const upstream = new Response('hello', { status: 201, statusText: 'Created' });
    const wrapped = wrapResponse(upstream);
    expect(wrapped.status).toBe(201);
    expect(await wrapped.text()).toBe('hello');
    expect(wrapped.headers.get('Content-Encoding')).toBe('identity');
  });
});

describe('makeErrorReadable', () => {
  it('returns undefined for successful responses', async () => {
    const response = new Response('ok', { status: 200 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: false,
    });
    expect(result).toBeUndefined();
  });

  it('returns BYOK message for 401', async () => {
    const response = new Response('Unauthorized', { status: 401 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: true,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toContain('[BYOK]');
    expect(body.error).toContain('invalid or has been revoked');
  });

  it('returns BYOK message for 402', async () => {
    const response = new Response('Payment Required', { status: 402 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: true,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(402);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toContain('insufficient funds');
  });

  it('returns BYOK message for 429', async () => {
    const response = new Response('Rate Limited', { status: 429 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: true,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(429);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toContain('rate limit');
  });

  it('returns undefined for non-BYOK errors', async () => {
    const response = new Response('Server Error', { status: 500 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: false,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for BYOK with non-mapped status codes', async () => {
    const response = new Response('Server Error', { status: 500 });
    const result = await makeErrorReadable({
      requestedModel: 'test',
      request: { model: 'test', messages: [] },
      response,
      isUserByok: true,
    });
    expect(result).toBeUndefined();
  });
});
