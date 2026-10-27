import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve('../..'), 'PORT');
  return {
    plugins: [react()],
    server: {
      proxy: { '/api': `http://127.0.0.1:${env.PORT || '4310'}` },
      fs: { allow: [resolve('../..')] },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
