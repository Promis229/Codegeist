import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// En developpement, /api est proxifie vers le backend (evite CORS). En production, nginx fait la meme chose.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: process.env.API_TARGET || 'http://localhost:4000', changeOrigin: false } },
  },
});
