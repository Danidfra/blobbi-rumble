/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5177 },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
