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
    expect(dest).toMatch(/\/root\/\.openclaw\/workspace\/SOUL\.md\.bak\.\d+$/);
  });

  it('removes oldest backups when exceeding max count', () => {
    // Simulate 5 existing backups + the one just created by copyFileSync.
    // readdirSync runs AFTER copyFileSync, so it sees all 6.
    const existingBackups = [
      'SOUL.md.bak.1740787200000',
      'SOUL.md.bak.1740873600000',
      'SOUL.md.bak.1740960000000',
      'SOUL.md.bak.1741046400000',
      'SOUL.md.bak.1741132800000',
    ];
    // The new backup created by copyFileSync will also appear in the listing
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => [
      ...existingBackups,
      'SOUL.md.bak.1741219200000', // the one just created
    ]);

    backupFile('/root/.openclaw/workspace/SOUL.md', deps);

    expect(deps.unlinkSync).toHaveBeenCalledOnce();
    expect(deps.unlinkSync).toHaveBeenCalledWith(
      '/root/.openclaw/workspace/SOUL.md.bak.1740787200000'
    );
  });

  it('does not remove backups when under max count', () => {
    const backups = ['SOUL.md.bak.1740787200000', 'SOUL.md.bak.1740873600000'];
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(backups);

    backupFile('/root/.openclaw/workspace/SOUL.md', deps);

    expect(deps.unlinkSync).not.toHaveBeenCalled();
  });
});
