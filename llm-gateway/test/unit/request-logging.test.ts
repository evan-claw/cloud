// Tests for background/request-logging: isKiloEmployee guard and DB insert.

import { describe, it, expect, vi } from 'vitest';
import { runRequestLogging } from '../../src/background/request-logging';

function makeDb(
  insertMock = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'log-1' }]),
    }),
  })
) {
  return { insert: insertMock } as unknown as import('@kilocode/db/client').WorkerDb;
}

function emptyStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('test response'));
      controller.close();
    },
  });
}

describe('runRequestLogging', () => {
  it('skips non-Kilo employees', async () => {
    const insertMock = vi.fn();
    const db = makeDb(insertMock);
    await runRequestLogging({
      db,
      responseStream: emptyStream(),
      statusCode: 200,
      user: { id: 'user-1', google_user_email: 'user@gmail.com' },
      organizationId: null,
      provider: 'openrouter',
      model: 'test',
      request: { model: 'test', messages: [] },
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('logs for @kilo.ai employees', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'log-1' }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const db = makeDb(insertMock);
    await runRequestLogging({
      db,
      responseStream: emptyStream(),
      statusCode: 200,
      user: { id: 'user-1', google_user_email: 'dev@kilo.ai' },
      organizationId: null,
      provider: 'openrouter',
      model: 'test-model',
      request: { model: 'test-model', messages: [] },
    });
    expect(insertMock).toHaveBeenCalled();
  });

  it('logs for @kilocode.ai employees', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'log-1' }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const db = makeDb(insertMock);
    await runRequestLogging({
      db,
      responseStream: emptyStream(),
      statusCode: 200,
      user: { id: 'user-1', google_user_email: 'dev@kilocode.ai' },
      organizationId: null,
      provider: 'openrouter',
      model: 'test-model',
      request: { model: 'test-model', messages: [] },
    });
    expect(insertMock).toHaveBeenCalled();
  });

  it('logs for Kilo organization ID', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'log-1' }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const db = makeDb(insertMock);
    await runRequestLogging({
      db,
      responseStream: emptyStream(),
      statusCode: 200,
      user: { id: 'user-1', google_user_email: 'user@random.com' },
      organizationId: '9d278969-5453-4ae3-a51f-a8d2274a7b56',
      provider: 'openrouter',
      model: 'test-model',
      request: { model: 'test-model', messages: [] },
    });
    expect(insertMock).toHaveBeenCalled();
  });

  it('handles DB insert failure gracefully', async () => {
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
    });
    const db = makeDb(insertMock);
    // Should not throw
    await runRequestLogging({
      db,
      responseStream: emptyStream(),
      statusCode: 200,
      user: { id: 'user-1', google_user_email: 'dev@kilo.ai' },
      organizationId: null,
      provider: 'openrouter',
      model: 'test-model',
      request: { model: 'test-model', messages: [] },
    });
  });
});
