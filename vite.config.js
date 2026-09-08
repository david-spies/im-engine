import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: 'index.html',
      output: {
        // single JS chunk for portability (matches original single-file spirit)
        manualChunks: undefined,
      },
    },
  },
  server: { port: 3000 },
});
