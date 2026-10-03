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
    // Most test files build a database of their own: PGlite is Postgres compiled
    // to WebAssembly, and a few dozen of them at once exhaust the heap ("Fatal
    // process out of memory: Zone"). Three at a time keeps the suite quick and
    // keeps it from falling over on a laptop.
    poolOptions: { forks: { maxForks: 3 }, threads: { maxThreads: 3 } },
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
