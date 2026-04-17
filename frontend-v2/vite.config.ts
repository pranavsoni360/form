import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://localhost:8200', changeOrigin: true },
      '/uploads': { target: 'http://localhost:8200', changeOrigin: true },
    },
  },
})
