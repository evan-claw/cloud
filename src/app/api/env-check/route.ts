import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getEnvVariable } from '@/lib/dotenvx';

const ENV_CHECK_SECRET = getEnvVariable('ENV_CHECK_SECRET');

type Deployment = {
  name: string;
  url: string;
};

const DEPLOYMENTS: Deployment[] = [
  { name: 'kilocode-app', url: getEnvVariable('KILOCODE_APP_URL') },
  { name: 'kilocode-global-app', url: getEnvVariable('KILOCODE_GLOBAL_APP_URL') },
  { name: 'kilocode-app-staging', url: getEnvVariable('KILOCODE_STAGING_APP_URL') },
];

type EnvCheckSuccess = {
  status: 'ok';
  message: string;
  deployments: string[];
};

type KeyDrift = {
  key: string;
  missingFrom?: string[];
  mismatchBetween?: string[];
};

type EnvCheckDrift = {
  status: 'drift';
  message: string;
  differences: KeyDrift[];
};

type EnvCheckError = {
  status: 'error';
  message: string;
  failures: { name: string; error: string }[];
};

type FetchResult = {
  name: string;
  entries: Record<string, string> | null;
  error: string | null;
};

async function fetchEnvKeys(deployment: Deployment, secret: string): Promise<FetchResult> {
  try {
    const response = await fetch(`${deployment.url}/api/env-keys`, {
      headers: { Authorization: `Bearer ${secret}` },
    });

    if (!response.ok) {
      return {
        name: deployment.name,
        entries: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const entries: Record<string, string> = await response.json();
    return { name: deployment.name, entries, error: null };
  } catch (err) {
    return {
      name: deployment.name,
      entries: null,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Fetches /api/env-keys from all three deployments, compares keys and hashed
 * values, and reports any drift. Protected by ENV_CHECK_SECRET bearer token.
 * Never exposes actual env values or hashes — only key names and drift type.
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<EnvCheckSuccess | EnvCheckDrift | EnvCheckError | { error: string }>> {
  const authHeader = request.headers.get('authorization');
  if (!ENV_CHECK_SECRET || authHeader !== `Bearer ${ENV_CHECK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const configuredDeployments = DEPLOYMENTS.filter(d => d.url);
  if (configuredDeployments.length === 0) {
    return NextResponse.json(
      { error: 'No deployment URLs configured' },
      { status: 500 }
    );
  }

  const results = await Promise.all(
    configuredDeployments.map(d => fetchEnvKeys(d, ENV_CHECK_SECRET))
  );

  const failures = results.filter(r => r.error !== null);
  if (failures.length > 0) {
    return NextResponse.json(
      {
        status: 'error' as const,
        message: `Failed to fetch env keys from ${failures.length} deployment(s)`,
        failures: failures.map(f => ({ name: f.name, error: f.error ?? 'Unknown error' })),
      },
      { status: 502 }
    );
  }

  // Collect the union of all keys across all deployments
  const allKeys = new Set<string>();
  for (const result of results) {
    if (result.entries) {
      for (const key of Object.keys(result.entries)) {
        allKeys.add(key);
      }
    }
  }

  // Find keys missing from any deployment, or with mismatched hashed values
  const differences: KeyDrift[] = [];
  for (const key of [...allKeys].sort()) {
    const presentIn = results.filter(r => r.entries && key in r.entries);
    const missingFrom = results
      .filter(r => r.entries && !(key in r.entries))
      .map(r => r.name);

    if (missingFrom.length > 0) {
      differences.push({ key, missingFrom });
    } else if (presentIn.length > 1) {
      // All deployments have this key — check whether hashed values match
      const hashes = presentIn.map(r => r.entries?.[key]);
      const unique = new Set(hashes);
      if (unique.size > 1) {
        differences.push({ key, mismatchBetween: presentIn.map(r => r.name) });
      }
    }
  }

  const deploymentNames = configuredDeployments.map(d => d.name);

  if (differences.length === 0) {
    return NextResponse.json({
      status: 'ok' as const,
      message: 'All deployments have matching env vars',
      deployments: deploymentNames,
    });
  }

  return NextResponse.json(
    {
      status: 'drift' as const,
      message: `Found ${differences.length} env var(s) with drift across deployments`,
      differences,
    },
    { status: 200 }
  );
}
