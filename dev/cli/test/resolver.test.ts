import { describe, expect, test } from 'bun:test';
import { resolve } from '../src/services/resolver';

describe('dependency resolver', () => {
  test("resolving 'nextjs' includes postgres, redis, migrations", () => {
    const result = resolve(['nextjs']);
    const names = result.map(s => s.name);
    expect(names).toContain('postgres');
    expect(names).toContain('redis');
    expect(names).toContain('migrations');
    expect(names).toContain('nextjs');
  });

  test('infra comes before apps in resolved order', () => {
    const result = resolve(['nextjs']);
    const names = result.map(s => s.name);
    expect(names.indexOf('postgres')).toBeLessThan(names.indexOf('migrations'));
    expect(names.indexOf('migrations')).toBeLessThan(names.indexOf('nextjs'));
  });

  test("resolving 'kiloclaw' includes nextjs and its deps", () => {
    const result = resolve(['kiloclaw']);
    const names = result.map(s => s.name);
    expect(names).toContain('postgres');
    expect(names).toContain('nextjs');
    expect(names).toContain('kiloclaw');
  });

  test('no duplicates in resolved set', () => {
    const result = resolve(['kiloclaw', 'cloud-agent']);
    const names = result.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('resolving unknown service throws', () => {
    expect(() => resolve(['nonexistent'])).toThrow();
  });

  test('resolving empty array returns empty', () => {
    expect(resolve([])).toEqual([]);
  });
});
