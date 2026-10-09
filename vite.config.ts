/// <reference types="vitest/config" />
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * THE ONE RELATIONSHIP THIS REPOSITORY HAS WITH THE RENDERER.
 *
 * Every Blobbi shown here is built by `@blobbi-kit/3d`, consumed as the
 * PUBLISHED package from npm, resolved through its `exports` to its `dist/`.
 * There is no copy of the renderer here.
 *
 * To work against an unpublished kit instead, `npm link` the kit's
 * `packages/blobbi-3d` (or point the dependency at it with `file:`): the
 * linked package then lives outside this directory, so the kit directory is
 * allowed to be served, and Babylon is deduped to this project's single copy
 * (two copies of Babylon would not recognise each other's scenes).
 */
const KIT_3D = resolve(__dirname, 'node_modules/@blobbi-kit/3d');
const KIT_DIR = existsSync(KIT_3D) ? resolve(realpathSync(KIT_3D), '..', '..') : resolve(__dirname, '..', 'blobbi-kit');
const BABYLON = resolve(__dirname, 'node_modules/@babylonjs/core');

/** Share links (`/play/<room>`) open the game page in dev too, as `npm run serve` does (`net/static.ts`). */
const playLinks = {
  name: 'rumble-play-links',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = (req.url ?? '').split('?');
      if (/^\/play\/[^/]{0,32}$/.test(path)) req.url = `/rumble.html${query ? `?${query}` : ''}`;
      next();
    });
  },
};

export default defineConfig({
  plugins: [playLinks],
  server: { host: '127.0.0.1', port: 5177, fs: { allow: [__dirname, KIT_DIR] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input: { playground: resolve(__dirname, 'index.html'), rumble: resolve(__dirname, 'rumble.html') } } },
  // Havok's loader finds its wasm next to its own module; pre-bundling would move it.
  optimizeDeps: { exclude: ['@babylonjs/havok'] },
  resolve: {
    dedupe: ['@babylonjs/core'],
    // Belt and braces for the test runner: every `@babylonjs/core/...` import, from the linked package too, is this copy.
    alias: [{ find: /^@babylonjs\/core(\/.*)?$/, replacement: `${BABYLON}$1` }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
