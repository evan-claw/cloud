import { describe, expect, test } from '@jest/globals';
import { createStore } from 'jotai';
import type { StoredMessage, TextPart } from '../types';
import { isAssistantMessage } from '../types';
import { messagesMapAtom, updateMessageAtom } from './atoms';

const createMessageInfo = (
  overrides: Partial<Extract<StoredMessage['info'], { role: 'assistant' }>> = {}
): Extract<StoredMessage['info'], { role: 'assistant' }> => ({
  id: 'message-1',
  sessionID: 'session-1',
  role: 'assistant',
  time: {
    created: 1,
  },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  parentID: 'parent-1',
  modelID: 'model',
  providerID: 'provider',
  mode: 'code',
  agent: 'code',
  path: {
    cwd: '/tmp',
    root: '/tmp',
  },
  ...overrides,
});

const createTextPart = (overrides: Partial<TextPart> = {}): TextPart => ({
  type: 'text',
  id: 'part-1',
  sessionID: 'session-1',
  messageID: 'message-1',
  text: 'Rendered text',
  time: {
    start: 1,
    end: 2,
  },
  ...overrides,
});

describe('updateMessageAtom', () => {
  test('preserves existing parts when an existing message receives empty parts', () => {
    const store = createStore();
    const existingPart = createTextPart();

    store.set(
      messagesMapAtom,
      new Map([
        [
          'message-1',
          {
            info: createMessageInfo(),
            parts: [existingPart],
          },
        ],
      ])
    );

    store.set(updateMessageAtom, {
      messageId: 'message-1',
      info: createMessageInfo({
        time: {
          created: 1,
          completed: 3,
        },
      }),
      parts: [],
    });

    const updatedMessage = store.get(messagesMapAtom).get('message-1');

    expect(updatedMessage?.parts).toEqual([existingPart]);
    expect(
      updatedMessage &&
        isAssistantMessage(updatedMessage.info) &&
        updatedMessage.info.time.completed
    ).toBe(3);
  });
});
