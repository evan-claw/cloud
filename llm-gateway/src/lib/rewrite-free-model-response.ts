// SSE stream transformer for Kilo free model responses.
// Port of src/lib/rewriteModelResponse.ts — removes cost fields and normalises
// reasoning_details so the client receives a consistent OpenRouter-shaped payload.

import { createParser } from 'eventsource-parser';
import { getOutputHeaders } from './response-helpers';

// ─── Types (subset of processUsage/rewriteModelResponse types) ───────────────

type OpenRouterUsage = {
  cost?: number;
  cost_details?: unknown;
  is_byok?: unknown;
};

type MessageWithReasoning = {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Array<{ type: string; text: string }>;
  role?: string | null;
  [key: string]: unknown;
};

type ChatCompletionChunk = {
  model?: string;
  choices?: Array<{
    delta?: MessageWithReasoning & { role?: string | null };
    [key: string]: unknown;
  }>;
  usage?: OpenRouterUsage;
  [key: string]: unknown;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ReasoningDetailType = { Text: 'reasoning.text' } as const;

function convertReasoningToOpenRouterFormat(message: MessageWithReasoning) {
  if (!message.reasoning_content) return;
  if (!message.reasoning) {
    message.reasoning = message.reasoning_content;
  }
  if (!message.reasoning_details) {
    message.reasoning_details = [
      { type: ReasoningDetailType.Text, text: message.reasoning_content },
    ];
  }
  delete message.reasoning_content;
}

function removeCostInfo(usage: OpenRouterUsage) {
  delete usage.cost;
  delete usage.cost_details;
  delete usage.is_byok;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function rewriteFreeModelResponse(
  response: Response,
  model: string
): Promise<Response> {
  const headers = getOutputHeaders(response);

  // Non-streaming (application/json)
  if (headers.get('content-type')?.includes('application/json')) {
    type JsonCompletion = {
      model?: string;
      choices?: Array<{ message?: MessageWithReasoning }>;
      usage?: OpenRouterUsage;
    };
    const json = (await response.json()) as JsonCompletion;
    if (json.model) json.model = model;

    const message = json.choices?.[0]?.message;
    if (message) convertReasoningToOpenRouterFormat(message);

    if (json.usage) removeCostInfo(json.usage);

    return Response.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Streaming (text/event-stream)
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const parser = createParser({
        onEvent(event) {
          if (event.data === '[DONE]') return;
          const chunk = JSON.parse(event.data) as ChatCompletionChunk;
          if (chunk.model) chunk.model = model;

          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.role === null) delete delta.role;
            convertReasoningToOpenRouterFormat(delta);
          }

          if (!chunk.choices) {
            // Some APIs omit choices on the usage chunk — ensure OpenCode accepts it
            chunk.choices = [];
          }

          if (chunk.usage) removeCostInfo(chunk.usage);

          controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        },
        onComment() {
          controller.enqueue(encoder.encode(': KILO PROCESSING\n\n'));
        },
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        console.error('[rewriteFreeModelResponse] stream error', err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
