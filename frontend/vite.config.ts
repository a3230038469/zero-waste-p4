import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 允许局域网/内网穿透访问（同 WiFi 队友演示用）
    host: true
  }
})
