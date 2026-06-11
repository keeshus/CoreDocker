import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.js'],
    globalSetup: './tests/e2e/setup.js',
    globalTeardown: './tests/e2e/teardown.js',
    testTimeout: 90000,  // 90s per test — VM operations can be slow
    hookTimeout: 120000, // 120s for setup/teardown hooks
  },
});
