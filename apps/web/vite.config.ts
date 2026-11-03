import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/** `bun run dev` can go without telling its children (a closed terminal, a kill -9); Vite would keep the port. */
const endWithParent: Plugin = {
  name: 'end-with-parent',
  apply: 'serve',
  configureServer(server) {
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) void server.close().finally(() => process.exit(0));
    }, 2000).unref();
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve('../..'), 'PORT');
  // `bun run dev` watches for changes and the page offers to reload (`DevReload.tsx`).
  const control = process.env.LIVING_LAYER_DEV_CONTROL;
  return {
    plugins: [react(), endWithParent],
    server: {
      // No hot reload: an edit, often another session's half-done one, would reload the page under you.
      hmr: false,
      proxy: {
        '/api': `http://127.0.0.1:${env.PORT || '43431'}`,
        ...(control ? { '/__dev': control } : {}),
      },
      fs: { allow: [resolve('../..')] },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
