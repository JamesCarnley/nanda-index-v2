import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite resolves environment files before tests/setup.ts can apply its guard.
  ...(process.env['NANDA_TEST_ENV_ONLY'] === '1' ? { envDir: false } : {}),
  test: {
    setupFiles: ['./tests/setup.ts'],
    // registry-server has its own vitest.config.ts and .env — run it separately
    exclude: ['registry-server/**', '**/node_modules/**'],
  },
});
