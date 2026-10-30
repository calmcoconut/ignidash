import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Order matters: the first matching alias wins, so the more specific `@/convex` has to come
    // before `@`, or `@/convex/...` is rewritten to `src/convex/...` and never resolves.
    alias: [
      { find: '@/convex', replacement: resolve(__dirname, './convex') },
      { find: '@', replacement: resolve(__dirname, './src') },
    ],
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**'],
    server: { deps: { inline: ['convex-test'] } },
  },
});
