// Header extraction helpers — port of src/lib/llm-proxy-helpers.ts and src/lib/utils.ts.
// Uses the Fetch API Headers interface (compatible with Cloudflare Workers).

export function extractHeaderAndLimitLength(headers: Headers, name: string): string | null {
  return headers.get(name)?.slice(0, 500)?.trim() || null;
}

export type FraudDetectionHeaders = {
  http_x_forwarded_for: string | null;
  geo_city: string | null;
  geo_country: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  ja3_hash: string | null;
  http_user_agent: string | null;
};

function parseFloatOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// Safe property access on an unknown object.
function prop(obj: unknown, key: string): unknown {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

// Reads geo/fingerprint data from Cloudflare's request.cf object.
// `cf` is typed as `unknown` to avoid fighting the CfProperties union
// (IncomingRequestCfProperties | RequestInitCfProperties); at runtime it's
// always an IncomingRequestCfProperties on incoming requests.
export function getFraudDetectionHeaders(headers: Headers, cf: unknown): FraudDetectionHeaders {
  return {
    http_x_forwarded_for: headers.get('x-forwarded-for'),
    geo_city: str(prop(cf, 'city')),
    geo_country: str(prop(cf, 'country')),
    geo_latitude: parseFloatOrNull(prop(cf, 'latitude')),
    geo_longitude: parseFloatOrNull(prop(cf, 'longitude')),
    ja3_hash: str(prop(prop(cf, 'botManagement'), 'ja3Hash')),
    http_user_agent: headers.get('user-agent'),
  };
}

// Port of src/lib/normalizeProjectId.ts
function normalizeProjectId(projectId: string | null): string | null {
  if (!projectId) return null;
  const truncated = projectId.substring(0, 256);

  const httpsRepoPattern = /^https?:\/\/[^/]+\/([^\s?#]+?)(?:\.git)?$/i;
  const httpsMatch = truncated.match(httpsRepoPattern);
  if (httpsMatch) {
    const repoPath = httpsMatch[1];
    const parts = repoPath.split('/');
    return parts[parts.length - 1] ?? null;
  }

  const sshGitPattern = /^git@[^:]+:([^\s]+?)(?:\.git)?$/i;
  const sshMatch = truncated.match(sshGitPattern);
  if (sshMatch) {
    const repoPath = sshMatch[1];
    const parts = repoPath.split('/');
    return parts[parts.length - 1] ?? null;
  }

  return truncated;
}

// Port of src/lib/userAgent.ts (getXKiloCodeVersionNumber)
function getXKiloCodeVersionNumber(userAgent: string | null | undefined): number | undefined {
  if (!userAgent) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[a-zA-Z0-9.]+)?(?:\s|$)/.exec(userAgent);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  const patch = match[3] ? Number(match[3]) : 0;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return undefined;
  return major + minor / 1000 + patch / 1_000_000;
}

export type ProjectHeaders = {
  fraudHeaders: FraudDetectionHeaders;
  xKiloCodeVersion: string | null;
  projectId: string | null;
  numericKiloCodeVersion: number;
  taskId: string | null;
  editorName: string | null;
  machineId: string | null;
};

export function extractProjectHeaders(headers: Headers, cf: unknown): ProjectHeaders {
  const xKiloCodeVersion = headers.get('X-KiloCode-Version');
  return {
    fraudHeaders: getFraudDetectionHeaders(headers, cf),
    xKiloCodeVersion,
    projectId: normalizeProjectId(headers.get('X-KiloCode-ProjectId')),
    numericKiloCodeVersion: getXKiloCodeVersionNumber(xKiloCodeVersion) ?? 0,
    taskId: extractHeaderAndLimitLength(headers, 'x-kilocode-taskid'),
    editorName: extractHeaderAndLimitLength(headers, 'x-kilocode-editorname'),
    machineId: extractHeaderAndLimitLength(headers, 'x-kilocode-machineid'),
  };
}
