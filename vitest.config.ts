import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/admin/app/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
      ],
    },
  },
});
