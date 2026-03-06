import type { Message, SerializedThread, StateAdapter, Thread } from 'chat';
import { LINK_TOKEN_TTL_SECONDS } from '@/lib/bot-identity';

const PENDING_LINK_REPLAY_KEY_PREFIX = 'bot:pending-link-replay';
const PENDING_LINK_REPLAY_TTL_MS = LINK_TOKEN_TTL_SECONDS * 1000;
const PENDING_LINK_REPLAY_LOCK_TTL_MS = 10_000;

export type PendingLinkReplayContext = {
  message: Message;
  thread: Thread;
};

function getPendingLinkReplayKey(token: string): string {
  return `${PENDING_LINK_REPLAY_KEY_PREFIX}:${token}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isThread(value: unknown): value is Thread {
  return (
    isRecord(value) &&
    typeof value.channelId === 'string' &&
    typeof value.createSentMessageFromMessage === 'function' &&
    typeof value.id === 'string' &&
    typeof value.post === 'function'
  );
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.threadId === 'string' &&
    typeof value.text === 'string'
  );
}

function hasToJSON<TSerialized>(value: unknown): value is { toJSON(): TSerialized } {
  return isRecord(value) && typeof value.toJSON === 'function';
}

function serializeThread(thread: Thread): SerializedThread {
  if (!hasToJSON<SerializedThread>(thread)) {
    throw new Error('Expected thread to support serialization');
  }

  return thread.toJSON();
}

export async function storePendingLinkReplay(
  state: StateAdapter,
  token: string,
  thread: Thread,
  message: Message
): Promise<void> {
  await state.set(
    getPendingLinkReplayKey(token),
    JSON.stringify({
      thread: serializeThread(thread),
      message: message.toJSON(),
    }),
    PENDING_LINK_REPLAY_TTL_MS
  );
}

export async function consumePendingLinkReplay(
  state: StateAdapter,
  token: string
): Promise<string | null> {
  const key = getPendingLinkReplayKey(token);
  const lock = await state.acquireLock(key, PENDING_LINK_REPLAY_LOCK_TTL_MS);
  if (!lock) return null;

  try {
    const payload = await state.get<string>(key);
    if (!payload) return null;

    await state.delete(key);
    return payload;
  } finally {
    await state.releaseLock(lock);
  }
}

export function deserializePendingLinkReplay(
  payload: string,
  reviver: (key: string, value: unknown) => unknown
): PendingLinkReplayContext {
  const parsed: unknown = JSON.parse(payload, reviver);

  if (!isRecord(parsed) || !isThread(parsed.thread) || !isMessage(parsed.message)) {
    throw new Error('Invalid pending link replay payload');
  }

  return {
    thread: parsed.thread,
    message: parsed.message,
  };
}
