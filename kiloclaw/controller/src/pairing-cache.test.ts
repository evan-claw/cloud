import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPairingCache,
  OPENCLAW_BIN,
  DEBOUNCE_DELAY_MS,
  INITIAL_REFRESH_DELAY_MS,
  PERIODIC_INTERVAL_MS,
  FAILURE_RETRY_BASE_MS,
  FAILURE_RETRY_MAX_MS,
} from './pairing-cache';

type ExecImpl = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function createTestHarness(overrides?: { execImpl?: ExecImpl; readConfigImpl?: () => unknown }) {
  const execImpl = overrides?.execImpl ?? vi.fn<ExecImpl>();
  const readConfigImpl =
    overrides?.readConfigImpl ??
    vi.fn(() => ({
      channels: {
        telegram: { enabled: true, botToken: 'tok' },
        discord: { enabled: true, token: 'tok' },
      },
    }));
  const nowImpl = vi.fn(() => '2026-03-12T00:00:00.000Z');

  const cache = createPairingCache({
    execImpl,
    readConfigImpl,
    nowImpl,
  });

  return { cache, execImpl, readConfigImpl, nowImpl };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-12T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createPairingCache', () => {
  describe('channel pairing list', () => {
    it('merges requests from multiple channels', async () => {
      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        const channel = args[2];
        if (channel === 'telegram') {
          return Promise.resolve({
            stdout: JSON.stringify({ requests: [{ code: 'ABC', id: '1' }] }),
            stderr: '',
          });
        }
        return Promise.resolve({
          stdout: JSON.stringify({ requests: [{ code: 'DEF', id: '2' }] }),
          stderr: '',
        });
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(2);
      expect(result.requests[0]).toEqual({ code: 'ABC', id: '1', channel: 'telegram' });
      expect(result.requests[1]).toEqual({ code: 'DEF', id: '2', channel: 'discord' });
      expect(result.lastUpdated).toBe('2026-03-12T00:00:00.000Z');
    });

    it('returns empty list when config is unavailable', async () => {
      const readConfigImpl = vi.fn(() => {
        throw new Error('no config');
      });
      const execImpl = vi.fn<ExecImpl>();

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(cache.getChannelPairing()).toEqual({ requests: [], lastUpdated: '' });
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('handles per-channel failures with Promise.allSettled', async () => {
      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        const channel = args[2];
        if (channel === 'telegram') {
          return Promise.reject(new Error('cli failed'));
        }
        return Promise.resolve({
          stdout: JSON.stringify({ requests: [{ code: 'DEF', id: '2' }] }),
          stderr: '',
        });
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      // telegram had no prior data, so only discord's results appear
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toEqual({ code: 'DEF', id: '2', channel: 'discord' });
    });

    it('preserves stale data for a failed channel when it had prior cached requests', async () => {
      let telegramShouldFail = false;
      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        const channel = args[2];
        if (channel === 'telegram' && telegramShouldFail) {
          return Promise.reject(new Error('cli failed'));
        }
        if (channel === 'telegram') {
          return Promise.resolve({
            stdout: JSON.stringify({ requests: [{ code: 'ABC', id: '1' }] }),
            stderr: '',
          });
        }
        return Promise.resolve({
          stdout: JSON.stringify({ requests: [{ code: 'DEF', id: '2' }] }),
          stderr: '',
        });
      });

      const { cache } = createTestHarness({ execImpl });

      // First refresh: both channels succeed
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(2);

      // Second refresh: telegram fails — its prior data should be preserved
      telegramShouldFail = true;
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(2);
      expect(result.requests).toEqual(
        expect.arrayContaining([
          { code: 'ABC', id: '1', channel: 'telegram' },
          { code: 'DEF', id: '2', channel: 'discord' },
        ])
      );
    });

    it('logs WARNING prefix when a previously-successful channel fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let callCount = 0;
      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        const channel = args[2];
        callCount++;
        if (channel === 'telegram' && callCount > 1) {
          return Promise.reject(new Error('cli down'));
        }
        return Promise.resolve({
          stdout: JSON.stringify({ requests: [{ code: 'ABC', id: '1' }] }),
          stderr: '',
        });
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      // First refresh: telegram succeeds and populates the cache
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(1);

      // Second refresh: telegram fails — should log WARNING since it had prior data
      await cache.refreshChannelPairing();

      const calls = consoleErrorSpy.mock.calls.map(args => String(args[0]));
      const warnCall = calls.find(msg => msg.includes('WARNING: keeping stale data for'));
      expect(warnCall).toBeDefined();
      expect(warnCall).toContain('telegram');

      consoleErrorSpy.mockRestore();
    });

    it('logs plain error prefix (no WARNING) when failing channel had no prior data', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const execImpl = vi.fn<ExecImpl>().mockRejectedValue(new Error('cli down'));
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      // First refresh: telegram fails immediately (no prior data)
      await cache.refreshChannelPairing();

      const calls = consoleErrorSpy.mock.calls.map(args => String(args[0]));
      const warnCall = calls.find(msg => msg.includes('WARNING'));
      expect(warnCall).toBeUndefined();

      consoleErrorSpy.mockRestore();
    });

    it('returns cached data on subsequent calls without re-exec', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [{ code: 'A', id: '1' }] }),
        stderr: '',
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshChannelPairing();

      const first = cache.getChannelPairing();
      const second = cache.getChannelPairing();
      expect(first).toBe(second);
      // Only the initial refresh calls exec, getChannelPairing is synchronous
      expect(execImpl).toHaveBeenCalledTimes(2); // once per channel
    });
  });

  describe('device pairing list', () => {
    it('returns device requests with stripped publicKey', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({
          pending: [
            {
              requestId: 'r1',
              deviceId: 'd1',
              role: 'operator',
              platform: 'ios',
              clientId: 'c1',
              ts: 1234,
              publicKey: 'SHOULD_BE_STRIPPED',
            },
          ],
        }),
        stderr: '',
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toEqual({
        requestId: 'r1',
        deviceId: 'd1',
        role: 'operator',
        platform: 'ios',
        clientId: 'c1',
        ts: 1234,
      });
      expect(result.lastUpdated).toBe('2026-03-12T00:00:00.000Z');
      expect('publicKey' in result.requests[0]).toBe(false);
    });
  });

  describe('approveChannel', () => {
    it('runs CLI and refreshes cache on success', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveChannel('telegram', 'ABC123');

      expect(result).toEqual({ success: true, message: 'Pairing approved', statusHint: 200 });
      expect(execImpl).toHaveBeenCalledWith(OPENCLAW_BIN, [
        'pairing',
        'approve',
        'telegram',
        'ABC123',
        '--notify',
      ]);
      // approve call + refresh calls
      expect(execImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects invalid channel name', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('INVALID!!', 'ABC');
      expect(result).toEqual({
        success: false,
        message: 'Invalid channel name',
        statusHint: 400,
      });
    });

    it('rejects invalid pairing code', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'bad code!!');
      expect(result).toEqual({
        success: false,
        message: 'Invalid pairing code',
        statusHint: 400,
      });
    });

    it('returns success when approve succeeds but post-approve refresh throws', async () => {
      let callCount = 0;
      const execImpl = vi.fn<ExecImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ stdout: '{}', stderr: '' });
        return Promise.reject(new Error('refresh boom'));
      });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveChannel('telegram', 'ABC');
      expect(result).toEqual({ success: true, message: 'Pairing approved', statusHint: 200 });
    });

    it('returns error on CLI failure', async () => {
      const execImpl = vi.fn<ExecImpl>().mockRejectedValue(new Error('cli boom'));
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveChannel('telegram', 'ABC');
      expect(result).toEqual({ success: false, message: 'cli boom', statusHint: 500 });
    });
  });

  describe('approveDevice', () => {
    it('runs CLI and refreshes cache on success', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(result).toEqual({ success: true, message: 'Device approved', statusHint: 200 });
      expect(execImpl).toHaveBeenCalledWith(OPENCLAW_BIN, [
        'devices',
        'approve',
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      ]);
    });

    it('returns success when approve succeeds but post-approve refresh throws', async () => {
      let callCount = 0;
      const execImpl = vi.fn<ExecImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ stdout: '{}', stderr: '' });
        return Promise.reject(new Error('refresh boom'));
      });
      const { cache } = createTestHarness({ execImpl });

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result).toEqual({ success: true, message: 'Device approved', statusHint: 200 });
    });

    it('rejects non-UUID requestId', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveDevice('not-a-uuid');
      expect(result).toEqual({
        success: false,
        message: 'Invalid request ID',
        statusHint: 400,
      });
    });
  });

  describe('error handling', () => {
    it('returns last-known-good data on CLI failure after prior success', async () => {
      let callCount = 0;
      const execImpl = vi.fn<ExecImpl>().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First refresh succeeds (two channels)
          return Promise.resolve({
            stdout: JSON.stringify({ requests: [{ code: 'A', id: '1' }] }),
            stderr: '',
          });
        }
        return Promise.reject(new Error('cli down'));
      });

      const { cache } = createTestHarness({ execImpl });

      await cache.refreshChannelPairing();
      const good = cache.getChannelPairing();
      expect(good.requests).toHaveLength(2);

      await cache.refreshChannelPairing();
      // Should still have the last-known-good data (both channels failed, so no update)
      // Actually allSettled: all channels failed so anySuccess=false, cache not updated
      const after = cache.getChannelPairing();
      expect(after.requests).toHaveLength(2);
      expect(after.lastUpdated).toBe(good.lastUpdated);
    });

    it('returns empty list with empty lastUpdated when never fetched', () => {
      const { cache } = createTestHarness();
      expect(cache.getChannelPairing()).toEqual({ requests: [], lastUpdated: '' });
      expect(cache.getDevicePairing()).toEqual({ requests: [], lastUpdated: '' });
    });

    it('keeps device cache on CLI failure', async () => {
      let callCount = 0;
      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        callCount++;
        if (args[0] === 'devices' && args[1] === 'list') {
          if (callCount === 1) {
            return Promise.resolve({
              stdout: JSON.stringify({ pending: [{ requestId: 'r1', deviceId: 'd1' }] }),
              stderr: '',
            });
          }
          return Promise.reject(new Error('fail'));
        }
        return Promise.resolve({ stdout: '{}', stderr: '' });
      });

      const readConfigImpl = vi.fn(() => ({ channels: {} }));
      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      await cache.refreshDevicePairing();
      expect(cache.getDevicePairing().requests).toHaveLength(1);

      await cache.refreshDevicePairing();
      // Should keep last-known-good
      expect(cache.getDevicePairing().requests).toHaveLength(1);
    });
  });

  describe('periodic refresh', () => {
    it('starts after initial delay and then refreshes every 120s', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.start();

      await vi.advanceTimersByTimeAsync(INITIAL_REFRESH_DELAY_MS - 1);
      expect(execImpl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterInitial = execImpl.mock.calls.length;
      expect(callsAfterInitial).toBeGreaterThan(0);

      // Advance to periodic interval — periodic fires
      await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
      expect(execImpl.mock.calls.length).toBeGreaterThan(callsAfterInitial);

      const callsBefore = execImpl.mock.calls.length;

      // Advance another periodic interval — periodic fires again
      await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
      expect(execImpl.mock.calls.length).toBeGreaterThan(callsBefore);

      cache.cleanup();
    });
  });

  describe('initial fetch', () => {
    it('waits 120s before first refresh', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.start();

      await vi.advanceTimersByTimeAsync(INITIAL_REFRESH_DELAY_MS - 1);
      expect(execImpl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(execImpl).toHaveBeenCalled();

      cache.cleanup();
    });
  });

  describe('debounced refresh', () => {
    it('fires 2s after first trigger', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      cache.onPairingLogLine('new pairing request received');

      expect(execImpl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(execImpl).toHaveBeenCalled();
    });

    it('collapses burst into single refresh (non-sliding window)', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      cache.onPairingLogLine('pairing event 1');
      await vi.advanceTimersByTimeAsync(500);
      cache.onPairingLogLine('pairing event 2');
      await vi.advanceTimersByTimeAsync(500);
      cache.onPairingLogLine('pairing event 3');

      // 1s has elapsed since first trigger, should not have fired yet
      expect(execImpl).not.toHaveBeenCalled();

      // Advance to 2s from first trigger (1s more)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(execImpl).toHaveBeenCalled();

      // Should only have fired once (channel + device refreshes)
      const callsAtFirstFire = execImpl.mock.calls.length;

      // After the debounce fires, a new trigger should work
      cache.onPairingLogLine('another pairing event');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(execImpl.mock.calls.length).toBeGreaterThan(callsAtFirstFire);
    });

    it('ignores lines without pairing keywords', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const { cache } = createTestHarness({ execImpl });

      cache.onPairingLogLine('some unrelated log output');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(execImpl).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('clears all timers so no further refreshes fire', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.start();

      // Let the delayed initial refresh run
      await vi.advanceTimersByTimeAsync(INITIAL_REFRESH_DELAY_MS);
      const callsAfterInitial = execImpl.mock.calls.length;

      cache.onPairingLogLine('pairing event');
      cache.cleanup();

      await vi.advanceTimersByTimeAsync(120_000);
      // No additional calls beyond the initial refresh
      expect(execImpl.mock.calls.length).toBe(callsAfterInitial);
    });
  });

  describe('lastUpdated', () => {
    it('is set on successful fetch and not updated on failure', async () => {
      let shouldFail = false;
      const execImpl = vi.fn<ExecImpl>().mockImplementation(() => {
        if (shouldFail) return Promise.reject(new Error('fail'));
        return Promise.resolve({
          stdout: JSON.stringify({ pending: [{ requestId: 'r1', deviceId: 'd1' }] }),
          stderr: '',
        });
      });
      const readConfigImpl = vi.fn(() => ({ channels: {} }));

      const { cache, nowImpl } = createTestHarness({ execImpl, readConfigImpl });

      nowImpl.mockReturnValue('2026-03-12T01:00:00.000Z');
      await cache.refreshDevicePairing();
      expect(cache.getDevicePairing().lastUpdated).toBe('2026-03-12T01:00:00.000Z');

      shouldFail = true;
      nowImpl.mockReturnValue('2026-03-12T02:00:00.000Z');
      await cache.refreshDevicePairing();
      // lastUpdated should NOT be updated
      expect(cache.getDevicePairing().lastUpdated).toBe('2026-03-12T01:00:00.000Z');
    });
  });

  describe('empty-field filtering', () => {
    it('filters out channel requests with empty code', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({
          requests: [
            { code: '', id: '1' },
            { code: 'ABC', id: '2' },
          ],
        }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('ABC');
    });

    it('filters out channel requests with empty id', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({
          requests: [
            { code: 'ABC', id: '' },
            { code: 'DEF', id: '2' },
          ],
        }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      const result = cache.getChannelPairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].code).toBe('DEF');
    });

    it('filters out device requests with empty requestId', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({
          pending: [
            { requestId: '', deviceId: 'd1' },
            { requestId: 'r2', deviceId: 'd2' },
          ],
        }),
        stderr: '',
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r2');
    });

    it('filters out device requests with empty deviceId', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({
          pending: [
            { requestId: 'r1', deviceId: '' },
            { requestId: 'r2', deviceId: 'd2' },
          ],
        }),
        stderr: '',
      });

      const { cache } = createTestHarness({ execImpl });
      await cache.refreshDevicePairing();

      const result = cache.getDevicePairing();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe('r2');
    });
  });

  describe('post-cleanup behavior', () => {
    it('refreshChannelPairing is a no-op after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.cleanup();

      await cache.refreshChannelPairing();
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('refreshDevicePairing is a no-op after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ pending: [] }),
        stderr: '',
      });

      const { cache } = createTestHarness({ execImpl });
      cache.cleanup();

      await cache.refreshDevicePairing();
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('approveChannel returns 500 after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const { cache } = createTestHarness({ execImpl });
      cache.cleanup();

      const result = await cache.approveChannel('telegram', 'ABC123');
      expect(result).toEqual({
        success: false,
        message: 'Cache is shutting down',
        statusHint: 500,
      });
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('approveDevice returns 500 after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const { cache } = createTestHarness({ execImpl });
      cache.cleanup();

      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result).toEqual({
        success: false,
        message: 'Cache is shutting down',
        statusHint: 500,
      });
      expect(execImpl).not.toHaveBeenCalled();
    });

    it('onPairingLogLine is ignored after cleanup', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.cleanup();

      cache.onPairingLogLine('new pairing request received');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(execImpl).not.toHaveBeenCalled();
    });
  });

  describe('detectChannels', () => {
    it('detects Slack with botToken', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [{ code: 'A', id: '1' }] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: true, botToken: 'xoxb-tok' },
        },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(execImpl).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['slack']));
    });

    it('detects Slack with appToken only', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [{ code: 'A', id: '1' }] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: true, appToken: 'xapp-tok' },
        },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(execImpl).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['slack']));
    });

    it('skips Slack when disabled even with tokens', async () => {
      const execImpl = vi.fn<ExecImpl>();
      const readConfigImpl = vi.fn(() => ({
        channels: {
          slack: { enabled: false, botToken: 'xoxb-tok' },
        },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      await cache.refreshChannelPairing();

      expect(execImpl).not.toHaveBeenCalled();
    });

    it('clears stale channel cache when all channels are removed', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [{ code: 'ABC', id: '1' }] }),
        stderr: '',
      });
      const configWithChannel: unknown = {
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      };
      const configNoChannels: unknown = { channels: {} };

      const readConfigImpl = vi.fn(() => configWithChannel);
      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      // First refresh populates the cache
      await cache.refreshChannelPairing();
      expect(cache.getChannelPairing().requests).toHaveLength(1);

      // Remove all channels
      readConfigImpl.mockReturnValue(configNoChannels);
      await cache.refreshChannelPairing();

      // Cache should be cleared, not stale
      expect(cache.getChannelPairing().requests).toHaveLength(0);
      expect(cache.getChannelPairing().lastUpdated).not.toBe('');
    });
  });

  describe('concurrent refresh race', () => {
    it('stale refresh does not overwrite newer data (channel)', async () => {
      // Simulate: slow refresh starts, then a fast post-approve refresh
      // completes first with updated data.  The slow one must not clobber it.
      let resolveSlowChannel!: (v: { stdout: string; stderr: string }) => void;
      let callCount = 0;

      const execImpl = vi.fn<ExecImpl>().mockImplementation((_cmd, args) => {
        if (args[0] === 'pairing' && args[1] === 'list') {
          callCount++;
          if (callCount === 1) {
            // First (slow) refresh — parks until we resolve manually
            return new Promise(resolve => {
              resolveSlowChannel = resolve;
            });
          }
          // Second (fast) refresh — returns immediately with post-approve data
          return Promise.resolve({
            stdout: JSON.stringify({ requests: [] }),
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '{}', stderr: '' });
      });

      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });

      // Start slow refresh (does not await)
      const slowPromise = cache.refreshChannelPairing();

      // Start fast refresh while slow is in-flight
      await cache.refreshChannelPairing();

      // Fast refresh completed: cache should be empty (approved request gone)
      expect(cache.getChannelPairing().requests).toHaveLength(0);

      // Now let the slow refresh finish with stale pre-approve data
      resolveSlowChannel({
        stdout: JSON.stringify({ requests: [{ code: 'STALE', id: '99' }] }),
        stderr: '',
      });
      await slowPromise;

      // Cache must still reflect the newer (empty) result, NOT the stale data
      expect(cache.getChannelPairing().requests).toHaveLength(0);
    });

    it('stale refresh does not overwrite newer data (device)', async () => {
      let resolveSlowDevice!: (v: { stdout: string; stderr: string }) => void;
      let callCount = 0;

      const execImpl = vi.fn<ExecImpl>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise(resolve => {
            resolveSlowDevice = resolve;
          });
        }
        return Promise.resolve({
          stdout: JSON.stringify({ pending: [] }),
          stderr: '',
        });
      });

      const { cache } = createTestHarness({ execImpl });

      const slowPromise = cache.refreshDevicePairing();
      await cache.refreshDevicePairing();

      expect(cache.getDevicePairing().requests).toHaveLength(0);

      resolveSlowDevice({
        stdout: JSON.stringify({ pending: [{ requestId: 'r1', deviceId: 'd1' }] }),
        stderr: '',
      });
      await slowPromise;

      expect(cache.getDevicePairing().requests).toHaveLength(0);
    });
  });

  describe('start idempotency', () => {
    it('calling start twice does not create duplicate timers', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({
        stdout: JSON.stringify({ requests: [] }),
        stderr: '',
      });
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.start();
      cache.start(); // second call should be no-op

      // Wait for delayed initial refresh
      await vi.advanceTimersByTimeAsync(INITIAL_REFRESH_DELAY_MS);

      // With two channels (telegram), initial fetch calls exec twice
      // If start() wasn't idempotent, we'd see 4 calls
      const callsAfterInitial = execImpl.mock.calls.length;
      expect(callsAfterInitial).toBe(2); // telegram channel + device list

      cache.cleanup();
    });
  });

  describe('failure backoff', () => {
    it('uses exponential backoff and caps retries at 5 minutes', async () => {
      const execImpl = vi.fn<ExecImpl>().mockRejectedValue(new Error('cli down'));
      const readConfigImpl = vi.fn(() => ({
        channels: { telegram: { enabled: true, botToken: 'tok' } },
      }));

      const { cache } = createTestHarness({ execImpl, readConfigImpl });
      cache.start();

      await vi.advanceTimersByTimeAsync(INITIAL_REFRESH_DELAY_MS);
      const callsAfterFirstFailure = execImpl.mock.calls.length;
      expect(callsAfterFirstFailure).toBeGreaterThan(0);

      // Still within first failure backoff window, so no retry yet.
      expect(execImpl.mock.calls.length).toBe(callsAfterFirstFailure);

      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS - 1);
      expect(execImpl.mock.calls.length).toBe(callsAfterFirstFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterSecondFailure = execImpl.mock.calls.length;
      expect(callsAfterSecondFailure).toBeGreaterThan(callsAfterFirstFailure);

      // Second failure should back off longer (2x base).
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 2 - 1);
      expect(execImpl.mock.calls.length).toBe(callsAfterSecondFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterThirdFailure = execImpl.mock.calls.length;
      expect(callsAfterThirdFailure).toBeGreaterThan(callsAfterSecondFailure);

      // Third failure backs off to 4x base.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 4 - 1);
      expect(execImpl.mock.calls.length).toBe(callsAfterThirdFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterFourthFailure = execImpl.mock.calls.length;
      expect(callsAfterFourthFailure).toBeGreaterThan(callsAfterThirdFailure);

      // Fourth failure backs off to 8x base.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_BASE_MS * 8 - 1);
      expect(execImpl.mock.calls.length).toBe(callsAfterFourthFailure);

      await vi.advanceTimersByTimeAsync(1);
      const callsAfterFifthFailure = execImpl.mock.calls.length;
      expect(callsAfterFifthFailure).toBeGreaterThan(callsAfterFourthFailure);

      // Next delay should be capped at max (5 minutes), not continue doubling.
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MAX_MS - 1);
      expect(execImpl.mock.calls.length).toBe(callsAfterFifthFailure);

      await vi.advanceTimersByTimeAsync(1);
      expect(execImpl.mock.calls.length).toBeGreaterThan(callsAfterFifthFailure);

      cache.cleanup();
    });
  });

  describe('input validation regexes', () => {
    it('rejects channel names starting with digit', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('1bad', 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('rejects channel names with uppercase', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('BadName', 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('rejects channel names longer than 64 chars', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('a' + 'b'.repeat(64), 'ABC');
      expect(result.statusHint).toBe(400);
    });

    it('accepts valid channel names', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveChannel('my-channel_1', 'ABC');
      expect(result.statusHint).toBe(200);
    });

    it('rejects codes with special characters', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'bad!code');
      expect(result.statusHint).toBe(400);
    });

    it('rejects codes longer than 32 chars', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', 'A'.repeat(33));
      expect(result.statusHint).toBe(400);
    });

    it('rejects empty code', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveChannel('telegram', '');
      expect(result.statusHint).toBe(400);
    });

    it('rejects malformed UUID', async () => {
      const { cache } = createTestHarness();
      const result = await cache.approveDevice('not-a-uuid-format');
      expect(result.statusHint).toBe(400);
    });

    it('accepts valid UUID', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveDevice('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result.statusHint).toBe(200);
    });

    it('accepts uppercase UUID', async () => {
      const execImpl = vi.fn<ExecImpl>().mockResolvedValue({ stdout: '{}', stderr: '' });
      const { cache } = createTestHarness({ execImpl });
      const result = await cache.approveDevice('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
      expect(result.statusHint).toBe(200);
    });
  });
});
