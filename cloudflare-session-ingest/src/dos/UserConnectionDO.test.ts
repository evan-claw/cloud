import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cloudflare:workers before importing UserConnectionDO
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { UserConnectionDO } from './UserConnectionDO';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type MockWS = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  _attachment: unknown;
  _tags: string[];
  serializeAttachment(att: unknown): void;
  deserializeAttachment(): unknown;
};

function createMockWs(tags: string[] = [], attachment?: unknown): MockWS {
  const ws: MockWS = {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    _attachment: attachment ?? null,
    _tags: tags,
    serializeAttachment(att: unknown) {
      ws._attachment = att;
    },
    deserializeAttachment() {
      return ws._attachment;
    },
  };
  return ws;
}

// ---------------------------------------------------------------------------
// Mock DurableObjectState (this.ctx)
// ---------------------------------------------------------------------------

function createMockCtx() {
  const sockets: MockWS[] = [];
  return {
    sockets,
    addSocket(ws: MockWS) {
      sockets.push(ws);
    },
    removeSocket(ws: MockWS) {
      const idx = sockets.indexOf(ws);
      if (idx !== -1) sockets.splice(idx, 1);
    },
    // Builds the ctx object passed to the DO constructor
    build() {
      return {
        getWebSockets(tag?: string): MockWS[] {
          if (!tag) return [...sockets];
          return sockets.filter(ws => ws._tags.includes(tag));
        },
        acceptWebSocket(ws: MockWS, tags: string[]) {
          ws._tags = tags;
          sockets.push(ws);
        },
        getTags(ws: MockWS) {
          return ws._tags;
        },
        storage: {
          setAlarm: vi.fn(),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, status = 'busy', title = 'Test') {
  return { id, status, title };
}

function parseSent(ws: MockWS, callIndex = 0): unknown {
  const call = ws.send.mock.calls[callIndex];
  if (!call) throw new Error(`No send call at index ${callIndex}`);
  return JSON.parse(call[0] as string);
}

function allSent(ws: MockWS): unknown[] {
  return ws.send.mock.calls.map(c => JSON.parse(c[0] as string));
}

/** Instantiate a fresh DO with a mock context. Returns the DO and helpers. */
function setup() {
  const mockCtx = createMockCtx();
  const ctx = mockCtx.build();
  const doInstance = new UserConnectionDO(ctx as never, {} as never);
  return { doInstance, ctx, mockCtx };
}

/** Create a CLI WebSocket and add it to the context with proper attachment. */
function addCliSocket(
  mockCtx: ReturnType<typeof createMockCtx>,
  connectionId: string,
  sessions: Array<{ id: string; status: string; title: string }> = []
): MockWS {
  const attachment = { role: 'cli' as const, connectionId, sessions };
  const ws = createMockWs(['cli'], attachment);
  mockCtx.addSocket(ws);
  return ws;
}

/** Create a web WebSocket and add it to the context. */
function addWebSocket(
  mockCtx: ReturnType<typeof createMockCtx>,
  connectionId = 'web-1',
  subscribedSessions: string[] = []
): MockWS {
  const attachment = { role: 'web' as const, connectionId, subscribedSessions };
  const ws = createMockWs(['web'], attachment);
  mockCtx.addSocket(ws);
  return ws;
}

/** Send a heartbeat from a CLI ws */
function sendHeartbeat(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  sessions: Array<{ id: string; status: string; title: string }>
) {
  const msg = JSON.stringify({ type: 'heartbeat', sessions });
  doInstance.webSocketMessage(cliWs as never, msg);
}

/** Send a subscribe from a web ws */
function sendSubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'subscribe', sessionId });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send an unsubscribe from a web ws */
function sendUnsubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'unsubscribe', sessionId });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a command from a web ws */
function sendCommand(
  doInstance: UserConnectionDO,
  webWs: MockWS,
  opts: { id: string; command: string; sessionId?: string; connectionId?: string; data?: unknown }
) {
  const msg = JSON.stringify({ type: 'command', ...opts });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a response from a CLI ws */
function sendCliResponse(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  opts: { id: string; result?: unknown; error?: unknown }
) {
  const msg = JSON.stringify({ type: 'response', ...opts });
  doInstance.webSocketMessage(cliWs as never, msg);
}

/** Trigger CLI disconnect */
function disconnectCli(doInstance: UserConnectionDO, cliWs: MockWS) {
  doInstance.webSocketClose(cliWs as never, 0, '', false);
}

/** Trigger web disconnect */
function disconnectWeb(doInstance: UserConnectionDO, webWs: MockWS) {
  doInstance.webSocketClose(webWs as never, 0, '', false);
}

// ===========================================================================
// Tests
// ===========================================================================

describe('UserConnectionDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Heartbeat processing
  // -------------------------------------------------------------------------

  describe('heartbeat processing', () => {
    it('updates session ownership and broadcasts to web clients', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      const sessions = [makeSession('s1'), makeSession('s2')];
      sendHeartbeat(doInstance, cliWs, sessions);

      // Web should receive sessions.heartbeat system message
      expect(webWs.send).toHaveBeenCalledTimes(1);
      const sent = parseSent(webWs);
      expect(sent).toEqual({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', sessions },
      });

      // CLI attachment updated with sessions
      const att = cliWs.deserializeAttachment() as { sessions: unknown[] };
      expect(att.sessions).toEqual(sessions);
    });

    it('removes session ownership when session disappears from heartbeat', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      addWebSocket(mockCtx, 'web-1');

      // First heartbeat: owns s1 and s2
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);

      // Second heartbeat: only s1
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Verify via command routing: command to s2 should fail (no owner)
      const webWs2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, webWs2, { id: 'cmd-1', command: 'test', sessionId: 's2' });
      const resp = parseSent(webWs2);
      expect(resp).toMatchObject({
        type: 'response',
        id: 'cmd-1',
        error: 'Session owner not found',
      });
    });

    it('schedules stale alarm on heartbeat', () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stale connection eviction
  // -------------------------------------------------------------------------

  describe('stale connection eviction', () => {
    it('closes stale connection after timeout', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Send heartbeat to register the connection and set lastHeartbeatAt
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Fast-forward time so the connection appears stale
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(Date.now() + 31_000) // for ensureState check
        .mockReturnValue(Date.now() + 31_000); // for alarm's Date.now()

      await doInstance.alarm();

      expect(cliWs.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
    });

    it('reschedules alarm if other live connections remain', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const staleCli = addCliSocket(mockCtx, 'stale-1');
      const freshCli = addCliSocket(mockCtx, 'fresh-1');

      // Both send heartbeats
      sendHeartbeat(doInstance, staleCli, [makeSession('s1')]);
      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);

      // Reset setAlarm call count
      ctx.storage.setAlarm.mockClear();

      // Make stale-1 appear stale but fresh-1 stays fresh
      const now = Date.now();
      const staleTime = now + 31_000;
      vi.spyOn(Date, 'now').mockReturnValue(staleTime);

      // Manually set lastHeartbeatAt for fresh-1 to "just now" (staleTime)
      // by sending another heartbeat from fresh-1
      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);
      ctx.storage.setAlarm.mockClear();

      await doInstance.alarm();

      // Stale one closed
      expect(staleCli.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      // Fresh one alive
      expect(freshCli.close).not.toHaveBeenCalled();
      // Alarm rescheduled because fresh-1 remains
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });

    it('does not evict connection with recent heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Time is within timeout window
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      await doInstance.alarm();

      expect(cliWs.close).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // -------------------------------------------------------------------------

  describe('subscribe/unsubscribe', () => {
    it('sends subscribe to owning CLI when web subscribes', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // CLI owns s1
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, webWs, 's1');

      // CLI should receive subscribe
      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('broadcasts subscribe to all CLIs when no owner found', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // No heartbeat sent, so no owner for 's1'
      // Trigger ensureState via a harmless message first
      sendSubscribe(doInstance, webWs, 's1');

      // Both CLIs should receive subscribe
      expect(cli1.send).toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli1)).toEqual({ type: 'subscribe', sessionId: 's1' });
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('duplicate subscribe is idempotent for attachment', () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendSubscribe(doInstance, webWs, 's1');
      sendSubscribe(doInstance, webWs, 's1');

      const att = webWs.deserializeAttachment() as { subscribedSessions: string[] };
      expect(att.subscribedSessions).toEqual(['s1']);
    });

    it('unsubscribe sends to CLI when last subscriber leaves', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      sendUnsubscribe(doInstance, webWs, 's1');

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({ type: 'unsubscribe', sessionId: 's1' });
    });

    it('unsubscribe does not send to CLI when other subscribers remain', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, web1, 's1');
      sendSubscribe(doInstance, web2, 's1');
      cliWs.send.mockClear();

      // Unsubscribe first — CLI should NOT get unsubscribe
      sendUnsubscribe(doInstance, web1, 's1');
      expect(cliWs.send).not.toHaveBeenCalled();

      // Unsubscribe second — CLI SHOULD get unsubscribe
      sendUnsubscribe(doInstance, web2, 's1');
      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({ type: 'unsubscribe', sessionId: 's1' });
    });
  });

  // -------------------------------------------------------------------------
  // CLI disconnect
  // -------------------------------------------------------------------------

  describe('CLI disconnect', () => {
    it('cleans up session ownership and broadcasts cli.disconnected', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      // Remove from sockets before disconnect (simulates runtime closing)
      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

      // Web receives cli.disconnected
      expect(webWs.send).toHaveBeenCalled();
      const msgs = allSent(webWs);
      const disconnectMsg = msgs.find(
        (m: any) => m.type === 'system' && m.event === 'cli.disconnected'
      );
      expect(disconnectMsg).toEqual({
        type: 'system',
        event: 'cli.disconnected',
        data: { connectionId: 'cli-1' },
      });

      // Session no longer routable
      const web2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, web2, { id: 'cmd-1', command: 'test', sessionId: 's1' });
      expect(parseSent(web2)).toMatchObject({ type: 'response', error: 'Session owner not found' });
    });

    it('sends error responses for pending commands on disconnect', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Send command from web
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'test', sessionId: 's1' });
      webWs.send.mockClear();

      // CLI disconnects
      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

      // Web receives error response
      const msgs = allSent(webWs);
      const errorResp = msgs.find((m: any) => m.type === 'response' && m.id === 'cmd-1');
      expect(errorResp).toMatchObject({ type: 'response', id: 'cmd-1', error: 'CLI disconnected' });
    });

    it('reconnecting CLI — old socket close does not destroy state', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      // CLI2 connects with same connectionId (simulates reconnect)
      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // CLI1's close event fires (stale socket), but cli2 still holds the connectionId
      // DON'T remove cli2 from sockets — cli2 is the replacement
      // Just remove cli1 to simulate it being closed
      mockCtx.removeSocket(cli1);
      disconnectCli(doInstance, cli1);

      // State should NOT be cleaned up — cli2 is live
      // Verify by routing a command to s1 — should reach cli2
      cli2.send.mockClear();
      sendSubscribe(doInstance, webWs, 's1');
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });
  });

  // -------------------------------------------------------------------------
  // Web disconnect
  // -------------------------------------------------------------------------

  describe('web disconnect', () => {
    it('removes from all subscription sets', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      sendSubscribe(doInstance, webWs, 's1');
      sendSubscribe(doInstance, webWs, 's2');

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // Verify: CLI events for s1 and s2 go nowhere (no crash)
      const cliEventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, cliEventMsg);
      // No web sockets to receive the event — no crash = success
    });

    it('sends unsubscribe to CLI when last subscriber leaves', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // CLI should get unsubscribe for s1
      const msgs = allSent(cliWs);
      const unsub = msgs.find((m: any) => m.type === 'unsubscribe');
      expect(unsub).toEqual({ type: 'unsubscribe', sessionId: 's1' });
    });

    it('cleans up pending commands from disconnecting web socket', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'test', sessionId: 's1' });

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // CLI sends response, but the pending command is gone — no crash
      sendCliResponse(doInstance, cliWs, { id: 'cmd-1', result: 'ok' });
      // webWs.send should NOT have been called after disconnect
      // (all calls before disconnect are from subscription messages)
    });
  });

  // -------------------------------------------------------------------------
  // Command routing
  // -------------------------------------------------------------------------

  describe('command routing', () => {
    it('routes web command to correct CLI by sessionId', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        data: { text: 'hello' },
      });

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'command',
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        data: { text: 'hello' },
      });
    });

    it('routes CLI response to correct web socket', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'test', sessionId: 's1' });
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, { id: 'cmd-1', result: { success: true } });

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: { success: true },
      });
    });

    it('returns error when CLI not found for session', () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'test',
        sessionId: 'unknown-session',
      });

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'Session owner not found',
      });
    });

    it('routes command by connectionId to specific CLI', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Trigger ensureState
      sendHeartbeat(doInstance, cli1, []);
      sendHeartbeat(doInstance, cli2, []);
      cli1.send.mockClear();
      cli2.send.mockClear();

      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'test',
        connectionId: 'cli-2',
      });

      expect(cli1.send).not.toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalledTimes(1);
    });

    it('routes to first CLI when no sessionId or connectionId given', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();

      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'test' });
      expect(cliWs.send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // CLI event forwarding
  // -------------------------------------------------------------------------

  describe('CLI event forwarding', () => {
    it('forwards events to subscribed web sockets only', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, subWeb, 's1');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      // CLI sends event for s1
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(subWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(subWeb)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      expect(otherWeb.send).not.toHaveBeenCalled();
    });

    it('routes child event to parent session subscribers via parentSessionId', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      sendSubscribe(doInstance, webWs, 'parent-session');
      webWs.send.mockClear();

      // CLI sends event for a child session with parentSessionId
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
    });

    it('drops child event when neither sessionId nor parentSessionId has subscribers', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('other-session')]);
      sendSubscribe(doInstance, webWs, 'other-session');
      webWs.send.mockClear();

      // Child event with parent that nobody subscribes to
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'unknown-parent',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('events without parentSessionId still route normally (backward compat)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
    });

    it('child event does not include parentSessionId when not set', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'session.status',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      const sent = parseSent(webWs);
      expect(sent).not.toHaveProperty('parentSessionId');
    });
  });

  // -------------------------------------------------------------------------
  // Broadcast resilience
  // -------------------------------------------------------------------------

  describe('broadcast resilience', () => {
    it('one closed socket does not abort broadcast to others', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const failWeb = addWebSocket(mockCtx, 'web-fail');
      const okWeb = addWebSocket(mockCtx, 'web-ok');

      // Make failWeb throw on send
      failWeb.send.mockImplementation(() => {
        throw new Error('socket closed');
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // okWeb should still receive the message
      expect(okWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(okWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Hibernation recovery (ensureState)
  // -------------------------------------------------------------------------

  describe('ensureState (hibernation recovery)', () => {
    it('reconstructs sessionOwners and connectionSessions from CLI attachments', () => {
      const { doInstance, mockCtx } = setup();

      // Simulate hibernation: sockets exist with pre-set attachments
      const sessions = [makeSession('s1'), makeSession('s2')];
      addCliSocket(mockCtx, 'cli-1', sessions);
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Trigger ensureState by calling any method (e.g., webSocketMessage with subscribe)
      sendSubscribe(doInstance, webWs, 's1');

      // Verify state was reconstructed by routing a command
      const web2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, web2, { id: 'cmd-1', command: 'test', sessionId: 's1' });

      // Should route to cli-1 (not "Session owner not found")
      const cliWs = mockCtx.sockets.find(s => s._tags.includes('cli'));
      expect(cliWs?.send).toHaveBeenCalled();
      const cliMsgs = allSent(cliWs!);
      const cmdMsg = cliMsgs.find((m: any) => m.type === 'command');
      expect(cmdMsg).toMatchObject({ type: 'command', id: 'cmd-1' });
    });

    it('reconstructs webSubscriptions from web attachments', () => {
      const { doInstance, mockCtx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('s1')]);
      // Web socket with pre-existing subscription (from hibernation)
      const webWs = addWebSocket(mockCtx, 'web-1', ['s1']);

      // Trigger ensureState by calling any method
      const triggerMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'test',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, triggerMsg);

      // webWs should have received the event because it was subscribed via attachment
      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toMatchObject({
        type: 'event',
        sessionId: 's1',
      });
    });
  });

  // -------------------------------------------------------------------------
  // getActiveSessions RPC
  // -------------------------------------------------------------------------

  describe('getActiveSessions', () => {
    it('returns sessions from live CLI connections', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('s1', 'busy', 'Fix bug'),
        makeSession('s2', 'idle', 'Review PR'),
      ]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        { id: 's1', status: 'busy', title: 'Fix bug', connectionId: 'cli-1' },
        { id: 's2', status: 'idle', title: 'Review PR', connectionId: 'cli-1' },
      ]);
    });

    it('excludes sessions from stale connections without live sockets', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Remove from sockets (simulates close)
      mockCtx.removeSocket(cliWs);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('ignores non-JSON messages', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Should not throw
      doInstance.webSocketMessage(cliWs as never, 'not-json');
    });

    it('ignores messages from socket with no attachment', () => {
      const { doInstance, mockCtx } = setup();
      const ws = createMockWs(['cli'], null);
      mockCtx.addSocket(ws);

      // Trigger ensureState first
      doInstance.webSocketMessage(ws as never, JSON.stringify({ type: 'heartbeat', sessions: [] }));
      // Should not throw
    });

    it('ignores messages that fail Zod validation', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []); // trigger ensureState

      // Invalid CLI message
      const badMsg = JSON.stringify({ type: 'invalid_type' });
      doInstance.webSocketMessage(cliWs as never, badMsg);
      // Should not throw

      // Invalid web message
      const webWs = addWebSocket(mockCtx, 'web-1');
      doInstance.webSocketMessage(webWs as never, badMsg);
      // Should not throw
    });

    it('webSocketError triggers webSocketClose', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      // Remove CLI so disconnect can clean up
      mockCtx.removeSocket(cliWs);
      doInstance.webSocketError(cliWs as never);

      // Should broadcast cli.disconnected
      const msgs = allSent(webWs);
      expect(msgs.some((m: any) => m.event === 'cli.disconnected')).toBe(true);
    });

    it('CLI response for unknown correlation ID is a no-op', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []);

      // Should not throw
      sendCliResponse(doInstance, cliWs, { id: 'nonexistent', result: 'ok' });
    });
  });
});
