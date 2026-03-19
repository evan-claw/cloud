import { describe, expect, test } from 'bun:test';
import { services } from '../src/services/registry';

describe('status: shared-port detection', () => {
  test('identifies services that share a port', () => {
    const portServices = services.filter(s => s.port && s.type !== 'infra');
    const portGroups = new Map<number, string[]>();
    for (const svc of portServices) {
      const group = portGroups.get(svc.port!) ?? [];
      group.push(svc.name);
      portGroups.set(svc.port!, group);
    }
    const sharedPorts = [...portGroups.entries()].filter(([, names]) => names.length > 1);

    // Verify the known shared ports are detected
    expect(sharedPorts.length).toBeGreaterThanOrEqual(2);

    const port8792 = portGroups.get(8792);
    expect(port8792).toBeDefined();
    expect(port8792).toContain('auto-fix');
    expect(port8792).toContain('db-proxy');

    const port8795 = portGroups.get(8795);
    expect(port8795).toBeDefined();
    expect(port8795).toContain('kiloclaw');
    expect(port8795).toContain('git-token');
  });

  test('unique-port services are not grouped', () => {
    const portServices = services.filter(s => s.port && s.type !== 'infra');
    const portGroups = new Map<number, string[]>();
    for (const svc of portServices) {
      const group = portGroups.get(svc.port!) ?? [];
      group.push(svc.name);
      portGroups.set(svc.port!, group);
    }

    // Port 3000 belongs only to nextjs
    const port3000 = portGroups.get(3000);
    expect(port3000).toEqual(['nextjs']);
  });

  test('all non-infra port services are accounted for in port groups', () => {
    const portServices = services.filter(s => s.port && s.type !== 'infra');
    const portGroups = new Map<number, string[]>();
    for (const svc of portServices) {
      const group = portGroups.get(svc.port!) ?? [];
      group.push(svc.name);
      portGroups.set(svc.port!, group);
    }

    // Every port-having service should be in exactly one group
    const allGroupedNames = [...portGroups.values()].flat();
    const serviceNames = portServices.map(s => s.name);
    expect(allGroupedNames.sort()).toEqual(serviceNames.sort());
  });
});
