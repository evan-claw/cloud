import fs from 'node:fs';
import path from 'node:path';

const MAX_BACKUPS = 5;

export interface BackupFileDeps {
  copyFileSync: typeof fs.copyFileSync;
  readdirSync: typeof fs.readdirSync;
  unlinkSync: typeof fs.unlinkSync;
}

const defaultDeps: BackupFileDeps = {
  copyFileSync: fs.copyFileSync,
  readdirSync: fs.readdirSync,
  unlinkSync: fs.unlinkSync,
};

export function backupFile(filePath: string, deps: BackupFileDeps = defaultDeps): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const backupName = `${basename}.bak.${Date.now()}`;

  deps.copyFileSync(filePath, path.join(dir, backupName));

  const entries = deps.readdirSync(dir) as string[];
  const backupPrefix = `${basename}.bak.`;
  const backups = entries.filter(e => e.startsWith(backupPrefix)).sort();

  while (backups.length > MAX_BACKUPS) {
    const oldest = backups.shift()!;
    deps.unlinkSync(path.join(dir, oldest));
  }
}
