import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getEnvVariable } from '@/lib/dotenvx';

const ENV_CHECK_SECRET = getEnvVariable('ENV_CHECK_SECRET');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Vercel-managed env vars that legitimately differ between deployments
const IGNORED_KEYS = new Set([
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_MESSAGE',
  'VERCEL_GIT_COMMIT_AUTHOR_LOGIN',
  'VERCEL_GIT_COMMIT_AUTHOR_NAME',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_GIT_PREVIOUS_SHA',
  'VERCEL_GIT_PROVIDER',
  'VERCEL_GIT_PULL_REQUEST_ID',
  'VERCEL_GIT_REPO_ID',
  'VERCEL_GIT_REPO_OWNER',
  'VERCEL_GIT_REPO_SLUG',
  'VERCEL_REGION',
  'VERCEL_DEPLOYMENT_ID',
  'VERCEL_SKEW_PROTECTION_ENABLED',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
]);

/**
 * Returns the set of process.env keys available at runtime with SHA-256
 * hashed values, filtered to exclude Vercel-managed vars that differ
 * between deployments. Protected by ENV_CHECK_SECRET bearer token.
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | Record<string, string>>> {
  const authHeader = request.headers.get('authorization');
  if (!ENV_CHECK_SECRET || authHeader !== `Bearer ${ENV_CHECK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keys = Object.keys(process.env)
    .filter(key => !IGNORED_KEYS.has(key))
    .sort();

  const hashedEntries: Record<string, string> = {};
  for (const key of keys) {
    hashedEntries[key] = sha256(process.env[key] ?? '__undefined__');
  }

  return NextResponse.json(hashedEntries);
}
