import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': `${root}packages/engine`,
      '@': root,
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
