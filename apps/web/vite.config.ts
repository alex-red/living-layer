import { createLogger, defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { hostname } from 'node:os';
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

/**
 * Quiet while the API server isn't listening (starting, restarting, stopped): the page's polls
 * would each log a refused connection. `bun run dev` already says when it stops; the page gets 502.
 */
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, options) => {
  const code = (options?.error as { code?: string } | null | undefined)?.code;
  if (code === 'ECONNREFUSED' && msg.includes('http proxy error')) return;
  logError(msg, options);
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve('../..'), 'PORT');
  // `bun run dev` watches for changes and the page offers to reload (`DevReload.tsx`).
  const control = process.env.LIVING_LAYER_DEV_CONTROL;
  return {
    // The web demo is served under its repository's path on GitHub Pages (`bun run static-demo`).
    base: process.env.VITE_BASE ?? '/',
    plugins: [react(), endWithParent],
    customLogger: logger,
    server: {
      // No hot reload: an edit, often another session's half-done one, would reload the page under you.
      hmr: false,
      // Beside loopback, this machine by name on the network (the API server's `LAB_HOSTS`).
      allowedHosts: [hostname(), hostname().split('.')[0]!],
      proxy: {
        '/api': `http://127.0.0.1:${env.PORT || '43431'}`,
        ...(control ? { '/__dev': control } : {}),
      },
      fs: { allow: [resolve('../..')] },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          // React is a third of the first load and changes rarely: its own chunk stays cached across releases.
          codeSplitting: {
            groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
          },
        },
      },
    },
  };
});
