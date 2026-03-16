import { ReasoningDetailType } from '@/lib/custom-llm/reasoning-details';
import { getOutputHeaders } from '@/lib/llm-proxy-helpers';
import type { ChatCompletionChunk, OpenRouterUsage } from '@/lib/processUsage.types';
import type { MessageWithReasoning } from '@/lib/providers/openrouter/types';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type OpenAI from 'openai';

type WithCostInfo = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

function convertReasoningToOpenRouterFormat(message: MessageWithReasoning) {
  if (!message.reasoning_content) {
    return;
  }
  if (!message.reasoning) {
    message.reasoning = message.reasoning_content;
  }
  if (!message.reasoning_details) {
    message.reasoning_details = [
      {
        type: ReasoningDetailType.Text,
        text: message.reasoning_content,
      },
    ];
  }
  delete message.reasoning_content;
}

function removeCostInfo(usage: OpenRouterUsage | WithCostInfo) {
  // We only rewrite the response for free models, strip upstream cost
  delete usage.cost;
  delete usage.cost_details;
  delete usage.is_byok;
}

export async function rewriteFreeModelResponse_ChatCompletions(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const json = (await response.json()) as OpenAI.ChatCompletion;
    if (json.model) {
      json.model = model;
    }

    const message = json.choices?.[0]?.message;
    if (message) {
      convertReasoningToOpenRouterFormat(message as MessageWithReasoning);
    }

    const usage = json.usage as OpenRouterUsage;
    if (usage) {
      removeCostInfo(usage);
    }

    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === '[DONE]') {
            return;
          }
          const json = JSON.parse(event.data) as ChatCompletionChunk;
          if (json.model) {
            json.model = model;
          }

          const delta = json.choices?.[0]?.delta;
          if (delta) {
            // Some APIs set null here, which is not accepted by OpenCode
            if (delta?.role === null) {
              delete delta.role;
            }

            convertReasoningToOpenRouterFormat(delta as MessageWithReasoning);
          }

          if (!json.choices) {
            // Some APIs leave this out when returning usage, which is not accepted by OpenCode
            json.choices = [];
          }

          if (json.usage) {
            removeCostInfo(json.usage);
          }

          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue('data: [DONE]\n\n');
          controller.close();
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    },
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ResponsesApiEvent = {
  type: string;
  response?: OpenAI.Responses.Response & { usage?: WithCostInfo | null };
};

export async function rewriteFreeModelResponse_Responses(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const json = (await response.json()) as OpenAI.Responses.Response & {
      usage?: WithCostInfo | null;
    };
    if (json.model) {
      json.model = model;
    }
    if (json.usage) {
      removeCostInfo(json.usage);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === '[DONE]') {
            return;
          }
          const json = JSON.parse(event.data) as ResponsesApiEvent;
          if (json.response) {
            if (json.response.model) {
              json.response.model = model;
            }
            if (json.response.usage) {
              removeCostInfo(json.response.usage);
            }
          }
          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    },
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
