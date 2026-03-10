import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
} from '@kilocode/db/schema';
import * as z from 'zod';
import { sql, and, gte, lt, eq, isNotNull, desc, ilike, or, type SQL } from 'drizzle-orm';
import {
  REVIEW_PROMO_MODEL,
  REVIEW_PROMO_START,
  REVIEW_PROMO_END,
  isActiveReviewPromo,
} from '@/lib/code-reviews/core/constants';

/**
 * SQL condition to exclude "Insufficient credits" errors from failure metrics.
 * These are expected billing errors (402) that shouldn't count as system failures.
 * Uses COALESCE to handle NULL error_message (NULL NOT LIKE returns NULL, not TRUE).
 */
const excludeInsufficientCreditsError = sql`COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT LIKE '%Insufficient credits%'`;

/**
 * Categorize error messages into high-level buckets via SQL CASE WHEN.
 * Pattern matching is ordered from most-specific to least-specific.
 */
const errorCategoryExpr = sql<string>`CASE
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%rate limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Rate limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%429%' THEN 'Rate Limited'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%timeout%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Timeout%' OR ${cloud_agent_code_reviews.error_message} LIKE '%ETIMEDOUT%' OR ${cloud_agent_code_reviews.error_message} LIKE '%timed out%' THEN 'Timeout'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%context window%' OR ${cloud_agent_code_reviews.error_message} LIKE '%token limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%too large%' OR ${cloud_agent_code_reviews.error_message} LIKE '%maximum context length%' THEN 'Context Window Exceeded'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%authentication%' OR ${cloud_agent_code_reviews.error_message} LIKE '%401%' OR ${cloud_agent_code_reviews.error_message} LIKE '%403%' OR ${cloud_agent_code_reviews.error_message} LIKE '%permission%' THEN 'Auth / Permission Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%not found%' OR ${cloud_agent_code_reviews.error_message} LIKE '%404%' THEN 'Not Found'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%500%' OR ${cloud_agent_code_reviews.error_message} LIKE '%502%' OR ${cloud_agent_code_reviews.error_message} LIKE '%503%' OR ${cloud_agent_code_reviews.error_message} LIKE '%internal server%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Internal Server%' THEN 'Upstream Server Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%ECONNREFUSED%' OR ${cloud_agent_code_reviews.error_message} LIKE '%ECONNRESET%' OR ${cloud_agent_code_reviews.error_message} LIKE '%socket hang up%' OR ${cloud_agent_code_reviews.error_message} LIKE '%network%' THEN 'Network Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%parse%' OR ${cloud_agent_code_reviews.error_message} LIKE '%JSON%' OR ${cloud_agent_code_reviews.error_message} LIKE '%unexpected token%' THEN 'Parse Error'
  WHEN ${cloud_agent_code_reviews.error_message} IS NULL THEN 'Unknown Error'
  ELSE 'Other'
END`;

const FilterSchema = z.object({
  startDate: z.string().date(), // ISO date string YYYY-MM-DD
  endDate: z.string().date(), // ISO date string YYYY-MM-DD
  userId: z.string().min(1).optional(), // Filter by specific user
  organizationId: z.string().uuid().optional(), // Filter by specific organization
  ownershipType: z.enum(['all', 'personal', 'organization']).optional().default('all'),
  agentVersion: z.enum(['all', 'v1', 'v2']).optional().default('all'),
});

/**
 * Helper to build ownership filter conditions.
 *
 * Returns undefined when filtering is "all ownership types" which is intentional -
 * the date range conditions (startDate, endDate) are always required and applied,
 * ensuring queries are bounded even without ownership filters.
 */
function buildOwnershipFilter(
  userId?: string,
  organizationId?: string,
  ownershipType?: 'all' | 'personal' | 'organization'
): SQL | undefined {
  const conditions: SQL[] = [];

  if (userId) {
    conditions.push(eq(cloud_agent_code_reviews.owned_by_user_id, userId));
  }

  if (organizationId) {
    conditions.push(eq(cloud_agent_code_reviews.owned_by_organization_id, organizationId));
  }

  if (!userId && !organizationId && ownershipType && ownershipType !== 'all') {
    if (ownershipType === 'personal') {
      conditions.push(isNotNull(cloud_agent_code_reviews.owned_by_user_id));
    } else if (ownershipType === 'organization') {
      conditions.push(isNotNull(cloud_agent_code_reviews.owned_by_organization_id));
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Returns a SQL condition filtering by agent_version, or undefined for 'all'. */
function buildAgentVersionFilter(agentVersion?: 'all' | 'v1' | 'v2'): SQL | undefined {
  if (!agentVersion || agentVersion === 'all') return undefined;
  return eq(cloud_agent_code_reviews.agent_version, agentVersion);
}

export const adminCodeReviewsRouter = createTRPCRouter({
  // Get overview KPIs
  getOverviewStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
      .select({
        total_reviews: sql<number>`COUNT(*)`,
        completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude "Insufficient credits" errors from failed count - these are expected billing errors, not system failures
        failed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeInsufficientCreditsError})`,
        cancelled_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'cancelled')`,
        interrupted_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'interrupted')`,
        in_progress_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running'))`,
        avg_duration_seconds: sql<number>`AVG(EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))) FILTER (WHERE ${cloud_agent_code_reviews.completed_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} IS NOT NULL)`,
        // Separate count for billing errors (for visibility)
        insufficient_credits_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${cloud_agent_code_reviews.error_message} LIKE '%Insufficient credits%')`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions));

    const stats = result[0];
    const total = Number(stats.total_reviews) || 0;
    const completedCount = Number(stats.completed_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const cancelledCount = Number(stats.cancelled_count) || 0;
    const interruptedCount = Number(stats.interrupted_count) || 0;
    const inProgressCount = Number(stats.in_progress_count) || 0;
    const insufficientCreditsCount = Number(stats.insufficient_credits_count) || 0;

    // Calculate rates over terminal states only (completed, failed, interrupted, cancelled)
    // In-progress states (pending, queued, running) are excluded as they haven't finished yet
    // Note: insufficientCreditsCount is excluded from failedCount but included in terminal count
    const terminalCount =
      completedCount + failedCount + interruptedCount + cancelledCount + insufficientCreditsCount;

    // Per-version breakdown (only when viewing all versions)
    const baseConditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
    ].filter(Boolean) as SQL[];

    const versionBreakdown =
      !agentVersion || agentVersion === 'all'
        ? await db
            .select({
              agent_version: sql<string>`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`,
              total: sql<number>`COUNT(*)`,
              completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
              failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeInsufficientCreditsError})`,
              avg_duration_seconds: sql<number>`AVG(EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))) FILTER (WHERE ${cloud_agent_code_reviews.completed_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} IS NOT NULL)`,
            })
            .from(cloud_agent_code_reviews)
            .where(and(...baseConditions))
            .groupBy(cloud_agent_code_reviews.agent_version)
        : undefined;

    return {
      totalReviews: total,
      completedCount,
      failedCount,
      cancelledCount,
      interruptedCount,
      inProgressCount,
      insufficientCreditsCount,
      // Success rate = completed / terminal states
      successRate: terminalCount > 0 ? (completedCount / terminalCount) * 100 : 0,
      // Failure rate = (failed + interrupted) / terminal states
      // Note: cancelled and insufficient credits are neutral (not success, not failure)
      failureRate: terminalCount > 0 ? ((failedCount + interruptedCount) / terminalCount) * 100 : 0,
      avgDurationSeconds: Number(stats.avg_duration_seconds) || 0,
      versionBreakdown: versionBreakdown?.map(row => ({
        agentVersion: row.agent_version,
        total: Number(row.total) || 0,
        completed: Number(row.completed) || 0,
        failed: Number(row.failed) || 0,
        avgDurationSeconds: Number(row.avg_duration_seconds) || 0,
      })),
    };
  }),

  // Get daily time series data
  getDailyStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})::date::text`,
        total: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude "Insufficient credits" errors from failed count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeInsufficientCreditsError})`,
        cancelled: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'cancelled')`,
        interrupted: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'interrupted')`,
        in_progress: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running'))`,
        insufficient_credits: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${cloud_agent_code_reviews.error_message} LIKE '%Insufficient credits%')`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`)
      .orderBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`);

    return result.map(row => ({
      day: row.day,
      total: Number(row.total) || 0,
      completed: Number(row.completed) || 0,
      failed: Number(row.failed) || 0,
      cancelled: Number(row.cancelled) || 0,
      interrupted: Number(row.interrupted) || 0,
      inProgress: Number(row.in_progress) || 0,
      insufficientCredits: Number(row.insufficient_credits) || 0,
    }));
  }),

  // Get error analysis (excludes "Insufficient credits" billing errors from the list)
  getErrorAnalysis: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      eq(cloud_agent_code_reviews.status, 'failed'),
      excludeInsufficientCreditsError,
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    // Categorized error summary
    const categorized = await db
      .select({
        category: errorCategoryExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${cloud_agent_code_reviews.created_at})::text`,
        last_occurrence: sql<string>`MAX(${cloud_agent_code_reviews.created_at})::text`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(errorCategoryExpr)
      .orderBy(desc(sql`COUNT(*)`));

    // Raw error messages (top 50, for drill-down table)
    const raw = await db
      .select({
        error_type: sql<string>`COALESCE(SUBSTRING(${cloud_agent_code_reviews.error_message} FROM 1 FOR 200), 'Unknown Error')`,
        category: errorCategoryExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${cloud_agent_code_reviews.created_at})::text`,
        last_occurrence: sql<string>`MAX(${cloud_agent_code_reviews.created_at})::text`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(
        sql`SUBSTRING(${cloud_agent_code_reviews.error_message} FROM 1 FOR 200)`,
        errorCategoryExpr
      )
      .orderBy(desc(sql`COUNT(*)`))
      .limit(50);

    return {
      categories: categorized.map(row => ({
        category: row.category,
        count: Number(row.count) || 0,
        firstOccurrence: row.first_occurrence,
        lastOccurrence: row.last_occurrence,
      })),
      details: raw.map(row => ({
        errorType: row.error_type,
        category: row.category,
        count: Number(row.count) || 0,
        firstOccurrence: row.first_occurrence,
        lastOccurrence: row.last_occurrence,
      })),
    };
  }),

  // Get user segmentation (note: this doesn't use filters since it shows top users/orgs for selection)
  getUserSegmentation: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const baseConditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    // Personal vs Org breakdown
    const ownershipBreakdown = await db
      .select({
        ownership_type: sql<string>`CASE WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'organization' ELSE 'personal' END`,
        count: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude "Insufficient credits" errors from failed count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeInsufficientCreditsError})`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...baseConditions))
      .groupBy(
        sql`CASE WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'organization' ELSE 'personal' END`
      );

    // Top users (only show if not filtering by specific user)
    const topUsers = userId
      ? []
      : await db
          .select({
            user_id: cloud_agent_code_reviews.owned_by_user_id,
            email: kilocode_users.google_user_email,
            name: kilocode_users.google_user_name,
            review_count: sql<number>`COUNT(*)`,
            completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
          })
          .from(cloud_agent_code_reviews)
          .leftJoin(
            kilocode_users,
            eq(cloud_agent_code_reviews.owned_by_user_id, kilocode_users.id)
          )
          .where(and(isNotNull(cloud_agent_code_reviews.owned_by_user_id), ...baseConditions))
          .groupBy(
            cloud_agent_code_reviews.owned_by_user_id,
            kilocode_users.google_user_email,
            kilocode_users.google_user_name
          )
          .orderBy(desc(sql`COUNT(*)`))
          .limit(10);

    // Top organizations (only show if not filtering by specific org)
    const topOrgs = organizationId
      ? []
      : await db
          .select({
            org_id: cloud_agent_code_reviews.owned_by_organization_id,
            org_name: organizations.name,
            org_plan: organizations.plan,
            review_count: sql<number>`COUNT(*)`,
            completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
          })
          .from(cloud_agent_code_reviews)
          .leftJoin(
            organizations,
            eq(cloud_agent_code_reviews.owned_by_organization_id, organizations.id)
          )
          .where(
            and(isNotNull(cloud_agent_code_reviews.owned_by_organization_id), ...baseConditions)
          )
          .groupBy(
            cloud_agent_code_reviews.owned_by_organization_id,
            organizations.name,
            organizations.plan
          )
          .orderBy(desc(sql`COUNT(*)`))
          .limit(10);

    return {
      ownershipBreakdown: ownershipBreakdown.map(row => ({
        type: row.ownership_type,
        count: Number(row.count) || 0,
        completed: Number(row.completed) || 0,
        failed: Number(row.failed) || 0,
      })),
      topUsers: topUsers.map(row => ({
        userId: row.user_id,
        email: row.email,
        name: row.name,
        reviewCount: Number(row.review_count) || 0,
        completedCount: Number(row.completed_count) || 0,
      })),
      topOrgs: topOrgs.map(row => ({
        orgId: row.org_id,
        name: row.org_name,
        plan: row.org_plan,
        reviewCount: Number(row.review_count) || 0,
        completedCount: Number(row.completed_count) || 0,
      })),
    };
  }),

  // Get daily performance percentiles (execution time = completed_at - started_at)
  getPerformanceStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      isNotNull(cloud_agent_code_reviews.completed_at),
      isNotNull(cloud_agent_code_reviews.started_at),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const durationExpr = sql`EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))`;

    const result = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})::date::text`,
        agent_version: sql<string>`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`,
        avg_seconds: sql<number>`AVG(${durationExpr})`,
        p50_seconds: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${durationExpr})`,
        p90_seconds: sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${durationExpr})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(
        sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`,
        cloud_agent_code_reviews.agent_version
      )
      .orderBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`);

    return result.map(row => ({
      day: row.day,
      agentVersion: row.agent_version,
      avgSeconds: Number(row.avg_seconds) || 0,
      p50Seconds: Number(row.p50_seconds) || 0,
      p90Seconds: Number(row.p90_seconds) || 0,
      count: Number(row.count) || 0,
    }));
  }),

  // Get CSV export data
  getExportData: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
      .select({
        id: cloud_agent_code_reviews.id,
        owned_by_organization_id: cloud_agent_code_reviews.owned_by_organization_id,
        owned_by_user_id: cloud_agent_code_reviews.owned_by_user_id,
        repo_full_name: cloud_agent_code_reviews.repo_full_name,
        pr_number: cloud_agent_code_reviews.pr_number,
        pr_title: cloud_agent_code_reviews.pr_title,
        pr_author: cloud_agent_code_reviews.pr_author,
        status: cloud_agent_code_reviews.status,
        error_message: cloud_agent_code_reviews.error_message,
        started_at: cloud_agent_code_reviews.started_at,
        completed_at: cloud_agent_code_reviews.completed_at,
        created_at: cloud_agent_code_reviews.created_at,
        session_id: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .orderBy(desc(cloud_agent_code_reviews.created_at))
      .limit(10000);

    return result;
  }),

  // Search users for filter dropdown
  searchUsers: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(
          or(
            ilike(kilocode_users.google_user_email, `%${input.query}%`),
            ilike(kilocode_users.google_user_name, `%${input.query}%`),
            eq(kilocode_users.id, input.query)
          )
        )
        .limit(20);

      return result;
    }),

  // Search organizations for filter dropdown
  searchOrganizations: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          plan: organizations.plan,
        })
        .from(organizations)
        .where(or(ilike(organizations.name, `%${input.query}%`), eq(organizations.id, input.query)))
        .limit(20);

      return result;
    }),

  getReviewPromotionStats: adminProcedure.query(async () => {
    // Aggregates: total requests, unique users, unique orgs
    const aggregates = await db
      .select({
        total_requests: sql<number>`COUNT(*)`,
        unique_users: sql<number>`COUNT(DISTINCT ${microdollar_usage.kilo_user_id})`,
        unique_orgs: sql<number>`COUNT(DISTINCT ${microdollar_usage.organization_id})`,
      })
      .from(microdollar_usage)
      .innerJoin(
        microdollar_usage_metadata,
        eq(microdollar_usage.id, microdollar_usage_metadata.id)
      )
      .where(
        and(
          eq(microdollar_usage.requested_model, REVIEW_PROMO_MODEL),
          eq(microdollar_usage.cost, 0),
          sql`(${microdollar_usage_metadata.is_user_byok} IS NULL OR ${microdollar_usage_metadata.is_user_byok} = false)`,
          gte(microdollar_usage.created_at, REVIEW_PROMO_START),
          lt(microdollar_usage.created_at, REVIEW_PROMO_END)
        )
      );

    // Daily breakdown
    const daily = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${microdollar_usage.created_at})::date::text`,
        total: sql<number>`COUNT(*)`,
        unique_users: sql<number>`COUNT(DISTINCT ${microdollar_usage.kilo_user_id})`,
      })
      .from(microdollar_usage)
      .innerJoin(
        microdollar_usage_metadata,
        eq(microdollar_usage.id, microdollar_usage_metadata.id)
      )
      .where(
        and(
          eq(microdollar_usage.requested_model, REVIEW_PROMO_MODEL),
          eq(microdollar_usage.cost, 0),
          sql`(${microdollar_usage_metadata.is_user_byok} IS NULL OR ${microdollar_usage_metadata.is_user_byok} = false)`,
          gte(microdollar_usage.created_at, REVIEW_PROMO_START),
          lt(microdollar_usage.created_at, REVIEW_PROMO_END)
        )
      )
      .groupBy(sql`DATE_TRUNC('day', ${microdollar_usage.created_at})`)
      .orderBy(sql`DATE_TRUNC('day', ${microdollar_usage.created_at})`);

    const agg = aggregates[0];
    return {
      promoActive: isActiveReviewPromo('reviewer', REVIEW_PROMO_MODEL),
      promoStart: REVIEW_PROMO_START,
      promoEnd: REVIEW_PROMO_END,
      totalRequests: Number(agg.total_requests) || 0,
      uniqueUsers: Number(agg.unique_users) || 0,
      uniqueOrgs: Number(agg.unique_orgs) || 0,
      daily: daily.map(row => ({
        day: row.day,
        total: Number(row.total) || 0,
        uniqueUsers: Number(row.unique_users) || 0,
      })),
    };
  }),
});
