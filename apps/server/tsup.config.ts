import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  removeNodeProtocol: false,
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@livinglayer/domain'],
  external: ['fastify', '@fastify/static', '@meta-sam/parser', 'dotenv', 'openai', 'sharp', 'zod'],
});
