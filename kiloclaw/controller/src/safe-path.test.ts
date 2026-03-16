import { describe, it, expect } from 'vitest';
import { resolveSafePath } from './safe-path';

const ROOT = '/root/.openclaw';

describe('resolveSafePath', () => {
  it('resolves a simple relative path', () => {
    expect(resolveSafePath('openclaw.json', ROOT)).toBe('/root/.openclaw/openclaw.json');
  });

  it('resolves a nested path', () => {
    expect(resolveSafePath('workspace/SOUL.md', ROOT)).toBe('/root/.openclaw/workspace/SOUL.md');
  });

  it('rejects path traversal with ..', () => {
    expect(() => resolveSafePath('../etc/passwd', ROOT)).toThrow();
  });

  it('rejects path traversal with encoded ..', () => {
    expect(() => resolveSafePath('workspace/../../etc/passwd', ROOT)).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath('/etc/passwd', ROOT)).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => resolveSafePath('workspace/SOUL\0.md', ROOT)).toThrow();
  });

  it('rejects credentials directory', () => {
    expect(() => resolveSafePath('credentials/key.json', ROOT)).toThrow();
  });

  it('rejects credentials directory with nested path', () => {
    expect(() => resolveSafePath('credentials/sub/key.json', ROOT)).toThrow();
  });

  it('allows paths that contain "credentials" as substring in filename', () => {
    expect(resolveSafePath('workspace/my-credentials-notes.md', ROOT)).toBe(
      '/root/.openclaw/workspace/my-credentials-notes.md'
    );
  });

  it('rejects empty path', () => {
    expect(() => resolveSafePath('', ROOT)).toThrow();
  });
});
