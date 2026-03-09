import { describe, expect, it, vi } from 'vitest';
import { createIngestHandler, type IngestDOContext, type IngestAttachment } from './ingest.js';
import type { EventQueries } from '../session/queries/index.js';
import type { SessionId, ExecutionId } from '../types/ids.js';

const SESSION_ID = 'sess_test' as SessionId;
const EXECUTION_ID = 'exc_test' as ExecutionId;

function createFakeState() {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    getTags: vi.fn().mockReturnValue([]),
  } as unknown as DurableObjectState;
}

function createFakeEventQueries() {
  return {
    insert: vi.fn().mockReturnValue(1),
    findByFilters: vi.fn().mockReturnValue([]),
    deleteOlderThan: vi.fn().mockReturnValue(0),
    iterateByFilters: vi.fn(),
    countByExecutionId: vi.fn(),
    getLatestEventId: vi.fn(),
  } as unknown as EventQueries;
}

function createFakeDOContext(): IngestDOContext {
  return {
    updateKiloSessionId: vi.fn().mockResolvedValue(undefined),
    updateUpstreamBranch: vi.fn().mockResolvedValue(undefined),
    clearActiveExecution: vi.fn().mockResolvedValue(undefined),
    getActiveExecutionId: vi.fn().mockResolvedValue(null),
    getExecution: vi.fn().mockResolvedValue(null),
    transitionToRunning: vi.fn().mockResolvedValue(true),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeWebSocket(attachment: unknown = null) {
  return {
    deserializeAttachment: vi.fn().mockReturnValue(attachment),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as WebSocket;
}

function makeAttachment(overrides?: Partial<IngestAttachment>): IngestAttachment {
  return {
    executionId: EXECUTION_ID,
    connectedAt: Date.now(),
    kiloSessionState: { captured: false },
    lastHeartbeatUpdate: Date.now(),
    ...overrides,
  };
}

describe('createIngestHandler', () => {
  describe('handleIngestClose', () => {
    it('returns null when WebSocket has no attachment', () => {
      const state = createFakeState();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(null);

      expect(handler.handleIngestClose(ws)).toBeNull();
    });

    it('returns executionId when no other ingest sockets remain', () => {
      const state = createFakeState();
      // No remaining sockets for this execution
      vi.mocked(state.getWebSockets).mockReturnValue([]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      expect(handler.handleIngestClose(ws)).toBe(EXECUTION_ID);
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${EXECUTION_ID}`);
    });

    it('returns null when a replacement ingest socket exists', () => {
      const state = createFakeState();
      const replacementWs = createFakeWebSocket();
      // A replacement socket still exists for this execution
      vi.mocked(state.getWebSockets).mockReturnValue([replacementWs]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      expect(handler.handleIngestClose(ws)).toBeNull();
    });

    // The positive case through the full handleIngestRequest → handleIngestClose
    // flow requires WebSocketPair and state.acceptWebSocket — Cloudflare Worker
    // APIs unavailable in vitest Node. That path is covered by integration tests.
  });

  describe('hasActiveConnection', () => {
    it('returns true when getWebSockets finds ingest sockets', () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([createFakeWebSocket()]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      expect(handler.hasActiveConnection(EXECUTION_ID)).toBe(true);
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${EXECUTION_ID}`);
    });

    it('returns false when getWebSockets finds no ingest sockets', () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      expect(handler.hasActiveConnection(EXECUTION_ID)).toBe(false);
    });
  });
});
