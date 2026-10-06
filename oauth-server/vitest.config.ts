import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Cache dans le node_modules partagé des workspaces, pas dans oauth-server/node_modules.
  cacheDir: '../node_modules/.vite/oauth-server',
  test: {
    include: ['test/**/*.test.ts'],
  },
});
