import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  // npm run app:dev startet wrangler auf 8787; Vite leitet /api dorthin
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
