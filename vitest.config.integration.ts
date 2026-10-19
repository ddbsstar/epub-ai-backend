import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.integration-spec.ts'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
