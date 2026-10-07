/// <reference types="vitest/config" />
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * THE ONE RELATIONSHIP THIS REPOSITORY HAS WITH THE RENDERER.
 *
 * Every Blobbi the playground shows is built by `@blobbi-kit/3d`, consumed
 * as a PACKAGE: a `file:` dependency on the kit checkout, resolved through
 * its published `exports` to its built `dist/`. There is no copy of the
 * renderer here. Build the kit (`npm run build` in blobbi-kit) and this
 * page shows the result.
 *
 * The linked package lives outside this directory and brings its own
 * dependencies from the kit's tree, so: the kit directory is allowed to be
 * served, and Babylon is deduped to this project's single copy (two copies
 * of Babylon would not recognise each other's scenes).
 */
const KIT_3D = resolve(__dirname, 'node_modules/@blobbi-kit/3d');
const KIT_DIR = existsSync(KIT_3D) ? resolve(realpathSync(KIT_3D), '..', '..') : resolve(__dirname, '..', 'blobbi-kit');
const BABYLON = resolve(__dirname, 'node_modules/@babylonjs/core');

export default defineConfig({
  server: { host: '127.0.0.1', port: 5177, fs: { allow: [__dirname, KIT_DIR] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
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
