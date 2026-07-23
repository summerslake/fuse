import { defineConfig } from 'vitest/config';
import path from 'path';

// Minimal config for unit tests — just the '@' alias and a node env.
// Kept separate from vite.config.js so the lib build (dts plugin, etc.)
// doesn't run during tests.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
