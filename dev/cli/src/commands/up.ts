import { resolve } from '../services/resolver';
import { getServiceNames, type ServiceDef } from '../services/registry';
import * as docker from '../infra/docker';
import { spawnService, run } from '../utils/process';
import * as ui from '../utils/ui';
import { join } from 'path';

export async function up(args: string[], root: string) {
  const targets = args.length > 0 ? args : ['nextjs'];

  const validNames = getServiceNames();
  for (const name of targets) {
    if (!validNames.includes(name)) {
      ui.error(`Unknown service: "${name}"`);
      console.log(`\nAvailable services: ${validNames.join(', ')}`);
      process.exit(1);
    }
  }

  const plan = resolve(targets);

  ui.header('Starting services');
  console.log(`  ${plan.map(s => s.name).join(' → ')}\n`);

  const infraServices = plan.filter(s => s.type === 'infra');
  const appServices = plan.filter(s => s.type !== 'infra');

  for (const svc of infraServices) {
    await startInfraService(svc, root);
  }

  if (appServices.length === 0) {
    ui.success('Infrastructure is ready. No app services to start.');
    return;
  }

  ui.header('Starting dev servers');

  for (const svc of appServices) {
    if (!svc.devCommand) continue;
    const cwd = join(root, svc.dir);
    const portInfo = svc.port ? ` (port ${svc.port})` : '';
    console.log(`  Starting ${ui.bold(svc.name)}${portInfo}...`);
    spawnService({ name: svc.name, command: svc.devCommand, cwd });
  }

  console.log(`\n  ${ui.dim('Press Ctrl+C to stop all services')}\n`);
  await new Promise(() => {});
}

async function startInfraService(svc: ServiceDef, root: string) {
  ui.header(`Starting ${svc.name}`);

  if (!svc.devCommand) return;

  const ok = await run({
    command: svc.devCommand,
    cwd: join(root, svc.dir),
    label: svc.devCommand,
  });

  if (!ok) {
    ui.error(`Failed to start ${svc.name}`);
    process.exit(1);
  }

  if (svc.name === 'postgres' || svc.name === 'redis') {
    console.log(`  Waiting for ${svc.name} to be healthy...`);
    const healthy = await docker.waitForHealthy(root, svc.name);
    if (healthy) {
      ui.success(`${svc.name} is ready`);
    } else {
      ui.warn(`${svc.name} health check timed out — continuing anyway`);
    }
  } else {
    ui.success(`${svc.name} complete`);
  }
}
