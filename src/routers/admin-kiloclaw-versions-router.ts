import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_available_versions,
  kiloclaw_version_pins,
  kilocode_users,
  KiloClawVersionStatus,
} from '@/db/schema';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { eq, and, desc, asc, ilike, sql, count, countDistinct } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';

const ListVersionsSchema = z.object({
  status: z.enum(['active', 'deprecated', 'disabled', 'all']).default('all'),
  variant: z.string().optional(),
  sortBy: z.enum(['published_at', 'created_at', 'image_tag']).default('published_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const UpdateVersionStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['active', 'deprecated', 'disabled']),
});

const PublishVersionSchema = z.object({
  openclawVersion: z.string().min(1),
  variant: z.string().min(1).default('default'),
  imageTag: z.string().min(1),
  imageDigest: z.string().nullable().optional(),
  setLatest: z.boolean().default(false),
  notes: z.string().optional(),
});

const PinUserSchema = z.object({
  userId: z.string().min(1),
  imageTag: z.string().min(1),
  reason: z.string().optional(),
});

const UnpinUserSchema = z.object({
  userId: z.string().min(1),
});

const GetPinSchema = z.object({
  userId: z.string().min(1),
});

const ListPinsSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
});

export const adminKiloclawVersionsRouter = createTRPCRouter({
  listVersions: adminProcedure.input(ListVersionsSchema).query(async ({ input }) => {
    const conditions = [];
    if (input.status !== 'all') {
      conditions.push(eq(kiloclaw_available_versions.status, input.status));
    }
    if (input.variant) {
      conditions.push(eq(kiloclaw_available_versions.variant, input.variant));
    }

    const sortCol =
      input.sortBy === 'image_tag'
        ? kiloclaw_available_versions.image_tag
        : input.sortBy === 'created_at'
          ? kiloclaw_available_versions.created_at
          : kiloclaw_available_versions.published_at;
    const orderFn = input.sortOrder === 'asc' ? asc : desc;

    const rows = await db
      .select()
      .from(kiloclaw_available_versions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderFn(sortCol));

    return { versions: rows };
  }),

  updateVersionStatus: adminProcedure
    .input(UpdateVersionStatusSchema)
    .mutation(async ({ input }) => {
      const [updated] = await db
        .update(kiloclaw_available_versions)
        .set({ status: input.status })
        .where(eq(kiloclaw_available_versions.id, input.id))
        .returning();

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
      }

      return updated;
    }),

  publishVersion: adminProcedure.input(PublishVersionSchema).mutation(async ({ input, ctx }) => {
    // Reject if digest already belongs to a different tag
    if (input.imageDigest) {
      const conflict = await db.query.kiloclaw_available_versions.findFirst({
        where: eq(kiloclaw_available_versions.image_digest, input.imageDigest),
      });
      if (conflict && conflict.image_tag !== input.imageTag) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Digest "${input.imageDigest.slice(0, 16)}..." already belongs to tag "${conflict.image_tag}". Same image cannot have two catalog entries.`,
        });
      }
    }

    // Upsert into catalog by image_tag
    const values = {
      openclaw_version: input.openclawVersion,
      variant: input.variant,
      image_tag: input.imageTag,
      image_digest: input.imageDigest ?? null,
      is_latest: input.setLatest,
      published_by: ctx.user.id,
      notes: input.notes ?? null,
    };

    const [row] = await db.transaction(async tx => {
      // If setting as latest, lock then clear is_latest for same variant.
      // FOR UPDATE prevents concurrent publishes from both clearing the flag.
      if (input.setLatest) {
        await tx
          .select({ id: kiloclaw_available_versions.id })
          .from(kiloclaw_available_versions)
          .where(
            and(
              eq(kiloclaw_available_versions.variant, input.variant),
              eq(kiloclaw_available_versions.is_latest, true)
            )
          )
          .for('update');

        await tx
          .update(kiloclaw_available_versions)
          .set({ is_latest: false })
          .where(
            and(
              eq(kiloclaw_available_versions.variant, input.variant),
              eq(kiloclaw_available_versions.is_latest, true)
            )
          );
      }

      return tx
        .insert(kiloclaw_available_versions)
        .values(values)
        .onConflictDoUpdate({
          target: kiloclaw_available_versions.image_tag,
          set: {
            openclaw_version: input.openclawVersion,
            variant: input.variant,
            image_digest: input.imageDigest ?? null,
            is_latest: input.setLatest,
            published_by: ctx.user.id,
            notes: input.notes ?? null,
          },
        })
        .returning();
    });

    // Sync to worker KV
    try {
      const client = new KiloClawInternalClient();
      await client.publishImageVersion({
        openclawVersion: input.openclawVersion,
        variant: input.variant,
        imageTag: input.imageTag,
        imageDigest: input.imageDigest,
        setLatest: input.setLatest,
      });
    } catch (err) {
      console.error('[admin-versions] Failed to sync to worker KV:', err);
      // Non-fatal: catalog is the source of truth
    }

    return row;
  }),

  triggerSync: adminProcedure.mutation(async () => {
    const cronUrl = `${APP_URL}/api/cron/sync-kiloclaw-versions`;
    const response = await fetch(cronUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
      },
    });

    if (!response.ok) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Sync failed: ${response.status}`,
      });
    }

    return response.json() as Promise<{ success: boolean; inserted: number; updated: number }>;
  }),

  pinUser: adminProcedure.input(PinUserSchema).mutation(async ({ input, ctx }) => {
    // Validate image exists in catalog and is not disabled
    const version = await db.query.kiloclaw_available_versions.findFirst({
      where: eq(kiloclaw_available_versions.image_tag, input.imageTag),
    });

    if (!version) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Image tag "${input.imageTag}" not found in the version catalog`,
      });
    }

    if (version.status === 'disabled') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Image tag "${input.imageTag}" is disabled and cannot be pinned`,
      });
    }

    const [pin] = await db
      .insert(kiloclaw_version_pins)
      .values({
        user_id: input.userId,
        image_tag: input.imageTag,
        pinned_by: ctx.user.id,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: kiloclaw_version_pins.user_id,
        set: {
          image_tag: input.imageTag,
          pinned_by: ctx.user.id,
          reason: input.reason ?? null,
        },
      })
      .returning();

    return pin;
  }),

  unpinUser: adminProcedure.input(UnpinUserSchema).mutation(async ({ input }) => {
    const result = await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.user_id, input.userId));

    return { success: (result.rowCount ?? 0) > 0 };
  }),

  getPin: adminProcedure.input(GetPinSchema).query(async ({ input }) => {
    const pin = await db.query.kiloclaw_version_pins.findFirst({
      where: eq(kiloclaw_version_pins.user_id, input.userId),
    });

    if (!pin) return { pin: null, version: null };

    // Look up catalog entry for metadata
    const version = await db.query.kiloclaw_available_versions.findFirst({
      where: eq(kiloclaw_available_versions.image_tag, pin.image_tag),
    });

    return { pin, version: version ?? null };
  }),

  listPins: adminProcedure.input(ListPinsSchema).query(async ({ input }) => {
    const rows = await db
      .select({
        pin: kiloclaw_version_pins,
        userEmail: kilocode_users.google_user_email,
      })
      .from(kiloclaw_version_pins)
      .leftJoin(kilocode_users, eq(kiloclaw_version_pins.user_id, kilocode_users.id))
      .orderBy(desc(kiloclaw_version_pins.created_at))
      .limit(input.limit)
      .offset(input.offset);

    return {
      pins: rows.map(r => ({
        ...r.pin,
        userEmail: r.userEmail,
      })),
    };
  }),

  stats: adminProcedure.query(async () => {
    const [versionCounts] = await db
      .select({
        total: count(),
        active: count(sql`CASE WHEN ${kiloclaw_available_versions.status} = 'active' THEN 1 END`),
        variants: countDistinct(kiloclaw_available_versions.variant),
      })
      .from(kiloclaw_available_versions);

    const [pinCount] = await db.select({ total: count() }).from(kiloclaw_version_pins);

    return {
      versions: {
        total: versionCounts?.total ?? 0,
        active: versionCounts?.active ?? 0,
        variants: versionCounts?.variants ?? 0,
      },
      pins: {
        total: pinCount?.total ?? 0,
      },
    };
  }),
});
