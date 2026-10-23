import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 通过 Tailscale serve（https 代理到 127.0.0.1:5180）访问时，Host 头是 ts.net 域名
    allowedHosts: ['poordaddy.tail7ca151.ts.net'],
  },
})
