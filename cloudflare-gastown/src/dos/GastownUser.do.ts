import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, desc } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';
import {
  user_towns,
  user_rigs,
  type UserTownsSelect,
  type UserRigsSelect,
} from '../db/sqlite-schema';

const USER_LOG = '[GastownUser.do]';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * GastownUserDO — per-user control-plane metadata for towns and rigs.
 *
 * Keying: one DO instance per user (keyed by `owner_user_id`). A single
 * instance stores all towns a user owns plus their rigs.
 *
 * This is a temporary home — towns/rigs are simple control-plane entities
 * that will move to Postgres once the replication layer lands (Phase 4,
 * #230). The DO is used now so reads don't require Postgres and the
 * worker stays self-contained.
 *
 * Cross-rig coordination will be added in Phase 2 (#215).
 */
export class GastownUserDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
    });
  }

  // ── Towns ─────────────────────────────────────────────────────────────

  async createTown(input: { name: string; owner_user_id: string }): Promise<UserTownsSelect> {
    const id = generateId();
    const timestamp = now();
    console.log(`${USER_LOG} createTown: id=${id} name=${input.name} owner=${input.owner_user_id}`);

    this.db
      .insert(user_towns)
      .values({
        id,
        name: input.name,
        owner_user_id: input.owner_user_id,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .run();

    const town = this.getTown(id);
    if (!town) throw new Error('Failed to create town');
    console.log(`${USER_LOG} createTown: created town id=${town.id}`);
    // TODO: Should create the Town DO now, call setTownId, and then some function like ensureContainer
    // In the background, this way the town will likely be ready to go when the user gets to the UI

    return town;
  }

  async getTownAsync(townId: string): Promise<UserTownsSelect | null> {
    return this.getTown(townId);
  }

  private getTown(townId: string): UserTownsSelect | null {
    return this.db.select().from(user_towns).where(eq(user_towns.id, townId)).get() ?? null;
  }

  async listTowns(): Promise<UserTownsSelect[]> {
    return this.db.select().from(user_towns).orderBy(desc(user_towns.created_at)).all();
  }

  // ── Rigs ──────────────────────────────────────────────────────────────

  async createRig(input: {
    town_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    platform_integration_id?: string;
  }): Promise<UserRigsSelect> {
    console.log(
      `${USER_LOG} createRig: town_id=${input.town_id} name=${input.name} git_url=${input.git_url} default_branch=${input.default_branch} integration=${input.platform_integration_id ?? 'none'}`
    );

    // Verify town exists
    const town = this.getTown(input.town_id);
    if (!town) {
      console.error(`${USER_LOG} createRig: town ${input.town_id} not found`);
      throw new Error(`Town ${input.town_id} not found`);
    }

    const id = generateId();
    const timestamp = now();

    this.db
      .insert(user_rigs)
      .values({
        id,
        town_id: input.town_id,
        name: input.name,
        git_url: input.git_url,
        default_branch: input.default_branch,
        platform_integration_id: input.platform_integration_id ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .run();

    const rig = this.getRig(id);
    if (!rig) throw new Error('Failed to create rig');
    console.log(`${USER_LOG} createRig: created rig id=${rig.id}`);
    return rig;
  }

  async getRigAsync(rigId: string): Promise<UserRigsSelect | null> {
    return this.getRig(rigId);
  }

  private getRig(rigId: string): UserRigsSelect | null {
    return this.db.select().from(user_rigs).where(eq(user_rigs.id, rigId)).get() ?? null;
  }

  async listRigs(townId: string): Promise<UserRigsSelect[]> {
    return this.db
      .select()
      .from(user_rigs)
      .where(eq(user_rigs.town_id, townId))
      .orderBy(desc(user_rigs.created_at))
      .all();
  }

  async deleteRig(rigId: string): Promise<boolean> {
    if (!this.getRig(rigId)) return false;
    this.db.delete(user_rigs).where(eq(user_rigs.id, rigId)).run();
    return true;
  }

  async deleteTown(townId: string): Promise<boolean> {
    if (!this.getTown(townId)) return false;
    // Cascade: delete all rigs belonging to this town first
    this.db.delete(user_rigs).where(eq(user_rigs.town_id, townId)).run();
    this.db.delete(user_towns).where(eq(user_towns.id, townId)).run();
    return true;
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

export function getGastownUserStub(env: Env, userId: string) {
  return env.GASTOWN_USER.get(env.GASTOWN_USER.idFromName(userId));
}
