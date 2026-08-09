import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports avoid the 3000/5173 crowd so this can run alongside the other consoles
// in ~/work without a collision.
const API_PORT = process.env.PORT ?? '5280';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5281,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
