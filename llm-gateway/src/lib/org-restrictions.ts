// Organization balance and model restriction checks.
// Ports checkOrganizationModelRestrictions from src/lib/llm-proxy-helpers.ts and
// getBalanceForOrganizationUser from src/lib/organizations/organization-usage.ts.

import type { WorkerDb } from '@kilocode/db/client';
import type { OrganizationSettings, OrganizationPlan } from '@kilocode/db/schema-types';
import { processOrganizationExpirations } from './credit-expiration';
import {
  organizations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
} from '@kilocode/db/schema';
import { and, eq, sql, not } from 'drizzle-orm';
import { normalizeModelId } from './models';

// Inference providers that a Kilo free model REQUIRES (must all be in provider allow list)
const kiloFreeModelProviders: Record<string, string[]> = {
  'corethink:free': ['corethink'],
  'giga-potato': ['stealth'],
  'giga-potato-thinking': ['stealth'],
  'moonshotai/kimi-k2.5:free': [],
  'minimax/minimax-m2.5:free': [],
  'x-ai/grok-code-fast-1:optimized:free': ['stealth'],
  'z-ai/glm-5:free': [],
};

function extraRequiredProviders(model: string): string[] {
  return kiloFreeModelProviders[model] ?? [];
}

export type OpenRouterProviderConfig = {
  order?: string[];
  only?: string[];
  data_collection?: 'allow' | 'deny';
};

export type OrganizationRestrictionResult = {
  error: { status: 400 | 401 | 402 | 403 | 404; message: string } | null;
  providerConfig?: OpenRouterProviderConfig;
};

export function checkOrganizationModelRestrictions(params: {
  modelId: string;
  settings?: OrganizationSettings;
  organizationPlan?: OrganizationPlan;
}): OrganizationRestrictionResult {
  if (!params.settings) return { error: null };

  const normalizedModelId = normalizeModelId(params.modelId);

  // Model allow list only enforced for Enterprise plans
  if (params.organizationPlan === 'enterprise') {
    const modelAllowList = params.settings.model_allow_list ?? [];
    if (modelAllowList.length > 0) {
      const isExactMatch = modelAllowList.includes(normalizedModelId);
      const providerSlug = normalizedModelId.split('/')[0];
      const wildcardEntry = `${providerSlug}/*`;
      const isWildcardMatch = modelAllowList.includes(wildcardEntry);
      if (!isExactMatch && !isWildcardMatch) {
        return { error: { status: 404, message: 'Model not allowed for your team.' } };
      }
    }
  }

  const providerAllowList = params.settings.provider_allow_list ?? [];
  const dataCollection = params.settings.data_collection;
  const providerConfig: OpenRouterProviderConfig = {};

  if (params.organizationPlan === 'enterprise' && providerAllowList.length > 0) {
    const requiredProviders = extraRequiredProviders(params.modelId);
    if (
      requiredProviders.length > 0 &&
      !requiredProviders.every(p => providerAllowList.includes(p))
    ) {
      return { error: { status: 404, message: 'Model not allowed for your team.' } };
    }
    providerConfig.only = providerAllowList;
  }

  if (dataCollection) {
    providerConfig.data_collection = dataCollection;
  }

  return {
    error: null,
    providerConfig: Object.keys(providerConfig).length > 0 ? providerConfig : undefined,
  };
}

export type OrgBalanceAndSettings = {
  balance: number;
  settings: OrganizationSettings | undefined;
  plan: OrganizationPlan | undefined;
  /** Fields needed for auto-top-up (org requests only) */
  autoTopUp?: {
    organizationId: string;
    auto_top_up_enabled: boolean;
    total_microdollars_acquired: number;
    microdollars_used: number;
  };
};

export async function getBalanceAndOrgSettings(
  db: WorkerDb,
  organizationId: string | undefined,
  user: { total_microdollars_acquired: number; microdollars_used: number; id: string }
): Promise<OrgBalanceAndSettings> {
  // Non-org users: balance is on the user object already
  if (!organizationId) {
    const balance = (user.total_microdollars_acquired - user.microdollars_used) / 1_000_000;
    return { balance, settings: undefined, plan: undefined };
  }

  const [row] = await db
    .select({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
      plan: organizations.plan,
      require_seats: organizations.require_seats,
      auto_top_up_enabled: organizations.auto_top_up_enabled,
      next_credit_expiration_at: organizations.next_credit_expiration_at,
      microdollar_limit: organization_user_limits.microdollar_limit,
      microdollar_usage: organization_user_usage.microdollar_usage,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .leftJoin(
      organization_user_limits,
      and(
        eq(organization_user_limits.organization_id, organizations.id),
        eq(organization_user_limits.kilo_user_id, user.id),
        eq(organization_user_limits.limit_type, 'daily')
      )
    )
    .leftJoin(
      organization_user_usage,
      and(
        eq(organization_user_usage.organization_id, organizations.id),
        eq(organization_user_usage.kilo_user_id, user.id),
        eq(organization_user_usage.limit_type, 'daily'),
        eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
      )
    )
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organization_memberships.kilo_user_id, user.id),
        not(eq(organization_memberships.role, 'billing_manager'))
      )
    )
    .limit(1);

  if (!row) {
    return { balance: 0, settings: undefined, plan: undefined };
  }

  let { total_microdollars_acquired } = row;
  const { microdollars_used } = row;

  // Lazy credit expiry check — random-hour jitter to spread load, matching reference.
  // subHours(new Date(), Math.random()) ≈ new Date(Date.now() - Math.random() * 3600000)
  const expireBefore = new Date(Date.now() - Math.random() * 3_600_000);
  if (row.next_credit_expiration_at && expireBefore >= new Date(row.next_credit_expiration_at)) {
    try {
      const expiryResult = await processOrganizationExpirations(
        db,
        {
          id: organizationId,
          microdollars_used,
          next_credit_expiration_at: row.next_credit_expiration_at,
          total_microdollars_acquired,
        },
        expireBefore
      );
      if (expiryResult) {
        total_microdollars_acquired = expiryResult.total_microdollars_acquired;
      }
    } catch (err) {
      console.error('[getBalanceAndOrgSettings] credit expiry failed', err);
    }
  }

  const orgBalance = (total_microdollars_acquired - microdollars_used) / 1_000_000;

  const autoTopUp = {
    organizationId,
    auto_top_up_enabled: row.auto_top_up_enabled,
    total_microdollars_acquired,
    microdollars_used,
  };

  if (row.require_seats) {
    return {
      balance: orgBalance,
      settings: row.settings ?? undefined,
      plan: row.plan ?? undefined,
      autoTopUp,
    };
  }

  if (row.microdollar_limit == null) {
    return {
      balance: orgBalance,
      settings: row.settings ?? undefined,
      plan: row.plan ?? undefined,
      autoTopUp,
    };
  }

  const usageAmount = row.microdollar_usage ?? 0;
  const remainingAllowance = (row.microdollar_limit - usageAmount) / 1_000_000;
  const cappedBalance = Math.min(remainingAllowance, orgBalance);

  return {
    balance: cappedBalance,
    settings: row.settings ?? undefined,
    plan: row.plan ?? undefined,
    autoTopUp,
  };
}
