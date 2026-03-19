import { z } from 'zod';
import type { RigAgentEventRecord } from '../../db/tables/rig-agent-events.table';

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

// Zod schemas for the SSE event `data` (properties) shapes stored in rig_agent_events.
// The `data` column holds the `properties` object from the SSE event payload.
// Be lenient: use .passthrough() and optional fields to avoid throwing on unknown shapes.

const MessageCreatedData = z.object({
  sessionID: z.string().optional(),
  message: z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.array(z.unknown()).optional(),
  }),
});

const MessagePartUpdatedData = z.object({
  sessionID: z.string().optional(),
  message: z.object({
    id: z.string(),
  }),
  part: z.object({
    type: z.string(),
    text: z.string().optional(),
  }),
});

const ContentTextItem = z.object({
  type: z.union([z.literal('output_text'), z.literal('input_text')]),
  text: z.string(),
});

const ContentOtherItem = z.object({ type: z.string() }).passthrough();

const ContentItem = z.union([ContentTextItem, ContentOtherItem]);

const MessageCompletedData = z.object({
  sessionID: z.string().optional(),
  message: z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.array(ContentItem).optional(),
  }),
});

type PendingTurn = {
  role: 'user' | 'assistant';
  /** Text deltas accumulated from message_part.updated events */
  deltaParts: string[];
  /** Final content from message.completed, if received */
  completedContent: string | null;
};

/**
 * Reconstructs conversation turns from stored AgentDO streaming events.
 * Returns turns in chronological order.
 * Gracefully handles missing/malformed events.
 */
export function reconstructConversation(events: RigAgentEventRecord[]): ConversationTurn[] {
  // Map from message id → pending turn, preserving insertion order for chronological output
  const pendingById = new Map<string, PendingTurn>();
  // Track order in which message IDs were first seen
  const messageOrder: string[] = [];

  for (const event of events) {
    const { event_type, data } = event;

    if (event_type === 'message.created') {
      const parsed = MessageCreatedData.safeParse(data);
      if (!parsed.success) continue;

      const { id, role } = parsed.data.message;
      if (!pendingById.has(id)) {
        pendingById.set(id, { role, deltaParts: [], completedContent: null });
        messageOrder.push(id);
      }
      continue;
    }

    if (event_type === 'message_part.updated') {
      const parsed = MessagePartUpdatedData.safeParse(data);
      if (!parsed.success) continue;

      const { id } = parsed.data.message;
      const { type, text } = parsed.data.part;

      // Only accumulate output_text and input_text parts; skip tool calls etc.
      if ((type === 'output_text' || type === 'input_text') && text !== undefined) {
        const pending = pendingById.get(id);
        if (pending) {
          pending.deltaParts.push(text);
        }
      }
      continue;
    }

    if (event_type === 'message.completed') {
      const parsed = MessageCompletedData.safeParse(data);
      if (!parsed.success) continue;

      const { id, role, content } = parsed.data.message;

      // Ensure we have a pending turn (message.created may have been pruned)
      if (!pendingById.has(id)) {
        pendingById.set(id, { role, deltaParts: [], completedContent: null });
        messageOrder.push(id);
      }

      const pending = pendingById.get(id);
      if (pending && content) {
        const textParts: string[] = [];
        let hasToolCall = false;

        for (const item of content) {
          const itemParsed = ContentItem.safeParse(item);
          if (!itemParsed.success) continue;
          const c = itemParsed.data;
          const textItem = ContentTextItem.safeParse(c);
          if (textItem.success) {
            textParts.push(textItem.data.text);
          } else {
            hasToolCall = true;
          }
        }

        const builtText = textParts.join('');
        if (builtText) {
          pending.completedContent = builtText;
        } else if (hasToolCall && !builtText) {
          pending.completedContent = '[tool call]';
        }
      }
      continue;
    }
  }

  const turns: ConversationTurn[] = [];

  for (const id of messageOrder) {
    const pending = pendingById.get(id);
    if (!pending) continue;

    // Prefer completed content (authoritative), fall back to accumulated deltas
    const rawContent =
      pending.completedContent !== null ? pending.completedContent : pending.deltaParts.join('');

    const content = rawContent.trim();
    // Skip empty turns
    if (!content) continue;

    turns.push({ role: pending.role, content });
  }

  return turns;
}

/**
 * Formats a conversation transcript for injection into a new session prompt.
 * Truncates to the last `maxTurns` turns to manage context window size.
 */
export function formatConversationTranscript(turns: ConversationTurn[], maxTurns = 50): string {
  const recent = turns.slice(-maxTurns);
  const lines = recent.map(t => `${t.role === 'user' ? 'User' : 'Mayor'}: ${t.content}`);
  return [
    '[Previous conversation restored from session history]',
    '',
    ...lines,
    '',
    '[Container restarted — resuming conversation]',
  ].join('\n');
}
