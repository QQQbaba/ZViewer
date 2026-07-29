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
    // preview 模式下也需要代理 /api、/socket.io、/live 到后端，
    // 否则前端 API 请求会发送到 preview 端口（如 4173）导致 404。
    // target 通过环境变量注入，支持一键启动脚本自定义后端 / HTTP-FLV 端口。
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
      },
      '/live': {
        target: process.env.VITE_LIVE_TARGET || 'http://localhost:3335',
        changeOrigin: true,
      },
    },
  },
})
