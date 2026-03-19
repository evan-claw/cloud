import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendBetterStackHeartbeat } from './betterstack-heartbeat.js';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendBetterStackHeartbeat', () => {
  it('fetches the URL directly on success', async () => {
    mockFetch.mockResolvedValue(new Response());

    await sendBetterStackHeartbeat('https://uptime.betterstack.com/api/v1/heartbeat/abc', true);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith('https://uptime.betterstack.com/api/v1/heartbeat/abc');
  });

  it('appends /fail to the URL on failure', async () => {
    mockFetch.mockResolvedValue(new Response());

    await sendBetterStackHeartbeat('https://uptime.betterstack.com/api/v1/heartbeat/abc', false);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://uptime.betterstack.com/api/v1/heartbeat/abc/fail'
    );
  });

  it('suppresses fetch errors and does not throw', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(
      sendBetterStackHeartbeat('https://uptime.betterstack.com/api/v1/heartbeat/abc', true)
    ).resolves.toBeUndefined();
  });
});
