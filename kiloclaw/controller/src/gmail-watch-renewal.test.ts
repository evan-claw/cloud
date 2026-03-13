import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('gmail-watch-renewal', () => {
  let startWatchRenewal: typeof import('./gmail-watch-renewal').startWatchRenewal;
  let stopWatchRenewal: typeof import('./gmail-watch-renewal').stopWatchRenewal;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const mod = await import('./gmail-watch-renewal');
    startWatchRenewal = mod.startWatchRenewal;
    stopWatchRenewal = mod.stopWatchRenewal;
  });

  afterEach(() => {
    stopWatchRenewal();
    vi.useRealTimers();
  });

  it('does not spawn immediately on start', () => {
    const spawn = vi.fn();
    startWatchRenewal('user@gmail.com', spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns gog gmail watch renew after 1 hour', () => {
    const spawn = vi.fn();
    startWatchRenewal('user@gmail.com', spawn);

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(['gmail', 'watch', 'renew', '--account', 'user@gmail.com']);
  });

  it('repeats every 24 hours after the initial 1-hour delay', () => {
    const spawn = vi.fn();
    startWatchRenewal('user@gmail.com', spawn);

    // Advance past initial 1-hour delay
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(spawn).toHaveBeenCalledTimes(1);

    // Each 24-hour tick triggers another renewal
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(spawn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('does not throw if spawn fails', () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error('gog failed');
    });

    startWatchRenewal('user@gmail.com', spawn);

    expect(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    }).not.toThrow();
  });

  it('stopWatchRenewal prevents the initial spawn', () => {
    const spawn = vi.fn();
    startWatchRenewal('user@gmail.com', spawn);
    stopWatchRenewal();

    vi.advanceTimersByTime(60 * 60 * 1000 + 24 * 60 * 60 * 1000);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('stopWatchRenewal cancels the repeating interval', () => {
    const spawn = vi.fn();
    startWatchRenewal('user@gmail.com', spawn);

    // Trigger initial renewal
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(spawn).toHaveBeenCalledTimes(1);

    stopWatchRenewal();

    // Advance far beyond where next interval would fire
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
