import { services } from '../services/registry';
import * as docker from '../infra/docker';
import * as ui from '../utils/ui';

export async function status(root: string) {
  ui.header('Service Status');

  const pgHealthy = await docker.isHealthy(root, 'postgres');
  const redisHealthy = await docker.isHealthy(root, 'redis');

  console.log(
    `  ${pgHealthy ? ui.green('●') : ui.red('●')} postgres    ${pgHealthy ? 'running' : 'stopped'}`
  );
  console.log(
    `  ${redisHealthy ? ui.green('●') : ui.red('●')} redis       ${redisHealthy ? 'running' : 'stopped'}`
  );

  const portServices = services.filter(s => s.port && s.type !== 'infra');

  // Group services by port to detect shared-port conflicts
  const portGroups = new Map<number, typeof portServices>();
  for (const svc of portServices) {
    const group = portGroups.get(svc.port!) ?? [];
    group.push(svc);
    portGroups.set(svc.port!, group);
  }

  // Check each unique port once
  const portStatus = new Map<number, boolean>();
  for (const port of portGroups.keys()) {
    portStatus.set(port, await isPortListening(port));
  }

  for (const [port, group] of portGroups) {
    const listening = portStatus.get(port)!;

    if (group.length === 1) {
      // Unique port — show definitive status
      const svc = group[0];
      console.log(
        `  ${listening ? ui.green('●') : ui.dim('○')} ${svc.name.padEnd(12)} ${listening ? `port ${port}` : ui.dim('not running')}`
      );
    } else {
      // Shared port — cannot determine which service is actually running
      const names = group.map(s => s.name);
      if (listening) {
        console.log(
          `  ${ui.yellow('●')} ${names.join(', ').padEnd(12)} port ${port} ${ui.yellow('(shared — cannot distinguish)')}`
        );
      } else {
        for (const svc of group) {
          console.log(
            `  ${ui.dim('○')} ${svc.name.padEnd(12)} ${ui.dim('not running')}`
          );
        }
      }
    }
  }

  console.log();
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data() {},
        open(s) {
          s.end();
        },
        error() {},
      },
    });
    return true;
  } catch {
    return false;
  }
}
