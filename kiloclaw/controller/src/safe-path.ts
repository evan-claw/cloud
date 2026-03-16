import path from 'node:path';

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafePathError';
  }
}

export function resolveSafePath(relativePath: string, rootDir: string): string {
  if (!relativePath) {
    throw new SafePathError('Path must not be empty');
  }

  if (relativePath.includes('\0')) {
    throw new SafePathError('Path must not contain null bytes');
  }

  if (path.isAbsolute(relativePath)) {
    throw new SafePathError('Path must be relative');
  }

  const resolved = path.resolve(rootDir, relativePath);

  if (resolved !== rootDir && !resolved.startsWith(rootDir + '/')) {
    throw new SafePathError('Path escapes root directory');
  }

  const relative = path.relative(rootDir, resolved);
  const firstSegment = relative.split('/')[0];
  if (firstSegment === 'credentials') {
    throw new SafePathError('Access to credentials directory is forbidden');
  }

  return resolved;
}
