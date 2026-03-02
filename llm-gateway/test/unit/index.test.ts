import { describe, it, expect } from 'vitest';

// Phase 1 scaffolding smoke test.
describe('llm-gateway scaffold', () => {
  it('module loads without error', async () => {
    const { default: worker } = await import('../../src/index');
    expect(typeof worker.fetch).toBe('function');
  });
});
