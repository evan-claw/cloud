import { run } from '../utils/process';

export async function runMigrations(root: string): Promise<boolean> {
  return run({
    command: 'pnpm drizzle migrate',
    cwd: root,
    label: 'drizzle migrate',
  });
}
