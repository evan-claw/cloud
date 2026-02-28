import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

export function runMigrations(db: DrizzleSqliteDODatabase): void {
  migrate(db, migrations);
}
