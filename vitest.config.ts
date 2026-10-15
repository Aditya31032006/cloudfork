import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests pull and boot a Floci container on first run.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
