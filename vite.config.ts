import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'chrome114',
    rollupOptions: {
      input: { sidepanel: resolve(import.meta.dirname, 'sidepanel.html'), background: resolve(import.meta.dirname, 'src/background.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
});
