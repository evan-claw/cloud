import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit tests - run in Node (fast, supports vi.mock and global mocking)
export default defineConfig({
  resolve: {
    alias: {
      // cloudflare:workers is only available in the Workers runtime.
      // Provide a minimal stub so unit tests can import modules that
      // transitively depend on DurableObject (e.g. RateLimitDO).
      'cloudflare:workers': path.resolve(__dirname, 'test/unit/stubs/cloudflare-workers.ts'),
    },
  },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
