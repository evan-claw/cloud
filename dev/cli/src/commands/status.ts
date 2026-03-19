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

  // Group services by port to detect shared ports
  const portToServices = new Map<number, string[]>();
  for (const svc of portServices) {
    const list = portToServices.get(svc.port!) ?? [];
    list.push(svc.name);
    portToServices.set(svc.port!, list);
  }

  // Track ports we've already checked to avoid duplicate probes
  const checkedPorts = new Set<number>();

  for (const svc of portServices) {
    const port = svc.port!;
    const sharesPort = portToServices.get(port)!;

    if (checkedPorts.has(port)) {
      // Already reported for this port — skip duplicate probe
      continue;
    }
    checkedPorts.add(port);

    const listening = await isPortListening(port);

    if (sharesPort.length > 1) {
      // Multiple services claim this port — show them together with a note
      const names = sharesPort.join(' / ');
      const ambiguityNote = ui.dim('(shared port — cannot distinguish)');
      console.log(
        `  ${listening ? ui.green('●') : ui.dim('○')} ${names.padEnd(24)} ${listening ? `port ${port} ${ambiguityNote}` : ui.dim('not running')}`
      );
    } else {
      console.log(
        `  ${listening ? ui.green('●') : ui.dim('○')} ${svc.name.padEnd(12)} ${listening ? `port ${port}` : ui.dim('not running')}`
      );
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
