/**
 * Reconstructs a human-readable conversation transcript from a sequence of
 * AgentDO streaming events.
 *
 * The SDK emits a stream of fine-grained events as an agent works. This
 * utility reassembles those events into clean `{ role, content }` turns that
 * can be injected into a prompt for context recovery after a container restart.
 *
 * Event types consumed:
 *   - `message.updated` / `message.completed` — carries the final Message
 *     object (UserMessage | AssistantMessage) in `data.info`.
 *   - `message_part.updated` — carries a streaming Part in `data.part`;
 *     TextParts are accumulated per messageID so assistant text is captured
 *     even when no `message.updated` event follows (e.g. mid-stream crash).
 *
 * The returned transcript is ordered chronologically and truncated to
 * `maxTurns` (keeping the most recent turns).
 */

import { z } from 'zod';
import { type RigAgentEventRecord } from '../db/tables/rig-agent-events.table';

// ── Output type ────────────────────────────────────────────────────────────

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

// ── Zod schemas for the event data payloads ────────────────────────────────
// We only validate the fields we actually use, using .passthrough() to ignore
// everything else. This makes the schemas resilient to schema evolution.

const UserMessageSummary = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

const UserMessageInfo = z
  .object({
    id: z.string(),
    role: z.literal('user'),
    // User text lives inside summary.body (generated later) or is not in the
    // message object at all — the raw prompt is only visible in part events.
    summary: UserMessageSummary.optional(),
  })
  .passthrough();

const AssistantMessageInfo = z
  .object({
    id: z.string(),
    role: z.literal('assistant'),
    error: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const MessageInfo = z.union([UserMessageInfo, AssistantMessageInfo]);

// Payload of message.updated / message.completed events
const MessageEventData = z
  .object({
    info: MessageInfo,
  })
  .passthrough();

// TextPart from message_part.updated
const TextPartData = z
  .object({
    id: z.string(),
    messageID: z.string(),
    type: z.literal('text'),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
  })
  .passthrough();

// Minimal Part schema — we only care about TextPart; everything else is
// parsed as an unknown part so we can skip it gracefully.
const PartData = z.discriminatedUnion('type', [
  TextPartData,
  z.object({ type: z.literal('reasoning'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('tool'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('file'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('step-start'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('step-finish'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('snapshot'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('patch'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('agent'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('retry'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('compaction'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('subtask'), messageID: z.string() }).passthrough(),
]);

// Payload of message_part.updated events
const PartEventData = z
  .object({
    part: PartData,
  })
  .passthrough();

// ── Internal state during reconstruction ──────────────────────────────────

type UserInfo = z.infer<typeof UserMessageInfo>;
type AssistantInfo = z.infer<typeof AssistantMessageInfo>;

type MessageAccumulator = {
  role: 'user' | 'assistant';
  // Latest snapshot of the message metadata (may be null if we only saw parts)
  info: UserInfo | AssistantInfo | null;
  // Text parts keyed by part id; stored in insertion order
  textParts: Map<string, string>;
  // Whether this message had any non-text parts (tool calls, etc.)
  hasNonTextParts: boolean;
};

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Reconstruct a conversation transcript from a flat list of AgentDO events.
 *
 * @param events    Ordered sequence of `RigAgentEventRecord` rows from AgentDO.
 * @param maxTurns  Maximum number of turns to return. When the transcript
 *                  exceeds this, the oldest turns are dropped so the most
 *                  recent context is preserved. Pass `Infinity` to keep all.
 *                  Defaults to 50.
 *
 * @returns  Array of `{ role, content }` turns in chronological order.
 */
export function reconstructConversation(
  events: RigAgentEventRecord[],
  maxTurns = 50
): ConversationTurn[] {
  // messageId → accumulator, insertion-ordered
  const messages = new Map<string, MessageAccumulator>();

  for (const event of events) {
    const { event_type, data } = event;

    if (event_type === 'message.updated' || event_type === 'message.completed') {
      const parsed = MessageEventData.safeParse(data);
      if (!parsed.success) continue;

      const { info } = parsed.data;
      let acc = messages.get(info.id);
      if (!acc) {
        acc = {
          role: info.role,
          info,
          textParts: new Map(),
          hasNonTextParts: false,
        };
        messages.set(info.id, acc);
      } else {
        // Update with the latest message metadata
        acc.info = info;
        acc.role = info.role;
      }
    } else if (event_type === 'message_part.updated' || event_type === 'message.part.updated') {
      // The SDK emits both forms depending on version; handle both.
      const parsed = PartEventData.safeParse(data);
      if (!parsed.success) continue;

      const { part } = parsed.data;
      const messageId = part.messageID;

      let acc = messages.get(messageId);
      if (!acc) {
        // We may see part events before the message.updated event — create a
        // placeholder accumulator. Role will be filled in when we see the info.
        acc = {
          role: 'assistant', // default; corrected when message info arrives
          info: null,
          textParts: new Map(),
          hasNonTextParts: false,
        };
        messages.set(messageId, acc);
      }

      if (part.type === 'text') {
        // Skip synthetic / ignored parts (used for internal context injection)
        if (part.synthetic || part.ignored) continue;
        acc.textParts.set(part.id, part.text);
      } else {
        acc.hasNonTextParts = true;
      }
    }
  }

  // ── Assemble turns ───────────────────────────────────────────────────────

  const turns: ConversationTurn[] = [];

  for (const acc of messages.values()) {
    const content = buildContent(acc);
    if (content === null) continue; // skip tool-only or empty turns
    turns.push({ role: acc.role, content });
  }

  // ── Truncate ─────────────────────────────────────────────────────────────

  if (turns.length > maxTurns) {
    return turns.slice(turns.length - maxTurns);
  }

  return turns;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildContent(acc: MessageAccumulator): string | null {
  if (acc.role === 'user') {
    return buildUserContent(acc);
  }
  return buildAssistantContent(acc);
}

function buildUserContent(acc: MessageAccumulator): string | null {
  // User messages: text parts hold the raw prompt text.
  // If no text parts are present, fall back to summary.body if available.
  const fromParts = joinTextParts(acc.textParts);
  if (fromParts !== '') return fromParts;

  const summaryBody = extractSummaryBody(acc.info);
  if (summaryBody) return summaryBody;

  // No text content found — user turn is unreadable (e.g. file-only message)
  return null;
}

function buildAssistantContent(acc: MessageAccumulator): string | null {
  const fromParts = joinTextParts(acc.textParts);
  if (fromParts !== '') return fromParts;

  // Assistant messages with only tool calls (no text) are tool-only turns.
  // These are not meaningful for a human-readable transcript.
  if (acc.hasNonTextParts) return null;

  // No content at all (e.g. message was created but never had parts — perhaps
  // due to a crash mid-stream). Skip.
  return null;
}

function joinTextParts(parts: Map<string, string>): string {
  return [...parts.values()].join('').trim();
}

function extractSummaryBody(info: UserInfo | AssistantInfo | null): string | null {
  if (!info || info.role !== 'user') return null;
  // info.summary is typed as { title?: string; body?: string } | undefined
  const parsed = UserMessageSummary.safeParse(info.summary);
  if (!parsed.success) return null;
  return parsed.data.body ?? null;
}
