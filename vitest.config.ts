import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'], testTimeout: 180000 },
});
