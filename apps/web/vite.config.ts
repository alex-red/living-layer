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
  return {
    plugins: [react(), endWithParent],
    server: {
      proxy: { '/api': `http://127.0.0.1:${env.PORT || '43431'}` },
      fs: { allow: [resolve('../..')] },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
