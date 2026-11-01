import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxy = Object.fromEntries(
  ['/api', '/health', '/docs', '/openapi.json'].map(path => [
    path, { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000', changeOrigin: true },
  ]),
);
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)([\\/]|$)/, priority: 20 },
            { name: 'visualization', test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
});
