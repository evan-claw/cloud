import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupFile, type BackupFileDeps } from './backup-file';

describe('backupFile', () => {
  let deps: BackupFileDeps;

  beforeEach(() => {
    deps = {
      copyFileSync: vi.fn(),
      readdirSync: vi.fn().mockReturnValue([]),
      unlinkSync: vi.fn(),
    };
  });

  it('creates a timestamped backup', () => {
    backupFile('/root/.openclaw/workspace/SOUL.md', deps);

    expect(deps.copyFileSync).toHaveBeenCalledOnce();
    const [src, dest] = (deps.copyFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(src).toBe('/root/.openclaw/workspace/SOUL.md');
    expect(dest).toMatch(/\/root\/\.openclaw\/workspace\/SOUL\.md\.bak\.\d{4}-\d{2}-\d{2}T/);
  });

  it('removes oldest backups when exceeding max count', () => {
    const allBackups = [
      'SOUL.md.bak.2026-03-01T00:00:00.000Z',
      'SOUL.md.bak.2026-03-02T00:00:00.000Z',
      'SOUL.md.bak.2026-03-03T00:00:00.000Z',
      'SOUL.md.bak.2026-03-04T00:00:00.000Z',
      'SOUL.md.bak.2026-03-05T00:00:00.000Z',
      'SOUL.md.bak.2026-03-06T00:00:00.000Z',
    ];
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(allBackups);

    backupFile('/root/.openclaw/workspace/SOUL.md', deps);

    expect(deps.unlinkSync).toHaveBeenCalledOnce();
    expect(deps.unlinkSync).toHaveBeenCalledWith(
      '/root/.openclaw/workspace/SOUL.md.bak.2026-03-01T00:00:00.000Z'
    );
  });

  it('does not remove backups when under max count', () => {
    const backups = [
      'SOUL.md.bak.2026-03-01T00:00:00.000Z',
      'SOUL.md.bak.2026-03-02T00:00:00.000Z',
    ];
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(backups);

    backupFile('/root/.openclaw/workspace/SOUL.md', deps);

    expect(deps.unlinkSync).not.toHaveBeenCalled();
  });
});
