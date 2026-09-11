import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { PRODUCT_FULL_NAME } from './src/config/product';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'product-name-in-html',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('%PRODUCT_FULL_NAME%', PRODUCT_FULL_NAME),
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3000', changeOrigin: true, ws: true },
    },
  },
});
