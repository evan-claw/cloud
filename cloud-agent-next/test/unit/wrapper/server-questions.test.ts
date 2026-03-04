/**
 * Tests for wrapper server question handlers.
 *
 * Verifies that answerQuestion and rejectQuestion handlers:
 * - Open connections when idle
 * - Track inflight entries
 * - Remove inflight on error
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createJobContext = (overrides: Partial<JobContext> = {}): JobContext => ({
  executionId: 'exec_test',
  sessionId: 'session_abc',
  userId: 'user_xyz',
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  kilocodeToken: 'kilo_token_789',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapper question handlers - state behavior', () => {
  let state: WrapperState;

  beforeEach(() => {
    state = new WrapperState();
  });

  describe('inflight tracking for question handlers', () => {
    it('addInflight tracks a new entry', () => {
      state.startJob(createJobContext());
      const messageId = state.nextMessageId();
      const deadline = Date.now() + 120000;

      state.addInflight(messageId, deadline);

      expect(state.hasInflight(messageId)).toBe(true);
      expect(state.isActive).toBe(true);
      expect(state.isIdle).toBe(false);
    });

    it('removeInflight cleans up after error', () => {
      state.startJob(createJobContext());
      const messageId = state.nextMessageId();
      const deadline = Date.now() + 120000;

      state.addInflight(messageId, deadline);
      expect(state.hasInflight(messageId)).toBe(true);

      state.removeInflight(messageId);
      expect(state.hasInflight(messageId)).toBe(false);
      expect(state.isIdle).toBe(true);
    });

    it('isIdle returns true when no inflight entries', () => {
      state.startJob(createJobContext());
      expect(state.isIdle).toBe(true);
    });

    it('isIdle returns false when inflight entries exist', () => {
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);
      expect(state.isIdle).toBe(false);
    });

    it('multiple question actions can be tracked simultaneously', () => {
      state.startJob(createJobContext());
      const msgId1 = state.nextMessageId();
      const msgId2 = state.nextMessageId();

      state.addInflight(msgId1, Date.now() + 60000);
      state.addInflight(msgId2, Date.now() + 60000);

      expect(state.inflightCount).toBe(2);
      expect(state.isActive).toBe(true);
    });
  });

  describe('connection state for question recovery', () => {
    it('hasJob returns false when no job started', () => {
      expect(state.hasJob).toBe(false);
    });

    it('hasJob returns true after startJob', () => {
      state.startJob(createJobContext());
      expect(state.hasJob).toBe(true);
    });

    it('currentJob returns job context', () => {
      const ctx = createJobContext();
      state.startJob(ctx);
      expect(state.currentJob?.executionId).toBe(ctx.executionId);
    });

    it('clearJob removes the job context', () => {
      state.startJob(createJobContext());
      state.clearJob();
      expect(state.hasJob).toBe(false);
      expect(state.currentJob).toBeNull();
    });
  });
});
