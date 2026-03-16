import * as docker from '../infra/docker';
import * as ui from '../utils/ui';

export async function down(root: string) {
  ui.header('Stopping services');
  await docker.stopAll(root);
  ui.success('Docker services stopped');
}
