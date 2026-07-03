import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed at https://2reachhq.github.io/buqo-io/ — a project-page subpath,
// so asset URLs must be rooted at /buqo-io/ instead of the default '/'.
export default defineConfig({
  base: '/buqo-io/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
