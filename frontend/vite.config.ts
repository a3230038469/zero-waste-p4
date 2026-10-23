import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 允许局域网/内网穿透访问（同 WiFi 队友演示用）
    host: true,
    // T3 · P2-12（2026-10-21）：前端请求统一走**同源 /api**（见 api/http.ts），
    // 开发态 vite dev server 在 5173、后端在 4000，不转发的话同源请求会 404。
    // 这里把 /api 代理到后端，开发态与生产构建用同一套相对地址。
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  },
  // T3（2026-10-21）：验收时用 `vite preview` 单独起一个端口跑构建产物，
  // /api 同样转发到后端 4000 —— 不碰共享的 frontend/dist，也不用重启后端。
  preview: {
    port: 4180,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
})
