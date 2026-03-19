import { services } from '../services/registry';
import * as ui from '../utils/ui';

export async function logs(args: string[], root: string) {
  if (args.length === 0) {
    ui.header('Available services');
    for (const svc of services) {
      const portInfo = svc.port ? ` (port ${svc.port})` : '';
      console.log(`  ${svc.name.padEnd(20)} ${ui.dim(svc.description)}${portInfo}`);
    }
    return;
  }

  const name = args[0];
  const svc = services.find(s => s.name === name);
  if (!svc) {
    ui.error(`Unknown service: "${name}"`);
    return;
  }

  // Only docker compose services support `docker compose logs`.
  // Infra services like 'migrations' use non-docker commands (e.g. pnpm drizzle migrate)
  // and have no persistent container to tail.
  const dockerComposeServices = new Set(['postgres', 'redis']);

  if (svc.type === 'infra' && dockerComposeServices.has(svc.name)) {
    const proc = Bun.spawn(
      ['docker', 'compose', '-f', 'dev/docker-compose.yml', 'logs', '-f', svc.name],
      { stdout: 'inherit', stderr: 'inherit', cwd: root }
    );
    await proc.exited;
  } else if (svc.type === 'infra') {
    ui.warn(
      `"${svc.name}" is not a Docker Compose service — no logs to tail.\n  It runs: ${svc.devCommand ?? 'n/a'}`
    );
  } else {
    ui.warn(
      `Log tailing for running dev servers is not yet supported.\n  Start the service with 'pnpm kilo dev up ${name}' to see its output.`
    );
  }
}
