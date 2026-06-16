import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.js'],
    globalSetup: './tests/e2e/setup.js',
    globalTeardown: './tests/e2e/teardown.js',
    testTimeout: 300000,  // 300s per test — Docker operations can be slow on VMs
    hookTimeout: 300000, // 300s for beforeAll/afterAll hooks
  },
});
