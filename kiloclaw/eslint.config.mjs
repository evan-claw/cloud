import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'eslint/config';
import baseConfig from '@kilocode/eslint-config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  ...baseConfig(__dirname),
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // vitest globals (vi.mock, vi.fn, etc.) are unresolvable via the workers tsconfig
    // types restriction; disable unsafe rules for test files only
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
]);
