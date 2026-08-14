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
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        // 后端使用 HTTPS 自签证书时，跳过证书验证
        secure: false,
      },
      '/uploads': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
      // 开发环境代理 NMS HTTP-FLV 拉流，匹配 /live/<streamKey>.flv
      '/live': {
        target: process.env.VITE_LIVE_TARGET || 'http://localhost:3335',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  // 生产环境由后端统一托管前端静态文件（统一端口 3333），
  // 不再使用 vite preview，因此移除 preview 配置。
})
