import { getService, type ServiceDef } from './registry';

/**
 * Given target service names, returns the full set of services needed
 * (including transitive dependencies) in topological order (deps first).
 */
export function resolve(targets: string[]): ServiceDef[] {
  if (targets.length === 0) return [];

  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection
  const order: ServiceDef[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected: ${name}`);
    }
    const svc = getService(name);
    if (!svc) throw new Error(`Unknown service: "${name}"`);
    visiting.add(name);
    for (const dep of svc.deps) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(svc);
  }

  for (const target of targets) {
    visit(target);
  }

  return order;
}
