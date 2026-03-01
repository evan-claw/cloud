/**
 * Rig registry for the Town DO.
 * Rigs are now SQL rows in the Town DO instead of KV entries.
 */

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, asc, sql } from 'drizzle-orm';
import { rigs } from '../../db/sqlite-schema';
import type { RigsSelect } from '../../db/sqlite-schema';

export type RigRecord = Omit<RigsSelect, 'config'> & {
  config: Record<string, unknown>;
};

function parseRig(row: RigsSelect): RigRecord {
  return {
    ...row,
    config: JSON.parse(row.config ?? '{}') as Record<string, unknown>,
  };
}

export function addRig(
  db: DrizzleSqliteDODatabase,
  input: {
    rigId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }
): RigRecord {
  const timestamp = new Date().toISOString();

  db.insert(rigs)
    .values({
      id: input.rigId,
      name: input.name,
      git_url: input.gitUrl,
      default_branch: input.defaultBranch,
      config: '{}',
      created_at: timestamp,
    })
    .onConflictDoUpdate({
      target: rigs.id,
      set: {
        name: sql`excluded.name`,
        git_url: sql`excluded.git_url`,
        default_branch: sql`excluded.default_branch`,
      },
    })
    .run();

  const rig = getRig(db, input.rigId);
  if (!rig) throw new Error('Failed to create rig');
  return rig;
}

export function getRig(db: DrizzleSqliteDODatabase, rigId: string): RigRecord | null {
  const row = db.select().from(rigs).where(eq(rigs.id, rigId)).get();
  if (!row) return null;
  return parseRig(row);
}

export function listRigs(db: DrizzleSqliteDODatabase): RigRecord[] {
  return db.select().from(rigs).orderBy(asc(rigs.created_at)).all().map(parseRig);
}

export function removeRig(db: DrizzleSqliteDODatabase, rigId: string): void {
  db.delete(rigs).where(eq(rigs.id, rigId)).run();
}
