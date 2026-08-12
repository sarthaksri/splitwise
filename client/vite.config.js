import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Splitwise',
        short_name: 'Splitwise',
        description: 'Split bills dish by dish, and settle up with the fewest payments.',
        theme_color: '#1cc29f',
        // Matches the cream page, so the splash screen doesn't flash white.
        background_color: '#f7f1e4',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Serve the app shell for client-side routes, but never for /api —
        // an API call must fail honestly rather than get handed index.html.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Deliberately no runtime caching of /api. This app is about money:
        // showing a cached balance that has since changed would misrepresent
        // what someone owes. The shell loads offline; the numbers need network.
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        // Keep the service worker out of the way during development.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Overridable so a second instance can run alongside the first without
    // fighting over ports: API_PORT=5001 npm run dev --workspace client -- --port 5175
    port: Number(process.env.CLIENT_PORT) || 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 5000}`,
        changeOrigin: true,
      },
    },
  },
});
