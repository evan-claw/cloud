import * as z from 'zod';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
} from '@/routers/organizations/utils';
import { microdollar_usage, user_auth_provider } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { and, eq, gte, lte, sql, desc } from 'drizzle-orm';

const MAX_EXPORT_ROWS = 10_000;

const ChargebackExportInputSchema = OrganizationIdInputSchema.extend({
  startDate: z.string().date(),
  endDate: z.string().date(),
});

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const organizationChargebackExportRouter = createTRPCRouter({
  export: organizationOwnerProcedure
    .input(ChargebackExportInputSchema)
    .mutation(async ({ input }) => {
      const { organizationId, startDate, endDate } = input;

      // endDate is inclusive: query up to end-of-day
      const endDateExclusive = `${endDate}T23:59:59.999Z`;

      const rows = await db
        .select({
          date: sql<string>`DATE(${microdollar_usage.created_at})`.as('date'),
          user_email: sql<string>`COALESCE(${user_auth_provider.email}, 'unknown')`.as(
            'user_email'
          ),
          total_cost: sql<number>`SUM(${microdollar_usage.cost})`.as('total_cost'),
        })
        .from(microdollar_usage)
        .leftJoin(
          user_auth_provider,
          and(
            eq(microdollar_usage.kilo_user_id, user_auth_provider.kilo_user_id),
            eq(user_auth_provider.provider, 'google')
          )
        )
        .where(
          and(
            eq(microdollar_usage.organization_id, organizationId),
            gte(microdollar_usage.created_at, `${startDate}T00:00:00.000Z`),
            lte(microdollar_usage.created_at, endDateExclusive)
          )
        )
        .groupBy(sql`DATE(${microdollar_usage.created_at})`, user_auth_provider.email)
        .orderBy(desc(sql`DATE(${microdollar_usage.created_at})`))
        .limit(MAX_EXPORT_ROWS);

      const header = 'date,user_email,model_cost';
      const csvRows = rows.map(row => {
        const dollarCost = (Number(row.total_cost) / 1_000_000).toFixed(6);
        return [
          escapeCsvField(String(row.date)),
          escapeCsvField(String(row.user_email)),
          escapeCsvField(dollarCost),
        ].join(',');
      });

      return {
        data: [header, ...csvRows].join('\n'),
        rowCount: rows.length,
      };
    }),
});
