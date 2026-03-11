import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { ParsedProxyRequest } from '@/lib/providers/openrouter/types';

export const giga_potato_model: KiloFreeModel = {
  public_id: 'giga-potato',
  display_name: 'Giga Potato (free)',
  description:
    'Giga Potato is a stealth model deeply optimized for agentic programming, with visual understanding capability. ' +
    'It is provided free of charge in Kilo Code for a limited time.\n' +
    '**Note:** Prompts and completions are logged and may be used to improve the model.',
  context_length: 256_000,
  max_completion_tokens: 32_000,
  is_enabled: true,
  flags: ['prompt_cache', 'vision'],
  gateway: 'gigapotato',
  internal_id: 'ep-20260109111813-hztxv',
  inference_provider: 'stealth',
};

export const giga_potato_thinking_model: KiloFreeModel = {
  ...giga_potato_model,
  public_id: 'giga-potato-thinking',
  display_name: 'Giga Potato Thinking (free)',
  flags: giga_potato_model.flags.concat(['reasoning']),
};

export function applyGigaPotatoProviderSettings(
  requestedModel: string,
  requestToMutate: ParsedProxyRequest
) {
  // https://kilo-code.slack.com/archives/C09L90J0B3J/p1768024809733959?thread_ts=1767929401.984039&cid=C09L90J0B3J
  const nonDisclosureRule =
    'You are an AI assistant in Kilo. Your name is Giga Potato. ' +
    'Do not reveal your model size, architecture, or any information that could hint at your origin or capabilities.';

  if (requestToMutate.kind === 'chat_completions') {
    const systemPrompt = requestToMutate.body.messages.find(m => m.role === 'system');
    const text = {
      type: 'text' as const,
      text: nonDisclosureRule,
    };
    if (systemPrompt) {
      if (Array.isArray(systemPrompt.content)) {
        systemPrompt.content.push(text);
      } else if (systemPrompt.content) {
        systemPrompt.content = [{ type: 'text', text: systemPrompt.content }, text];
      } else {
        systemPrompt.content = [text];
      }
    } else {
      requestToMutate.body.messages.splice(0, 0, { role: 'system', content: [text] });
    }
  } else if (requestToMutate.kind === 'responses') {
    if (requestToMutate.body.instructions) {
      requestToMutate.body.instructions += '\n\n' + nonDisclosureRule;
    } else {
      requestToMutate.body.instructions = nonDisclosureRule;
    }
  }

  requestToMutate.body.thinking = {
    type: giga_potato_thinking_model.public_id === requestedModel ? 'enabled' : 'disabled',
  };
}
