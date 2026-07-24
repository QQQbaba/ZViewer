import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
      },
      // 开发环境代理 NMS HTTP-FLV 拉流，匹配 /live/<streamKey>.flv
      '/live': {
        target: 'http://localhost:3335',
        changeOrigin: true,
      },
    },
  },
  preview: {
    // 绑定到 '::' 让 Vite preview 同时监听 IPv4 与 IPv6（IPv6 双栈），
    // 兼容纯 IPv6 网络环境以及 IPv4/IPv6 双栈访问。
    host: '::',
    allowedHosts: true,
  },
})
