import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['backend/__tests__/**/*.test.js'],
    setupFiles: [],
  },
});
