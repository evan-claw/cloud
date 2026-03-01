/**
 * Security Sync — Worker-side sync logic
 *
 * Ported from the Next.js app's sync-service.ts, dependabot-api.ts,
 * dependabot-parser.ts, security-findings.ts, and security-config.ts.
 *
 * This module is self-contained: it uses raw SQL via pg (through Hyperdrive)
 * and the GitHub REST API via fetch (with tokens from GIT_TOKEN_SERVICE).
 */

import { z } from 'zod';
import type { Database } from './db';

// ---------------------------------------------------------------------------
// Types (mirrored from src/lib/security-agent/core/types.ts)
// ---------------------------------------------------------------------------

const SecurityFindingSource = { DEPENDABOT: 'dependabot' } as const;

const SecurityFindingStatus = {
  OPEN: 'open',
  FIXED: 'fixed',
  IGNORED: 'ignored',
} as const;
type SecurityFindingStatus = (typeof SecurityFindingStatus)[keyof typeof SecurityFindingStatus];

const securitySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
type SecuritySeverity = z.infer<typeof securitySeveritySchema>;

const dependabotAlertStateSchema = z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']);
type DependabotAlertState = z.infer<typeof dependabotAlertStateSchema>;

const dependabotAlertRawSchema = z.object({
  number: z.number(),
  state: dependabotAlertStateSchema,
  dependency: z.object({
    package: z.object({ ecosystem: z.string(), name: z.string() }),
    manifest_path: z.string(),
    scope: z.enum(['development', 'runtime']),
  }),
  security_advisory: z.object({
    ghsa_id: z.string(),
    cve_id: z.string().nullable(),
    summary: z.string(),
    description: z.string(),
    severity: securitySeveritySchema,
    cvss: z.object({ score: z.number(), vector_string: z.string() }).optional(),
    cwes: z.array(z.object({ cwe_id: z.string(), name: z.string() })).optional(),
  }),
  security_vulnerability: z.object({
    vulnerable_version_range: z.string(),
    first_patched_version: z.object({ identifier: z.string() }).optional(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  fixed_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
  dismissed_by: z.object({ login: z.string() }).nullable().optional(),
  dismissed_reason: z.string().nullable().optional(),
  dismissed_comment: z.string().nullable().optional(),
  auto_dismissed_at: z.string().nullable().optional(),
  html_url: z.string(),
  url: z.string(),
});

type DependabotAlertRaw = z.infer<typeof dependabotAlertRawSchema>;

type ParsedSecurityFinding = {
  source: string;
  source_id: string;
  severity: SecuritySeverity;
  ghsa_id: string | null;
  cve_id: string | null;
  package_name: string;
  package_ecosystem: string;
  vulnerable_version_range: string | null;
  patched_version: string | null;
  manifest_path: string | null;
  title: string;
  description: string | null;
  status: SecurityFindingStatus;
  ignored_reason: string | null;
  ignored_by: string | null;
  fixed_at: string | null;
  dependabot_html_url: string | null;
  first_detected_at: string;
  raw_data: DependabotAlertRaw;
  cwe_ids: string[] | null;
  cvss_score: number | null;
  dependency_scope: 'development' | 'runtime' | null;
};

type SecurityAgentConfig = {
  sla_critical_days: number;
  sla_high_days: number;
  sla_medium_days: number;
  sla_low_days: number;
  repository_selection_mode: 'all' | 'selected';
  selected_repository_ids?: number[];
};

const securityAgentConfigSchema = z.object({
  sla_critical_days: z.number(),
  sla_high_days: z.number(),
  sla_medium_days: z.number(),
  sla_low_days: z.number(),
  repository_selection_mode: z.enum(['all', 'selected']),
  selected_repository_ids: z.array(z.number()).optional(),
});

const DEFAULT_SLA_CONFIG: SecurityAgentConfig = {
  sla_critical_days: 15,
  sla_high_days: 30,
  sla_medium_days: 45,
  sla_low_days: 90,
  repository_selection_mode: 'all',
};

type SecurityReviewOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type SyncResult = {
  synced: number;
  errors: number;
  staleRepos: string[];
};

type FetchAlertsResult =
  | { status: 'success'; alerts: DependabotAlertRaw[] }
  | { status: 'repo_not_found' }
  | { status: 'alerts_disabled' };

// ---------------------------------------------------------------------------
// Owner resolution — matches the dispatch message to DB config
// ---------------------------------------------------------------------------

type EnabledOwnerConfig = {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
  repoNameToId: Map<string, number>;
};

type IntegrationRow = {
  id: string;
  platform_installation_id: string;
  permissions: Record<string, string> | null;
  repositories: Array<{ id: number; full_name: string; name: string; private: boolean }> | null;
};

type AgentConfigRow = {
  id: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
};

export async function getOwnerConfig(
  db: Database,
  owner: SecurityReviewOwner
): Promise<EnabledOwnerConfig | null> {
  const isOrg = 'organizationId' in owner && Boolean(owner.organizationId);
  const ownerId = isOrg ? owner.organizationId : owner.userId;
  const ownerColumn = isOrg ? 'owned_by_organization_id' : 'owned_by_user_id';

  // Get agent config
  const configs = await db.query<AgentConfigRow>(
    `SELECT id, config, is_enabled FROM agent_configs
     WHERE agent_type = 'security_scan' AND platform = 'github' AND is_enabled = true AND ${ownerColumn} = $1
     LIMIT 1`,
    [ownerId]
  );
  if (configs.length === 0) return null;
  const agentConfig = configs[0];

  // Get platform integration
  const integrations = await db.query<IntegrationRow>(
    `SELECT id, platform_installation_id, permissions, repositories
     FROM platform_integrations
     WHERE ${ownerColumn} = $1 AND platform = 'github' AND platform_installation_id IS NOT NULL
     LIMIT 1`,
    [ownerId]
  );
  if (integrations.length === 0) return null;
  const integration = integrations[0];

  // Check vulnerability_alerts permission
  const perms = integration.permissions;
  if (!perms || (perms.vulnerability_alerts !== 'read' && perms.vulnerability_alerts !== 'write')) {
    console.warn(`Integration ${integration.id} missing vulnerability_alerts permission, skipping`);
    return null;
  }

  // Filter repositories
  const allRepos = (integration.repositories ?? []).filter(
    (r): r is { id: number; full_name: string; name: string; private: boolean } =>
      typeof r.id === 'number' && typeof r.full_name === 'string' && r.full_name.length > 0
  );
  if (allRepos.length === 0) return null;

  const repoNameToId = new Map(allRepos.map(r => [r.full_name, r.id]));

  const securityConfig = securityAgentConfigSchema.partial().parse(agentConfig.config);
  let selectedRepos: string[];
  if (
    securityConfig.repository_selection_mode === 'selected' &&
    securityConfig.selected_repository_ids &&
    securityConfig.selected_repository_ids.length > 0
  ) {
    const selectedIds = new Set(securityConfig.selected_repository_ids);
    selectedRepos = allRepos.filter(r => selectedIds.has(r.id)).map(r => r.full_name);
  } else {
    selectedRepos = allRepos.map(r => r.full_name);
  }

  if (selectedRepos.length === 0) return null;

  return {
    owner,
    platformIntegrationId: integration.id,
    installationId: integration.platform_installation_id,
    repositories: selectedRepos,
    repoNameToId,
  };
}

// ---------------------------------------------------------------------------
// GitHub Dependabot API — direct fetch (no Octokit needed)
// ---------------------------------------------------------------------------

async function fetchAllDependabotAlerts(
  token: string,
  repoOwner: string,
  repoName: string
): Promise<FetchAlertsResult> {
  const allAlerts: DependabotAlertRaw[] = [];
  let url: string | null =
    `https://api.github.com/repos/${repoOwner}/${repoName}/dependabot/alerts?per_page=100`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cloudflare-security-sync',
      },
    });

    if (response.status === 404) {
      return { status: 'repo_not_found' };
    }

    if (!response.ok) {
      const body = await response.text();

      if (
        response.status === 403 &&
        (body.includes('Dependabot alerts are disabled') ||
          body.includes('Dependabot alerts are not available'))
      ) {
        return { status: 'alerts_disabled' };
      }

      throw new Error(`GitHub API error ${response.status} for ${repoOwner}/${repoName}: ${body}`);
    }

    const json: unknown = await response.json();
    const data = z.array(dependabotAlertRawSchema).parse(json);
    allAlerts.push(...data);

    // Follow pagination via Link header
    const linkHeader = response.headers.get('link');
    url = parseLinkNext(linkHeader);

    // Check rate limit
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null && Number(remaining) < 100) {
      console.warn(
        `GitHub API rate limit low: ${remaining} remaining for ${repoOwner}/${repoName}`
      );
    }
  }

  return { status: 'success', alerts: allAlerts };
}

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Dependabot alert parser (ported from dependabot-parser.ts)
// ---------------------------------------------------------------------------

function mapDependabotStateToStatus(state: DependabotAlertState): SecurityFindingStatus {
  switch (state) {
    case 'open':
      return SecurityFindingStatus.OPEN;
    case 'fixed':
      return SecurityFindingStatus.FIXED;
    case 'dismissed':
    case 'auto_dismissed':
      return SecurityFindingStatus.IGNORED;
    default:
      return SecurityFindingStatus.OPEN;
  }
}

function parseDependabotAlert(alert: DependabotAlertRaw): ParsedSecurityFinding {
  const status = mapDependabotStateToStatus(alert.state);

  return {
    source: SecurityFindingSource.DEPENDABOT,
    source_id: alert.number.toString(),
    severity: alert.security_advisory.severity,
    ghsa_id: alert.security_advisory.ghsa_id,
    cve_id: alert.security_advisory.cve_id,
    package_name: alert.dependency.package.name,
    package_ecosystem: alert.dependency.package.ecosystem,
    vulnerable_version_range: alert.security_vulnerability.vulnerable_version_range,
    patched_version: alert.security_vulnerability.first_patched_version?.identifier ?? null,
    manifest_path: alert.dependency.manifest_path,
    title: alert.security_advisory.summary,
    description: alert.security_advisory.description,
    status,
    ignored_reason:
      status === SecurityFindingStatus.IGNORED ? (alert.dismissed_reason ?? null) : null,
    ignored_by:
      status === SecurityFindingStatus.IGNORED ? (alert.dismissed_by?.login ?? null) : null,
    fixed_at: alert.fixed_at,
    dependabot_html_url: alert.html_url,
    first_detected_at: alert.created_at,
    raw_data: alert,
    cwe_ids: alert.security_advisory.cwes?.map(cwe => cwe.cwe_id) ?? null,
    cvss_score: alert.security_advisory.cvss?.score ?? null,
    dependency_scope: alert.dependency.scope ?? null,
  };
}

// ---------------------------------------------------------------------------
// SLA helpers (ported from core/types.ts)
// ---------------------------------------------------------------------------

function getSlaForSeverity(config: SecurityAgentConfig, severity: SecuritySeverity): number {
  switch (severity) {
    case 'critical':
      return config.sla_critical_days;
    case 'high':
      return config.sla_high_days;
    case 'medium':
      return config.sla_medium_days;
    case 'low':
      return config.sla_low_days;
    default:
      return config.sla_low_days;
  }
}

function calculateSlaDueAt(firstDetectedAt: string, slaDays: number): string {
  const date = new Date(firstDetectedAt);
  date.setDate(date.getDate() + slaDays);
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// DB: get SLA config for owner
// ---------------------------------------------------------------------------

async function getSecurityAgentConfig(
  db: Database,
  owner: SecurityReviewOwner
): Promise<SecurityAgentConfig> {
  const isOrg = 'organizationId' in owner && Boolean(owner.organizationId);
  const ownerId = isOrg ? owner.organizationId : owner.userId;
  const ownerColumn = isOrg ? 'owned_by_organization_id' : 'owned_by_user_id';

  const rows = await db.query<{ config: Record<string, unknown> }>(
    `SELECT config FROM agent_configs
     WHERE agent_type = 'security_scan' AND platform = 'github' AND is_enabled = true AND ${ownerColumn} = $1
     LIMIT 1`,
    [ownerId]
  );

  if (rows.length === 0) return DEFAULT_SLA_CONFIG;
  const parsed = securityAgentConfigSchema.partial().safeParse(rows[0].config);
  if (!parsed.success) {
    console.warn('Invalid security agent config, using defaults', { error: parsed.error.message });
    return DEFAULT_SLA_CONFIG;
  }
  return { ...DEFAULT_SLA_CONFIG, ...parsed.data };
}

// ---------------------------------------------------------------------------
// DB: upsert security finding
// ---------------------------------------------------------------------------

async function upsertSecurityFinding(
  db: Database,
  params: {
    finding: ParsedSecurityFinding;
    owner: SecurityReviewOwner;
    platformIntegrationId: string;
    repoFullName: string;
    slaDueAt: string;
  }
): Promise<void> {
  const { finding, owner, platformIntegrationId, repoFullName, slaDueAt } = params;
  const isOrg = 'organizationId' in owner && Boolean(owner.organizationId);

  await db.query(
    `INSERT INTO security_findings (
      owned_by_organization_id, owned_by_user_id, platform_integration_id,
      repo_full_name, source, source_id, severity, ghsa_id, cve_id,
      package_name, package_ecosystem, vulnerable_version_range, patched_version,
      manifest_path, title, description, status, ignored_reason, ignored_by,
      fixed_at, sla_due_at, dependabot_html_url, raw_data, first_detected_at,
      cwe_ids, cvss_score, dependency_scope
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
    )
    ON CONFLICT (repo_full_name, source, source_id) DO UPDATE SET
      severity = EXCLUDED.severity,
      ghsa_id = EXCLUDED.ghsa_id,
      cve_id = EXCLUDED.cve_id,
      vulnerable_version_range = EXCLUDED.vulnerable_version_range,
      patched_version = EXCLUDED.patched_version,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      ignored_reason = EXCLUDED.ignored_reason,
      ignored_by = EXCLUDED.ignored_by,
      fixed_at = EXCLUDED.fixed_at,
      sla_due_at = EXCLUDED.sla_due_at,
      dependabot_html_url = EXCLUDED.dependabot_html_url,
      raw_data = EXCLUDED.raw_data,
      cwe_ids = EXCLUDED.cwe_ids,
      cvss_score = EXCLUDED.cvss_score,
      dependency_scope = EXCLUDED.dependency_scope,
      last_synced_at = now(),
      updated_at = now()`,
    [
      isOrg ? owner.organizationId : null,
      isOrg ? null : owner.userId,
      platformIntegrationId,
      repoFullName,
      finding.source,
      finding.source_id,
      finding.severity,
      finding.ghsa_id,
      finding.cve_id,
      finding.package_name,
      finding.package_ecosystem,
      finding.vulnerable_version_range,
      finding.patched_version,
      finding.manifest_path,
      finding.title,
      finding.description,
      finding.status,
      finding.ignored_reason,
      finding.ignored_by,
      finding.fixed_at,
      slaDueAt,
      finding.dependabot_html_url,
      JSON.stringify(finding.raw_data),
      finding.first_detected_at,
      finding.cwe_ids,
      finding.cvss_score?.toString() ?? null,
      finding.dependency_scope,
    ]
  );
}

// ---------------------------------------------------------------------------
// DB: write audit log
// ---------------------------------------------------------------------------

async function writeAuditLog(
  db: Database,
  params: {
    owner: SecurityReviewOwner;
    action: string;
    resource_type: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const { owner, action, resource_type, resource_id, metadata } = params;
  const isOrg = 'organizationId' in owner && Boolean(owner.organizationId);

  await db.query(
    `INSERT INTO security_audit_log (
      owned_by_organization_id, owned_by_user_id,
      actor_id, actor_email, actor_name,
      action, resource_type, resource_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      isOrg ? owner.organizationId : null,
      isOrg ? null : owner.userId,
      null, // actor_id — system operation
      null, // actor_email
      null, // actor_name
      action,
      resource_type,
      resource_id,
      JSON.stringify(metadata),
    ]
  );
}

// ---------------------------------------------------------------------------
// DB: prune stale repos from config
// ---------------------------------------------------------------------------

async function pruneStaleReposFromConfig(
  db: Database,
  owner: SecurityReviewOwner,
  staleRepoNames: string[],
  repoNameToId: Map<string, number>
): Promise<void> {
  if (staleRepoNames.length === 0) return;

  const staleIds = new Set(
    staleRepoNames.map(name => repoNameToId.get(name)).filter((id): id is number => id != null)
  );
  if (staleIds.size === 0) return;

  const isOrg = 'organizationId' in owner && Boolean(owner.organizationId);
  const ownerId = isOrg ? owner.organizationId : owner.userId;
  const ownerColumn = isOrg ? 'owned_by_organization_id' : 'owned_by_user_id';

  const rows = await db.query<{ id: string; config: Record<string, unknown>; is_enabled: boolean }>(
    `SELECT id, config, is_enabled FROM agent_configs
     WHERE agent_type = 'security_scan' AND platform = 'github' AND ${ownerColumn} = $1
     LIMIT 1`,
    [ownerId]
  );
  if (rows.length === 0) return;

  const parsed = securityAgentConfigSchema.partial().safeParse(rows[0].config);
  if (!parsed.success) {
    console.warn('Invalid security agent config, skipping prune', { error: parsed.error.message });
    return;
  }
  const config = parsed.data;
  if (
    config.repository_selection_mode !== 'selected' ||
    !config.selected_repository_ids ||
    config.selected_repository_ids.length === 0
  ) {
    return;
  }

  const prunedIds = config.selected_repository_ids.filter(id => !staleIds.has(id));
  if (prunedIds.length === config.selected_repository_ids.length) return;

  const updatedConfig = { ...config, selected_repository_ids: prunedIds };
  await db.query(`UPDATE agent_configs SET config = $1, updated_at = now() WHERE id = $2`, [
    JSON.stringify(updatedConfig),
    rows[0].id,
  ]);

  console.warn(
    `Pruned ${config.selected_repository_ids.length - prunedIds.length} stale repo(s) from config`
  );
}

// ---------------------------------------------------------------------------
// Sync orchestration for a single owner (called from queue handler)
// ---------------------------------------------------------------------------

export async function syncOwner(params: {
  db: Database;
  gitTokenService: GitTokenService;
  owner: SecurityReviewOwner;
  runId: string;
}): Promise<SyncResult> {
  const { db: database, gitTokenService, owner, runId } = params;

  const config = await getOwnerConfig(database, owner);
  if (!config) {
    console.info(`No enabled config for owner, skipping`, { runId, owner });
    return { synced: 0, errors: 0, staleRepos: [] };
  }

  const token = await gitTokenService.getToken(config.installationId);
  const slaConfig = await getSecurityAgentConfig(database, owner);

  const totalResult: SyncResult = { synced: 0, errors: 0, staleRepos: [] };
  let firstError: Error | null = null;
  let successfulRepos = 0;

  for (const repoFullName of config.repositories) {
    try {
      const repoResult = await syncRepo({
        db: database,
        token,
        owner,
        platformIntegrationId: config.platformIntegrationId,
        repoFullName,
        slaConfig,
      });
      totalResult.synced += repoResult.synced;
      totalResult.errors += repoResult.errors;
      totalResult.staleRepos.push(...repoResult.staleRepos);
      successfulRepos++;
    } catch (error) {
      totalResult.errors++;
      console.error(`Failed to sync ${repoFullName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!firstError && error instanceof Error) {
        firstError = error;
      }
    }
  }

  if (successfulRepos === 0 && firstError) {
    throw firstError;
  }

  // Prune stale repos
  if (totalResult.staleRepos.length > 0) {
    try {
      await pruneStaleReposFromConfig(database, owner, totalResult.staleRepos, config.repoNameToId);
    } catch (error) {
      console.error('Failed to prune stale repos from config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Write audit log
  const ownerId =
    'organizationId' in owner ? (owner.organizationId ?? 'unknown') : (owner.userId ?? 'unknown');
  try {
    await writeAuditLog(database, {
      owner,
      action: 'security.sync.completed',
      resource_type: 'agent_config',
      resource_id: ownerId,
      metadata: {
        source: 'system',
        trigger: 'worker_queue',
        runId,
        synced: totalResult.synced,
        errors: totalResult.errors,
        repoCount: config.repositories.length,
      },
    });
  } catch (error) {
    console.error('Failed to write audit log', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return totalResult;
}

// ---------------------------------------------------------------------------
// Sync a single repository
// ---------------------------------------------------------------------------

async function syncRepo(params: {
  db: Database;
  token: string;
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  repoFullName: string;
  slaConfig: SecurityAgentConfig;
}): Promise<SyncResult> {
  const { db: database, token, owner, platformIntegrationId, repoFullName, slaConfig } = params;
  const result: SyncResult = { synced: 0, errors: 0, staleRepos: [] };

  const [repoOwner, repoName] = repoFullName.split('/');
  if (!repoOwner || !repoName) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }

  const fetchResult = await fetchAllDependabotAlerts(token, repoOwner, repoName);

  if (fetchResult.status === 'repo_not_found') {
    console.warn(`Repository ${repoFullName} no longer exists, marking as stale`);
    result.staleRepos.push(repoFullName);
    return result;
  }

  if (fetchResult.status === 'alerts_disabled') {
    console.info(`Dependabot alerts disabled for ${repoFullName}, skipping`);
    return result;
  }

  const findings = fetchResult.alerts.map(alert => parseDependabotAlert(alert));
  console.info(`Fetched ${fetchResult.alerts.length} alerts, parsed ${findings.length} findings`, {
    repo: repoFullName,
  });

  for (const finding of findings) {
    try {
      const slaDays = getSlaForSeverity(slaConfig, finding.severity);
      const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

      await upsertSecurityFinding(database, {
        finding,
        owner,
        platformIntegrationId,
        repoFullName,
        slaDueAt,
      });
      result.synced++;
    } catch (error) {
      result.errors++;
      console.error(`Error upserting finding for ${repoFullName}`, {
        alertNumber: finding.source_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
