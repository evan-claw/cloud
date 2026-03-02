// Tests for rewriteFreeModelResponse — SSE stream transformer for free model responses.
// Verifies cost stripping, model replacement, and reasoning_content → reasoning conversion.

import { describe, it, expect } from 'vitest';
import { rewriteFreeModelResponse } from '../../src/lib/rewrite-free-model-response';

function sseChunk(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeSSEResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readSSEEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

describe('rewriteFreeModelResponse — SSE streaming', () => {
  it('replaces model name in SSE chunks', async () => {
    const upstream = makeSSEResponse([
      sseChunk({
        model: 'actual-provider-model-id',
        choices: [{ delta: { content: 'hello' } }],
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const events = await readSSEEvents(res);
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).model).toBe('corethink:free');
  });

  it('strips cost from usage chunks', async () => {
    const upstream = makeSSEResponse([
      sseChunk({
        model: 'internal-model',
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.0001,
          cost_details: { upstream_inference_cost: 0.0001 },
          is_byok: false,
        },
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const events = await readSSEEvents(res);
    const usage = (events[0] as { usage: Record<string, unknown> }).usage;
    expect(usage.cost).toBeUndefined();
    expect(usage.cost_details).toBeUndefined();
    expect(usage.is_byok).toBeUndefined();
    expect(usage.prompt_tokens).toBe(10);
  });

  it('converts reasoning_content to reasoning + reasoning_details', async () => {
    const upstream = makeSSEResponse([
      sseChunk({
        model: 'internal-model',
        choices: [
          {
            delta: {
              reasoning_content: 'Let me think...',
              content: 'The answer is 42.',
            },
          },
        ],
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await rewriteFreeModelResponse(upstream, 'giga-potato-thinking');
    const events = await readSSEEvents(res);
    const delta = (events[0] as { choices: Array<{ delta: Record<string, unknown> }> }).choices[0]
      .delta;
    expect(delta.reasoning).toBe('Let me think...');
    expect(delta.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'Let me think...' }]);
    expect(delta.reasoning_content).toBeUndefined();
  });

  it('removes null role from delta', async () => {
    const upstream = makeSSEResponse([
      sseChunk({
        model: 'internal-model',
        choices: [{ delta: { role: null, content: 'hi' } }],
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const events = await readSSEEvents(res);
    const delta = (events[0] as { choices: Array<{ delta: Record<string, unknown> }> }).choices[0]
      .delta;
    expect(delta.role).toBeUndefined();
  });

  it('emits [DONE] sentinel at end', async () => {
    const upstream = makeSSEResponse([
      sseChunk({ model: 'x', choices: [{ delta: { content: 'a' } }] }),
      'data: [DONE]\n\n',
    ]);
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
  });

  it('sets Content-Encoding: identity', async () => {
    const upstream = makeSSEResponse([sseChunk({ model: 'x', choices: [] }), 'data: [DONE]\n\n']);
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    expect(res.headers.get('Content-Encoding')).toBe('identity');
  });
});

describe('rewriteFreeModelResponse — JSON (non-streaming)', () => {
  it('replaces model name in JSON response', async () => {
    const upstream = makeJsonResponse({
      model: 'internal-model-id',
      choices: [{ message: { content: 'hello' } }],
    });
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.model).toBe('corethink:free');
  });

  it('strips cost from JSON usage', async () => {
    const upstream = makeJsonResponse({
      model: 'internal-model',
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 10,
        cost: 0.05,
        cost_details: {},
        is_byok: true,
      },
    });
    const res = await rewriteFreeModelResponse(upstream, 'corethink:free');
    const body = (await res.json()) as { usage: Record<string, unknown> };
    expect(body.usage.cost).toBeUndefined();
    expect(body.usage.cost_details).toBeUndefined();
    expect(body.usage.is_byok).toBeUndefined();
    expect(body.usage.prompt_tokens).toBe(5);
  });

  it('converts reasoning_content in JSON message', async () => {
    const upstream = makeJsonResponse({
      model: 'internal',
      choices: [
        {
          message: {
            reasoning_content: 'thinking...',
            content: 'done',
          },
        },
      ],
    });
    const res = await rewriteFreeModelResponse(upstream, 'giga-potato-thinking');
    const body = (await res.json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    const msg = body.choices[0].message;
    expect(msg.reasoning).toBe('thinking...');
    expect(msg.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'thinking...' }]);
    expect(msg.reasoning_content).toBeUndefined();
  });
});
