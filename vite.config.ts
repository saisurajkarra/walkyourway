import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages (/walkyourway/) or any static host.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
