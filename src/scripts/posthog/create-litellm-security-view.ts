import '@/lib/load-env';
import { getEnvVariable } from '@/lib/dotenvx';

const POSTHOG_API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '141915';

const VIEW_NAME = 'notification_litellm_security_mar_24';

// HogQL query that finds users who have used the LiteLLM provider in the last 90 days.
// Returns distinct_id (which is the Kilo user ID) as `id` so the notification code can
// query `select id from notification_litellm_security_mar_24`.
const VIEW_QUERY = `
SELECT
    DISTINCT distinct_id AS id
FROM events
WHERE
    event = 'LLM Completion'
    AND properties.apiProvider = 'litellm'
    AND timestamp >= now() - INTERVAL 90 DAY
ORDER BY id ASC
LIMIT 100000
`.trim();

async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  const apiKey = getEnvVariable('POSTHOG_QUERY_WRITER_KEY');
  if (!apiKey) {
    throw new Error('POSTHOG_QUERY_WRITER_KEY environment variable is required');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  return response;
}

type SavedQuery = {
  id: string;
  name: string;
};

async function findExistingView(): Promise<SavedQuery | undefined> {
  const url = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/warehouse_saved_queries/?search=${encodeURIComponent(VIEW_NAME)}`;
  console.log(`Searching for existing view "${VIEW_NAME}"...`);

  const response = await fetchWithAuth(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to search saved queries: HTTP ${response.status}\n${errorText}`);
  }

  const data: { results: SavedQuery[] } = await response.json();
  return data.results.find(v => v.name === VIEW_NAME);
}

async function createView(): Promise<void> {
  const url = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/warehouse_saved_queries/`;
  console.log(`Creating saved query "${VIEW_NAME}"...`);
  console.log(`  HogQL:\n${VIEW_QUERY}\n`);

  const response = await fetchWithAuth(url, {
    method: 'POST',
    body: JSON.stringify({
      name: VIEW_NAME,
      query: {
        kind: 'HogQLQuery',
        query: VIEW_QUERY,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create saved query: HTTP ${response.status}\n${errorText}`);
  }

  const result: SavedQuery = await response.json();
  console.log(`Created saved query "${result.name}" (ID: ${result.id})`);
}

async function run(): Promise<void> {
  console.log(`Setting up PostHog Data Warehouse Saved Query for LiteLLM security notification\n`);

  const existing = await findExistingView();
  if (existing) {
    console.log(`View "${VIEW_NAME}" already exists (ID: ${existing.id}). No action needed.`);
    return;
  }

  await createView();
  console.log('\nDone. The notification code can now query this view.');
}

run().then(
  () => process.exit(0),
  err => {
    console.error('Fatal error:', err);
    process.exit(1);
  }
);
