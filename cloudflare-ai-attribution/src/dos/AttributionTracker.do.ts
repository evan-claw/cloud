import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../util/logger';
import {
  attributionsMetadata,
  linesAdded,
  linesRemoved,
  type AttributionsMetadataInsert,
  type AttributionsMetadataSelect,
  type LinesAddedInsert,
  type LinesAddedSelect,
  type LinesRemovedInsert,
  type LinesRemovedSelect,
} from '../db/sqlite-schema';
import migrations from '../../drizzle/migrations';
import type { AttributionsTrackRequestBody } from '../schemas';

export class AttributionTrackerDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void this.ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
      logger.info('Database migrated');
    });
  }

  clearAllData() {
    this.db.delete(linesAdded).run();
    this.db.delete(linesRemoved).run();
    this.db.delete(attributionsMetadata).run();
  }

  deleteAttribution(id: number): boolean {
    const existing = this.db
      .select({ id: attributionsMetadata.id })
      .from(attributionsMetadata)
      .where(eq(attributionsMetadata.id, id))
      .all();

    if (existing.length === 0) {
      return false;
    }

    this.db.delete(linesAdded).where(eq(linesAdded.attributions_metadata_id, id)).run();
    this.db.delete(linesRemoved).where(eq(linesRemoved.attributions_metadata_id, id)).run();
    this.db.delete(attributionsMetadata).where(eq(attributionsMetadata.id, id)).run();

    logger.info('Attribution deleted', { id });
    return true;
  }

  insertAttributionMetadata(data: AttributionsMetadataInsert): AttributionsMetadataSelect {
    return this.db
      .insert(attributionsMetadata)
      .values({
        user_id: data.user_id,
        project_id: data.project_id,
        organization_id: data.organization_id,
        branch: data.branch,
        file_path: data.file_path,
        status: data.status,
        task_id: data.task_id,
      })
      .returning()
      .get();
  }

  insertLinesAdded(data: LinesAddedInsert): LinesAddedSelect {
    return this.db
      .insert(linesAdded)
      .values({
        attributions_metadata_id: data.attributions_metadata_id,
        line_number: data.line_number,
        line_hash: data.line_hash,
      })
      .returning()
      .get();
  }

  insertLinesRemoved(data: LinesRemovedInsert): LinesRemovedSelect {
    return this.db
      .insert(linesRemoved)
      .values({
        attributions_metadata_id: data.attributions_metadata_id,
        line_number: data.line_number,
        line_hash: data.line_hash,
      })
      .returning()
      .get();
  }

  async trackAttribution(
    params: AttributionsTrackRequestBody & { user_id: string; organization_id: string }
  ): Promise<AttributionsMetadataSelect & { linesAdded: number; linesRemoved: number }> {
    const metadata = this.insertAttributionMetadata(params);
    const attributionId = metadata.id;

    for (const line of params.lines_added) {
      this.insertLinesAdded({
        attributions_metadata_id: attributionId,
        line_number: line.line_number,
        line_hash: line.line_hash,
      });
    }

    for (const line of params.lines_removed) {
      this.insertLinesRemoved({
        attributions_metadata_id: attributionId,
        line_number: line.line_number,
        line_hash: line.line_hash,
      });
    }

    logger.info('Attribution tracked', {
      ...metadata,
      linesAdded: params.lines_added.length,
      linesRemoved: params.lines_removed.length,
    });

    return {
      ...metadata,
      linesAdded: params.lines_added.length,
      linesRemoved: params.lines_removed.length,
    };
  }

  /**
   * @deprecated Use getAttributionEvents() for flexible retention calculation
   */
  getLinesAddedByHash(branch?: string): Record<string, number[]> {
    const branchPattern = branch ?? '*';

    const rows = this.db
      .select({
        line_hash: linesAdded.line_hash,
        line_number: linesAdded.line_number,
      })
      .from(linesAdded)
      .innerJoin(
        attributionsMetadata,
        eq(linesAdded.attributions_metadata_id, attributionsMetadata.id)
      )
      .where(
        and(
          eq(attributionsMetadata.status, 'accepted'),
          sql`${attributionsMetadata.branch} GLOB ${branchPattern}`
        )
      )
      .orderBy(linesAdded.line_hash, linesAdded.line_number)
      .all();

    const result: Record<string, number[]> = {};
    for (const row of rows) {
      if (!result[row.line_hash]) {
        result[row.line_hash] = [];
      }
      result[row.line_hash].push(row.line_number);
    }

    return result;
  }

  getAttributionEvents(
    branch?: string
  ): Array<{ id: number; taskId: string | null; lineHashes: string[] }> {
    const branchPattern = branch ?? '*';

    const metadataRows = this.db
      .select({
        id: attributionsMetadata.id,
        task_id: attributionsMetadata.task_id,
      })
      .from(attributionsMetadata)
      .where(
        and(
          eq(attributionsMetadata.status, 'accepted'),
          sql`${attributionsMetadata.branch} GLOB ${branchPattern}`
        )
      )
      .orderBy(attributionsMetadata.created_at)
      .all();

    const result: Array<{ id: number; taskId: string | null; lineHashes: string[] }> = [];

    for (const metadata of metadataRows) {
      const lineRows = this.db
        .select({ line_hash: linesAdded.line_hash })
        .from(linesAdded)
        .where(eq(linesAdded.attributions_metadata_id, metadata.id))
        .orderBy(linesAdded.line_number)
        .all();

      result.push({
        id: metadata.id,
        taskId: metadata.task_id,
        lineHashes: lineRows.map(r => r.line_hash),
      });
    }

    return result;
  }

  getDebugData(): {
    attributions: Array<
      AttributionsMetadataSelect & {
        lines_added: LinesAddedSelect[];
        lines_removed: LinesRemovedSelect[];
      }
    >;
    summary: {
      total_attributions: number;
      total_lines_added: number;
      total_lines_removed: number;
      by_status: Record<string, number>;
      by_branch: Record<string, number>;
    };
  } {
    const metadataRows = this.db
      .select()
      .from(attributionsMetadata)
      .orderBy(sql`${attributionsMetadata.created_at} DESC`)
      .all();

    const attributions: Array<
      AttributionsMetadataSelect & {
        lines_added: LinesAddedSelect[];
        lines_removed: LinesRemovedSelect[];
      }
    > = [];

    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const byStatus: Record<string, number> = {};
    const byBranch: Record<string, number> = {};

    for (const metadata of metadataRows) {
      byStatus[metadata.status] = (byStatus[metadata.status] || 0) + 1;
      byBranch[metadata.branch] = (byBranch[metadata.branch] || 0) + 1;

      const linesAddedRows = this.db
        .select()
        .from(linesAdded)
        .where(eq(linesAdded.attributions_metadata_id, metadata.id))
        .orderBy(linesAdded.line_number)
        .all();

      totalLinesAdded += linesAddedRows.length;

      const linesRemovedRows = this.db
        .select()
        .from(linesRemoved)
        .where(eq(linesRemoved.attributions_metadata_id, metadata.id))
        .orderBy(linesRemoved.line_number)
        .all();

      totalLinesRemoved += linesRemovedRows.length;

      attributions.push({
        ...metadata,
        lines_added: linesAddedRows,
        lines_removed: linesRemovedRows,
      });
    }

    return {
      attributions,
      summary: {
        total_attributions: metadataRows.length,
        total_lines_added: totalLinesAdded,
        total_lines_removed: totalLinesRemoved,
        by_status: byStatus,
        by_branch: byBranch,
      },
    };
  }
}

export function getAttributionTrackerDO(
  env: Env,
  params: {
    organization_id: string;
    project_id: string;
    file_path: string;
  }
): DurableObjectStub<AttributionTrackerDO> {
  const doKey = `${params.organization_id}/${params.project_id}/${params.file_path}`;
  const id = env.ATTRIBUTION_TRACKER.idFromName(doKey);
  return env.ATTRIBUTION_TRACKER.get(id);
}
