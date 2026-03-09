/**
 * Connection management for the long-running wrapper.
 *
 * Handles:
 * - Ingest WebSocket connection (for sending events to DO)
 * - SSE consumer (for receiving events from kilo server)
 *
 * Connections are opened on-demand when the wrapper transitions from IDLE to ACTIVE,
 * and closed when transitioning back to IDLE (after drain period).
 */

import type { WrapperState } from './state.js';
import type { IngestEvent, WrapperCommand } from '../../src/shared/protocol.js';
import { trimPayload } from '../../src/shared/trim-payload.js';
import { createSSEConsumer, isTerminalErrorEvent, type SSEConsumer } from './sse-consumer.js';
import { logToFile } from './utils.js';
import type { KiloClient } from './kilo-client.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Type guard for session.idle events.
 * Kilo server sends: {type: "session.idle", properties: {sessionID: "..."}}
 * After mapping: {type: "session.idle", properties: {sessionID: "..."}, event: "session.idle"}
 */
export function isSessionIdleEvent(
  data: unknown
): data is { event: 'session.idle'; properties: { sessionID: string } } {
  if (!isRecord(data)) return false;
  if (data.event !== 'session.idle') return false;
  const props = data.properties;
  return isRecord(props) && typeof props.sessionID === 'string';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionConfig = {
  kiloServerPort: number;
  kiloClient: KiloClient;
};

export type ConnectionCallbacks = {
  /** Called when a completion event is detected for a message */
  onMessageComplete: (messageId: string) => void;
  /** Called when a terminal error is detected */
  onTerminalError: (reason: string) => void;
  /** Called when a command is received from DO */
  onCommand: (cmd: WrapperCommand) => void;
  /** Called when the connection unexpectedly closes */
  onDisconnect: (reason: string) => void;
  /** Called on any completion event to signal post-processing waiters */
  onCompletionSignal: () => void;
  /** Called when the ingest WS starts reconnecting */
  onReconnecting?: (attempt: number) => void;
  /** Called when the ingest WS successfully reconnects */
  onReconnected?: () => void;
};

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

/** Maximum number of reconnection attempts before giving up.
 *  3 attempts ≈ 7s total (1+2+4), fitting within the DO's 10s grace period. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay for exponential backoff (1 second) */
const RECONNECT_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Connection Manager
// ---------------------------------------------------------------------------

export type ConnectionManager = {
  /** Open ingest WS and SSE consumer. Resolves when both are connected. */
  open: () => Promise<void>;
  /** Close both connections gracefully. */
  close: () => Promise<void>;
  /** Check if currently connected. */
  isConnected: () => boolean;
  /** Whether the ingest WS is currently attempting to reconnect */
  isReconnecting: () => boolean;
};

/**
 * Create a connection manager that handles ingest WS and SSE consumer.
 *
 * The connections are stored in WrapperState for reference, but actual
 * management (open/close) happens here.
 */
export function createConnectionManager(
  state: WrapperState,
  config: ConnectionConfig,
  callbacks: ConnectionCallbacks
): ConnectionManager {
  let sseConsumer: SSEConsumer | null = null;
  let ingestWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  let closedByUs = false;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  // Event buffer for disconnection periods
  const MAX_BUFFER_SIZE = 1000;
  const eventBuffer: IngestEvent[] = [];
  let bufferOverflowed = false;

  /**
   * Send an event to the ingest WebSocket.
   * Buffers events if disconnected.
   */
  function sendToIngest(event: IngestEvent): void {
    if (ingestWs && ingestWs.readyState === WebSocket.OPEN) {
      ingestWs.send(JSON.stringify(event));
    } else {
      // Buffer events while disconnected
      if (eventBuffer.length < MAX_BUFFER_SIZE) {
        eventBuffer.push(event);
      } else {
        bufferOverflowed = true;
      }
    }
  }

  /**
   * Flush buffered events after reconnection.
   */
  function flushBuffer(): void {
    if (!ingestWs || ingestWs.readyState !== WebSocket.OPEN) return;

    // Send resume marker so DO knows we may have lost events
    if (eventBuffer.length > 0 || bufferOverflowed) {
      ingestWs.send(
        JSON.stringify({
          streamEventType: 'wrapper_resumed',
          timestamp: new Date().toISOString(),
          data: { bufferedEvents: eventBuffer.length, eventsLost: bufferOverflowed },
        })
      );
    }

    // Flush buffer
    for (const event of eventBuffer) {
      ingestWs.send(JSON.stringify(event));
    }
    eventBuffer.length = 0;
    bufferOverflowed = false;
  }

  /**
   * Open the ingest WebSocket connection.
   * @param expectedGeneration If provided, the connection is only accepted when
   *   `generation` still matches. This prevents a stale reconnect from assigning
   *   `ingestWs` and flushing buffered events after `close()` was called.
   */
  async function openIngestWs(expectedGeneration?: number): Promise<void> {
    const job = state.currentJob;
    if (!job) {
      throw new Error('Cannot open ingest WS: no job context');
    }

    const url = new URL(job.ingestUrl);
    url.searchParams.set('executionId', job.executionId);
    url.searchParams.set('sessionId', job.sessionId);
    url.searchParams.set('userId', job.userId);

    const wsUrl = url.toString();
    logToFile(`ingest WS connecting to: ${wsUrl}`);

    return new Promise<void>((resolve, reject) => {
      // Bun's WebSocket supports headers parameter
      const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;

      // Use kilocodeToken (user JWT) for auth - ingestToken is just executionId for DO validation
      const ws = new WebSocketWithHeaders(wsUrl, {
        headers: {
          Authorization: `Bearer ${job.kilocodeToken}`,
        },
      });

      ws.onopen = () => {
        logToFile(`ingest WS connected to: ${wsUrl}`);
        // Guard against stale reconnect: if close() was called while we were
        // connecting, generation will have advanced and we must not adopt
        // this socket or flush buffered events through it.
        if (expectedGeneration !== undefined && expectedGeneration !== generation) {
          logToFile('stale reconnect detected in onopen — discarding socket');
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Stale reconnect'));
          return;
        }
        ingestWs = ws;
        flushBuffer();
        resolve();
      };

      ws.onclose = (event: CloseEvent) => {
        logToFile(
          `ingest WS closed: code=${event.code} reason=${event.reason || '(none)'} url=${wsUrl}`
        );
        if (ingestWs !== ws) return; // Stale socket — ignore

        ingestWs = null;

        if (closedByUs) {
          // Expected close (during drain/shutdown) — don't reconnect
          closedByUs = false;
          return;
        }

        // Unexpected close — attempt reconnection
        logToFile('ingest WS closed unexpectedly — starting reconnection');
        stopHeartbeat();
        attemptReconnect();
      };

      ws.onerror = () => {
        logToFile(`ingest WS error connecting to: ${wsUrl}`);
        if (!ingestWs) {
          reject(new Error(`Failed to connect to ingest: ${wsUrl}`));
        }
      };

      ws.onmessage = event => {
        try {
          const cmd = JSON.parse(String(event.data)) as WrapperCommand;
          callbacks.onCommand(cmd);
        } catch {
          // Ignore parse errors
        }
      };

      // Timeout for initial connection
      setTimeout(() => {
        if (!ingestWs) {
          ws.close();
          reject(new Error('Ingest connection timeout'));
        }
      }, 10_000);
    });
  }

  /**
   * Open the SSE consumer for kilo server events.
   */
  async function openSSEConsumer(): Promise<void> {
    const baseUrl = `http://127.0.0.1:${config.kiloServerPort}`;
    const abortController = new AbortController();

    sseConsumer = await createSSEConsumer({
      baseUrl,
      onActivity: () => {
        // Called for ALL SSE events including heartbeats - for activity tracking
        state.updateActivity();
        state.recordSseEvent();
      },
      onEvent: (event: IngestEvent) => {
        // Trim large payloads before forwarding to reduce DO storage pressure
        const trimmed: IngestEvent = {
          ...event,
          data: trimPayload(event.streamEventType, event.data),
        };
        sendToIngest(trimmed);

        // Check for terminal errors
        if (event.streamEventType === 'kilocode') {
          const data = event.data as Record<string, unknown>;
          const eventName = typeof data.event === 'string' ? data.event : '';

          // Track the last root-session assistant message ID for autocommit association.
          // message.updated events carry { event, properties: { info: { id, role, sessionID } } }
          if (eventName === 'message.updated') {
            const props = data.properties;
            if (isRecord(props)) {
              const info = props.info;
              if (isRecord(info) && info.role === 'assistant' && typeof info.id === 'string') {
                const msgSessionId = info.sessionID;
                const currentSessionId = state.currentJob?.kiloSessionId;
                if (!currentSessionId || msgSessionId === currentSessionId) {
                  state.setLastAssistantMessageId(info.id);
                }
              }
            }
          }

          const terminal = isTerminalErrorEvent({ event: eventName, data });
          if (terminal.isTerminal) {
            callbacks.onTerminalError(terminal.reason ?? 'terminal error');
            return;
          }

          // Auto-reject permission requests — Cloud Agent has no UI to answer them,
          // so unanswered permissions would block the session indefinitely.
          if (data.event === 'permission.asked') {
            const props = data.properties;
            if (isRecord(props) && typeof props.id === 'string') {
              const permission =
                typeof props.permission === 'string' ? props.permission : 'unknown';
              logToFile(`auto-rejecting permission: id=${props.id} permission=${permission}`);
              config.kiloClient
                .answerPermission(props.id, 'reject')
                .catch((err: unknown) =>
                  logToFile(
                    `failed to auto-reject permission ${String(props.id)}: ${err instanceof Error ? err.message : String(err)}`
                  )
                );
            }
          }

          // session.idle is the primary completion signal - it means the assistant finished
          // and the session is waiting for the next user input.
          // Only the root session's idle event should trigger completion — child sessions
          // (subagents) also emit session.idle, which we must ignore.
          if (data.event === 'session.idle') {
            if (!isSessionIdleEvent(data)) {
              logToFile(`session.idle without parseable sessionID — ignoring`);
              return;
            }
            const currentSessionId = state.currentJob?.kiloSessionId;
            if (currentSessionId && data.properties.sessionID !== currentSessionId) {
              logToFile(
                `ignoring session.idle for child session: event=${data.properties.sessionID} current=${currentSessionId}`
              );
              return;
            }
            logToFile(`session.idle received - marking all inflight as complete`);
            // Complete ALL inflight messages for this job - the session is idle
            const inflightIds = state.inflightMessageIds;
            for (const messageId of inflightIds) {
              logToFile(`completing inflight messageId=${messageId}`);
              callbacks.onMessageComplete(messageId);
            }
            callbacks.onCompletionSignal();
          }
        }
      },
      onConnected: () => {
        logToFile('SSE consumer connected');
      },
      onClose: reason => {
        logToFile(`SSE consumer closed: ${reason}`);
        if (sseConsumer) {
          callbacks.onDisconnect(`SSE closed: ${reason}`);
        }
      },
      onError: error => {
        logToFile(`SSE consumer error: ${error.message}`);
      },
    });

    // Store abort controller in state (ingestWs is guaranteed set after openIngestWs resolves)
    if (!ingestWs) {
      throw new Error('ingestWs not set after openIngestWs');
    }
    state.setConnections(ingestWs, abortController);
    state.setSendToIngestFn(sendToIngest);
  }

  /**
   * Start heartbeat interval.
   */
  function startHeartbeat(): void {
    const job = state.currentJob;
    if (!job) return;

    heartbeatInterval = setInterval(() => {
      if (ingestWs?.readyState === WebSocket.OPEN) {
        ingestWs.send(
          JSON.stringify({
            streamEventType: 'heartbeat',
            data: { executionId: job.executionId },
            timestamp: new Date().toISOString(),
          })
        );
      }
    }, 20_000);
  }

  /**
   * Stop heartbeat interval.
   */
  function stopHeartbeat(): void {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  function attemptReconnect(): void {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempt = 0;
    scheduleReconnect();
  }

  function completeReconnect(): void {
    logToFile(`reconnected successfully on attempt ${reconnectAttempt}`);
    reconnecting = false;
    reconnectAttempt = 0;
    startHeartbeat();
    const sseAbort = state.sseAbortController;
    if (ingestWs && sseAbort) {
      state.setConnections(ingestWs, sseAbort);
    }
    callbacks.onReconnected?.();
  }

  function discardStaleReconnect(): void {
    logToFile('reconnect succeeded but connection was closed — discarding stale socket');
    if (ingestWs) {
      try {
        ingestWs.close();
      } catch {
        /* ignore */
      }
      ingestWs = null;
    }
  }

  function scheduleReconnect(): void {
    reconnectAttempt++;
    if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      logToFile(`reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts — giving up`);
      reconnecting = false;
      reconnectAttempt = 0;
      callbacks.onDisconnect('ingest websocket closed (reconnection failed)');
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt - 1);
    logToFile(`reconnect attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    callbacks.onReconnecting?.(reconnectAttempt);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const gen = generation;
      openIngestWs(gen)
        .then(() => {
          if (gen !== generation) {
            discardStaleReconnect();
            return;
          }
          completeReconnect();
        })
        .catch((err: unknown) => {
          if (gen !== generation) return;
          const msg = err instanceof Error ? err.message : String(err);
          logToFile(`reconnect attempt ${reconnectAttempt} failed: ${msg}`);
          scheduleReconnect();
        });
    }, delay);
  }

  function cancelReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting = false;
    reconnectAttempt = 0;
  }

  return {
    open: async () => {
      logToFile('opening connections');

      // Open both connections
      await openIngestWs();
      await openSSEConsumer();

      // Start heartbeat
      startHeartbeat();

      logToFile('connections opened');
    },

    close: async () => {
      logToFile('closing connections');
      generation++;
      cancelReconnect();
      stopHeartbeat();

      // Stop SSE consumer
      if (sseConsumer) {
        sseConsumer.stop();
        sseConsumer = null;
      }

      // Close ingest WS
      if (ingestWs) {
        closedByUs = true;
        try {
          ingestWs.close();
        } catch {
          // Ignore close errors
        }
        ingestWs = null;
      }
      closedByUs = false;

      // Clear state references
      state.clearConnections();
      state.setSendToIngestFn(null);

      logToFile('connections closed');
    },

    isConnected: () => {
      return ingestWs !== null && ingestWs.readyState === WebSocket.OPEN && sseConsumer !== null;
    },

    isReconnecting: () => reconnecting,
  };
}
