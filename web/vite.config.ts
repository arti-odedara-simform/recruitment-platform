import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev proxy is the reason this app needs no CORS on the API side.
 *
 * The browser only ever talks to `localhost:5173`; Vite forwards `/api/*` to the API on
 * 4000 server-side, so every request is same-origin and the API's middleware stack —
 * including its "exactly two anonymous routes" surface — is untouched by the existence
 * of a frontend. The compose stack keeps that property: there the bundle is served by
 * nginx, which forwards `/api/*` to the api service (see `nginx.conf`).
 *
 * `rewrite` strips the prefix: the client calls `/api/pipeline`, the API sees
 * `/pipeline`. Keeping the prefix on the client side means one place decides where the
 * API lives, and nothing below src/api/ knows the answer.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
