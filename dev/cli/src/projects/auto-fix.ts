import type { ProjectDef } from './types';
import { spawnService, run } from '../utils/process';
import * as ui from '../utils/ui';
import { join } from 'path';
import { createHmac, randomUUID } from 'crypto';

const GENERIC_BODY = JSON.stringify(
  {
    action: 'created',
    comment: {
      body: 'PLACEHOLDER: Replace with real comment',
    },
    pull_request: {
      number: 123,
      title: 'PLACEHOLDER: Replace with real PR title',
      body: 'PLACEHOLDER: Replace with real PR body',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/OWNER/REPO/pull/123',
      user: {
        id: 1,
        login: 'octocat',
        avatar_url: 'https://github.com/images/error/octocat_happy.gif',
      },
      head: {
        sha: '1111111111111111111111111111111111111111',
        ref: 'feature/placeholder',
        repo: { full_name: 'OWNER/REPO' },
      },
      base: {
        sha: '2222222222222222222222222222222222222222',
        ref: 'main',
      },
    },
    repository: {
      id: 1,
      name: 'REPO',
      full_name: 'OWNER/REPO',
      private: false,
      owner: { login: 'OWNER' },
    },
    installation: { id: 12345678 },
    sender: { login: 'octocat' },
  },
  null,
  2
);

async function upCommand(args: string[], root: string): Promise<void> {
  const skipRoot = args.includes('--no-root');

  const logDir = join(root, 'dev', '.dev-logs', 'auto-fix');
  await Bun.write(join(logDir, '.gitkeep'), '');

  ui.header('Kilo Cloud Dev Services — Auto Fix');
  console.log(`  ${ui.dim(`Logs → ${logDir}/`)}\n`);

  if (!skipRoot) {
    console.log(`  Starting ${ui.bold('root')} (Next.js, port 3000)...`);
    spawnService({
      name: 'root',
      command: 'pnpm dev',
      cwd: root,
    });
  }

  console.log(`  Starting ${ui.bold('session')} (Session Worker, inspector 9230)...`);
  spawnService({
    name: 'session',
    command: 'pnpm exec wrangler dev --inspector-port 9230',
    cwd: join(root, 'cloudflare-session-ingest'),
  });

  console.log(`  Starting ${ui.bold('auto-fix')} (Auto Fix Worker, inspector 9231)...`);
  spawnService({
    name: 'auto-fix',
    command: 'pnpm exec wrangler dev --inspector-port 9231',
    cwd: join(root, 'cloudflare-auto-fix-infra'),
  });

  console.log(`  Starting ${ui.bold('agent-next')} (Agent Next Worker, inspector 9232)...`);
  const agentNextDir = join(root, 'cloud-agent-next');
  const buildOk = await run({
    command: 'pnpm run build:wrapper',
    cwd: agentNextDir,
    label: 'agent-next: build:wrapper',
  });
  if (!buildOk) {
    ui.error('agent-next build:wrapper failed — aborting');
    process.exit(1);
  }
  spawnService({
    name: 'agent-next',
    command: 'pnpm exec wrangler dev --env dev --inspector-port 9232',
    cwd: agentNextDir,
  });

  console.log(`\n  ${ui.dim('Press Ctrl+C to stop all services')}\n`);
  await new Promise(() => {});
}

async function testWebhookCommand(args: string[], _root: string): Promise<void> {
  const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://127.0.0.1:3000/api/webhooks/github';
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'dausigdb781g287d9asgd9721dsa';
  const DEFAULT_EVENT_TYPE = 'pull_request_review_comment';

  const payloadFile = args[0];
  let rawBody: string;
  let payloadSource: string;

  if (payloadFile === '-') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk);
    }
    rawBody = Buffer.concat(chunks).toString('utf-8');
    payloadSource = 'stdin';
  } else if (payloadFile) {
    rawBody = await Bun.file(payloadFile).text();
    payloadSource = payloadFile;
  } else {
    rawBody = GENERIC_BODY;
    payloadSource = 'embedded generic payload';
  }

  // Detect event from envelope payload
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = {};
  }

  let finalEventType: string;
  if (process.env.EVENT_TYPE) {
    finalEventType = process.env.EVENT_TYPE;
  } else if (parsed && typeof parsed.event === 'string') {
    finalEventType = parsed.event;
  } else {
    finalEventType = DEFAULT_EVENT_TYPE;
  }

  // Unwrap envelope payloads like {event: "...", payload: {...}}
  const body =
    parsed && typeof parsed.payload === 'object' && parsed.payload !== null
      ? JSON.stringify(parsed.payload)
      : rawBody;

  const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  const deliveryId = randomUUID();

  console.log(`Delivery ID:    ${deliveryId}`);
  console.log(`Event:          ${finalEventType}`);
  console.log(`URL:            ${WEBHOOK_URL}`);
  console.log(`Payload source: ${payloadSource}`);
  console.log(`Signature:      ${signature}`);
  console.log();
  console.log('Sending webhook...');
  console.log();

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': finalEventType,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
    },
    body,
  });

  const responseText = await response.text();
  console.log(responseText);
  console.log(`HTTP Status: ${response.status}`);
  console.log();
  console.log('Done.');
}

export const autoFix: ProjectDef = {
  name: 'auto-fix',
  description: 'Auto-fix dev environment (workers + Next.js)',
  commands: {
    up: {
      description: 'Start auto-fix dev environment (Next.js + session/auto-fix/agent-next workers)',
      run: upCommand,
    },
    'test-webhook': {
      description: 'Send a test GitHub pull_request_review_comment webhook to the local dev server',
      run: testWebhookCommand,
    },
  },
};
