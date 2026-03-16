import type { ProjectDef } from './types';
import { run } from '../utils/process';
import * as ui from '../utils/ui';
import { join } from 'path';

const SESSION = 'app-builder-dev';

const SERVICES = [
  {
    pane: 0,
    title: 'db-proxy (8792)',
    dir: 'cloudflare-db-proxy',
    cmd: 'pnpm exec wrangler dev --inspector-port 9230',
    url: 'http://localhost:8792',
  },
  {
    pane: 1,
    title: 'session-ingest (8787)',
    dir: 'cloudflare-session-ingest',
    cmd: 'pnpm exec wrangler dev --inspector-port 9233',
    url: 'http://localhost:8787',
  },
  {
    pane: 2,
    title: 'cloud-agent (8788)',
    dir: 'cloud-agent',
    cmd: 'pnpm exec wrangler dev --inspector-port 9231',
    url: 'http://localhost:8788',
  },
  {
    pane: 3,
    title: 'images-mcp (8796)',
    dir: 'cloudflare-images-mcp',
    cmd: 'pnpm exec wrangler dev --env dev --inspector-port 9236',
    url: 'http://localhost:8796',
  },
  {
    pane: 4,
    title: 'webhook-ingest (8793)',
    dir: 'cloudflare-webhook-agent-ingest',
    cmd: 'pnpm exec wrangler dev --env dev --inspector-port 9237',
    url: 'http://localhost:8793',
  },
  {
    pane: 5,
    title: 'git-token (8795)',
    dir: 'cloudflare-git-token-service',
    cmd: 'pnpm exec wrangler dev --inspector-port 9235',
    url: 'http://localhost:8795',
  },
  {
    pane: 6,
    title: 'app-builder (8790)',
    dir: 'cloudflare-app-builder',
    cmd: 'pnpm exec wrangler dev --inspector-port 9232',
    url: 'http://localhost:8790',
  },
  {
    pane: 7,
    title: 'ngrok -> 8790',
    dir: '.',
    cmd: 'ngrok http 8790',
    url: 'forwarding to :8790',
  },
  {
    pane: 8,
    title: 'cloud-agent-next (8794)',
    dir: 'cloud-agent-next',
    cmd: 'pnpm run dev',
    url: 'http://localhost:8794',
  },
] as const;

function tmux(args: string[]): boolean {
  const proc = Bun.spawnSync(['tmux', ...args]);
  return proc.exitCode === 0;
}

function sessionExists(): boolean {
  return Bun.spawnSync(['tmux', 'has-session', '-t', SESSION]).exitCode === 0;
}

async function upCommand(args: string[], root: string): Promise<void> {
  const restart = args.includes('--restart') || args.includes('-r');

  // Check dependencies
  const hasTmux = await run({ command: 'command -v tmux', cwd: root, label: 'check tmux' });
  if (!hasTmux) {
    ui.error('tmux is required but not installed. Install it with: brew install tmux');
    process.exit(1);
  }

  const hasNgrok = await run({ command: 'command -v ngrok', cwd: root, label: 'check ngrok' });
  if (!hasNgrok) {
    ui.error('ngrok is required but not installed. Install it from: https://ngrok.com/download');
    process.exit(1);
  }

  // Handle existing session
  if (sessionExists()) {
    if (restart) {
      ui.warn('Restarting existing session...');
      tmux(['kill-session', '-t', SESSION]);
    } else {
      console.log(
        `\n${ui.bold('Attaching to existing session...')} ${ui.dim('(use --restart to start fresh)')}\n`
      );
      const proc = Bun.spawn(['tmux', 'attach', '-t', SESSION], { stdio: 'inherit' });
      await proc.exited;
      return;
    }
  }

  ui.header('Starting App Builder Dev Environment');

  // Create the tmux session
  tmux(['new-session', '-d', '-s', SESSION, '-n', 'services', '-c', root]);

  // Build up 9 panes by splitting:
  // Split once vertically (creates pane 1 below pane 0)
  tmux(['split-window', '-v', '-t', `${SESSION}:services`, '-c', root]);
  // Split pane 0 horizontally four times (top row: panes 0-4)
  tmux(['split-window', '-h', '-t', `${SESSION}:services.0`, '-c', root]);
  tmux(['split-window', '-h', '-t', `${SESSION}:services.0`, '-c', root]);
  tmux(['split-window', '-h', '-t', `${SESSION}:services.0`, '-c', root]);
  tmux(['split-window', '-h', '-t', `${SESSION}:services.0`, '-c', root]);
  // Split pane 5 horizontally three times (bottom row: panes 5-8)
  tmux(['split-window', '-h', '-t', `${SESSION}:services.5`, '-c', root]);
  tmux(['split-window', '-h', '-t', `${SESSION}:services.5`, '-c', root]);
  tmux(['split-window', '-h', '-t', `${SESSION}:services.5`, '-c', root]);

  // Arrange in tiled layout
  tmux(['select-layout', '-t', `${SESSION}:services`, 'tiled']);

  // Configure pane borders
  tmux(['set-option', '-t', SESSION, 'pane-border-status', 'top']);
  tmux(['set-option', '-t', SESSION, 'pane-border-format', ' #{pane_index}: #{pane_title} ']);
  tmux(['set-option', '-t', SESSION, 'allow-set-title', 'off']);

  // Set pane titles and send commands
  for (const svc of SERVICES) {
    const paneTarget = `${SESSION}:services.${svc.pane}`;
    tmux(['select-pane', '-t', paneTarget, '-T', svc.title]);

    const dir = svc.dir === '.' ? root : join(root, svc.dir);
    tmux(['send-keys', '-t', paneTarget, `cd "${dir}" && ${svc.cmd}`, 'C-m']);
  }

  // Select the ngrok pane by default
  tmux(['select-pane', '-t', `${SESSION}:services.7`]);

  // Print summary
  console.log(`
${ui.bold(ui.cyan('App Builder Dev Environment Started!'))}

${ui.bold('Services:')}
`);
  ui.table([
    ['db-proxy', 'http://localhost:8792'],
    ['session-ingest', 'http://localhost:8787'],
    ['cloud-agent', 'http://localhost:8788'],
    ['cloud-agent-next', 'http://localhost:8794'],
    ['git-token-service', 'http://localhost:8795'],
    ['app-builder', 'http://localhost:8790'],
    ['images-mcp', 'http://localhost:8796'],
    ['webhook-agent-ingest', 'http://localhost:8793'],
    ['ngrok', 'forwarding to :8790'],
  ]);

  console.log(`
${ui.bold('tmux Navigation:')}
  ${ui.dim('Switch panes:  Ctrl+b then arrow keys')}
  ${ui.dim('Scroll mode:   Ctrl+b then [  (use arrows/PgUp/PgDn, q=exit)')}
  ${ui.dim('Detach:        Ctrl+b then d')}
  ${ui.dim('Zoom pane:     Ctrl+b then z  (toggle fullscreen pane)')}

${ui.bold('Session Commands:')}
  ${ui.dim(`Attach:  tmux attach -t ${SESSION}`)}
  ${ui.dim(`Kill:    tmux kill-session -t ${SESSION}`)}
`);

  // Attach to the session
  const proc = Bun.spawn(['tmux', 'attach', '-t', SESSION], { stdio: 'inherit' });
  await proc.exited;
}

export const appBuilder: ProjectDef = {
  name: 'app-builder',
  description: 'App builder Cloudflare Workers dev environment (tmux session)',
  commands: {
    up: {
      description:
        'Start all app-builder services in a tmux session (--restart to force fresh start)',
      run: upCommand,
    },
  },
};
