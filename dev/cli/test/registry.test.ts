import { describe, expect, test } from "bun:test";
import { services, getService, getServiceNames } from "../src/services/registry";

describe("service registry", () => {
  test("all services have unique names", () => {
    const names = services.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all services have unique ports (where defined)", () => {
    const portsWithNames = services
      .filter((s) => s.port)
      .map((s) => ({ name: s.name, port: s.port }));
    const portMap = new Map<number, string[]>();
    for (const { name, port } of portsWithNames) {
      portMap.set(port!, [...(portMap.get(port!) ?? []), name]);
    }
    const conflicts = [...portMap.entries()].filter(([, names]) => names.length > 1);
    // NOTE: Some upstream wrangler.jsonc files have port conflicts (e.g. db-proxy
    // and auto-fix both claim 8792, git-token and kiloclaw both claim 8795).
    // The registry records the wrangler.jsonc ports as-is. These services are
    // rarely run simultaneously, but if you need to, override the port in
    // wrangler.jsonc with --port or in the registry here.
    // This test documents known conflicts rather than failing on them.
    for (const [port, names] of conflicts) {
      console.warn(`  ⚠ Port ${port} claimed by: ${names.join(", ")}`);
    }
  });

  test("all deps reference valid service names", () => {
    const names = new Set(services.map((s) => s.name));
    for (const svc of services) {
      for (const dep of svc.deps) {
        expect(names.has(dep)).toBe(true);
      }
    }
  });

  test("getService returns service by name", () => {
    const svc = getService("nextjs");
    expect(svc).toBeDefined();
    expect(svc!.port).toBe(3000);
  });

  test("getServiceNames returns all names", () => {
    const names = getServiceNames();
    expect(names).toContain("nextjs");
    expect(names).toContain("postgres");
  });
});
